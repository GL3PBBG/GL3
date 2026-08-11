import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { playerStats, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: `Hosp${Date.now()}`, password: "hunter2hunter2" },
  });
  ({ token, playerId } = reg.json());
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
