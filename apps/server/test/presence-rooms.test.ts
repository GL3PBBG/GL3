import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats } from "../src/db/schema/index.js";
import { seedLocations } from "../src/db/seed.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { frameOfKind, mintTicket, nextFrame, openSocket, receivedFrameOfKind, sendFrame } from "./helpers/ws.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let baseUrl: string;
let chicago: string;
let miami: string;
const opened: WebSocket[] = [];

beforeAll(async () => {
  ({ app, close: closeServer, redis } = await bootTestServer());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}/ws`;
});
beforeEach(async () => {
  for (const s of opened.splice(0)) s.close();
  await resetDb(db);
  await seedLocations(db);
  const rows = await db.select({ id: locations.id, name: locations.name }).from(locations);
  chicago = rows.find((r) => r.name === "Chicago")!.id;
  miami = rows.find((r) => r.name === "Miami")!.id;
});
afterAll(async () => { for (const s of opened) s.close(); await closeServer(); await conn.end(); });

/** A verified player standing in `locationId` (null = nowhere), with an open socket past `ready`. */
async function playerIn(locationId: string | null, username?: string) {
  const p = await registerVerifiedPlayer({ app, redis }, username ? { username } : undefined);
  if (locationId) await db.update(playerStats).set({ locationId }).where(eq(playerStats.playerId, p.playerId));
  const socket = await openSocket(`${baseUrl}?ticket=${await mintTicket(app, p.token)}`);
  opened.push(socket);
  expect((await nextFrame(socket)).kind).toBe("ready");
  return { ...p, socket };
}
async function joined(locationId: string | null, username?: string) {
  const p = await playerIn(locationId, username);
  sendFrame(p.socket, { kind: "presence.join", client: "godot-desktop" });
  return p;
}
const move = (socket: WebSocket, seq: number, x: number, y: number, facing = 0) =>
  sendFrame(socket, { kind: "presence.move", seq, x, y, facing });

describe("presence.join", () => {
  it("answers with a snapshot of the room, and tells the room about the joiner", async () => {
    const a = await joined(chicago, "Vito");
    const snapA = await frameOfKind(a.socket, "presence.snapshot");
    expect(snapA.room.locationId).toBe(chicago);
    expect(snapA.room.locationName).toBe("Chicago");
    expect(snapA.you).toMatchObject({ playerId: a.playerId, username: "Vito", gangId: null, x: snapA.room.spawn.x, y: snapA.room.spawn.y });
    expect(snapA.players).toEqual([]);
    expect(snapA.concealed).toBe(false);

    const b = await joined(chicago, "Sonny");
    const snapB = await frameOfKind(b.socket, "presence.snapshot");
    expect(snapB.players.map((p) => p.playerId)).toEqual([a.playerId]);

    const tick = await frameOfKind(a.socket, "presence.tick");
    expect(tick.locationId).toBe(chicago);
    expect(tick.joined.map((p) => p.playerId)).toEqual([b.playerId]);
  });

  it("errors no_location for a player who is nowhere", async () => {
    const a = await joined(null);
    expect(await frameOfKind(a.socket, "presence.error")).toEqual({ kind: "presence.error", code: "no_location" });
  });

  it("errors not_joined on a move before join", async () => {
    const a = await playerIn(chicago);
    move(a.socket, 1, 0, 0);
    expect(await frameOfKind(a.socket, "presence.error")).toEqual({ kind: "presence.error", code: "not_joined" });
  });

  it("derives a stable avatar body from the player id", async () => {
    const a = await joined(chicago);
    const first = (await frameOfKind(a.socket, "presence.snapshot")).you.avatar.body;
    sendFrame(a.socket, { kind: "presence.join", client: "web" });
    expect((await frameOfKind(a.socket, "presence.snapshot")).you.avatar.body).toBe(first);
  });
});

describe("presence.move", () => {
  it("batches several moves into one tick carrying the last position", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await frameOfKind(a.socket, "presence.tick"); // B joined

    move(b.socket, 1, 0.1, -15, 0.5);
    move(b.socket, 2, 0.2, -15, 0.5);
    move(b.socket, 3, 0.3, -15, 0.5);
    const tick = await frameOfKind(a.socket, "presence.tick");
    expect(tick.moved).toHaveLength(1);
    expect(tick.moved[0]).toMatchObject({ playerId: b.playerId, facing: 0.5 });
    expect(tick.moved[0]!.x).toBeCloseTo(0.3, 5);
    expect(tick.moved[0]!.y).toBeCloseTo(-15, 5);
    expect(tick.moved[0]!.at).toBeGreaterThan(0);
  });

  it("clamps an out-of-bounds position to the room bounds", async () => {
    const a = await joined(chicago);
    const snap = await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await frameOfKind(a.socket, "presence.tick");
    // Wait past the 50 ms dt floor so the speed clamp cannot be what bounds this.
    await new Promise((r) => setTimeout(r, 1200));
    move(b.socket, 1, snap.room.bounds.maxX + 500, snap.room.bounds.minY - 500);
    const tick = await frameOfKind(a.socket, "presence.tick");
    expect(tick.moved[0]!.x).toBeLessThanOrEqual(snap.room.bounds.maxX);
    expect(tick.moved[0]!.y).toBeGreaterThanOrEqual(snap.room.bounds.minY);
  });

  it("rubber-bands a jump to maxSpeed × dt from the previous accepted position", async () => {
    const a = await joined(chicago);
    const snap = await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await frameOfKind(a.socket, "presence.tick");
    const { x: sx, y: sy } = snap.room.spawn;
    move(b.socket, 1, sx, sy);
    await frameOfKind(a.socket, "presence.tick");
    await new Promise((r) => setTimeout(r, 100));
    move(b.socket, 2, sx + 30, sy);
    const tick = await frameOfKind(a.socket, "presence.tick");
    const dx = tick.moved[0]!.x - sx;
    // dt is ~100 ms from the server clock: 6 m/s × 0.1 s = 0.6 m, with slack for scheduling; never the 30 m asked for.
    expect(dx).toBeGreaterThan(0.3);
    expect(dx).toBeLessThan(6);
    expect(tick.moved[0]!.y).toBeCloseTo(sy, 5);
  });

  it("drops a stale seq", async () => {
    const a = await joined(chicago);
    const snap = await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await frameOfKind(a.socket, "presence.tick");
    const { x: sx, y: sy } = snap.room.spawn;
    move(b.socket, 5, sx + 0.1, sy);
    move(b.socket, 3, sx + 0.2, sy);
    const tick = await frameOfKind(a.socket, "presence.tick");
    expect(tick.moved[0]!.x).toBeCloseTo(sx + 0.1, 5);
  });

  it("sends nothing to the room when nobody moves", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    expect(await receivedFrameOfKind(a.socket, "presence.tick", 600)).toBe(false);
  });

  it("forwards an emote in the tick", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await frameOfKind(a.socket, "presence.tick");
    sendFrame(b.socket, { kind: "presence.emote", emote: "wave" });
    const tick = await frameOfKind(a.socket, "presence.tick");
    expect(tick.emoted).toEqual([{ playerId: b.playerId, emote: "wave" }]);
  });
});

describe("leaving", () => {
  it("presence.leave tells the room, and so does a closed socket", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await frameOfKind(a.socket, "presence.tick");
    sendFrame(b.socket, { kind: "presence.leave" });
    expect((await frameOfKind(a.socket, "presence.tick")).left).toEqual([b.playerId]);

    const c = await joined(chicago);
    await frameOfKind(c.socket, "presence.snapshot");
    await frameOfKind(a.socket, "presence.tick");
    c.socket.close();
    expect((await frameOfKind(a.socket, "presence.tick")).left).toEqual([c.playerId]);
  });
});

describe("one avatar per player", () => {
  it("a second join supersedes the first socket, which keeps receiving ticks", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const second = await openSocket(`${baseUrl}?ticket=${await mintTicket(app, a.token)}`);
    opened.push(second);
    await nextFrame(second); // ready
    sendFrame(second, { kind: "presence.join", client: "web" });
    await frameOfKind(second, "presence.snapshot");
    expect(await frameOfKind(a.socket, "presence.error")).toEqual({ kind: "presence.error", code: "superseded" });

    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    expect((await frameOfKind(a.socket, "presence.tick")).joined[0]!.playerId).toBe(b.playerId);
    expect((await frameOfKind(second, "presence.tick")).joined[0]!.playerId).toBe(b.playerId);
  });
});

describe("concealed rooms", () => {
  beforeEach(async () => {
    await db.update(locations).set({ combatMode: "underground" }).where(eq(locations.id, chicago));
  });

  it("snapshots with players: [] and concealed: true, and broadcasts nothing", async () => {
    const a = await joined(chicago);
    const snapA = await frameOfKind(a.socket, "presence.snapshot");
    expect(snapA.concealed).toBe(true);
    expect(snapA.room.combatMode).toBe("underground");

    const b = await joined(chicago);
    const snapB = await frameOfKind(b.socket, "presence.snapshot");
    expect(snapB.concealed).toBe(true);
    expect(snapB.players).toEqual([]);

    move(b.socket, 1, 1, 1);
    sendFrame(b.socket, { kind: "presence.emote", emote: "wave" });
    expect(await receivedFrameOfKind(a.socket, "presence.tick", 700)).toBe(false);
  });
});
