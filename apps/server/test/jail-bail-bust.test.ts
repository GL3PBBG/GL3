import { GameEventSchema, type GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, notifications, playerStats, settings as settingsTable, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
const subscriber = createSubscriber(redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let townA: string;
let townB: string;

interface Player { token: string; playerId: string; username: string }

async function register(name: string): Promise<Player> {
  return registerOn(app, name);
}

/**
 * Identical body to `register`, but takes the Fastify instance explicitly —
 * `POST /api/jail/bust`'s branch-dependent tests each boot their own app
 * against a seeded settings row and need to register players on THAT app,
 * not the shared `app` from `beforeEach`.
 */
async function registerOn(target: FastifyInstance, name: string): Promise<Player> {
  const res = await target.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}`, password: "hunter2hunter2" },
  });
  const body = res.json();
  return { token: body.token, playerId: body.playerId, username: body.username };
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
afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

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
    const [before] = await db.select().from(playerStats).where(eq(playerStats.playerId, inmate.playerId));

    // Subscribed BEFORE the request, so the publish that follows commit can't
    // race the subscription (CLAUDE.md rule 4: filter by the TARGET's own
    // actorId — `game:events` is a single channel shared by every test file).
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, inmate.playerId);

    const res = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer),
      payload: { playerId: inmate.playerId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.freed).toBe(inmate.playerId);

    const event: GameEvent = GameEventSchema.parse(await waiting);
    expect(event).toMatchObject({ type: "player.released", actorId: inmate.playerId });

    const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, inmate.playerId));
    expect(target?.jailedUntil).toBeNull();
    expect(target?.cash).toBe(before?.cash);

    const [payerRow] = await db.select().from(playerStats).where(eq(playerStats.playerId, payer.playerId));
    expect(payerRow?.cash).toBe(500_000n - BigInt(body.paid));

    const ledger = await db.select().from(transactions).where(eq(transactions.playerId, payer.playerId));
    expect(ledger.filter((t) => t.reason === "jail.bail")).toHaveLength(1);
    const sum = ledger.reduce((acc, t) => acc + (t.balanceKind === "cash" ? t.amount : 0n), 0n);
    expect(sum).toBe(payerRow?.cash);

    const notified = await db.select().from(notifications).where(eq(notifications.playerId, inmate.playerId));
    expect(notified).toHaveLength(1);
    expect(notified[0]?.body).toBe(`${payer.username} paid your bail.`);
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

/**
 * `jail.bust_success_percent` is read once at boot, so each branch gets its
 * own app. 100 and 0 make the outcome independent of the draw — the roll
 * itself is unit-tested in facility-settings.test.ts.
 */
async function bootWith(rows: Record<string, string>): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  await db.insert(settingsTable)
    .values(Object.entries(rows).map(([key, value]) => ({ key, value })));
  return bootTestServer();
}

describe("POST /api/jail/bust", () => {
  it("frees the target and leaves the caller free when the roll always wins", async () => {
    const own = await bootWith({ "jail.bust_success_percent": "100" });
    try {
      const buster = await registerOn(own.app, "Buster");
      const inmate = await registerOn(own.app, "Inmate");
      await place(buster, townA);
      await place(inmate, townA, { jailedUntil: new Date(Date.now() + 300_000) });

      const res = await own.app.inject({
        method: "POST", url: "/api/jail/bust", headers: auth(buster),
        payload: { playerId: inmate.playerId },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true, jailedUntil: null });

      const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, inmate.playerId));
      expect(target?.jailedUntil).toBeNull();
      const [caller] = await db.select().from(playerStats).where(eq(playerStats.playerId, buster.playerId));
      expect(caller?.jailedUntil).toBeNull();

      // Busting is free on both branches — a successful bust moves no money.
      const ledger = await db.select().from(transactions).where(eq(transactions.playerId, buster.playerId));
      expect(ledger).toHaveLength(0);
    } finally {
      await own.close();
    }
  });

  it("jails the caller and leaves the target in when the roll always loses", async () => {
    const own = await bootWith({ "jail.bust_success_percent": "0", "jail.bust_fail_jail_seconds": "120" });
    try {
      const buster = await registerOn(own.app, "Buster");
      const inmate = await registerOn(own.app, "Inmate");
      await place(buster, townA);
      const inmateUntil = new Date(Date.now() + 300_000);
      await place(inmate, townA, { jailedUntil: inmateUntil });

      const res = await own.app.inject({
        method: "POST", url: "/api/jail/bust", headers: auth(buster),
        payload: { playerId: inmate.playerId },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);

      const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, inmate.playerId));
      expect(target?.jailedUntil?.getTime()).toBe(inmateUntil.getTime());

      const [caller] = await db.select().from(playerStats).where(eq(playerStats.playerId, buster.playerId));
      const callerSeconds = Math.round(((caller?.jailedUntil?.getTime() ?? 0) - Date.now()) / 1000);
      expect(callerSeconds).toBeGreaterThan(110);
      expect(callerSeconds).toBeLessThanOrEqual(120);

      // A failed bust is free too — the caller's own jail time is the whole cost.
      const ledger = await db.select().from(transactions).where(eq(transactions.playerId, buster.playerId));
      expect(ledger).toHaveLength(0);
    } finally {
      await own.close();
    }
  });

  it("refuses a jailed caller, another town, a free target, and yourself", async () => {
    const jailed = await register("Jailed");
    const inmate = await register("Inmate");
    const far = await register("Far");
    const free = await register("Free");
    await place(jailed, townA, { jailedUntil: new Date(Date.now() + 300_000) });
    await place(inmate, townA, { jailedUntil: new Date(Date.now() + 300_000) });
    await place(far, townB, { jailedUntil: new Date(Date.now() + 300_000) });
    await place(free, townA);

    const bust = (caller: Player, targetId: string) => app.inject({
      method: "POST", url: "/api/jail/bust", headers: auth(caller), payload: { playerId: targetId },
    });

    // A prisoner cannot bust anyone.
    expect((await bust(jailed, inmate.playerId)).json()).toMatchObject({ error: "already_jailed" });

    const freeCaller = await register("FreeCaller");
    await place(freeCaller, townA);
    expect((await bust(freeCaller, far.playerId)).json()).toMatchObject({ error: "wrong_location" });
    expect((await bust(freeCaller, free.playerId)).json()).toMatchObject({ error: "not_jailed" });
    expect((await bust(freeCaller, freeCaller.playerId)).json()).toMatchObject({ error: "self_target" });
  });
});
