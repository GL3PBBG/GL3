import { eq, or } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Redis } from "ioredis";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { faroPlugin } from "./helpers/faro.js";
import { casinoSessions, propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Concurrency net for the casino pair-lock: casino-lock-order.test.ts's ABBA
 * race (A plays at B's table while B plays at A's), 400 rounds per run from
 * one barrier, ~16s. Born as the repro harness for the once-per-suite 40P01
 * flake (2026-08-29 hunt: ~47,000 races across quiet, checkpoint-storm and
 * dual-suite-load conditions, zero reproductions — the two-transaction race
 * is safe in isolation; see the recent-statement ring dump in db/client.ts +
 * plugins/routes.ts for what captures the next natural occurrence). Kept in
 * the suite because 400 contended races per run is the densest exercise the
 * sorted pair-lock gets anywhere. Sessions are deleted between rounds
 * (FARO's `start` never settles) and the symmetric wagers net each round's
 * cash movement to zero.
 */

const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

const WAGER = "100000";
const HOUSE_CASH = 10_000_000n;

let regCounter = 0;
async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `Stress${regCounter}`,
    remoteAddress: `10.63.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
}

async function seedLocation(): Promise<string> {
  const id = uuidv7();
  await db.insert(locations).values({
    id, name: `city-${id.slice(-8)}`, travelCost: 0n, travelCooldownSeconds: 60,
    bulletStock: 0, bulletCost: 1n,
  });
  return id;
}

async function seedHouse(locationId: string, ownerId: string): Promise<void> {
  await db.insert(propertiesTable).values({
    id: uuidv7(), locationId, pluginId: "faro", ownerPlayerId: ownerId, cost: 0n, profit: 0n,
  });
}

const play = (token: string): InjectOptions => ({
  method: "POST",
  url: "/api/casino/play",
  headers: { authorization: `Bearer ${token}` },
  payload: { gameId: "faro", wager: WAGER },
});

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
    if ((row?.n ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for lock waiters");
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer({ plugins: [faroPlugin] }));
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("casino ABBA stress", () => {
  it("survives 400 rounds of A-plays-at-B's-table racing B-plays-at-A's-table", async () => {
    const a = await register();
    const b = await register();
    const locA = await seedLocation();
    const locB = await seedLocation();
    await seedHouse(locA, a.playerId);
    await seedHouse(locB, b.playerId);
    await db.update(playerStats)
      .set({ locationId: locB, cash: HOUSE_CASH, jailedUntil: null, hospitalUntil: null })
      .where(eq(playerStats.playerId, a.playerId));
    await db.update(playerStats)
      .set({ locationId: locA, cash: HOUSE_CASH, jailedUntil: null, hospitalUntil: null })
      .where(eq(playerStats.playerId, b.playerId));

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    try {
      for (let round = 0; round < 400; round += 1) {
        const t0 = await blocker.reserve();
        let aRes: LightMyRequestResponse;
        let bRes: LightMyRequestResponse;
        try {
          await t0`BEGIN`;
          await t0`
            SELECT player_id FROM player_stats
            WHERE player_id IN (${a.playerId}::uuid, ${b.playerId}::uuid)
            ORDER BY player_id FOR UPDATE
          `;
          const pa = fire(play(a.token));
          const pb = fire(play(b.token));
          await waitForLockWaiters(2);
          await t0`ROLLBACK`;
          [aRes, bRes] = await Promise.all([pa, pb]);
        } finally {
          try { await t0`ROLLBACK`; } catch { /* already rolled back */ }
          t0.release();
        }

        expect(aRes.statusCode, `round ${round} A body: ${aRes.body}`).not.toBe(500);
        expect(bRes.statusCode, `round ${round} B body: ${bRes.body}`).not.toBe(500);

        // Close the round: FARO's start never settles, so drop the open
        // sessions directly. The symmetric wagers netted the cash to zero.
        await db.delete(casinoSessions).where(
          or(eq(casinoSessions.playerId, a.playerId), eq(casinoSessions.playerId, b.playerId)),
        );
      }
    } finally {
      await blocker.end();
    }
  }, 600_000);
});
