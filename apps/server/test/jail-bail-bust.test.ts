import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let townA: string;
let townB: string;

interface Player { token: string; playerId: string }

async function register(name: string): Promise<Player> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}`, password: "hunter2hunter2" },
  });
  const body = res.json();
  return { token: body.token, playerId: body.playerId };
}

async function place(p: Player, locationId: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await db.update(playerStats).set({ locationId, ...patch }).where(eq(playerStats.playerId, p.playerId));
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  townA = uuidv7();
  townB = uuidv7();
  await db.insert(locations).values([
    { id: townA, name: `Town A ${townA.slice(0, 8)}` },
    { id: townB, name: `Town B ${townB.slice(0, 8)}` },
  ]);
});
afterAll(async () => { await closeServer(); await conn.end(); });

const auth = (p: Player) => ({ authorization: `Bearer ${p.token}` });

describe("POST /api/jail/bail", () => {
  it("frees a local inmate and charges the payer", async () => {
    const payer = await register("Payer");
    const inmate = await register("Inmate");
    await place(payer, townA);
    await place(inmate, townA, { jailedUntil: new Date(Date.now() + 60_000) });
    await db.transaction((tx) => applyBalanceChange(tx, {
      playerId: payer.playerId, amount: 500_000n, kind: "cash", reason: "test.seed",
    }));

    const res = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer),
      payload: { playerId: inmate.playerId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.freed).toBe(inmate.playerId);

    const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, inmate.playerId));
    expect(target?.jailedUntil).toBeNull();

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, payer.playerId));
    expect(ledger.filter((t) => t.reason === "jail.bail")).toHaveLength(1);
  });

  it("409s an inmate in another town, a free player, and yourself", async () => {
    const payer = await register("Payer");
    const far = await register("Far");
    const free = await register("Free");
    await place(payer, townA, { cash: 5_000_000n, jailedUntil: new Date(Date.now() + 60_000) });
    await place(far, townB, { jailedUntil: new Date(Date.now() + 60_000) });
    await place(free, townA);

    const bail = (targetId: string) => app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer), payload: { playerId: targetId },
    });

    expect((await bail(far.playerId)).json()).toMatchObject({ error: "wrong_location" });
    expect((await bail(free.playerId)).json()).toMatchObject({ error: "not_jailed" });
    expect((await bail(payer.playerId)).json()).toMatchObject({ error: "self_target" });
  });

  it("409s when the payer cannot afford it and 400s a malformed body", async () => {
    const payer = await register("Payer");
    const inmate = await register("Inmate");
    await place(payer, townA, { cash: 1n });
    await place(inmate, townA, { jailedUntil: new Date(Date.now() + 600_000) });

    const res = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer),
      payload: { playerId: inmate.playerId },
    });
    expect(res.json()).toMatchObject({ error: "insufficient_funds" });

    const bad = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer), payload: { playerId: "nope" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
