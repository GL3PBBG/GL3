import { asc, eq, gt, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../db/client.js";
import { gangs, playerStats, settings as settingsTable } from "../db/schema/index.js";
import { insertNotification } from "../game/notifications/service.js";
import { applyBalanceChange, applyGangBalanceChange, lockPlayersForUpdate } from "./ledger.js";
import { wealthTaxPercent, wealthTaxThreshold } from "./settings.js";

/**
 * The daily wealth tax: demurrage on banked wealth above a threshold, the
 * drain for money that pools at franchise owners and long-inactive accounts.
 * Once per UTC day, every player bank and every gang bank above the threshold
 * pays `percent × (balance − threshold)`, destroyed through the ledger (reason
 * `economy.wealth_tax`) — so the MIMO dashboard shows the drain by reason with
 * no dashboard change. Cash is deliberately untouched: banked money decays
 * slowly, pocket money stays stealable by a killer, and that split is what
 * keeps depositing a tradeoff rather than a dominant strategy.
 *
 * Scheduling is the bullets-restock mechanism at day granularity, driven by a
 * sentence-sweeper-shaped loop: a day-truncated Postgres-clock cursor in the
 * settings table, an advisory lock with a re-read under it, and the whole
 * day's pass in ONE transaction — the cursor is stamped inside that same
 * transaction, so the day is either fully taxed or not at all, and two server
 * instances racing produce one pass and one no-op. A percent of 0 (the
 * rollback knob) skips WITHOUT stamping, so enabling it later takes effect on
 * the very next tick.
 */

/** 7461001 first-admin claim, 7461002 rounds, 7461003 bullets restock. */
const WEALTH_TAX_LOCK = 7461004;

/** Full key — a cursor, not a tunable, so it never goes through a parser. */
const CURSOR_KEY = "economy.wealth_tax.last_day";

const LEDGER_REASON = "economy.wealth_tax";

export interface WealthTaxResult {
  /** False when the day was already settled, the tax is off, or a race lost. */
  ran: boolean;
  playersTaxed: number;
  gangsTaxed: number;
}

const NO_OP: WealthTaxResult = { ran: false, playersTaxed: 0, gangsTaxed: 0 };

/**
 * Postgres's clock, not Node's, so the cursor and the comparison against it
 * can never come from two clocks that disagree (the restock rule).
 */
async function currentDay(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0]): Promise<number> {
  // postgres-js returns the row list itself (assets/sweep.ts's `count` cast is
  // the precedent for how opaque execute's typing is here).
  const rows = await db.execute<{ epoch: string }>(
    sql`select extract(epoch from date_trunc('day', now()))::bigint as epoch`,
  );
  // Exactly one row, always — the query has no FROM and cannot be empty.
  return Number(rows[0]!.epoch);
}

/** A missing or unparseable cursor reads as 0 — i.e. long overdue. */
async function readCursor(
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
): Promise<number> {
  const [row] = await db.select({ value: settingsTable.value }).from(settingsTable)
    .where(eq(settingsTable.key, CURSOR_KEY));
  const parsed = Number(row?.value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Ceiling division, the same rounding direction as the wealth-scaled fees. */
function taxOn(excess: bigint, percent: number): bigint {
  return (excess * BigInt(percent) + 99n) / 100n;
}

/**
 * Settle today's pass if it has not run. `settings` is the boot snapshot —
 * same read-at-boot posture as every gameplay setting, so retuning is a
 * restart, and tests can hand tunables straight in (the bullets-restock test
 * pattern) without seeding rows or booting a server.
 */
export async function settleWealthTaxOnce(db: Db, settings: Record<string, string>): Promise<WealthTaxResult> {
  const percent = wealthTaxPercent(settings);
  const threshold = wealthTaxThreshold(settings);
  if (percent <= 0) return NO_OP;

  // Unlocked pre-check: the common tick — today already settled, or the tax
  // freshly disabled at the knob — costs one indexed row read, no lock.
  if ((await readCursor(db)) === await currentDay(db)) return NO_OP;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${WEALTH_TAX_LOCK})`);

    // Re-read UNDER the lock — what makes N racing ticks produce one pass and
    // N−1 no-ops, the same structure as ensureCurrentRound and restockIfDue.
    const today = await currentDay(tx);
    if ((await readCursor(tx)) === today) return NO_OP;

    let playersTaxed = 0;

    // Ordered by playerId ascending (rule 6): the candidate list decides the
    // lock order, so it must be the sorted order `lockPlayersForUpdate`
    // establishes everywhere else. The bank is re-read under each player's own
    // row lock before the amount is computed — a withdrawal landing between
    // the candidate SELECT and the debit can shrink or zero the tax, never
    // over-tax a balance the player no longer holds.
    const players = await tx.select({ playerId: playerStats.playerId })
      .from(playerStats)
      .where(gt(playerStats.bank, threshold))
      .orderBy(asc(playerStats.playerId));
    for (const { playerId } of players) {
      await lockPlayersForUpdate(tx, [playerId]);
      const [fresh] = await tx.select({ bank: playerStats.bank })
        .from(playerStats).where(eq(playerStats.playerId, playerId));
      const bank = fresh?.bank ?? 0n;
      if (bank <= threshold) continue;

      const tax = taxOn(bank - threshold, percent);
      await applyBalanceChange(tx, { playerId, amount: -tax, kind: "bank", reason: LEDGER_REASON });
      // The rounds-finalize pattern: the notification rides the settle
      // transaction, so a player reads exactly what the ledger took.
      await insertNotification(tx, {
        id: uuidv7(), playerId,
        body: `The bank took ${tax.toString()} from your account in wealth tax.`,
      });
      playersTaxed += 1;
    }

    // Gangs after players, ascending by id — the two live in different tables
    // so there is no cross-table order to agree on with anyone. No
    // notification: a gang bank is visible to its members already.
    let gangsTaxed = 0;
    const gangRows = await tx.select({ id: gangs.id })
      .from(gangs)
      .where(gt(gangs.bank, threshold))
      .orderBy(asc(gangs.id));
    for (const { id } of gangRows) {
      // applyGangBalanceChange locks the row itself; the amount comes from a
      // read taken under that lock via a plain re-select first.
      const [fresh] = await tx.select({ bank: gangs.bank }).from(gangs).where(eq(gangs.id, id));
      const bank = fresh?.bank ?? 0n;
      if (bank <= threshold) continue;

      const tax = taxOn(bank - threshold, percent);
      await applyGangBalanceChange(tx, { gangId: id, amount: -tax, kind: "bank", reason: LEDGER_REASON });
      gangsTaxed += 1;
    }

    const value = String(today);
    await tx.insert(settingsTable).values({ key: CURSOR_KEY, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } });

    return { ran: true, playersTaxed, gangsTaxed };
  });
}

export interface WealthTaxLoopHandle {
  /** Stops the loop. Safe to call more than once. */
  stop: () => void;
}

export interface WealthTaxLoopDeps {
  db: Db;
  /** The boot snapshot — retuning the tax is a restart, like every setting. */
  settings: Record<string, string>;
  /** Milliseconds between the END of one check and the START of the next. */
  intervalMs: number;
  onError?: (error: unknown) => void;
}

/**
 * Self-scheduling `setTimeout`, the sentence sweeper's shape: delay from the
 * END of a pass (no overlap), a throwing pass reported and swallowed (the
 * cursor keeps the day unclaimed, so the next tick retries it whole — an
 * interrupted pass rolls back atomically and simply has not happened).
 */
export function startWealthTaxLoop(deps: WealthTaxLoopDeps): WealthTaxLoopHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    try {
      await settleWealthTaxOnce(deps.db, deps.settings);
    } catch (error) {
      deps.onError?.(error);
    }
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, deps.intervalMs);
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
