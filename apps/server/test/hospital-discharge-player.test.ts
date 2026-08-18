import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let townA: string;
let townB: string;

interface Player { token: string; playerId: string }

async function register(name: string): Promise<Player> {
  return registerVerifiedPlayer({ app, redis }, { username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}` });
}

async function place(p: Player, locationId: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await db.update(playerStats).set({ locationId, ...patch }).where(eq(playerStats.playerId, p.playerId));
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  townA = uuidv7();
  townB = uuidv7();
  await db.insert(locations).values([
    { id: townA, name: `Town A ${townA.slice(0, 8)}` },
    { id: townB, name: `Town B ${townB.slice(0, 8)}` },
  ]);
});
afterAll(async () => { await closeServer(); await conn.end(); });

const auth = (p: Player) => ({ authorization: `Bearer ${p.token}` });
const post = (p: Player, body: unknown) => app.inject({
  method: "POST", url: "/api/hospital/discharge-player", headers: auth(p), payload: body,
});

describe("POST /api/hospital/discharge-player", () => {
  it("pays for a local patient, heals them, and debits only the payer", async () => {
    const payer = await register("Payer");
    const patient = await register("Patient");
    await place(payer, townA);
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() + 60_000) });
    await db.transaction((tx) => applyBalanceChange(tx, {
      playerId: payer.playerId, amount: 500_000n, kind: "cash", reason: "test.seed",
    }));
    const [before] = await db.select().from(playerStats).where(eq(playerStats.playerId, patient.playerId));

    const res = await post(payer, { playerId: patient.playerId });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.freed).toBe(patient.playerId);
    expect(BigInt(body.paid)).toBeGreaterThan(0n);

    const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, patient.playerId));
    expect(target?.hospitalUntil).toBeNull();
    expect(target?.health).toBe(100);
    expect(target?.cash).toBe(before?.cash);

    const [payerRow] = await db.select().from(playerStats).where(eq(playerStats.playerId, payer.playerId));
    expect(payerRow?.cash).toBe(500_000n - BigInt(body.paid));

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, payer.playerId));
    expect(ledger.filter((t) => t.reason === "hospital.discharge")).toHaveLength(1);
    const sum = ledger.reduce((acc, t) => acc + (t.balanceKind === "cash" ? t.amount : 0n), 0n);
    expect(sum).toBe(payerRow?.cash);
  });

  it("409s a patient in another town", async () => {
    const payer = await register("Payer");
    const patient = await register("Patient");
    await place(payer, townA, { cash: 5_000_000n });
    await place(patient, townB, { health: 0, hospitalUntil: new Date(Date.now() + 60_000) });

    const res = await post(payer, { playerId: patient.playerId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "wrong_location" });
  });

  it("409s a target who is not in hospital", async () => {
    const payer = await register("Payer");
    const other = await register("Other");
    await place(payer, townA, { cash: 5_000_000n });
    await place(other, townA);

    const res = await post(payer, { playerId: other.playerId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "not_hospitalised" });
  });

  it("409s paying for yourself", async () => {
    const payer = await register("Payer");
    await place(payer, townA, { cash: 5_000_000n, health: 0, hospitalUntil: new Date(Date.now() + 60_000) });

    const res = await post(payer, { playerId: payer.playerId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "self_target" });
  });

  it("409s when the payer cannot afford it", async () => {
    const payer = await register("Payer");
    const patient = await register("Patient");
    await place(payer, townA, { cash: 1n });
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() + 600_000) });

    const res = await post(payer, { playerId: patient.playerId });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_funds" });
  });

  it("404s an unknown player and 400s a malformed body", async () => {
    const payer = await register("Payer");
    await place(payer, townA, { cash: 5_000_000n });

    expect((await post(payer, { playerId: uuidv7() })).statusCode).toBe(404);
    expect((await post(payer, { playerId: "not-a-uuid" })).statusCode).toBe(400);
    expect((await post(payer, {})).statusCode).toBe(400);
  });
});
