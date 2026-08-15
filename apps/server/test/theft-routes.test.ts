import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { theftCars, theftGarage, theftTiers } from "./helpers/plugin-tables.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * `POST /api/theft/steal`, success path and every refusal that must NOT cost
 * the player their cooldown. The failure branches (escape and capture) live in
 * `theft-chase.test.ts`, which drives them from settings rather than luck; the
 * lock order this route depends on is proven concurrently in
 * `theft-lock-order.test.ts`.
 *
 * Every tier here is deterministic — `success_chance: 100` always steals,
 * `success_chance: 0` never does — so nothing in this file depends on a roll.
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;
let locationId: string;
let auth: { authorization: string };

// Registration is rate-limited per IP. `bootTestServer` gives this file its
// own bucket prefix, but the app is booted ONCE, so every registration inside
// it shares that bucket — a distinct remoteAddress per call keeps them apart.
let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.41.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
    payload: { username: `Thief${regCounter}`, password: "hunter2hunter2" },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** A location row, with every NOT NULL travel/bullets column filled in. */
async function seedLocation(): Promise<string> {
  const id = uuidv7();
  await db.insert(locations).values({
    id,
    name: `city-${id.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  return id;
}

/** One catalogue car worth `value`, always drawn when it is alone in a tier. */
async function seedCar(name: string, value: bigint): Promise<string> {
  const id = uuidv7();
  await db.insert(theftCars).values({ id, name, value, theftWeight: 1 });
  return id;
}

async function seedTier(
  fields: { successChance: number; maxDamage: number; minCarValue: bigint; maxCarValue: bigint },
): Promise<string> {
  const id = uuidv7();
  await db.insert(theftTiers).values({ id, name: `tier-${id.slice(-8)}`, ...fields });
  return id;
}

const steal = (tierId: unknown, bearer = token) =>
  app.inject({
    method: "POST",
    url: "/api/theft/steal",
    headers: { authorization: `Bearer ${bearer}` },
    payload: { tierId },
  });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  ({ token, playerId } = await register());
  auth = { authorization: `Bearer ${token}` };
  locationId = await seedLocation();
  await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, playerId));
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("POST /api/theft/steal", () => {
  it("parks the stolen car at the caller's current location", async () => {
    const carId = await seedCar("Sedan", 10_000n);
    const tierId = await seedTier({
      successChance: 100, maxDamage: 0, minCarValue: 1n, maxCarValue: 1_000_000n,
    });

    const res = await steal(tierId);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ outcome: "stolen", car: "Sedan", damage: 0 });

    const rows = await db.select().from(theftGarage).where(eq(theftGarage.playerId, playerId));
    expect(rows).toHaveLength(1);
    // The location the CALLER was standing in, not the car's or the tier's:
    // `garage.location_id` is where the car sits and stays.
    expect(rows[0]).toMatchObject({ carId, damage: 0, locationId });
  });

  it("claims the cooldown, so an immediate second steal is refused", async () => {
    await seedCar("Sedan", 10_000n);
    const tierId = await seedTier({
      successChance: 100, maxDamage: 0, minCarValue: 1n, maxCarValue: 1_000_000n,
    });

    expect((await steal(tierId)).statusCode).toBe(201);

    const second = await steal(tierId);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: "cooldown_active" });
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);

    // The listing route reports the same claim, without spending anything.
    const tiers = await app.inject({ method: "GET", url: "/api/theft/tiers", headers: auth });
    const row = tiers.json<{ rows: Array<{ id: string; cooldownRemaining: string }> }>()
      .rows.find((r) => r.id === tierId);
    expect(Number(row?.cooldownRemaining)).toBeGreaterThan(0);

    // Exactly one car was ever parked.
    expect(await db.select().from(theftGarage).where(eq(theftGarage.playerId, playerId)))
      .toHaveLength(1);
  });

  it("404s an unknown tier and costs the player nothing", async () => {
    await seedCar("Sedan", 10_000n);
    const tierId = await seedTier({
      successChance: 100, maxDamage: 0, minCarValue: 1n, maxCarValue: 1_000_000n,
    });

    const missing = await steal(uuidv7());
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "tier_not_found" });

    // The tier is looked up BEFORE the cooldown is claimed, so this succeeds.
    expect((await steal(tierId)).statusCode).toBe(201);
  });

  it("400s a malformed tier id instead of reaching postgres", async () => {
    await seedCar("Sedan", 10_000n);
    const tierId = await seedTier({
      successChance: 100, maxDamage: 0, minCarValue: 1n, maxCarValue: 1_000_000n,
    });

    // Without the zod body schema this uuid reaches Postgres and 500s.
    expect((await steal("not-a-uuid")).statusCode).toBe(400);

    expect((await steal(tierId)).statusCode).toBe(201);
  });

  it("409s an empty value bracket without spending the cooldown", async () => {
    await seedCar("Sedan", 10_000n);
    const emptyTier = await seedTier({
      successChance: 100, maxDamage: 0, minCarValue: 1n, maxCarValue: 100n,
    });
    const fullTier = await seedTier({
      successChance: 100, maxDamage: 0, minCarValue: 1n, maxCarValue: 1_000_000n,
    });

    const res = await steal(emptyTier);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "no_cars_in_tier" });

    // An empty catalogue is not a mistake the player made, so the cooldown is
    // never claimed — this steal is the assertion that proves it.
    expect((await steal(fullTier)).statusCode).toBe(201);
  });

  it("409s a player who is nowhere, without spending the cooldown", async () => {
    await seedCar("Sedan", 10_000n);
    const tierId = await seedTier({
      successChance: 100, maxDamage: 0, minCarValue: 1n, maxCarValue: 1_000_000n,
    });
    await db.update(playerStats).set({ locationId: null }).where(eq(playerStats.playerId, playerId));

    const res = await steal(tierId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "no_location" });

    await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, playerId));
    expect((await steal(tierId)).statusCode).toBe(201);
  });

  it("refuses a jailed caller with the loader's own 423", async () => {
    await seedCar("Sedan", 10_000n);
    const tierId = await seedTier({
      successChance: 100, maxDamage: 0, minCarValue: 1n, maxCarValue: 1_000_000n,
    });
    await db
      .update(playerStats)
      .set({ jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, playerId));

    const res = await steal(tierId);
    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ error: "jailed" });
    expect(typeof res.json().remainingSeconds).toBe("number");

    // The gate runs before the Redis claim, so nothing was spent or parked.
    expect(await db.select().from(theftGarage).where(eq(theftGarage.playerId, playerId)))
      .toHaveLength(0);
  });

  it("401s without a token", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/theft/steal", payload: { tierId: uuidv7() },
    });
    expect(res.statusCode).toBe(401);
  });
});
