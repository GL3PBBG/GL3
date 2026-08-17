import type { PluginDbTx } from "@gl3/plugin-sdk";
import { randomInt } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, settings } from "./schema.js";
import type { BulletSettings } from "./settings.js";

/**
 * Port of V2's `bullets.inc.php::restock()` / `getNewBulletStock()`.
 *
 * V2 called it on the bullets module load; GL3 calls it from
 * `GET /api/bullets/shop` for the same reason — a core plugin cannot declare
 * BullMQ jobs (`buildApp` throws), and hanging it off the *purchase* would
 * deadlock the mechanic: the web page disables the buy button at zero stock,
 * so the buy that would trigger the refill can never happen.
 */

/** 7461001 is the first-admin claim, 7461002 is rounds. */
const RESTOCK_LOCK = 7461003;

/**
 * The one key in this plugin that is NOT read through `ctx.settings.get`, so
 * it carries its `bullets.` prefix in full rather than being namespaced by the
 * SDK.
 */
const CURSOR_KEY = "bullets.last_restock";

/** Exactly one row, always — the query has no FROM and cannot be empty. */
const HourRows = z.array(z.object({ epoch: z.string() })).nonempty();

/** V2's clamp: a server down for a week refills twelve hours' worth, not a week's. */
const MAX_CATCHUP_HOURS = 12;

export interface RestockResult {
  restocked: boolean;
  /** Hours actually paid out — 0 when nothing was due, never above 12. */
  hours: number;
}

/**
 * Postgres's clock, not Node's, so the cursor and the comparison against it
 * can never come from two clocks that disagree.
 */
async function currentHour(db: PluginDbTx): Promise<number> {
  // `PluginDbTx` erases `execute`'s row type (its `PgQueryResultHKT` is
  // unresolved), so the result is `unknown` and needs parsing rather than
  // casting — the same rule the SDK applies to every other external boundary.
  // `::bigint` comes back as a string, which is why this is not `z.number()`.
  const rows = HourRows.parse(await db.execute(
    sql`select extract(epoch from date_trunc('hour', now()))::bigint as epoch`,
  ));
  return Number(rows[0].epoch);
}

/** A missing, blank or unparseable cursor reads as the epoch — i.e. long overdue. */
async function readCursor(db: PluginDbTx): Promise<number> {
  const [row] = await db.select({ value: settings.value }).from(settings)
    .where(eq(settings.key, CURSOR_KEY));
  const parsed = Number(row?.value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function hoursDue(thisHour: number, cursor: number): number {
  const elapsed = Math.floor((thisHour - cursor) / 3600);
  if (elapsed <= 0) return 0;                        // also covers a cursor in the future
  return Math.min(MAX_CATCHUP_HOURS, elapsed);
}

/**
 * V2 drew per location, not once for all of them, so two towns in the same
 * pass get different amounts. `randomInt` from `node:crypto`, never
 * `Math.random` (SPEC §7) — and never a seeded rng either, because
 * `ctx.job.rng` exists only on job contexts and this plugin has no jobs.
 * `readBulletSettings` guarantees `max >= min`, without which
 * `randomInt(min, max + 1)` would throw and 500 every shop view.
 */
function draw(hours: number, s: BulletSettings): number {
  let total = 0;
  for (let i = 0; i < hours; i++) total += randomInt(s.stockMinPerHour, s.stockMaxPerHour + 1);
  return total;
}

export async function restockIfDue(db: PluginDbTx, s: BulletSettings): Promise<RestockResult> {
  const thisHour = await currentHour(db);

  // Unlocked pre-check. The common case — a shop view inside an hour already
  // paid — costs one indexed row read and takes no lock at all.
  if (hoursDue(thisHour, await readCursor(db)) === 0) return { restocked: false, hours: 0 };

  await db.execute(sql`select pg_advisory_xact_lock(${RESTOCK_LOCK})`);

  // Re-read UNDER the lock. This is what makes N racing shop views produce one
  // restock and N-1 no-ops instead of N draws; the same structure as
  // `ensureCurrentRound`.
  const hours = hoursDue(thisHour, await readCursor(db));
  if (hours === 0) return { restocked: false, hours: 0 };

  // RULE 6: this touches EVERY location row, so it takes them ascending — the
  // order `lockLocationsForUpdate` sorts into and travel already uses for its
  // two rows. A bare multi-row UPDATE would lock in scan order and could close
  // an ABBA cycle against travel. Regression: bullets-restock-lock-order.test.ts.
  const rows = await db.select({ id: locations.id }).from(locations)
    .orderBy(asc(locations.id)).for("update");

  for (const row of rows) {
    // LEAST() folds in V2's second statement (`SET L_bullets = $max WHERE
    // L_bullets > $max`): every row is touched here anyway, so clamping each
    // as it is written is equivalent and saves a full-table update. It also
    // caps a row that was already over the max, which V2's statement did.
    await db.update(locations)
      .set({ bulletStock: sql`least(${locations.bulletStock} + ${draw(hours, s)}, ${s.maxStock})` })
      .where(eq(locations.id, row.id));
  }

  const value = String(thisHour);
  await db.insert(settings).values({ key: CURSOR_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });

  return { restocked: true, hours };
}
