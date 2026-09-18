import { definePlugin, SINGLETON_ENTITY_ID } from "@gl3/plugin-sdk";
import { DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_SPAWN, RoomDescriptorSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FilesystemDriver } from "../src/assets/fs-driver.js";
import { bindAsset, resolveSingletonAsset, storeAsset } from "../src/assets/service.js";
import { locations, locationScenes, playerStats } from "../src/db/schema/index.js";
import { seedLocations } from "../src/db/seed.js";
import { makePng } from "./helpers/assets.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

const stub = { kind: "list" as const, items: [] };
const fixture = definePlugin({
  id: "worldfix", version: "1.0.0", apiVersion: 1, basePaths: ["/api/worldfix"],
  pages: [{ id: "worldfix.index", path: "/worldfix", view: stub }, { id: "worldfix.other", path: "/worldfix/other", view: stub }],
  providesAssets: [{ slot: "sign", label: "Sign", singleton: true }],
  worldHooks: [
    { id: "hall", kind: "building", label: "Hall", page: "worldfix.index", model: "office", order: 1, signageSlot: "sign", footprint: { w: 12, d: 9 } },
    { id: "tout", kind: "npc", label: "Tout", page: "worldfix.other", model: "npc-suit", order: 2 },
  ],
});

let app: FastifyInstance;
let redis: Redis;
let assetDriver: FilesystemDriver;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  // v2 profile: withCorePlugins merges the fixture with the core set, and the
  // v2 set is smaller, so the fixture's hooks are easy to find among them.
  ({ app, close: closeServer, redis, assetDriver } = await bootTestServer({ plugins: [fixture], profile: "v2" }));
});
beforeEach(async () => { await resetDb(db); await seedLocations(db); });
afterAll(async () => { await closeServer(); await conn.end(); });

const townId = async (name: string): Promise<string> => {
  const [row] = await db.select({ id: locations.id }).from(locations).where(eq(locations.name, name));
  return row!.id;
};
const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("GET /api/world/scene", () => {
  it("404s no_location for a player who is nowhere", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await get("/api/world/scene", token);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no_location" });
  });

  it("serves the caller's town with defaults and the fixture hooks placed", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const chicago = await townId("Chicago");
    await db.update(playerStats).set({ locationId: chicago }).where(eq(playerStats.playerId, playerId));

    const res = await get("/api/world/scene", token);
    expect(res.statusCode).toBe(200);
    const room = RoomDescriptorSchema.parse(res.json());
    expect(room).toMatchObject({ locationId: chicago, locationName: "Chicago", combatMode: "open", sceneKey: "default" });
    expect(room.bounds).toEqual(DEFAULT_SCENE_BOUNDS);
    expect(room.spawn).toEqual(DEFAULT_SCENE_SPAWN);

    const hall = room.hooks.find((h) => h.id === "worldfix.hall");
    const tout = room.hooks.find((h) => h.id === "worldfix.tout");
    expect(hall).toMatchObject({ pluginId: "worldfix", hookId: "hall", kind: "building", href: "/plugins/worldfix.index", signageUrl: null, footprint: { w: 12, d: 9 } });
    expect(tout).toMatchObject({ kind: "npc", href: "/plugins/worldfix.other", position: { x: hall!.position.x, y: expect.any(Number) } });
    expect(Math.abs(tout!.position.y)).toBe(7.5);
  });

  it("serves the bound signage image for the hook that declares a slot", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const chicago = await townId("Chicago");
    await db.update(playerStats).set({ locationId: chicago }).where(eq(playerStats.playerId, playerId));

    // Through the real asset service, so a wrong scope or slot name fails here
    // rather than passing on a null the unbound case would also produce.
    const stored = await storeAsset(db, assetDriver, {
      bytes: makePng(16, 16), declaredMime: "image/png", uploadedBy: null,
      maxBytes: 524_288, maxDimension: 2048,
    });
    await bindAsset(db, {
      scope: "worldfix", entityId: SINGLETON_ENTITY_ID, slot: "sign", assetId: stored.id,
    });
    const expected = await resolveSingletonAsset(db, assetDriver, "worldfix", "sign");
    expect(expected).not.toBeNull();

    const room = RoomDescriptorSchema.parse((await get("/api/world/scene", token)).json());
    expect(room.hooks.find((h) => h.id === "worldfix.hall")?.signageUrl).toBe(expected);
    // The NPC declares no signageSlot, so it stays null even now one is bound.
    expect(room.hooks.find((h) => h.id === "worldfix.tout")?.signageUrl).toBeNull();
  });

  it("reads a location_scenes row when one exists", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const miami = await townId("Miami");
    await db.update(playerStats).set({ locationId: miami }).where(eq(playerStats.playerId, playerId));
    await db.insert(locationScenes).values({
      locationId: miami, sceneKey: "beach", bounds: { minX: -10, minY: -10, maxX: 30, maxY: 10 }, spawn: { x: 5, y: -8, facing: 1 },
    });
    const room = RoomDescriptorSchema.parse((await get("/api/world/scene", token)).json());
    expect(room.sceneKey).toBe("beach");
    expect(room.spawn).toEqual({ x: 5, y: -8, facing: 1 });
    // Placement starts from THIS room's bounds, not the defaults.
    const first = room.hooks.find((h) => h.kind === "building")!;
    expect(first.position.x).toBe(-10 + 4 + first.footprint.w / 2);
  });

  it("serves any town by id, 404s an unknown one, and 401s without auth", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const ny = await townId("New York");
    expect((await get(`/api/world/scene/${ny}`, token)).statusCode).toBe(200);
    const missing = await get("/api/world/scene/0192a1b2-0000-7000-8000-00000000dead", token);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "unknown_location" });
    expect((await get("/api/world/scene/not-a-uuid", token)).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/world/scene/${ny}` })).statusCode).toBe(401);
  });
});

describe("worldHooks boot validation", () => {
  it("refuses a hook whose page belongs to another plugin", async () => {
    const bad = definePlugin({
      id: "worldbad", version: "1.0.0", apiVersion: 1, basePaths: ["/api/worldbad"],
      worldHooks: [{ id: "door", kind: "building", label: "Door", page: "worldfix.index", model: "office", order: 1 }],
    });
    await expect(bootTestServer({ plugins: [fixture, bad], profile: "v2" })).rejects.toThrow(/world hook "door" opens page "worldfix.index"/);
  });

  it("refuses a plugin claiming /api/world", async () => {
    const squatter = definePlugin({ id: "squat", version: "1.0.0", apiVersion: 1, basePaths: ["/api/world/x"] });
    await expect(bootTestServer({ plugins: [squatter], profile: "v2" })).rejects.toThrow(/reserved to core/);
  });
});

describe("PoC hooks on the gl3 profile", () => {
  let gl3App: FastifyInstance; let gl3Redis: Redis; let closeGl3: () => Promise<void>;
  beforeAll(async () => { ({ app: gl3App, redis: gl3Redis, close: closeGl3 } = await bootTestServer()); });
  afterAll(async () => { await closeGl3(); });

  it("places travel's station, crimes' corner and bank's bank, each opening its own page", async () => {
    await seedLocations(db);
    const { token, playerId } = await registerVerifiedPlayer({ app: gl3App, redis: gl3Redis });
    const ny = await townId("New York");
    await db.update(playerStats).set({ locationId: ny }).where(eq(playerStats.playerId, playerId));
    const res = await gl3App.inject({ method: "GET", url: "/api/world/scene", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const room = RoomDescriptorSchema.parse(res.json());
    const byId = new Map(room.hooks.map((h) => [h.id, h]));
    expect(byId.get("travel.station")).toMatchObject({ kind: "building", model: "station", href: "/plugins/travel.index", footprint: { w: 12, d: 9 } });
    expect(byId.get("crimes.corner")).toMatchObject({ kind: "npc", model: "npc-coat", href: "/plugins/crimes.index" });
    expect(byId.get("bank.bank")).toMatchObject({ kind: "building", model: "bank", href: "/plugins/bank.index", footprint: { w: 12, d: 9 } });
    // Order along the street is the declared order: station (10), corner (20), bank (30).
    expect(room.hooks.map((h) => h.id).filter((id) => byId.has(id)).slice(0, 3)).toEqual(["travel.station", "crimes.corner", "bank.bank"]);
    // Nobody stands inside a building: the spawn lot is clear.
    for (const h of room.hooks.filter((h) => h.kind === "building")) {
      const inside = Math.abs(room.spawn.x - h.position.x) < h.footprint.w / 2 && Math.abs(room.spawn.y - h.position.y) < h.footprint.d / 2;
      expect(inside, h.id).toBe(false);
    }
  });
});
