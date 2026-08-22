import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { playerStats, settings, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: `Hosp${Date.now()}` }));
});
afterAll(async () => { await closeServer(); await conn.end(); });

describe("hospital routes", () => {
  it("reports a free player", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/hospital",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hospitalised: false, until: null, remainingSeconds: 0 });
  });

  it("409s a discharge for a player who is not hospitalised", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/hospital/discharge",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_hospitalised" });
  });

  it("quotes a discharge cost proportional to the remaining sentence", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 100_000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "GET", url: "/api/hospital",
      headers: { authorization: `Bearer ${token}` },
    });

    const body = res.json();
    expect(body.hospitalised).toBe(true);
    // 100s remaining × the default 1000/second, allowing one second of drift.
    expect(BigInt(body.dischargeCost)).toBeGreaterThanOrEqual(99_000n);
    expect(BigInt(body.dischargeCost)).toBeLessThanOrEqual(100_000n);
  });

  it("discharges for cash, restores health, and ledgers the payment", async () => {
    const { db } = await testDb();
    // Seed the starting cash through the ledger (not a raw `db.update`, unlike
    // this file's other tests) because this is the only place in the suite
    // that proves sum(ledger) == balance for the discharge path:
    // economy-invariant.test.ts never boots a server, so it can't drive a
    // core HTTP route, and discharge is core, not a plugin. A raw cash write
    // here would make that invariant unprovable rather than merely untested.
    await db.transaction((tx) => applyBalanceChange(tx, {
      playerId, amount: 500_000n, kind: "cash", reason: "test.seed",
    }));
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 60_000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: "/api/hospital/discharge",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.health).toBe(100);

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.hospitalUntil).toBeNull();
    expect(row?.health).toBe(100);
    expect(row?.cash).toBeLessThan(500_000n);

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    expect(ledger.some((t) => t.reason === "hospital.discharge")).toBe(true);
    // sum(ledger) == balance, the invariant every money path must hold.
    const sum = ledger.reduce((acc, t) => acc + (t.balanceKind === "cash" ? t.amount : 0n), 0n);
    expect(sum).toBe(row?.cash);
  });

  it("409s when the player cannot afford the discharge", async () => {
    const { db } = await testDb();
    await db.update(playerStats)
      .set({ cash: 1n, hospitalUntil: new Date(Date.now() + 600_000), health: 0 })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: "/api/hospital/discharge",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_funds" });
  });
});

/**
 * Every other test in this file runs with the setting ABSENT, so none of them
 * reach a fallback branch. These do: each boots its own app against a row that
 * is present but unusable, and asserts the DEFAULT cost is quoted.
 *
 * The blank case is the one that actually shipped broken — `BigInt("")`
 * returns 0n rather than throwing, so it slipped past the try/catch and made
 * discharge free. The other two prove the branches that were merely assumed
 * to work.
 */
describe.each([
  { label: "blank", value: "" },
  { label: "non-numeric", value: "abc" },
  { label: "negative", value: "-5" },
])("unusable hospital.discharge_cost_per_second ($label)", ({ value }) => {
  it("quotes the default cost rather than parsing the setting", async () => {
    // Settings are read once at boot (loadSettings' own doc comment), so this
    // needs a fresh app built AFTER the row lands — the shared `app` from
    // beforeEach already booted against an empty settings table.
    await db.insert(settings).values({ key: "hospital.discharge_cost_per_second", value });

    const { buildApp } = await import("../src/app.js");
    const { loadConfig } = await import("../src/config.js");
    const { createRedis } = await import("../src/redis.js");
    const { loadPlugins } = await import("../src/plugins/loader.js");
    const { withCorePlugins } = await import("../src/plugins/core-plugins.js");
    const { loadSettings } = await import("../src/settings/load.js");

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const redis = createRedis(config.redisUrl);
    // uuid TAIL, not head: a uuidv7's leading bytes are a millisecond
    // timestamp and collide for rows created within the same ~65s.
    const suffix = uuidv7().slice(-12);
    const leaderboardPrefix = `hospital-fallback-${suffix}`;
    const loaded = await loadPlugins(
      { db, redis, settings: await loadSettings(db), leaderboardPrefix },
      withCorePlugins([]),
      `plugin-hospital-fallback-${suffix}-`,
    );
    const freshApp = await buildApp(config, { db, redis, leaderboardPrefix, plugins: loaded });

    try {
      const { token: freshToken, playerId: freshPlayerId } = await registerVerifiedPlayer(
        { app: freshApp, redis }, { username: `HospFb${suffix}` },
      );

      await db.update(playerStats)
        .set({ hospitalUntil: new Date(Date.now() + 100_000), health: 0 })
        .where(eq(playerStats.playerId, freshPlayerId));

      const res = await freshApp.inject({
        method: "GET", url: "/api/hospital",
        headers: { authorization: `Bearer ${freshToken}` },
      });

      const body = res.json();
      expect(body.hospitalised).toBe(true);
      // 100s remaining × the default 1000/second. A bare `BigInt("")` would
      // yield 0 here, and an honoured "-5" would yield a negative. Same
      // one-second-drift allowance as the non-blank quote test above.
      expect(BigInt(body.dischargeCost)).toBeGreaterThanOrEqual(99_000n);
      expect(BigInt(body.dischargeCost)).toBeLessThanOrEqual(100_000n);
    } finally {
      await freshApp.close();
      for (const w of loaded.workers) await w.close();
      for (const q of loaded.queues.values()) await q.close();
      redis.disconnect();
    }
  });
});

/**
 * Wealth-scaled discharge, mirroring the bail block in jail-bail-bust.test.ts:
 * the fee rises toward 1% (default) of the payer's cash + bank, floored at the
 * flat fee. A ~100s stay puts the flat fee at ≤ 100k, so the 500k scaled
 * expectations are drift-proof — the sentence can lose a second boundary
 * without moving the answer.
 */
describe("hospital routes — wealth scaling", () => {
  it("quotes and charges a rich patient above the flat fee", async () => {
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 100_000), health: 0, cash: 50_000_000n })
      .where(eq(playerStats.playerId, playerId));

    const quote = await app.inject({
      method: "GET", url: "/api/hospital",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(quote.json().dischargeCost).toBe("500000"); // 1% of 50M

    const res = await app.inject({
      method: "POST", url: "/api/hospital/discharge",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().paid).toBe("500000");
    expect(res.json().cash).toBe("49500000");
  });

  it("counts the patient's bank in the scaling but debits cash only", async () => {
    await db.update(playerStats)
      .set({ hospitalUntil: new Date(Date.now() + 100_000), health: 0, cash: 600_000n, bank: 49_400_000n })
      .where(eq(playerStats.playerId, playerId));

    const res = await app.inject({
      method: "POST", url: "/api/hospital/discharge",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().paid).toBe("500000");
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.cash).toBe(100_000n);
    expect(row?.bank).toBe(49_400_000n);
  });

  it("collapses to the flat fee when the percent is 0 — the rollback knob", async () => {
    await db.insert(settings).values({ key: "hospital.discharge_wealth_percent", value: "0" });
    const own = await bootTestServer();
    try {
      const { token: flatToken, playerId: flatId } = await registerVerifiedPlayer(
        { app: own.app, redis: own.redis }, { username: `HospFlat${uuidv7().slice(-8)}` },
      );
      await db.update(playerStats)
        .set({ hospitalUntil: new Date(Date.now() + 100_000), health: 0, cash: 50_000_000n })
        .where(eq(playerStats.playerId, flatId));

      const res = await own.app.inject({
        method: "POST", url: "/api/hospital/discharge",
        headers: { authorization: `Bearer ${flatToken}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const paid = BigInt(res.json().paid);
      expect(paid).toBeGreaterThanOrEqual(99_000n);
      expect(paid).toBeLessThanOrEqual(100_000n);
    } finally {
      await own.close();
    }
  });
});
