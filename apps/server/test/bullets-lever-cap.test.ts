import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locations, playerStats, settings } from "../src/db/schema/index.js";
import { eq } from "drizzle-orm";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The set-side half of V2's `maxBulletCost`: an owner may not price their
 * bullet factory above the admin's cap. Enforced through the SDK filter
 * system, because `POST /api/properties/:id/lever` is a generic properties
 * route that knows nothing about bullets.
 *
 * Driven through the real HTTP route, not `callPluginRoute`: the helper passes
 * only the called plugin's OWN filters into the ctx, so a cross-plugin
 * subscription would silently never run and the test would prove nothing.
 */
const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

/** Above `LEVER_FLOOR` (10_000n) so a rejection can only be the cap. */
const cap = 15_000n;

let regCounter = 0;
async function register(): Promise<{ token: string; playerId: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `Lever${regCounter}${Date.now()}`,
    remoteAddress: `10.79.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
}

/**
 * A fresh location per property: `p_properties_properties` is unique on
 * `(location_id, plugin_id)`, so two "bullets" factories in one town cannot
 * coexist and reusing a location would fail the insert rather than the cap.
 */
async function ownedProperty(pluginId: string): Promise<{ id: string; headers: { authorization: string } }> {
  const owner = await register();
  const townId = uuidv7();
  await db.insert(locations).values({
    id: townId, name: `Capville-${townId.slice(-8)}`, bulletStock: 0, bulletCost: 5n,
  });
  await db.update(playerStats).set({ locationId: townId }).where(eq(playerStats.playerId, owner.playerId));
  const id = uuidv7();
  await db.insert(propertiesTable).values({
    id, locationId: townId, pluginId, ownerPlayerId: owner.playerId, cost: 0n, profit: 0n,
  });
  return { id, headers: { authorization: `Bearer ${owner.token}` } };
}

const setLever = (id: string, headers: { authorization: string }, value: bigint) =>
  app.inject({ method: "POST", url: `/api/properties/${id}/lever`, headers, payload: { value: value.toString() } });

beforeAll(async () => {
  await resetDb(db);
  // Settings are a boot-time snapshot, so the cap must be in the table before
  // buildApp runs.
  await db.insert(settings).values({ key: "bullets.max_cost", value: cap.toString() });
  ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("the bullets max_cost cap on a factory owner's lever", () => {
  it("refuses a lever above the cap", async () => {
    const { id, headers } = await ownedProperty("bullets");

    const res = await setLever(id, headers, cap + 1n);

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("lever_above_cap");
  });

  it("allows a lever exactly at the cap", async () => {
    const { id, headers } = await ownedProperty("bullets");

    expect((await setLever(id, headers, cap)).statusCode).toBe(204);
  });

  it("leaves another plugin's property type alone", async () => {
    // The subscriber runs on every lever set in the game; it must only judge
    // its own type.
    const { id, headers } = await ownedProperty("blackjack");

    expect((await setLever(id, headers, cap * 10n)).statusCode).toBe(204);
  });
});
