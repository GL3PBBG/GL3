import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Two discharges for ONE player, in flight at the same time.
 *
 * `settleHospital` reads `hospital_until` with a plain SELECT, and
 * `applyBalanceChange` takes the player lock only when it runs. Before the fix
 * that read sat outside every lock, so both requests saw "hospitalised", both
 * queued on the ledger's lock, and both charged: one discharge, two
 * `hospital.discharge` rows, twice the cash gone (observed: 5,000,000 →
 * 3,800,000 for a single 600,000 discharge). NOTES.md rule 2's ban on
 * check-then-act, in Postgres rather than Redis.
 *
 * `economy-invariant.test.ts` cannot catch this: both charges are ledgered, so
 * `sum(ledger) == balance` holds the whole way through. Only the count of
 * charges gives it away.
 *
 * The blocker connection is a barrier, not an adversary — the same shape as
 * `combat-concurrency.test.ts`. It parks both requests on the victim row so
 * they are provably concurrent before either proceeds, instead of a bare
 * `Promise.all` that may or may not overlap on any given run.
 */

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

/** app.inject() is lazy — it dispatches only when something calls .then. */
function fire(opts: InjectOptions): Promise<LightMyRequestResponse> {
  return Promise.resolve(app.inject(opts));
}

async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await conn<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
    `;
    const seen = row?.n ?? 0;
    if (seen >= n) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${n} lock-waiting backends (saw ${seen})`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

const STARTING_CASH = 5_000_000n;
/** 600s remaining × the 1000/second default = 600,000 a discharge. */
const HOSPITAL_MS = 600_000;

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());

  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Wounded", password: "hunter2hunter2" },
  });
  ({ token, playerId } = res.json());

  await db
    .update(playerStats)
    .set({ cash: STARTING_CASH, health: 0, hospitalUntil: new Date(Date.now() + HOSPITAL_MS) })
    .where(eq(playerStats.playerId, playerId));
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("two concurrent discharges for one player", () => {
  it("charges exactly once and 409s the loser", async () => {
    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<LightMyRequestResponse>[] = [];

    try {
      // Hold the player's row. The shipped code needs it for its lock, and an
      // unlocked variant needs it for the ledger UPDATE, so this parks both
      // requests whichever way the route is written.
      await t0`BEGIN`;
      await t0`SELECT player_id FROM player_stats WHERE player_id = ${playerId}::uuid FOR UPDATE`;

      const opts: InjectOptions = {
        method: "POST",
        url: "/api/hospital/discharge",
        headers: { authorization: `Bearer ${token}` },
      };
      const r1 = fire(opts);
      const r2 = fire(opts);
      inFlight.push(r1, r2);
      await waitForLockWaiters(2);

      await t0`ROLLBACK`;
      const [res1, res2] = await Promise.all([r1, r2]);

      expect(
        [res1.statusCode, res2.statusCode].sort(),
        `bodies: ${res1.body} | ${res2.body}`,
      ).toEqual([200, 409]);
      // Not any 409: the loser must lose because it re-read the row under the
      // lock and found the sentence already cleared.
      const loser = res1.statusCode === 409 ? res1 : res2;
      expect(loser.json()).toMatchObject({ error: "not_hospitalised" });

      // The assertion the status codes alone would miss: a route that answered
      // 200/409 but still ran two applyBalanceChange calls would look right on
      // the wire and be wrong in the ledger.
      const rows = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
      const charges = rows.filter((t) => t.reason === "hospital.discharge");
      expect(charges).toHaveLength(1);

      const [after] = await db
        .select({ cash: playerStats.cash, health: playerStats.health, hospitalUntil: playerStats.hospitalUntil })
        .from(playerStats)
        .where(eq(playerStats.playerId, playerId));
      expect(after?.cash).toBe(STARTING_CASH + (charges[0]?.amount ?? 0n));
      expect(after?.hospitalUntil).toBeNull();
      expect(after?.health).toBeGreaterThan(0);
    } finally {
      try {
        await t0`ROLLBACK`;
      } catch {
        /* already rolled back */
      }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }
  }, 30_000);
});
