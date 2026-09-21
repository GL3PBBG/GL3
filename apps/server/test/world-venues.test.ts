import type { AddressInfo } from "node:net";
import { definePlugin } from "@gl3/plugin-sdk";
import { RoomDescriptorSchema } from "@gl3/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { locations, locationScenes, playerStats } from "../src/db/schema/index.js";
import { seedLocations } from "../src/db/seed.js";
import { resetDb, testDb } from "./helpers/db.js";
import { propertiesPlugin as propertiesTable } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { seedVenues } from "./helpers/venues.js";
import { frameOfKind, mintTicket, nextFrame, openSocket, sendFrame } from "./helpers/ws.js";

const { db, sql: conn } = testDb();

const floor = {
  sceneKey: "vfix-floor",
  bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
  spawn: { x: 0, y: -8, facing: 0 },
  points: [{ id: "desk", kind: "npc" as const, label: "Clerk", model: "npc-suit", position: { x: 0, y: 5 }, facing: 0 }],
};

/**
 * One enterable building gated on the `blackjack` venue, loaded beside the
 * gl3 union. Deliberately NOT `casino.casino`: the bundled casino hook does
 * not declare a venue until this cluster's casino task, so a fixture is the
 * only hook in the boot set whose door can be absent — which is exactly the
 * behaviour under test.
 */
const fixture = definePlugin({
  id: "vfix",
  version: "1.0.0",
  apiVersion: 1,
  basePaths: ["/api/vfix"],
  pages: [{ id: "vfix.index", path: "/vfix", view: { kind: "list" as const, items: [] } }],
  worldHooks: [
    { id: "hall", kind: "building", label: "Hall", page: "vfix.index", model: "bank", footprint: { w: 12, d: 9 }, order: 5, venue: "blackjack", interior: floor },
  ],
});

let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let baseUrl: string;
const opened: WebSocket[] = [];

beforeAll(async () => {
  ({ app, close: closeServer, redis } = await bootTestServer({ plugins: [fixture] }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}/ws`;
});
beforeEach(async () => {
  for (const s of opened.splice(0)) s.close();
  await resetDb(db);
  await seedLocations(db);
  // No seedVenues here, deliberately: every test in this file says for
  // itself which towns hold the venue.
});
afterAll(async () => { for (const s of opened) s.close(); await closeServer(); await conn.end(); });

const townId = async (name: string) => (await db.select({ id: locations.id }).from(locations).where(eq(locations.name, name)))[0]!.id;
const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

async function playerAt(locationId: string) {
  const p = await registerVerifiedPlayer({ app, redis });
  await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, p.playerId));
  return p;
}
async function socketFor(p: { token: string }) {
  const socket = await openSocket(`${baseUrl}?ticket=${await mintTicket(app, p.token)}`);
  opened.push(socket);
  expect((await nextFrame(socket)).kind).toBe("ready");
  return socket;
}
async function joined(locationId: string) {
  const p = await playerAt(locationId);
  const socket = await socketFor(p);
  sendFrame(socket, { kind: "presence.join", client: "godot-desktop" });
  return { ...p, socket };
}
/** A joined player who has walked through the fixture door. */
async function joinedInside(locationId: string) {
  const p = await joined(locationId);
  await frameOfKind(p.socket, "presence.snapshot");
  sendFrame(p.socket, { kind: "presence.enter", hookId: "vfix.hall" });
  const snap = await frameOfKind(p.socket, "presence.snapshot");
  expect(snap.room.space?.kind).toBe("interior");
  return { ...p, snap };
}
const sceneFor = async (token: string) => RoomDescriptorSchema.parse((await get("/api/world/scene", token)).json());

describe("per-town venue eligibility (spec 2026-09-21 town-venues §3)", () => {
  it("two towns on one template: only the town with a blackjack row has the door, its interior and entry", async () => {
    const chicago = await townId("Chicago");
    const miami = await townId("Miami");
    for (const id of [chicago, miami]) await db.insert(locationScenes).values({ locationId: id, sceneKey: "district-corner-v1" });
    await seedVenues(db, [chicago]);                                  // Chicago has the venue, Miami does not

    const a = await playerAt(chicago);
    const b = await playerAt(miami);
    const sc = await sceneFor(a.token);
    const sm = await sceneFor(b.token);
    expect(sc.hooks.map((x) => x.id)).toContain("vfix.hall");
    expect(sm.hooks.map((x) => x.id)).not.toContain("vfix.hall");
    expect(sm.hooks.map((x) => x.id)).toContain("travel.station");     // venue-less hooks stay
    expect(sm.hooks.slice(-2).map((x) => x.id)).toEqual(["core.jail", "core.hospital"]); // facilities untouched
    // Two towns, one template, two layouts: the memo key carries the
    // eligible hook ids, so Miami cannot be served Chicago's street.
    expect(sc.hooks.length).toBe(sm.hooks.length + 1);

    expect((await get("/api/world/interior/vfix.hall", a.token)).statusCode).toBe(200);
    expect((await get("/api/world/interior/vfix.hall", b.token)).statusCode).toBe(404);
    expect((await get("/api/world/interior/vfix.hall", b.token)).json()).toEqual({ error: "unknown_hook" });

    const sb = await joined(miami);
    await frameOfKind(sb.socket, "presence.snapshot");
    sendFrame(sb.socket, { kind: "presence.enter", hookId: "vfix.hall" });
    expect((await frameOfKind(sb.socket, "presence.error")).code).toBe("unknown_hook");
  });

  it("a player-owned row counts as present", async () => {
    const chicago = await townId("Chicago");
    const owner = await playerAt(chicago);
    await db.insert(propertiesTable).values({
      id: uuidv7(), locationId: chicago, pluginId: "blackjack", ownerPlayerId: owner.playerId, cost: 0n, profit: 0n,
    });
    expect((await sceneFor(owner.token)).hooks.map((x) => x.id)).toContain("vfix.hall");
  });

  it("removing the row drops the door on the next read while a socket already inside can still exit", async () => {
    const chicago = await townId("Chicago");
    await seedVenues(db, [chicago]);
    const a = await joinedInside(chicago);
    await db.delete(propertiesTable)
      .where(and(eq(propertiesTable.locationId, chicago), eq(propertiesTable.pluginId, "blackjack")));

    expect((await sceneFor(a.token)).hooks.map((x) => x.id)).not.toContain("vfix.hall");
    // The room already holds its interior descriptor, so the way out is the
    // door's own exit spot — a removed venue strands nobody (spec §3.3).
    sendFrame(a.socket, { kind: "presence.exit" });
    expect((await frameOfKind(a.socket, "presence.snapshot")).room.space?.kind).toBe("street");
  });

  it("the default street is filtered too", async () => {
    const chicago = await townId("Chicago");
    const miami = await townId("Miami");
    await seedVenues(db, [chicago]);
    const a = await playerAt(chicago);
    const b = await playerAt(miami);
    const sc = await sceneFor(a.token);
    const sm = await sceneFor(b.token);
    expect(sc.sceneKey).toBe("default");
    expect(sm.sceneKey).toBe("default");
    expect(sc.hooks.map((x) => x.id)).toContain("vfix.hall");
    expect(sm.hooks.map((x) => x.id)).not.toContain("vfix.hall");
    expect(sm.hooks.map((x) => x.id)).toContain("travel.station");
    expect(sm.hooks.slice(-2).map((x) => x.id)).toEqual(["core.jail", "core.hospital"]);
  });
});
