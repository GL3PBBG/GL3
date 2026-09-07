import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Redis } from "ioredis";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { gangInvites, gangs, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Account deletion reaches the gang row implicitly: `DELETE FROM players`
 * set-nulls gangs.boss_player_id, which is an UPDATE of the gang row taken
 * AFTER the player's own rows. A bank route holding the gang FOR UPDATE and
 * waiting on that player's player_stats is then a cycle (40P01, surfaced as
 * a bare 500). The route locks gang-and-player through the canonical helper
 * BEFORE the DELETE; this forces the interleaving the same way
 * gang-lock-order.test.ts does, with a third connection parking both
 * requests on the gang row in a known order.
 */

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let gangId: string;
let bossToken: string;
let bossId: string;

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer());

  // sole-admin guard needs a survivor
  const admin = await registerVerifiedPlayer({ app, redis }, { remoteAddress: "10.9.7.1" });
  void admin;
  const founder = await registerVerifiedPlayer({ app, redis }, { username: "Founder", remoteAddress: "10.9.7.1" });
  const gang = await app.inject({ method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${founder.token}` }, payload: { name: "Corleones" } });
  gangId = gang.json().id;

  const heir = await registerVerifiedPlayer({ app, redis }, { username: "Michael", password: "password123", remoteAddress: "10.9.7.1" });
  bossToken = heir.token; bossId = heir.playerId;
  await app.inject({ method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${founder.token}` }, payload: { username: "Michael" } });
  const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, bossId));
  await app.inject({ method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${bossToken}` } });
  const transfer = await app.inject({ method: "POST", url: `/api/gangs/${gangId}/transfer`, headers: { authorization: `Bearer ${founder.token}` }, payload: { playerId: bossId } });
  expect(transfer.statusCode).toBe(204);
  const [g] = await db.select({ boss: gangs.bossPlayerId }).from(gangs).where(eq(gangs.id, gangId));
  expect(g?.boss).toBe(bossId);
  await db.update(playerStats).set({ cash: 1_000n }).where(eq(playerStats.playerId, bossId));
});

afterAll(async () => { await closeServer(); await conn.end(); });

function fire(opts: InjectOptions): Promise<LightMyRequestResponse> {
  return Promise.resolve(app.inject(opts));
}

async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await conn<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if ((row?.n ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} lock waiters (saw ${row?.n ?? 0})`);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

describe("delete-account lock ordering", () => {
  it("a boss deleting their account does not deadlock against their own gang-bank deposit", async () => {
    expect(gangId < bossId).toBe(true); // the deposit locks the gang FIRST for this pair

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<LightMyRequestResponse>[] = [];
    try {
      await t0`BEGIN`;
      await t0`SELECT id FROM gangs WHERE id = ${gangId}::uuid FOR UPDATE`;

      const deposit = fire({ method: "POST", url: `/api/gangs/${gangId}/bank/deposit`, headers: { authorization: `Bearer ${bossToken}` }, payload: { amount: "100" }, remoteAddress: "10.9.7.1" });
      inFlight.push(deposit);
      await waitForLockWaiters(1);

      const del = fire({ method: "POST", url: "/api/auth/delete", headers: { authorization: `Bearer ${bossToken}` }, payload: { password: "password123" }, remoteAddress: "10.9.7.1" });
      inFlight.push(del);
      await waitForLockWaiters(2);

      await t0`COMMIT`;
      const [depositRes, delRes] = await Promise.all([deposit, del]);
      // One of them wins the row; NEITHER may be a 500. The deposit either
      // succeeds (ran first) or 401s (player gone); the delete is 204.
      expect([200, 401]).toContain(depositRes.statusCode);
      expect(delRes.statusCode).toBe(204);
    } finally {
      t0.release();
      await blocker.end();
      await Promise.allSettled(inFlight);
    }
  });
});
