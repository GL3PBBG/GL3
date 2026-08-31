import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats, settings } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

/** A property row owned by `ownerId` in the owner's current town. */
async function seedOwnedProperty(ownerId: string): Promise<string> {
  const [stats] = await db.select({ locationId: playerStats.locationId })
    .from(playerStats).where(eq(playerStats.playerId, ownerId));
  let locationId = stats?.locationId ?? null;
  if (locationId === null) {
    const [loc] = await db.select({ id: locations.id }).from(locations).limit(1);
    locationId = loc?.id ?? null;
    if (locationId === null) {
      // resetDb wiped the boot seeds; one town is all this route needs.
      locationId = uuidv7();
      await db.insert(locations).values({ id: locationId, name: "Testville" });
    }
    await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, ownerId));
  }
  const id = uuidv7();
  await db.execute(sql`
    insert into p_properties_properties (id, location_id, plugin_id, owner_player_id, cost, profit)
    values (${id}, ${locationId}, 'blackjack', ${ownerId}, 0, 0)`);
  return id;
}

async function seedPackage(): Promise<string> {
  const id = uuidv7();
  await db.execute(sql`
    insert into p_membership_packages (id, name, cost_points, duration_seconds)
    values (${id}, 'Test VIP', 10, 86400)`);
  return id;
}

function transfer(token: string, propertyId: string, username: string): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  return app.inject({
    method: "POST", url: `/api/properties/${propertyId}/transfer`,
    headers: { authorization: `Bearer ${token}` }, payload: { username },
  });
}

describe("same-IP handover block (anti-bot layer 3)", () => {
  it("properties transfer 409s same_ip_blocked between accounts sharing an address", async () => {
    const a = await registerVerifiedPlayer({ app, redis }, { username: "AltOne", remoteAddress: "203.0.113.9" });
    const b = await registerVerifiedPlayer({ app, redis }, { username: "AltTwo", remoteAddress: "203.0.113.9" });
    const propertyId = await seedOwnedProperty(a.playerId);

    const res = await transfer(a.token, propertyId, b.username);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "same_ip_blocked" });
  });

  it("properties transfer between distinct addresses goes through", async () => {
    const a = await registerVerifiedPlayer({ app, redis }, { username: "Honest", remoteAddress: "203.0.113.9" });
    const b = await registerVerifiedPlayer({ app, redis }, { username: "Friend", remoteAddress: "198.51.100.7" });
    const propertyId = await seedOwnedProperty(a.playerId);

    const res = await transfer(a.token, propertyId, b.username);
    expect(res.statusCode).toBe(204);
  });

  it("the properties setting turns the block off", async () => {
    await db.insert(settings).values({ key: "properties.block_same_ip_transfer", value: "false" });
    const a = await registerVerifiedPlayer({ app, redis }, { username: "HouseA", remoteAddress: "203.0.113.9" });
    const b = await registerVerifiedPlayer({ app, redis }, { username: "HouseB", remoteAddress: "203.0.113.9" });
    const propertyId = await seedOwnedProperty(a.playerId);

    const res = await transfer(a.token, propertyId, b.username);
    expect(res.statusCode).toBe(204);
  });

  it("membership gift 409s same_ip_blocked before any points move", async () => {
    const a = await registerVerifiedPlayer({ app, redis }, { username: "GiftA", remoteAddress: "203.0.113.9" });
    const b = await registerVerifiedPlayer({ app, redis }, { username: "GiftB", remoteAddress: "203.0.113.9" });
    void b;
    // Seeded directly: resetDb wipes the plugin's boot seeds, and a missing
    // package would 404 before the pair check and mask the result.
    const pkgId = await seedPackage();
    const res = await app.inject({
      method: "POST", url: "/api/membership/gift",
      headers: { authorization: `Bearer ${a.token}` },
      payload: { packageId: pkgId, recipientName: "GiftB" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "same_ip_blocked" });
  });

  it("membership gift between distinct addresses is not the gate's business", async () => {
    const a = await registerVerifiedPlayer({ app, redis }, { username: "FairA", remoteAddress: "203.0.113.9" });
    await registerVerifiedPlayer({ app, redis }, { username: "FairB", remoteAddress: "198.51.100.7" });
    const pkgId = await seedPackage();
    const res = await app.inject({
      method: "POST", url: "/api/membership/gift",
      headers: { authorization: `Bearer ${a.token}` },
      payload: { packageId: pkgId, recipientName: "FairB" },
    });
    // A broke gifter 409s insufficient_points — fine; only the same-IP code is wrong here.
    expect((res.json() as { error?: string }).error).not.toBe("same_ip_blocked");
  });
});
