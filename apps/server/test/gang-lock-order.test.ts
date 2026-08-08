import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { gangInvites, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Regression test for the lock-order inversion between the membership routes
 * and the bank routes.
 *
 * Before the fix, the two families locked the same two rows in opposite
 * orders:
 *
 *   - membership (kick/leave/accept-invite) took `player_stats` FOR UPDATE
 *     first via lockPlayersForUpdate, and only afterwards touched the `gangs`
 *     row — implicitly, as the FOR KEY SHARE Postgres takes when
 *     appendGangLog's INSERT into gang_logs (or accept-invite's UPDATE of
 *     player_stats.gang_id) checks its foreign key to gangs.id.
 *   - the bank routes took both rows through lockGangAndPlayerForUpdate,
 *     which orders them by UUID string comparison — so whenever
 *     `gangId < playerId` it took the `gangs` row FIRST.
 *
 * FOR KEY SHARE conflicts with FOR UPDATE, so for roughly half of all
 * (gang, player) pairs that is a genuine cycle. Postgres picks a victim
 * arbitrarily and aborts it with 40P01; neither route catches 40P01, so it
 * reaches Fastify uncaught and a well-formed request answers HTTP 500.
 *
 * gang-ledger.test.ts's existing "does not deadlock under concurrent
 * opposite-direction transfers" cannot catch this: every participant in it
 * goes through lockGangAndPlayerForUpdate and therefore agrees on the order
 * by construction. It proves exactly the case that was already safe.
 *
 * The interleaving here is forced, not hoped for. A third connection holds
 * the `gangs` row FOR UPDATE so that both requests park on it in a known
 * queue order; releasing it hands the row to the bank request (queued
 * first), which then has to wait on the `player_stats` row the pre-fix kick
 * is already holding, while the kick waits on the `gangs` row the bank
 * request now holds. Each step waits on an observed lock state in
 * pg_stat_activity rather than on a sleep.
 */

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let bossToken: string;
let gangId: string;
let memberToken: string;
let memberId: string;

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());

  const boss = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
  bossToken = boss.json().token;
  const gang = await app.inject({
    method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${bossToken}` }, payload: { name: "The Corleones" },
  });
  gangId = gang.json().id;

  const member = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Sonny", password: "hunter2hunter2" } });
  ({ token: memberToken, playerId: memberId } = member.json());
  await app.inject({
    method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` }, payload: { username: "Sonny" },
  });
  const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, memberId));
  await app.inject({ method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${memberToken}` } });

  await db.update(playerStats).set({ cash: 1_000n }).where(eq(playerStats.playerId, memberId));
});

afterAll(async () => { await closeServer(); await conn.end(); });

/**
 * `app.inject()` returns light-my-request's lazy chainable: the request is
 * only dispatched when something calls `.then` on it. Wrapping it in
 * Promise.resolve schedules that call immediately, which is what lets the
 * two requests actually be in flight while this test waits on lock state.
 */
function fire(opts: InjectOptions): Promise<LightMyRequestResponse> {
  return Promise.resolve(app.inject(opts));
}

/**
 * Blocks until `n` backends in THIS file's (private, per-file) database are
 * parked on a lock. Each isolated test database is cloned per file, so no
 * other test file's connections can be counted here.
 */
async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await conn<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
    `;
    const seen = row?.n ?? 0;
    if (seen >= n) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} lock-waiting backends (saw ${seen})`);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

describe("gang lock ordering", () => {
  it("does not deadlock when a kick and a bank deposit run concurrently on the same (gang, player) pair", async () => {
    // The inversion only bites when the bank route's UUID ordering puts the
    // gangs row first. uuidv7 is time-ordered and the gang is created before
    // the member registers, so this holds by construction — asserted rather
    // than assumed so that a change in id generation fails loudly here
    // instead of quietly making this test pass for the wrong reason.
    expect(gangId < memberId).toBe(true);

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const inFlight: Promise<LightMyRequestResponse>[] = [];
    const t0 = await blocker.reserve();

    try {
      await t0`BEGIN`;
      await t0`SELECT id FROM gangs WHERE id = ${gangId}::uuid FOR UPDATE`;

      // Queued FIRST on the gangs row, so it is the request Postgres hands
      // that row to when t0 commits.
      const deposit = fire({
        method: "POST", url: `/api/gangs/${gangId}/bank/deposit`,
        headers: { authorization: `Bearer ${memberToken}` }, payload: { amount: "100" },
      });
      inFlight.push(deposit);
      await waitForLockWaiters(1);

      // Queued SECOND. Pre-fix it has already taken player_stats FOR UPDATE
      // by the time it parks here on the gangs row.
      const kick = fire({
        method: "DELETE", url: `/api/gangs/${gangId}/members/${memberId}`,
        headers: { authorization: `Bearer ${bossToken}` },
      });
      inFlight.push(kick);
      await waitForLockWaiters(2);

      await t0`COMMIT`;

      const [depositRes, kickRes] = await Promise.all([deposit, kick]);

      // The regression: pre-fix, whichever transaction Postgres picks as the
      // deadlock victim is aborted with 40P01, which no route catches, so a
      // well-formed request answers 500.
      expect(depositRes.statusCode, `deposit body: ${depositRes.body}`).toBeLessThan(500);
      expect(kickRes.statusCode, `kick body: ${kickRes.body}`).toBeLessThan(500);

      // Both orderings are legal outcomes: the deposit commits first (200)
      // and the kick then removes the member, or the kick wins and the
      // deposit's in-transaction membership recheck rejects it (403).
      expect([200, 403]).toContain(depositRes.statusCode);
      expect(kickRes.statusCode).toBe(204);
    } finally {
      // Release the blocking row lock before draining, so that a failure
      // earlier in the test cannot leave the two requests parked forever.
      try { await t0`ROLLBACK`; } catch { /* already committed */ }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }
  }, 30_000);
});
