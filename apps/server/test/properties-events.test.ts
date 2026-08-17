import { GameEventSchema, type GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats } from "../src/db/schema/index.js";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Event envelopes for `bought`, `dropped` and `transferred` — `sold`/`income`
 * are gone (Task 5 dropped the accrual clock and its routes). Each is
 * `type: "plugin.event", pluginId: "properties"`, money crosses the wire as a
 * decimal string, and every await filters by the ACTING player's id (rule 4)
 * — for `transferred` that is the sender, even though the audience is the
 * recipient.
 */
const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
const subscriber = createSubscriber(redisUrl);

let app: Awaited<ReturnType<typeof bootTestServer>>["app"];
let closeServer: () => Promise<void>;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string; username: string }> {
  regCounter += 1;
  const username = `PropEvt${regCounter}`;
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: `10.51.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
    payload: { username, password: "hunter2hunter2" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json<{ token: string; playerId: string }>();
  return { ...body, username };
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

/** Registers a player, seeds a location under them, and buys the bullets
 * property there. Returns everything a drop/transfer test needs. */
async function setupOwnedProperty(): Promise<{
  ownerToken: string;
  ownerId: string;
  locationId: string;
  propertyId: string;
}> {
  const { token, playerId } = await register();
  const locId = await seedLocation();
  await db
    .update(playerStats)
    .set({ locationId: locId, cash: 1_000_000_000n })
    .where(eq(playerStats.playerId, playerId));

  const res = await app.inject({
    method: "POST",
    url: "/api/properties/buy",
    headers: { authorization: `Bearer ${token}` },
    payload: { pluginId: "bullets", locationId: locId },
  });
  expect(res.statusCode).toBe(200);
  const { propertyId } = res.json<{ propertyId: string }>();
  return { ownerToken: token, ownerId: playerId, locationId: locId, propertyId };
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("properties events", () => {
  it("publishes bought with typeName, locationName and price as a decimal string", async () => {
    const { token, playerId } = await register();
    const locationId = await seedLocation();
    await db
      .update(playerStats)
      .set({ locationId, cash: 1_000_000_000n })
      .where(eq(playerStats.playerId, playerId));

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, playerId);

    const res = await app.inject({
      method: "POST",
      url: "/api/properties/buy",
      headers: { authorization: `Bearer ${token}` },
      payload: { pluginId: "bullets", locationId },
    });
    expect(res.statusCode).toBe(200);

    const event: GameEvent = GameEventSchema.parse(await waiting);
    expect(event).toMatchObject({
      type: "plugin.event",
      pluginId: "properties",
      name: "bought",
      actorId: playerId,
      audience: { kind: "player", playerId },
      payload: { typeName: "Bullet Factory", locationName: expect.any(String), price: "100000000" },
    });
  });

  it("publishes dropped with typeName, locationName and the refund paid", async () => {
    const { ownerToken, ownerId, propertyId } = await setupOwnedProperty();

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, ownerId);

    const res = await app.inject({
      method: "POST",
      url: `/api/properties/${propertyId}/drop`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    // 200 with the refund, not 204: a drop pays half the declared price back.
    expect(res.statusCode).toBe(200);

    const event: GameEvent = GameEventSchema.parse(await waiting);
    expect(event).toMatchObject({
      type: "plugin.event",
      pluginId: "properties",
      name: "dropped",
      actorId: ownerId,
      audience: { kind: "player", playerId: ownerId },
      payload: {
        typeName: "Bullet Factory",
        locationName: expect.any(String),
        refund: expect.stringMatching(/^\d+$/),
      },
    });
  });

  it("publishes transferred to the recipient with typeName and locationName", async () => {
    const { ownerToken, ownerId, propertyId } = await setupOwnedProperty();
    const { playerId: targetId, username: targetUsername } = await register();

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const waiting = awaitOwnEvent(subscriber, ownerId);

    const res = await app.inject({
      method: "POST",
      url: `/api/properties/${propertyId}/transfer`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { username: targetUsername },
    });
    expect(res.statusCode).toBe(204);

    const event: GameEvent = GameEventSchema.parse(await waiting);
    expect(event).toMatchObject({
      type: "plugin.event",
      pluginId: "properties",
      name: "transferred",
      actorId: ownerId,
      audience: { kind: "player", playerId: targetId },
      payload: { typeName: "Bullet Factory", locationName: expect.any(String) },
    });
  });
});
