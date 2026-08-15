import { GameEventSchema, type GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { theftCars, theftGarage } from "./helpers/plugin-tables.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * `GET /api/garage`, `POST /api/garage/sell` and `POST /api/garage/repair`.
 * Every case here relies on `theft.repair.cost_per_point`'s default (500),
 * so unlike `theft-chase.test.ts` nothing needs a settings-row-then-reboot —
 * `readTheftSettings` is read per request, not from a boot-time snapshot.
 */
const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
const subscriber = createSubscriber(redisUrl);

let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;
let locationId: string;
let otherLocationId: string;

let regCounter = 0;

async function register(username: string): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.43.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
    payload: { username, password: "hunter2hunter2" },
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

async function seedCar(name: string, value: bigint): Promise<string> {
  const id = uuidv7();
  await db.insert(theftCars).values({ id, name, value, theftWeight: 1 });
  return id;
}

/** A garage row parked at `atLocationId`, owned by `ownerId`. */
async function seedGarage(
  ownerId: string,
  carId: string,
  damage: number,
  atLocationId: string,
): Promise<string> {
  const id = uuidv7();
  await db.insert(theftGarage).values({ id, playerId: ownerId, carId, damage, locationId: atLocationId });
  return id;
}

const list = (bearer = token) =>
  app.inject({ method: "GET", url: "/api/garage", headers: { authorization: `Bearer ${bearer}` } });

const sell = (garageId: unknown, bearer = token) =>
  app.inject({
    method: "POST",
    url: "/api/garage/sell",
    headers: { authorization: `Bearer ${bearer}` },
    payload: { garageId },
  });

const repair = (garageId: unknown, bearer = token) =>
  app.inject({
    method: "POST",
    url: "/api/garage/repair",
    headers: { authorization: `Bearer ${bearer}` },
    payload: { garageId },
  });

const cashOf = async (id: string): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, id));
  return row?.cash ?? 0n;
};

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  ({ token, playerId } = await register(`Owner${regCounter + 1}`));
  locationId = await seedLocation();
  otherLocationId = await seedLocation();
  await db.update(playerStats)
    .set({ locationId, cash: 1_000_000n })
    .where(eq(playerStats.playerId, playerId));
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("GET /api/garage", () => {
  it("shapes a TableRowsResponse with no other top-level key", async () => {
    const carId = await seedCar("Sedan", 10_000n);
    const garageId = await seedGarage(playerId, carId, 10, locationId);

    const res = await list();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual(["rows"]);
    expect(body.rows).toHaveLength(1);

    const row = body.rows[0];
    expect(row).toMatchObject({
      id: garageId,
      carName: "Sedan",
      damage: "10",
      here: "yes",
    });
    // 10_000 * 90 / 100 = 9000; 500 * 10 = 5000 (default cost_per_point).
    expect(row.saleValue).toBe("9000");
    expect(row.repairCost).toBe("5000");
    expect(typeof row.locationName).toBe("string");
    for (const value of Object.values(row)) {
      expect(typeof value).toBe("string");
    }
  });

  it("reports here: no for a car parked elsewhere", async () => {
    const carId = await seedCar("Coupe", 5_000n);
    await seedGarage(playerId, carId, 0, otherLocationId);

    const res = await list();
    expect(res.json().rows[0]).toMatchObject({ here: "no" });
  });
});

describe("POST /api/garage/sell", () => {
  it("pays value scaled by damage, truncating toward the house", async () => {
    const carId = await seedCar("Sedan", 10_001n);
    const garageId = await seedGarage(playerId, carId, 10, locationId);
    const before = await cashOf(playerId);

    const res = await sell(garageId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ payout: "9000" });

    expect(await cashOf(playerId)).toBe(before + 9000n);

    const ledgerRows = await db.select().from(transactions)
      .where(eq(transactions.reason, "theft.sell"));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.amount).toBe(9000n);

    const remaining = await db.select().from(theftGarage).where(eq(theftGarage.id, garageId));
    expect(remaining).toHaveLength(0);
  });

  it("pays the full value for an undamaged car", async () => {
    const carId = await seedCar("Wagon", 7_500n);
    const garageId = await seedGarage(playerId, carId, 0, locationId);
    const before = await cashOf(playerId);

    const res = await sell(garageId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ payout: "7500" });
    expect(await cashOf(playerId)).toBe(before + 7500n);
  });

  it("refuses a sell from the wrong city, leaving the car and the ledger untouched", async () => {
    const carId = await seedCar("Sedan", 10_000n);
    const garageId = await seedGarage(playerId, carId, 0, otherLocationId);

    const res = await sell(garageId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "wrong_location" });

    const remaining = await db.select().from(theftGarage).where(eq(theftGarage.id, garageId));
    expect(remaining).toHaveLength(1);

    const ledgerRows = await db.select().from(transactions)
      .where(eq(transactions.reason, "theft.sell"));
    expect(ledgerRows).toHaveLength(0);
  });

  it("404s another player's car rather than 403ing", async () => {
    const { token: otherToken } = await register(`Stranger${regCounter + 1}`);
    const carId = await seedCar("Sedan", 10_000n);
    const garageId = await seedGarage(playerId, carId, 0, locationId);

    const res = await sell(garageId, otherToken);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "car_not_found" });

    const remaining = await db.select().from(theftGarage).where(eq(theftGarage.id, garageId));
    expect(remaining).toHaveLength(1);
  });

  it("publishes theft.sold with the payout as a decimal string", async () => {
    const carId = await seedCar("Sedan", 10_000n);
    const garageId = await seedGarage(playerId, carId, 0, locationId);

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, playerId);

    const res = await sell(garageId);
    expect(res.statusCode).toBe(200);

    const event: GameEvent = GameEventSchema.parse(await waiting);
    expect(event).toMatchObject({
      type: "plugin.event",
      pluginId: "theft",
      name: "sold",
      payload: { carName: "Sedan", payout: "10000" },
    });
  });
});

describe("POST /api/garage/repair", () => {
  it("restores damage to 0 and charges cost_per_point * damage", async () => {
    const carId = await seedCar("Sedan", 10_000n);
    const garageId = await seedGarage(playerId, carId, 10, locationId);
    const before = await cashOf(playerId);

    const res = await repair(garageId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cost: "5000" });

    expect(await cashOf(playerId)).toBe(before - 5000n);

    const ledgerRows = await db.select().from(transactions)
      .where(eq(transactions.reason, "theft.repair"));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.amount).toBe(-5000n);

    const [row] = await db.select().from(theftGarage).where(eq(theftGarage.id, garageId));
    expect(row?.damage).toBe(0);
  });

  it("is a no-op 204 on a pristine car, with no charge", async () => {
    const carId = await seedCar("Sedan", 10_000n);
    const garageId = await seedGarage(playerId, carId, 0, locationId);
    const before = await cashOf(playerId);

    const res = await repair(garageId);
    expect(res.statusCode).toBe(204);
    expect(await cashOf(playerId)).toBe(before);

    const ledgerRows = await db.select().from(transactions)
      .where(eq(transactions.reason, "theft.repair"));
    expect(ledgerRows).toHaveLength(0);

    const [row] = await db.select().from(theftGarage).where(eq(theftGarage.id, garageId));
    expect(row?.damage).toBe(0);
  });

  it("refuses with insufficient_funds, moving no money and no damage change", async () => {
    const carId = await seedCar("Sedan", 10_000n);
    const garageId = await seedGarage(playerId, carId, 50, locationId);
    await db.update(playerStats).set({ cash: 100n }).where(eq(playerStats.playerId, playerId));

    const res = await repair(garageId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_funds" });

    expect(await cashOf(playerId)).toBe(100n);
    const ledgerRows = await db.select().from(transactions)
      .where(eq(transactions.reason, "theft.repair"));
    expect(ledgerRows).toHaveLength(0);
    const [row] = await db.select().from(theftGarage).where(eq(theftGarage.id, garageId));
    expect(row?.damage).toBe(50);
  });

  it("refuses a repair from the wrong city", async () => {
    const carId = await seedCar("Sedan", 10_000n);
    const garageId = await seedGarage(playerId, carId, 10, otherLocationId);

    const res = await repair(garageId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "wrong_location" });

    const [row] = await db.select().from(theftGarage).where(eq(theftGarage.id, garageId));
    expect(row?.damage).toBe(10);
  });

  it("refuses a pristine car in the wrong city with wrong_location, not 204", async () => {
    const carId = await seedCar("Sedan", 10_000n);
    const garageId = await seedGarage(playerId, carId, 0, otherLocationId);

    const res = await repair(garageId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "wrong_location" });
  });

  it("404s another player's car rather than 403ing", async () => {
    const { token: otherToken } = await register(`Stranger${regCounter + 1}`);
    const carId = await seedCar("Sedan", 10_000n);
    const garageId = await seedGarage(playerId, carId, 10, locationId);

    const res = await repair(garageId, otherToken);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "car_not_found" });
  });
});
