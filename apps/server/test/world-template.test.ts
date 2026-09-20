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
// Six props against six bays: the seventh is the dropped one.
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
    expect(byId.get("tfix.car-1")).toMatchObject({ position: { x: 37, y: 12 }, footprint: { w: 4, d: 2 }, href: "/plugins/tfix.index", signageUrl: null });
    // Core facilities on their reserved plots, with explicit yards.
    expect(room.hooks.at(-2)).toMatchObject({ id: "core.jail", position: { x: -106, y: 15 }, yard: { x: -115, y: 15 } });
    expect(room.hooks.at(-1)).toMatchObject({ id: "core.hospital", position: { x: -106, y: -15 }, yard: { x: -115, y: -15 } });

    const dflt = RoomDescriptorSchema.parse((await get(`/api/world/scene/${chicago}`, token)).json());
    expect(dflt.sceneKey).toBe("default");
    expect(dflt.hooks.some((h) => h.kind === "prop")).toBe(false);
    expect(dflt.hooks.some((h) => h.id === "tfix.lot")).toBe(true);
  });
});
