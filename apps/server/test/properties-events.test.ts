import { GameEventSchema, type GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import { locations, playerStats } from "../src/db/schema/index.js";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { propertiesPlugin } from "./helpers/plugin-tables.js";
import { bootTestServer } from "./helpers/server.js";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Asserts the event envelope for `bought`, the only event left after Task 5
 * dropped sell/claim (and with them, `sold`/`income`). It is published with
 * audience: { kind: "player", playerId } and matches `type: "plugin.event",
 * pluginId: "properties"`. Money is a decimal string.
 */
const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
const subscriber = createSubscriber(redisUrl);

let app: Awaited<ReturnType<typeof bootTestServer>>["app"];
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;
let locationId: string;
let auth: { authorization: string };

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.51.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
    payload: { username: `PropEvt${regCounter}`, password: "hunter2hunter2" },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

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

async function seedProperty(
  locId: string,
  fields: {
    cost?: bigint;
    ownerPlayerId?: string | null;
    profit?: bigint;
  },
): Promise<string> {
  const id = uuidv7();
  await db.insert(propertiesPlugin).values({
    id,
    locationId: locId,
    pluginId: "properties",
    cost: fields.cost ?? 10_000n,
    ownerPlayerId: fields.ownerPlayerId ?? null,
    profit: fields.profit ?? 0n,
  });
  return id;
}

const buy = (propId: unknown, bearer = token) =>
  app.inject({
    method: "POST",
    url: `/api/properties/${propId}/buy`,
    headers: { authorization: `Bearer ${bearer}` },
  });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  ({ token, playerId } = await register());
  auth = { authorization: `Bearer ${token}` };
  locationId = await seedLocation();
  await db
    .update(playerStats)
    .set({ locationId, cash: 1_000_000n })
    .where(eq(playerStats.playerId, playerId));
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("properties events", () => {
  it("publishes bought with propertyName and cost as decimal strings", async () => {
    const propId = await seedProperty(locationId, { cost: 50_000n });

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, playerId);

    const res = await buy(propId);
    expect(res.statusCode).toBe(200);

    const event: GameEvent = GameEventSchema.parse(await waiting);
    expect(event).toMatchObject({
      type: "plugin.event",
      pluginId: "properties",
      name: "bought",
      actorId: playerId,
      audience: { kind: "player", playerId },
      payload: { propertyName: expect.any(String), cost: "50000" },
    });
  });
});
