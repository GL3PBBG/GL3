import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GameEventSchema } from "@gl3/shared";
import { coreHospitalStay, definePlugin, on, type HospitalStayBatch } from "@gl3/plugin-sdk";
import { priceQuote, type BulletPriceQuote } from "@gl3/plugin-bullets";
import { exposure, type ExposureQuote } from "@gl3/plugin-combat";
import { jailOdds, type JailOdds } from "@gl3/plugin-crimes";
import { hireQuote, type HireQuote } from "@gl3/plugin-detectives";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { crimes, items, locations, playerItems, players, playerStats } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The five extension points the territory plugin (a registry package, not in
 * this tree) consumes: `bullets.priceQuote`, `detectives.hireQuote`,
 * `core.hospitalStay`, `crimes.jailOdds` and `combat.exposure`. One spy
 * plugin subscribes to all five; module-level knobs decide what it answers.
 * Every applier must clamp what it is handed, so the out-of-range cases are
 * asserted here rather than trusted to a well-behaved subscriber.
 */
const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let me: { id: string; token: string; username: string };

const knobs = {
  bulletBp: 0,
  hireBp: 0,
  stayBp: 0,
  jailExtra: 0,
  exposed: [] as string[],
  explode: false,
};

const spy = definePlugin({
  id: "territory-spy",
  version: "1.0.0",
  basePaths: ["/api/territory-spy"],
  filters: [
    on(priceQuote, (_ctx, q: BulletPriceQuote) => {
      if (knobs.explode) throw new Error("boom");
      return { ...q, discountBp: knobs.bulletBp };
    }),
    on(hireQuote, (_ctx, q: HireQuote) => ({ ...q, discountBp: knobs.hireBp })),
    on(coreHospitalStay, (_ctx, b: HospitalStayBatch) => ({
      entries: b.entries.map((e) => ({ ...e, discountBp: knobs.stayBp })),
    })),
    on(jailOdds, (_ctx, o: JailOdds) => ({ ...o, extraPercent: knobs.jailExtra })),
    on(exposure, (_ctx, q: ExposureQuote) => ({ ...q, exposed: [...q.exposed, ...knobs.exposed] })),
  ],
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function town(mode: "open" | "underground" = "open"): Promise<string> {
  const id = uuidv7();
  await db.insert(locations).values({
    id, name: `loc-${id.slice(-8)}`, travelCost: 0n, travelCooldownSeconds: 60,
    bulletStock: 1_000, bulletCost: 100n, combatMode: mode,
  });
  return id;
}

async function stranger(locationId: string): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username: `s-${id.slice(-8)}` });
  await db.insert(playerStats).values({ playerId: id, locationId });
  return id;
}

async function fighters(locationId: string, ...ids: string[]): Promise<void> {
  await db.update(playerStats)
    .set({ locationId, exp: 100_000n, level: 100, bullets: 1_000n, health: 100, gangId: null, jailedUntil: null, hospitalUntil: null })
    .where(inArray(playerStats.playerId, ids));
}

async function executioner(playerId: string): Promise<void> {
  const id = uuidv7();
  await db.insert(items).values({
    id, name: `w-${id.slice(-8)}`, itemType: "weapon",
    effects: { backfireChance: 0, accuracy: 100, damageMin: 500, damageMax: 500 },
  });
  await db.insert(playerItems).values({ playerId, itemId: id, qty: 1 });
  await db.update(playerStats).set({ weaponItemId: id }).where(eq(playerStats.playerId, playerId));
}

async function stats(playerId: string) {
  const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
  if (row === undefined) throw new Error("player_stats missing");
  return row;
}

beforeEach(async () => {
  await resetDb(db);
  Object.assign(knobs, { bulletBp: 0, hireBp: 0, stayBp: 0, jailExtra: 0, exposed: [], explode: false });
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer({ plugins: [spy] }));
  const r = await registerVerifiedPlayer({ app, redis }, { username: `t-${uuidv7().slice(-8)}` });
  me = { id: r.playerId, token: r.token, username: r.username };
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  subscriber.disconnect();
});

describe("bullets.priceQuote", () => {
  it("discounts the shop quote and the charged price alike; out-of-range bp is clamped", async () => {
    const loc = await town();
    await db.update(playerStats).set({ locationId: loc, cash: 100_000n }).where(eq(playerStats.playerId, me.id));

    knobs.bulletBp = 1_500;
    const shop = await app.inject({ method: "GET", url: "/api/bullets/shop", headers: auth(me.token) });
    expect(shop.json().unitCost).toBe("85");
    const buy = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth(me.token), payload: { quantity: 10 } });
    expect(buy.statusCode).toBe(200);
    expect((await stats(me.id)).cash).toBe(100_000n - 850n);

    knobs.bulletBp = -5_000; // a crediting subscriber is ignored
    expect((await app.inject({ method: "GET", url: "/api/bullets/shop", headers: auth(me.token) })).json().unitCost).toBe("100");
    knobs.bulletBp = 99_999; // more than everything is everything
    expect((await app.inject({ method: "GET", url: "/api/bullets/shop", headers: auth(me.token) })).json().unitCost).toBe("0");
  });

  it("a throwing subscriber costs its discount, not the sale (collect policy)", async () => {
    const loc = await town();
    await db.update(playerStats).set({ locationId: loc, cash: 100_000n }).where(eq(playerStats.playerId, me.id));
    knobs.bulletBp = 1_500;
    knobs.explode = true;
    const shop = await app.inject({ method: "GET", url: "/api/bullets/shop", headers: auth(me.token) });
    expect(shop.statusCode).toBe(200);
    expect(shop.json().unitCost).toBe("100");
  });
});

describe("detectives.hireQuote", () => {
  it("discounts the unit cost on hire and on the listing preview", async () => {
    await db.update(playerStats).set({ cash: 10_000_000n }).where(eq(playerStats.playerId, me.id));
    const loc = await town();
    const target = await stranger(loc);
    const [t] = await db.select({ username: players.username }).from(players).where(eq(players.id, target));

    knobs.hireBp = 2_000;
    const list = await app.inject({ method: "GET", url: "/api/detectives", headers: auth(me.token) });
    // 125,000 flat, wealth-scaled to 1% of 10M = 100,000 → floored at the flat 125,000; then −20%.
    expect(list.json().cost).toBe("100000");
    const hire = await app.inject({
      method: "POST", url: "/api/detectives", headers: auth(me.token),
      payload: { targetUsername: t?.username, detectives: 2, hours: 3 },
    });
    expect(hire.statusCode).toBe(201);
    expect(hire.json().cash).toBe(String(10_000_000 - 100_000 * 6));
  });
});

describe("core.hospitalStay", () => {
  it("shortens a voluntary check-in by the quoted basis points", async () => {
    await db.update(playerStats).set({ health: 60 }).where(eq(playerStats.playerId, me.id)); // 40 × 30s = 1200s
    knobs.stayBp = 2_500;
    const res = await app.inject({ method: "POST", url: "/api/hospital/checkin", headers: auth(me.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().remainingSeconds).toBeGreaterThan(890);
    expect(res.json().remainingSeconds).toBeLessThanOrEqual(900);
  });

  it("shortens the stay a kill hands the victim, never below one second", async () => {
    const loc = await town();
    const victim = await stranger(loc);
    await fighters(loc, me.id, victim);
    await executioner(me.id);
    knobs.stayBp = 2_500; // default combat hospital_seconds 600 → 450
    const before = Date.now();
    const res = await app.inject({ method: "POST", url: `/api/combat/attack/${victim}`, headers: auth(me.token) });
    expect(res.json().targetKilled).toBe(true);
    const until = (await stats(victim)).hospitalUntil?.getTime() ?? 0;
    expect(until - before).toBeGreaterThan(440_000);
    expect(until - before).toBeLessThanOrEqual(451_000);

    await redis.del(cooldownKey(me.id, "combat.attack"));
    const victim2 = await stranger(loc);
    await fighters(loc, victim2);
    knobs.stayBp = 10_000;
    const start = Date.now();
    await app.inject({ method: "POST", url: `/api/combat/attack/${victim2}`, headers: auth(me.token) });
    const until2 = (await stats(victim2)).hospitalUntil?.getTime() ?? 0;
    expect(until2).toBeGreaterThanOrEqual(start); // 1 second, not zero, not null
    expect(until2 - start).toBeLessThanOrEqual(2_000);
  });
});

describe("crimes.jailOdds", () => {
  async function commitAndWait(crimeId: string): Promise<{ success: boolean }> {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const seen: { type: string; success?: boolean }[] = [];
    const onMessage = (channel: string, raw: string): void => {
      if (channel !== GAME_EVENTS_CHANNEL) return;
      const parsed = GameEventSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.actorId === me.id) seen.push(parsed.data as { type: string; success?: boolean });
    };
    subscriber.on("message", onMessage);
    const res = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth(me.token) });
    expect(res.statusCode).toBe(202);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !seen.some((e) => e.type === "crime.resolved")) {
      await new Promise((r) => setTimeout(r, 100));
    }
    subscriber.off("message", onMessage);
    const resolved = seen.find((e) => e.type === "crime.resolved");
    if (resolved === undefined) throw new Error("crime never resolved");
    return { success: resolved.success === true };
  }

  async function hopelessCrime(): Promise<string> {
    const id = uuidv7();
    // Formula `0`: always fails. jail_chance_percent 0: never jails on its own.
    await db.insert(crimes).values({
      id, name: `hopeless-${id.slice(-6)}`, description: "", cooldownSeconds: 1, minPayout: 1n, maxPayout: 1n,
      minBullets: 0, maxBullets: 0, expReward: 0n, jailChancePercent: 0, jailSeconds: 120, sort: 1,
      crimeExpReward: 0n, successFormula: "0",
    });
    return id;
  }

  it("a subscriber's extra percent jails where the crime's own odds never would", async () => {
    const crimeId = await hopelessCrime();
    knobs.jailExtra = 100;
    const out = await commitAndWait(crimeId);
    expect(out.success).toBe(false);
    expect((await stats(me.id)).jailedUntil).not.toBeNull();
  });

  it("zero extra leaves a zero-odds crime unjailed", async () => {
    const crimeId = await hopelessCrime();
    knobs.jailExtra = 0;
    await commitAndWait(crimeId);
    expect((await stats(me.id)).jailedUntil).toBeNull();
  });
});

describe("combat.exposure", () => {
  it("an exposed target in an underground town is listed and attackable without a report", async () => {
    const loc = await town("underground");
    const hidden = await stranger(loc);
    const exposed = await stranger(loc);
    await fighters(loc, me.id, hidden, exposed);
    await executioner(me.id);

    let targets = await app.inject({ method: "GET", url: "/api/combat/targets", headers: auth(me.token) });
    expect(targets.json().mode).toBe("underground");
    expect(targets.json().targets).toEqual([]);

    knobs.exposed = [exposed];
    targets = await app.inject({ method: "GET", url: "/api/combat/targets", headers: auth(me.token) });
    expect(targets.json().targets.map((t: { playerId: string }) => t.playerId)).toEqual([exposed]);

    const refused = await app.inject({ method: "POST", url: `/api/combat/attack/${hidden}`, headers: auth(me.token) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("no_detective_report");

    await redis.del(cooldownKey(me.id, "combat.attack"));
    const shot = await app.inject({ method: "POST", url: `/api/combat/attack/${exposed}`, headers: auth(me.token) });
    expect(shot.statusCode).toBe(200);
    expect(shot.json().targetKilled).toBe(true);
  });
});
