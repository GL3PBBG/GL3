import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * POST /api/properties/buy, plus the four owner-gated propertyManagement
 * routes: /:id/lever, /:id/transfer, /:id/drop, /:id/reset.
 *
 * Buy moved off the id-in-path shape (Task 5 deleted sell/claim; this task
 * replaces buy itself, the last route still id-in-path): it now takes
 * {pluginId, locationId} in the body and charges whatever the consumer
 * plugin's `providesProperties` declares (bullets: $1,000,000, i.e.
 * 100,000,000 cents) rather than a price stored on the row. The row is
 * created lazily on first purchase, as V2 did.
 *
 * lever/transfer/drop/reset are V2's `propertyManagement` methods: set the
 * local price/limit the property's consumer reads, hand the property to
 * another player, walk away with no refund, zero the lifetime P&L counter.
 *
 * This describe block is ONE continuous story, not independent cases: the
 * buy test creates the property that lever/transfer/drop/reset then act on
 * in turn, so there is no per-test resetDb — only the beforeAll below.
 */
const { db, sql: conn } = testDb();

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

let playerId: string;
let playerHeaders: { authorization: string };
let playerUsername: string;
let startingCash: bigint;

let otherPlayerId: string;
let otherPlayerHeaders: { authorization: string };
let otherUsername: string;

let brokeHeaders: { authorization: string };

let locationId: string;
let otherLocationId: string;
let freshLocationId: string;

let propertyId: string;

let regCounter = 0;

async function register(): Promise<{ token: string; playerId: string; username: string }> {
  regCounter += 1;
  return registerVerifiedPlayer({ app, redis }, {
    username: `PropOwner${regCounter}`,
    remoteAddress: `10.50.${(regCounter >> 8) & 0xff}.${regCounter & 0xff}`,
  });
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

const cashOf = async (id: string): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, id));
  return row?.cash ?? 0n;
};

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer());

  const owner = await register();
  playerId = owner.playerId;
  playerHeaders = { authorization: `Bearer ${owner.token}` };
  playerUsername = owner.username;

  const other = await register();
  otherPlayerId = other.playerId;
  otherPlayerHeaders = { authorization: `Bearer ${other.token}` };
  otherUsername = other.username;

  const broke = await register();
  brokeHeaders = { authorization: `Bearer ${broke.token}` };

  locationId = await seedLocation();
  otherLocationId = await seedLocation();
  freshLocationId = await seedLocation();

  // Ten times bullets' declared $1,000,000 price: enough to survive both the
  // create buy and the already-owned re-attempt below, whose affordability
  // check the buy route runs BEFORE its ownership check.
  startingCash = 1_000_000_000n;
  await db.update(playerStats).set({ locationId, cash: startingCash }).where(eq(playerStats.playerId, playerId));
  await db
    .update(playerStats)
    .set({ locationId, cash: startingCash })
    .where(eq(playerStats.playerId, otherPlayerId));
  await db
    .update(playerStats)
    .set({ locationId: freshLocationId, cash: 0n })
    .where(eq(playerStats.playerId, broke.playerId));
});

afterAll(async () => {
  await closeServer?.();
  await conn.end();
});

describe("properties routes", () => {
  it("buys an undeclared type with a 404", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: playerHeaders,
      payload: { pluginId: "nope", locationId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("unknown_property_type");
  });

  it("refuses to buy in a location the player is not in", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: playerHeaders,
      payload: { pluginId: "bullets", locationId: otherLocationId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("wrong_location");
  });

  // Fix 2 of the final review pass: the row is created lazily on first
  // purchase (buyRoute's own doc comment), but listRoute used to select
  // `from(propertiesTable)` and return only rows that already exist — so a
  // franchise nobody had bought yet had no list entry and no Buy button,
  // unreachable from the UI on a fresh install. Placed here, before the
  // first buy below, specifically so no real property row exists yet: this
  // is the "table ships empty" case the synthesis exists for.
  it("synthesizes a buyable row for every declared type at the caller's own location only", async () => {
    const res = await app.inject({ method: "GET", url: "/api/properties", headers: playerHeaders });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ rows: { pluginId: string; locationId: string; ownerName: string; price: string }[] }>().rows;

    // bullets is the only declared type in this boot, and three locations were
    // seeded in beforeAll — but the list is the current town's board, so only
    // the (bullets, here) pair is synthesized, not one per location.
    const bulletsRows = rows.filter((r) => r.pluginId === "bullets");
    expect(bulletsRows.map((r) => r.locationId)).toEqual([locationId]);
    for (const row of bulletsRows) {
      expect(row.ownerName).toBe("—");
      expect(row.price).toBe("100000000");
    }
  });

  // The bug this replaced: listRoute selected every row in the table and
  // synthesized one per (type × EVERY location), so the page was a world
  // board. Red against the pre-fix handler, which returned all three towns.
  it("lists no row for a location the caller is not in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/properties", headers: playerHeaders });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ rows: { locationId: string }[] }>().rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.locationId === locationId)).toBe(true);
  });

  it("creates the row on first purchase and charges the declared price", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: playerHeaders,
      payload: { pluginId: "bullets", locationId },
    });
    expect(res.statusCode).toBe(200);
    ({ propertyId } = res.json<{ propertyId: string }>());
    expect(propertyId).toBeTruthy();
    expect(await cashOf(playerId)).toBe(startingCash - 100_000_000n);
  });

  // The assertion that actually matters: once a real row exists for a
  // (location, type) pair, the synthesis in listRoute must not ALSO emit a
  // synthetic row alongside it — this fails if the `covered` dedupe key
  // (`${locationId}:${pluginId}`) does not match the real row's own
  // location/plugin, e.g. from a typo or a stale key shape.
  it("lists the now-owned property exactly once, not duplicated by the synthesis", async () => {
    const res = await app.inject({ method: "GET", url: "/api/properties", headers: playerHeaders });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ rows: { pluginId: string; locationId: string; ownerName: string }[] }>().rows;
    const matches = rows.filter((r) => r.pluginId === "bullets" && r.locationId === locationId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.ownerName).toBe(playerUsername);
  });

  it("refuses a second buy of the same type in the same town", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: playerHeaders,
      payload: { pluginId: "bullets", locationId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("already_owned");
  });

  it("refuses a buy the player cannot afford", async () => {
    // broke player, fresh location
    const res = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: brokeHeaders,
      payload: { pluginId: "bullets", locationId: freshLocationId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("insufficient_funds");
  });

  it("sets the lever, refusing anything under the floor", async () => {
    const low = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/lever`, headers: playerHeaders,
      payload: { value: "9999" },
    });
    expect(low.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/lever`, headers: playerHeaders,
      payload: { value: "12345" },
    });
    expect(ok.statusCode).toBe(204);
  });

  it("refuses a lever change by a non-owner with 404", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/lever`, headers: otherPlayerHeaders,
      payload: { value: "12345" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("not_owned");
  });

  it("404s a lever change on a property id that doesn't exist at all", async () => {
    // loadOwnedRow's OTHER 404 branch — no such row, distinct from "not
    // yours" above. Same status and error shape for both (404-not-403, so a
    // property's existence is not probeable), but a different code path.
    const res = await app.inject({
      method: "POST", url: `/api/properties/${uuidv7()}/lever`, headers: playerHeaders,
      payload: { value: "12345" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("property_not_found");
  });

  it("transfers to another player and zeroes the lever", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/transfer`, headers: playerHeaders,
      payload: { username: otherUsername },
    });
    expect(res.statusCode).toBe(204);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.ownerPlayerId).toBe(otherPlayerId);
    expect(row!.cost).toBe(0n); // V2 zeroes PR_cost on handover
  });

  it("refuses transferring a property to yourself with 409", async () => {
    // otherPlayerId owns propertyId at this point in the story (previous
    // test). own-transfer target resolution runs BEFORE loadOwnedRow now
    // (Fix round 1: folding the target into loadOwnedRow's one player-lock
    // call), so this exercises that early check specifically.
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/transfer`, headers: otherPlayerHeaders,
      payload: { username: otherUsername },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("cannot_transfer_to_self");
    // No side effect: still owned by the same player.
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.ownerPlayerId).toBe(otherPlayerId);
  });

  it("transfers to an unknown player with 404", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/transfer`, headers: otherPlayerHeaders,
      payload: { username: "nobody" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("player_not_found");
  });

  // V2's drop is a DELETE with no refund. GL3 pays half the declared price
  // back instead, so a franchise is a partial sink rather than a total loss —
  // the price here is 100_000_000n, so the refund is 50_000_000n exactly.
  it("drops a property and refunds half its declared price", async () => {
    const before = await cashOf(otherPlayerId);
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/drop`, headers: otherPlayerHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ refund: string }>().refund).toBe("50000000");
    expect(await cashOf(otherPlayerId)).toBe(before + 50_000_000n);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.ownerPlayerId).toBeNull();
    expect(row!.cost).toBe(0n);
  });

  it("resets profit to zero without moving money", async () => {
    // The row is unowned after the drop above; re-buy it so the original
    // player owns it again before exercising reset.
    const rebuy = await app.inject({
      method: "POST", url: "/api/properties/buy", headers: playerHeaders,
      payload: { pluginId: "bullets", locationId },
    });
    expect(rebuy.statusCode).toBe(200);

    // Seed a nonzero profit by hand: no consumer plugin calls payOwner yet
    // (bullets becomes a consumer in Task 9), so this is the only way to
    // prove reset actually zeroes it rather than finding it already zero.
    await db.update(propertiesTable).set({ profit: 250_000n }).where(eq(propertiesTable.id, propertyId));

    // re-bought and paid first by the enclosing setup
    const before = await cashOf(playerId);
    const res = await app.inject({
      method: "POST", url: `/api/properties/${propertyId}/reset`, headers: playerHeaders,
    });
    expect(res.statusCode).toBe(204);
    expect(await cashOf(playerId)).toBe(before);
    const [row] = await db.select().from(propertiesTable).where(eq(propertiesTable.id, propertyId));
    expect(row!.profit).toBe(0n);
  });
});
