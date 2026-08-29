import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { deliverAndClear, insertOutboxEvents } from "../../bus/outbox.js";
import type { Db } from "../../db/client.js";
import { players, rounds } from "../../db/schema/index.js";
import { applyBalanceChange, lockPlayersForUpdate, type Tx } from "../../economy/ledger.js";
import { insertNotification } from "../notifications/service.js";
import { payoutPoints } from "./settings.js";
import { roundStandings } from "./standings.js";

export interface ActiveRound {
  id: string;
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
}

/**
 * A misconfigured schedule (thousands of one-second rounds) must fail loudly
 * rather than hold the advisory lock while it grinds.
 */
const MAX_SETTLE_PASSES = 50;
/** Shared with the two admin write routes; 7461001 is the first-admin claim. */
const ROUNDS_LOCK = 7461002;

interface ProbeRow {
  id: string;
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
  snapshottedAt: Date | null;
  /** Evaluated against the DATABASE clock, never the app's. */
  ended: boolean;
}

const toActive = (row: ProbeRow): ActiveRound => ({
  id: row.id, name: row.name, startsAt: row.startsAt, endsAt: row.endsAt,
});

/**
 * The earliest unfinalized round that has started. `ORDER BY starts_at ASC,
 * id ASC` is the deterministic tie-break §5.5 risk 2 requires: overlap is
 * rejected at admin write time, but that check is application-level, so the
 * read path picks one round rather than trusting uniqueness. Rows with a NULL
 * `starts_at` are inert and excluded by the predicate. This is the read
 * `rounds_open_idx` exists for.
 */
async function probe(exec: Db | Tx): Promise<ProbeRow | undefined> {
  const [row] = await exec.select({
    id: rounds.id,
    name: rounds.name,
    startsAt: rounds.startsAt,
    endsAt: rounds.endsAt,
    snapshottedAt: rounds.snapshottedAt,
    ended: sql<boolean>`(${rounds.endsAt} is not null and ${rounds.endsAt} <= now())`,
  }).from(rounds)
    .where(sql`${rounds.finalizedAt} is null and ${rounds.startsAt} is not null and ${rounds.startsAt} <= now()`)
    .orderBy(asc(rounds.startsAt), asc(rounds.id))
    .limit(1);
  return row;
}

/**
 * Activation steps 3-5 (§2.2a): the whole-population snapshot, the stamp, and
 * pointing every player at the round. Reached from inside the settle loop's
 * single call site — whether the round was already current when the loop
 * started, or became current only after finalizing every round ahead of it.
 * Returns whether THIS call activated the round; the caller publishes
 * `round.started` only then.
 *
 * Step 5's `UPDATE players` takes FOR NO KEY UPDATE on every row it touches, so
 * for the life of this transaction the two other single-row `UPDATE players`
 * statements in the game (the lazy argon2id upgrade, admin role assignment)
 * wait. Neither can deadlock against it: both hold one `players` row and then
 * want nothing else.
 */
async function activate(tx: Tx, round: ProbeRow): Promise<boolean> {
  // ON CONFLICT DO NOTHING because a player who registered between starts_at
  // and now already inserted their own entry (§2.5), and theirs is the more
  // accurate one — it was taken when they actually joined.
  await tx.execute(sql`
    insert into round_entries (round_id, player_id, joined_at, exp_at_start, cash_at_start, bank_at_start)
    select ${round.id}, ps.player_id, now(), ps.exp, ps.cash, ps.bank
    from player_stats ps
    on conflict (round_id, player_id) do nothing`);

  // The WHERE makes this statement the arbiter of "did THIS call activate it".
  const stamped = await tx.update(rounds)
    .set({ snapshottedAt: sql`now()` })
    .where(and(eq(rounds.id, round.id), isNull(rounds.snapshottedAt)))
    .returning({ id: rounds.id });
  if (stamped.length === 0) return false;

  // IS DISTINCT FROM makes the statement re-runnable and a no-op on rows that
  // already point at the round. First server code ever to write players.round_id.
  await tx.execute(sql`update players set round_id = ${round.id} where round_id is distinct from ${round.id}`);
  return true;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/**
 * Finalize steps 1-3 (§2.3). Returns the `round.finished` event when THIS call
 * settled the round, or null when the stamp matched nothing.
 */
async function finalize(tx: Tx, round: ProbeRow, settings: Record<string, string>): Promise<GameEvent | null> {
  // Step 1 — freeze. Runs before the payout so the numbers the board shows are
  // the numbers the placings were computed from.
  await tx.execute(sql`
    update round_entries as re
       set final_exp = ps.exp, final_cash = ps.cash, final_bank = ps.bank
      from player_stats as ps
     where ps.player_id = re.player_id and re.round_id = ${round.id}`);

  // Step 2 — pay. `tx`, not `db`: ranking must see the freeze this transaction
  // just wrote. `finalized: true` so a concurrent crime payout cannot shift a
  // placing. `minDelta: 0n` so a round nobody played pays nobody.
  const awards = payoutPoints(settings);
  const winners = awards.length === 0
    ? []
    : await roundStandings(tx, round.id, "exp", awards.length, true, 0n);

  if (winners.length > 0) {
    // Once, with the whole winner set, so player_stats locks are taken
    // ascending in one statement rather than in board (delta) order — §2.7.
    await lockPlayersForUpdate(tx, winners.map((w) => w.playerId));
    for (const [i, winner] of winners.entries()) {
      await applyBalanceChange(tx, {
        playerId: winner.playerId,
        amount: awards[i]!,
        kind: "points",
        reason: "round.payout",
        refId: round.id,
        // No jobId: finalize is not a BullMQ job. Its idempotency is the
        // advisory lock plus the finalized_at guard, and job_id is UNIQUE.
      });
      await insertNotification(tx, {
        id: uuidv7(),
        playerId: winner.playerId,
        body: `Round "${round.name}" finished — you placed ${ordinal(winner.rank)} and were paid ${awards[i]!.toString()} points.`,
      });
    }
  }

  // Step 3 — stamp. The WHERE is the arbiter of "did THIS call settle it".
  const stamped = await tx.update(rounds)
    .set({ finalizedAt: sql`now()` })
    .where(and(eq(rounds.id, round.id), isNull(rounds.finalizedAt)))
    .returning({ id: rounds.id });
  if (stamped.length === 0) return null;

  return {
    id: uuidv7(),
    type: "round.finished",
    at: new Date().toISOString(),
    actorId: round.id,
    actorName: round.name,
    audience: { kind: "global" },
    roundId: round.id,
    roundName: round.name,
    winners: winners.map((w, i) => ({
      playerId: w.playerId,
      username: w.username,
      placing: w.rank,
      // The award paid, deliberately not `score` — score is the delta that
      // earned the placing.
      points: awards[i]!.toString(),
    })),
  };
}

function startedEvent(round: ProbeRow): GameEvent {
  return {
    id: uuidv7(),
    type: "round.started",
    at: new Date().toISOString(),
    actorId: round.id,
    actorName: round.name,
    audience: { kind: "global" },
    roundId: round.id,
    roundName: round.name,
    endsAt: round.endsAt === null ? null : round.endsAt.toISOString(),
  };
}

/**
 * The transactional half: settle every ended round in one pass and activate
 * whatever becomes current. The advisory lock is the FIRST statement; the probe
 * that follows it is the recheck under the lock (§2.2a step 2 / §2.3's recheck /
 * §2.3 step 4's re-evaluation are the same statement, run once here).
 */
async function settle(
  db: Db, redis: Redis, settings: Record<string, string>,
): Promise<ActiveRound | null> {
  const pending: GameEvent[] = [];
  let rows: { id: string; kind: string; payload: unknown }[] = [];

  const active = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROUNDS_LOCK})`);

    let settled: ActiveRound | null = null;
    for (let pass = 0; ; pass += 1) {
      const current = await probe(tx);
      if (current === undefined) break;

      if (!current.ended) {
        if (current.snapshottedAt === null && await activate(tx, current)) {
          pending.push(startedEvent(current));
        }
        settled = toActive(current);
        break;
      }

      const finished = await finalize(tx, current, settings);
      if (finished !== null) pending.push(finished);
      if (pass + 1 >= MAX_SETTLE_PASSES) throw new Error("too many rounds to settle in one pass");
    }

    // The outbox rows join THIS transaction — a settle and the events it
    // produced commit together or not at all, which is the whole gap the
    // outbox closes. Rule 5's ordering half still holds: nothing here is
    // PUBLISHED inside the transaction, only made durable. Oldest
    // round.finished first, then round.started — the push order, preserved
    // by the envelopes' uuidv7 ids.
    rows = await insertOutboxEvents(tx, pending);
    return settled;
  });

  // The fast path — never throws; the dispatcher owns what it cannot deliver.
  await deliverAndClear(db, { redis }, rows);
  return active;
}

/**
 * The round that is active when this returns, or null.
 *
 * The fast path opens NO transaction: one unlocked, indexed SELECT ... LIMIT 1.
 * A round that is both unsnapshotted and already over is settled, not activated
 * — finalize is checked first, and that precedence is a genuine rule.
 *
 * Opens its own transaction, so it must never be called from inside one, and it
 * is never reached from a plugin. It must not throw on the common path: it sits
 * at the head of GET /api/leaderboard/:kind, a route that works today.
 */
export async function ensureCurrentRound(
  db: Db, redis: Redis, settings: Record<string, string>,
): Promise<ActiveRound | null> {
  const row = await probe(db);
  if (row === undefined) return null;
  if (!row.ended && row.snapshottedAt !== null) return toActive(row);
  return settle(db, redis, settings);
}
