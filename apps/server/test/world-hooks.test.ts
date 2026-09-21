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
import { seedVenues } from "./helpers/venues.js";

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
beforeEach(async () => { await resetDb(db); await seedLocations(db); await seedVenues(db); });
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
    // Served bounds contain the layout (2026-09-21): y is never widened, x
    // never shrinks, and x widens at least as far as the layout demands.
    expect(room.bounds.minY).toBe(DEFAULT_SCENE_BOUNDS.minY);
    expect(room.bounds.maxY).toBe(DEFAULT_SCENE_BOUNDS.maxY);
    expect(room.bounds.minX).toBeLessThanOrEqual(DEFAULT_SCENE_BOUNDS.minX);
    const buildingEdges = room.hooks.filter((h) => h.kind === "building").map((h) => h.position.x + h.footprint.w / 2);
    expect(room.bounds.maxX).toBeGreaterThanOrEqual(Math.max(...buildingEdges) + 4);
    const coreJail = room.hooks.find((h) => h.id === "core.jail")!;
    expect(room.bounds.maxX).toBeGreaterThanOrEqual(coreJail.yard!.x + 3 + 4);
    expect(room.spawn).toEqual(DEFAULT_SCENE_SPAWN);

    const hall = room.hooks.find((h) => h.id === "worldfix.hall");
    const tout = room.hooks.find((h) => h.id === "worldfix.tout");
    expect(hall).toMatchObject({ pluginId: "worldfix", hookId: "hall", kind: "building", href: "/plugins/worldfix.index", signageUrl: null, footprint: { w: 12, d: 9 } });
    expect(tout).toMatchObject({ kind: "npc", href: "/plugins/worldfix.other", position: { x: hall!.position.x, y: expect.any(Number) } });
    expect(Math.abs(tout!.position.y)).toBe(7.5);
  });

  it("appends core.jail then core.hospital after every plugin hook", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const chicago = await townId("Chicago");
    await db.update(playerStats).set({ locationId: chicago }).where(eq(playerStats.playerId, playerId));

    const room = RoomDescriptorSchema.parse((await get("/api/world/scene", token)).json());
    expect(room.hooks.map((h) => h.id).slice(-2)).toEqual(["core.jail", "core.hospital"]);
    const jail = room.hooks.at(-2)!;
    const hospital = room.hooks.at(-1)!;
    expect(jail).toMatchObject({
      pluginId: "core", hookId: "jail", kind: "building", label: "Jail", model: "jail",
      footprint: { w: 12, d: 9 }, facing: Math.PI, href: "/plugins/jail", signageUrl: null,
    });
    expect(jail.position.y).toBe(15);
    expect(jail.yard).toEqual({ x: jail.position.x + 9, y: 15 });
    expect(hospital).toMatchObject({
      pluginId: "core", hookId: "hospital", kind: "building", label: "Hospital", model: "hospital",
      footprint: { w: 12, d: 9 }, facing: 0, href: "/plugins/hospital", signageUrl: null,
    });
    expect(hospital.position.y).toBe(-15);
    expect(hospital.yard).toEqual({ x: hospital.position.x + 9, y: -15 });

    // The yard is core-only: no plugin hook carries one.
    for (const h of room.hooks.filter((h) => h.pluginId !== "core")) expect(h.yard).toBeUndefined();

    // And neither core building stands inside a plugin building on its side.
    for (const core of [jail, hospital]) {
      for (const h of room.hooks.filter((h) => h.kind === "building" && h.pluginId !== "core" && Math.sign(h.position.y) === Math.sign(core.position.y))) {
        const overlaps = Math.abs(h.position.x - core.position.x) < h.footprint.w / 2 + core.footprint.w / 2;
        expect(overlaps, `${h.id} vs ${core.id}`).toBe(false);
      }
    }
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
    // Served bounds contain this row's own layout — never the defaults —
    // and y is this row's own, untouched by widening.
    expect(room.bounds.maxX).toBeGreaterThanOrEqual(30);
    expect(room.bounds.minY).toBe(-10);
    expect(room.bounds.maxY).toBe(10);
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

  it("places the five core-plugin hooks in declared order and keeps the core yards on the street", async () => {
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
    expect(byId.get("casino.casino")).toMatchObject({ kind: "building", model: "casino", href: "/plugins/casino.index", footprint: { w: 12, d: 9 }, interior: { sceneKey: "casino-floor-v2" } });
    expect(byId.get("inventory.shop")).toMatchObject({ kind: "building", model: "shop", href: "/plugins/inventory.shop", footprint: { w: 6, d: 6 } });
    // Order along the street is the declared order: station (10), corner (20), bank (30), casino (40), shop (50).
    expect(room.hooks.map((h) => h.id).filter((id) => byId.has(id)).slice(0, 5))
      .toEqual(["travel.station", "crimes.corner", "bank.bank", "casino.casino", "inventory.shop"]);
    // Core jail and hospital close the street, after every plugin hook.
    expect(room.hooks.map((h) => h.id).slice(-2)).toEqual(["core.jail", "core.hospital"]);
    expect(room.hooks.at(-2)).toMatchObject({ pluginId: "core", hookId: "jail", href: "/plugins/jail", model: "jail", facing: Math.PI, signageUrl: null });
    expect(room.hooks.at(-1)).toMatchObject({ pluginId: "core", hookId: "hospital", href: "/plugins/hospital", model: "hospital", facing: 0, signageUrl: null });
    expect(room.hooks.at(-2)!.yard).toEqual({ x: room.hooks.at(-2)!.position.x + 9, y: 15 });
    expect(room.hooks.at(-1)!.yard).toEqual({ x: room.hooks.at(-1)!.position.x + 9, y: -15 });

    // The sixth building (theft.garage, order 55) lands on the street's north
    // side — inside bounds on its own — but that is the lot core.jail (also
    // north-pinned) would otherwise sit in, so jail slides east past it and
    // overflows the DEFAULT street (corner-district spec §6). The served
    // bounds grow to fit it (2026-09-21) — the street grows, there is no
    // invisible wall — so the overflow is checked against the raw default,
    // not against `room.bounds`, which has already widened past it.
    const coreJail = byId.get("core.jail")!;
    expect(coreJail.position.x + 6).toBeGreaterThan(DEFAULT_SCENE_BOUNDS.maxX);
    expect(room.bounds.maxX).toBeGreaterThanOrEqual(coreJail.yard!.x + 3 + 4);

    // Nobody stands inside a building: the spawn lot is clear.
    for (const h of room.hooks.filter((h) => h.kind === "building")) {
      const inside = Math.abs(room.spawn.x - h.position.x) < h.footprint.w / 2 && Math.abs(room.spawn.y - h.position.y) < h.footprint.d / 2;
      expect(inside, h.id).toBe(false);
    }
  });

  it("puts theft's garage in the vehicle zone and its cars in the bays on a template town, and only the garage on a default one", async () => {
    await seedLocations(db);
    const { token, playerId } = await registerVerifiedPlayer({ app: gl3App, redis: gl3Redis });
    const ny = await townId("New York");
    await db.insert(locationScenes).values({ locationId: ny, sceneKey: "district-corner-v1" });
    await db.update(playerStats).set({ locationId: ny }).where(eq(playerStats.playerId, playerId));
    const room = RoomDescriptorSchema.parse((await gl3App.inject({ method: "GET", url: "/api/world/scene", headers: { authorization: `Bearer ${token}` } })).json());
    const byId = new Map(room.hooks.map((h) => [h.id, h]));
    expect(byId.get("theft.garage")).toMatchObject({ kind: "building", model: "garage", position: { x: 61 }, href: "/plugins/theft.garage" });
    expect(byId.get("theft.car-1")).toMatchObject({ kind: "prop", model: "sedan", position: { x: 37, y: 12 }, href: "/plugins/theft.index" });
    expect(byId.get("theft.car-2")).toMatchObject({ kind: "prop", position: { x: 37, y: 26 } });
    const chicago = await townId("Chicago");
    const dflt = RoomDescriptorSchema.parse((await gl3App.inject({ method: "GET", url: `/api/world/scene/${chicago}`, headers: { authorization: `Bearer ${token}` } })).json());
    expect(dflt.hooks.some((h) => h.id === "theft.garage")).toBe(true);
    expect(dflt.hooks.some((h) => h.kind === "prop")).toBe(false);
  });
});

describe("the framework profile has no core hooks", () => {
  let fwApp: FastifyInstance; let fwRedis: Redis; let closeFw: () => Promise<void>;
  beforeAll(async () => { ({ app: fwApp, redis: fwRedis, close: closeFw } = await bootTestServer({ profile: "framework" })); });
  afterAll(async () => { await closeFw(); });

  it("serves a scene carrying plugin hooks only — jail and hospital do not exist there", async () => {
    await seedLocations(db);
    const { token, playerId } = await registerVerifiedPlayer({ app: fwApp, redis: fwRedis });
    const chicago = await townId("Chicago");
    await db.update(playerStats).set({ locationId: chicago }).where(eq(playerStats.playerId, playerId));
    const res = await fwApp.inject({ method: "GET", url: "/api/world/scene", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const room = RoomDescriptorSchema.parse(res.json());
    // `every` over an empty array is vacuously true, so prove the scene
    // really did serve hooks before asserting on what is missing from them.
    expect(room.hooks.map((h) => h.id)).toContain("bank.bank");
    expect(room.hooks.every((h) => h.pluginId !== "core")).toBe(true);
    expect(room.hooks.every((h) => h.yard === undefined)).toBe(true);
  });
});
