import { definePlugin } from "@gl3/plugin-sdk";
import { RoomDescriptorSchema, SceneTemplateSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { locations, locationScenes, playerStats } from "../src/db/schema/index.js";
import { seedLocations } from "../src/db/seed.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const stub = { kind: "list" as const, items: [] };
// Six bays, nine props wanting one: theft (a real CORE_PLUGINS member, loaded
// alongside this fixture under the v2 profile) contributes its own two real
// parking-zone cars at order 60/61, ahead of these seven fixture cars
// (order 101-107) — so theft's pair claims the first two bays and only four
// of these seven fit; car-5, car-6 and car-7 are the dropped ones.
const cars = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `car-${i}`, kind: "prop" as const, zone: "parking", label: "Car", page: "tfix.index", model: "sedan", footprint: { w: 4, d: 2 }, order: 100 + i }));
const fixture = definePlugin({
  id: "tfix", version: "1.0.0", apiVersion: 1, basePaths: ["/api/tfix"],
  pages: [{ id: "tfix.index", path: "/tfix", view: stub }],
  worldHooks: [{ id: "lot", kind: "building", zone: "vehicle", label: "Lot", page: "tfix.index", model: "garage", footprint: { w: 12, d: 9 }, order: 1 }, ...cars],
});

let app: FastifyInstance; let redis: Redis; let closeServer: () => Promise<void>;
beforeAll(async () => { ({ app, close: closeServer, redis } = await bootTestServer({ plugins: [fixture], profile: "v2" })); });
beforeEach(async () => { await resetDb(db); await seedLocations(db); });
afterAll(async () => { await closeServer(); await conn.end(); });

const townId = async (name: string) => (await db.select({ id: locations.id }).from(locations).where(eq(locations.name, name)))[0]!.id;
const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("GET /api/world/template/:sceneKey", () => {
  it("serves the authored template, 404s an unknown key, 401s without auth", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await get("/api/world/template/district-corner-v1", token);
    expect(res.statusCode).toBe(200);
    const t = SceneTemplateSchema.parse(res.json());
    expect(t.bounds).toEqual({ minX: -120, minY: -20, maxX: 70, maxY: 100 });
    expect((await get("/api/world/template/nope", token)).json()).toEqual({ error: "unknown_template" });
    expect((await app.inject({ method: "GET", url: "/api/world/template/district-corner-v1" })).statusCode).toBe(401);
  });
});

describe("a town on district-corner-v1", () => {
  it("serves template bounds and spawn, assigns by zone, drops the seventh car, keeps default towns prop-free", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const ny = await townId("New York");
    const chicago = await townId("Chicago");
    await db.insert(locationScenes).values({ locationId: ny, sceneKey: "district-corner-v1" });
    await db.update(playerStats).set({ locationId: ny }).where(eq(playerStats.playerId, playerId));

    const room = RoomDescriptorSchema.parse((await get("/api/world/scene", token)).json());
    expect(room.sceneKey).toBe("district-corner-v1");
    expect(room.bounds).toEqual({ minX: -120, minY: -20, maxX: 70, maxY: 100 });
    const byId = new Map(room.hooks.map((h) => [h.id, h]));
    expect(byId.get("tfix.lot")).toMatchObject({ position: { x: 61, y: 18 }, facing: Math.PI / 2 });
    expect(room.hooks.filter((h) => h.kind === "prop").length).toBe(6);
    expect(byId.has("tfix.car-7")).toBe(false);
    // theft.car-1 (order 60) and theft.car-2 (order 61) take bays y=12 and
    // y=26 first; tfix.car-1 (order 101) is the third car in and lands on
    // the third bay.
    expect(byId.get("theft.car-1")).toMatchObject({ position: { x: 37, y: 12 } });
    expect(byId.get("theft.car-2")).toMatchObject({ position: { x: 37, y: 26 } });
    expect(byId.get("tfix.car-1")).toMatchObject({ position: { x: 37, y: 40 }, footprint: { w: 4, d: 2 }, href: "/plugins/tfix.index", signageUrl: null });
    // Core facilities on their reserved plots, with explicit yards.
    expect(room.hooks.at(-2)).toMatchObject({ id: "core.jail", position: { x: -106, y: 15 }, yard: { x: -115, y: 15 } });
    expect(room.hooks.at(-1)).toMatchObject({ id: "core.hospital", position: { x: -106, y: -15 }, yard: { x: -115, y: -15 } });

    const dflt = RoomDescriptorSchema.parse((await get(`/api/world/scene/${chicago}`, token)).json());
    expect(dflt.sceneKey).toBe("default");
    expect(dflt.hooks.some((h) => h.kind === "prop")).toBe(false);
    expect(dflt.hooks.some((h) => h.id === "tfix.lot")).toBe(true);
  });
});

describe("core world admin", () => {
  it("lists towns and templates, switches a town, refuses a bad key and a plain player", async () => {
    const admin = await registerVerifiedPlayer({ app, redis });
    const plain = await registerVerifiedPlayer({ app, redis });
    const ny = await townId("New York");
    const put = (token: string, id: string, sceneKey: string) =>
      app.inject({ method: "PUT", url: "/api/admin/world/scene", headers: { authorization: `Bearer ${token}` }, payload: { locationId: id, sceneKey } });

    expect((await get("/api/admin/world/templates", admin.token)).json().rows).toEqual([
      { id: "default", name: "default" }, { id: "district-corner-v1", name: "district-corner-v1" },
    ]);
    let rows = (await get("/api/admin/world/scenes", admin.token)).json().rows as { id: string; name: string; sceneKey: string }[];
    expect(rows.find((r) => r.id === ny)).toEqual({ id: ny, name: "New York", sceneKey: "default" });

    expect((await put(admin.token, ny, "district-corner-v1")).statusCode).toBe(200);
    rows = (await get("/api/admin/world/scenes", admin.token)).json().rows;
    expect(rows.find((r) => r.id === ny)!.sceneKey).toBe("district-corner-v1");
    expect(RoomDescriptorSchema.parse((await get(`/api/world/scene/${ny}`, admin.token)).json()).sceneKey).toBe("district-corner-v1");
    // Back to default: the row stays, the key flips.
    expect((await put(admin.token, ny, "default")).statusCode).toBe(200);
    expect(RoomDescriptorSchema.parse((await get(`/api/world/scene/${ny}`, admin.token)).json()).sceneKey).toBe("default");

    expect((await put(admin.token, ny, "nope")).json()).toEqual({ error: "invalid_scene_key" });
    expect((await put(admin.token, "00000000-0000-0000-0000-000000000000", "default")).json()).toEqual({ error: "unknown_location" });
    expect((await put(plain.token, ny, "default")).statusCode).toBe(403);
    expect((await get("/api/admin/world/scenes", plain.token)).statusCode).toBe(403);

    const sections = (await get("/api/admin/plugins", admin.token)).json().sections as { pluginId: string }[];
    expect(sections.some((s) => s.pluginId === "world")).toBe(true);
  });
});
