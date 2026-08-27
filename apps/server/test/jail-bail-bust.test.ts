// Every boot here pins { profile: "v2" }: this file tests the attribute
// family's OPT-IN property (baselines without a pool, or a custom test
// pool plugin that would collide with the gl3 union's mccodes-attributes).
// The suite's default boot is the gl3 union — see helpers/server.ts.
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
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { definePlugin, type PluginManifest } from "@gl3/plugin-sdk";

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
  return registerVerifiedPlayer({ app: target, redis }, { username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}` });
}

async function place(p: Player, locationId: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await db.update(playerStats).set({ locationId, ...patch }).where(eq(playerStats.playerId, p.playerId));
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer({ profile: "v2" }));
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
    // race the subscription (NOTES.md rule 4: filter by the TARGET's own
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
 * Wealth-scaled bail: the fee rises toward `jail.bail_wealth_percent` (1% by
 * default) of the PAYER's cash + bank, floored at the flat fee and capped at
 * `jail.bail_wealth_cap_multiplier` (10×) the flat fee. Every case below
 * seeds a ~100s sentence, so the flat fee is ≤ 100k and second-boundary drift
 * cannot move an expected value: the scaled amounts (500k, 1M) sit above the
 * flat fee's whole drift band, below or at the cap.
 */
describe("POST /api/jail/bail — wealth scaling", () => {
  const sentence = () => new Date(Date.now() + 100_000);

  it("charges a rich payer above the flat fee", async () => {
    const payer = await register("Rich");
    const inmate = await register("Inmate");
    await place(payer, townA, { cash: 50_000_000n });
    await place(inmate, townA, { jailedUntil: sentence() });

    const res = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer),
      payload: { playerId: inmate.playerId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().paid).toBe("500000"); // 1% of 50M, above the ≤100k floor

    const [payerRow] = await db.select().from(playerStats).where(eq(playerStats.playerId, payer.playerId));
    expect(payerRow?.cash).toBe(49_500_000n);
  });

  it("caps the fee at 10× the flat fee for extreme wealth", async () => {
    const payer = await register("Whale");
    const inmate = await register("Inmate");
    await place(payer, townA, { cash: 5_000_000_000n });
    await place(inmate, townA, { jailedUntil: sentence() });

    const res = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer),
      payload: { playerId: inmate.playerId },
    });
    // 1% of 5B is 50M, but the cap is flat(≤100k) × 10 = ≤1M — and above the
    // 500k crossing point the cap is exactly 1M however many seconds remain.
    expect(res.json().paid).toBe("1000000");
  });

  it("counts the payer's bank — depositing is not a bail shelter", async () => {
    const payer = await register("Split");
    const inmate = await register("Inmate");
    await place(payer, townA, { cash: 600_000n, bank: 49_400_000n });
    await place(inmate, townA, { jailedUntil: sentence() });

    const res = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer),
      payload: { playerId: inmate.playerId },
    });
    expect(res.json().paid).toBe("500000"); // 1% of 50M cash+bank
    const [payerRow] = await db.select().from(playerStats).where(eq(playerStats.playerId, payer.playerId));
    // Debited from cash only — the bank balance is untouched, existing behavior.
    expect(payerRow?.cash).toBe(100_000n);
    expect(payerRow?.bank).toBe(49_400_000n);
  });

  it("409s a bank-rich, cash-poor payer — the debit stays cash-only", async () => {
    const payer = await register("Vault");
    const inmate = await register("Inmate");
    await place(payer, townA, { cash: 100_000n, bank: 50_000_000n });
    await place(inmate, townA, { jailedUntil: sentence() });

    const res = await app.inject({
      method: "POST", url: "/api/jail/bail", headers: auth(payer),
      payload: { playerId: inmate.playerId },
    });
    expect(res.json()).toMatchObject({ error: "insufficient_funds" });
  });

  it("prices the roster per viewer: two callers see different bailCosts", async () => {
    const poor = await register("Poor");
    const rich = await register("Rich");
    const inmate = await register("Inmate");
    await place(poor, townA, { cash: 10_000n });
    await place(rich, townA, { cash: 50_000_000n });
    await place(inmate, townA, { jailedUntil: sentence() });

    const asPoor = await app.inject({ method: "GET", url: "/api/jail/local", headers: auth(poor) });
    const asRich = await app.inject({ method: "GET", url: "/api/jail/local", headers: auth(rich) });
    expect(asPoor.statusCode).toBe(200);
    expect(asRich.statusCode).toBe(200);

    const costFor = (res: typeof asPoor): bigint =>
      BigInt(res.json().inmates.find((i: { playerId: string }) => i.playerId === inmate.playerId).bailCost);
    // Poor: 1% of 10k is 100, below the flat fee — the floor, exactly the
    // pre-scaling price. Rich: 1% of 50M, drift-proof as above.
    expect(costFor(asPoor)).toBeLessThanOrEqual(100_000n);
    expect(costFor(asRich)).toBe(500_000n);
  });

  it("collapses to the flat fee when the percent is 0 — the rollback knob", async () => {
    const own = await bootWith({ "jail.bail_wealth_percent": "0" });
    try {
      const payer = await registerOn(own.app, "RichFlat");
      const inmate = await registerOn(own.app, "InmateFlat");
      await place(payer, townA, { cash: 50_000_000n });
      await place(inmate, townA, { jailedUntil: sentence() });

      const res = await own.app.inject({
        method: "POST", url: "/api/jail/bail",
        headers: { authorization: `Bearer ${payer.token}` },
        payload: { playerId: inmate.playerId },
      });
      // 100s × 1000/sec, one second of drift either way.
      const paid = BigInt(res.json().paid);
      expect(paid).toBeGreaterThanOrEqual(99_000n);
      expect(paid).toBeLessThanOrEqual(100_000n);
    } finally {
      await own.close();
    }
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
  return bootTestServer({ profile: "v2" });
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
      // Audit §7 item 4: a successful bust grants the BUSTER level×5
      // crime_exp (level 1 here) — the counter's jail-side producer, riding
      // the same transaction as the release.
      expect(caller?.crimeExp).toBe(5n);

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

describe("POST /api/jail/bust — the 10-energy attempt charge (audit §7 item 12)", () => {
  /** Declares energy so the charge has a pool; registration seeds 12/12. */
  const declaresEnergy: PluginManifest = definePlugin({
    id: "bustenergy", version: "1.0.0", basePaths: ["/api/bustenergy"],
    providesAttributes: [
      { pool: "energy", defaultMax: 12, regenAmount: 1, regenIntervalSeconds: 60 },
    ],
  });

  it("charges 10 energy on both outcomes", async () => {
    const own = await bootTestServer({ profile: "v2", plugins: [declaresEnergy] });
    try {
      const buster = await registerOn(own.app, "ChargedBuster");
      const inmate = await registerOn(own.app, "ChargedInmate");
      await place(buster, townA);
      await place(inmate, townA, { jailedUntil: new Date(Date.now() + 300_000) });

      const res = await own.app.inject({
        method: "POST", url: "/api/jail/bust", headers: auth(buster),
        payload: { playerId: inmate.playerId },
      });
      expect(res.statusCode).toBe(200);

      // Registration seeded 12/12; whichever way the roll went, 10 is gone.
      const [caller] = await db.select().from(playerStats).where(eq(playerStats.playerId, buster.playerId));
      expect(caller?.energy).toBe(2);
    } finally {
      await own.close();
    }
  });

  it("409s without moving anything when energy cannot cover the charge", async () => {
    const own = await bootTestServer({ profile: "v2", plugins: [declaresEnergy] });
    try {
      const buster = await registerOn(own.app, "BrokeBuster");
      const inmate = await registerOn(own.app, "StillInmate");
      await place(buster, townA, { energy: 9 });
      const inmateUntil = new Date(Date.now() + 300_000);
      await place(inmate, townA, { jailedUntil: inmateUntil });

      const res = await own.app.inject({
        method: "POST", url: "/api/jail/bust", headers: auth(buster),
        payload: { playerId: inmate.playerId },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("insufficient_energy");

      const [caller] = await db.select().from(playerStats).where(eq(playerStats.playerId, buster.playerId));
      expect(caller?.energy).toBe(9);
      expect(caller?.jailedUntil).toBeNull();
      const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, inmate.playerId));
      expect(target?.jailedUntil?.getTime()).toBe(inmateUntil.getTime());
    } finally {
      await own.close();
    }
  });

  it("stays free on a default boot — no pool declared, byte-identical", async () => {
    const own = await bootTestServer({ profile: "v2" });
    try {
      const buster = await registerOn(own.app, "FreeBuster");
      const inmate = await registerOn(own.app, "FreeInmate");
      await place(buster, townA);
      await place(inmate, townA, { jailedUntil: new Date(Date.now() + 300_000) });

      const res = await own.app.inject({
        method: "POST", url: "/api/jail/bust", headers: auth(buster),
        payload: { playerId: inmate.playerId },
      });
      expect(res.statusCode).toBe(200);

      const [caller] = await db.select().from(playerStats).where(eq(playerStats.playerId, buster.playerId));
      expect(caller?.energy).toBe(0);
    } finally {
      await own.close();
    }
  });
});
