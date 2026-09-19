import type { AddressInfo } from "node:net";
import type { GameEvent, ServerFrame } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesystemDriver } from "../src/assets/fs-driver.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { locations, locationScenes, playerStats } from "../src/db/schema/index.js";
import { seedLocations } from "../src/db/seed.js";
import { publishEvent } from "../src/bus/publish.js";
import { createRooms, staticSpotFor } from "../src/presence/rooms.js";
import { createRedis } from "../src/redis.js";
import { createSceneService } from "../src/world/scene.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { frameOfKind, mintTicket, nextFrame, openSocket, receivedFrameOfKind, sendFrame } from "./helpers/ws.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let baseUrl: string;
let assetDriver: FilesystemDriver;
let chicago: string;
let miami: string;
const opened: WebSocket[] = [];

beforeAll(async () => {
  ({ app, close: closeServer, redis, assetDriver } = await bootTestServer());
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

/** A `player.travelled` straight onto `onEvent`, the way the bus delivers one. */
const travelled = (actorId: string, toLocationId: string): GameEvent => ({
  id: uuidv7(), type: "player.travelled", at: new Date().toISOString(),
  actorId, actorName: "traveller", audience: { kind: "player", playerId: actorId },
  fromLocationId: null, toLocationId, cost: "0",
});
const isTick = (f: ServerFrame): f is Extract<ServerFrame, { kind: "presence.tick" }> =>
  f.kind === "presence.tick";

/**
 * Every tick a socket receives over `withinMs`, not just the first.
 *
 * A burst bigger than one 200 ms flush window straddles a flush, so the
 * FIRST tick after it can carry a partial result — which reads exactly like
 * a rate-limit drop, and passes even when the limiter has been deleted.
 * Draining the whole burst is what makes these assertions mean what they say.
 */
async function drainTicks(
  socket: WebSocket, withinMs: number,
): Promise<Extract<ServerFrame, { kind: "presence.tick" }>[]> {
  const ticks: Extract<ServerFrame, { kind: "presence.tick" }>[] = [];
  const deadline = Date.now() + withinMs;
  for (let left = withinMs; left > 0; left = deadline - Date.now()) {
    let frame: ServerFrame;
    try { frame = await nextFrame(socket, left); } catch { break; }
    if (isTick(frame)) ticks.push(frame);
  }
  return ticks;
}
const isSnapshot = (f: ServerFrame): f is Extract<ServerFrame, { kind: "presence.snapshot" }> =>
  f.kind === "presence.snapshot";
const isError = (f: ServerFrame): f is Extract<ServerFrame, { kind: "presence.error" }> =>
  f.kind === "presence.error";

type Tick = Extract<ServerFrame, { kind: "presence.tick" }>;

/**
 * The next tick this socket receives that says something about `ok`.
 *
 * Auto-join announces every connecting socket as a static member, and the
 * `presence.join` that takes the avatar over re-announces it a moment later.
 * Those two writes coalesce into one tick when they fall inside the same
 * 200 ms flush and arrive as two when they straddle one, so a bare
 * `frameOfKind(socket, "presence.tick")` is no longer a reliable way to read
 * the tick a test actually means. This skips the ones that carry something
 * else — it never weakens an assertion, it only aims it.
 */
async function tickWhere(socket: WebSocket, ok: (t: Tick) => boolean, timeoutMs = 4000): Promise<Tick> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tick = await frameOfKind(socket, "presence.tick", Math.max(1, deadline - Date.now()));
    if (ok(tick)) return tick;
  }
}
const movedTick = (socket: WebSocket) => tickWhere(socket, (t) => t.moved.length > 0);
const emotedTick = (socket: WebSocket) => tickWhere(socket, (t) => t.emoted.length > 0);
const leftTick = (socket: WebSocket) => tickWhere(socket, (t) => t.left.length > 0);
/** The announce that says `playerId` is being DRIVEN — past any static one. */
const liveAnnounce = async (socket: WebSocket, playerId: string) =>
  (await tickWhere(socket, (t) => t.joined.some((p) => p.playerId === playerId && p.static === false)))
    .joined.find((p) => p.playerId === playerId)!;

/** Every socket of every player, as the gateway feeds it to the rooms. */
const noSockets = () => [];

/** Asserts this socket is told nothing about presence at all for `withinMs`. */
async function expectNoPresenceFrames(socket: WebSocket, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  for (let left = withinMs; left > 0; left = deadline - Date.now()) {
    let frame: ServerFrame;
    // `game:events` is global across test files, so an unrelated `event`
    // frame can land here; only presence frames are the claim being made.
    try { frame = await nextFrame(socket, left); } catch { break; }
    expect(frame.kind.startsWith("presence."), `unexpected ${frame.kind}`).toBe(false);
  }
}

describe("presence.join", () => {
  it("answers with a snapshot of the room, and tells the room about the joiner", async () => {
    const a = await joined(chicago, "Vito");
    const snapA = await frameOfKind(a.socket, "presence.snapshot");
    expect(snapA.room.locationId).toBe(chicago);
    expect(snapA.room.locationName).toBe("Chicago");
    // Not spawn: the gateway auto-joined this socket the moment it connected,
    // and taking the avatar over never moves it (spec 2026-09-19 §2).
    const spotA = staticSpotFor(a.playerId, snapA.room);
    expect(snapA.you).toMatchObject({
      playerId: a.playerId, username: "Vito", gangId: null, x: spotA.x, y: spotA.y, static: false,
    });
    expect(snapA.players).toEqual([]);
    expect(snapA.concealed).toBe(false);

    const b = await joined(chicago, "Sonny");
    const snapB = await frameOfKind(b.socket, "presence.snapshot");
    expect(snapB.players.map((p) => p.playerId)).toEqual([a.playerId]);

    // Past B's static announce, which auto-join produced a beat earlier.
    const tick = await tickWhere(a.socket, (t) => t.joined.some((p) => p.playerId === b.playerId && p.static === false));
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
    // B starts where auto-join stood it, not at spawn, so the moves below are
    // relative to that — a fixed target would be rubber-banded on the way.
    const { x: bx, y: by } = (await frameOfKind(b.socket, "presence.snapshot")).you;
    await liveAnnounce(a.socket, b.playerId);

    move(b.socket, 1, bx + 0.1, by, 0.5);
    move(b.socket, 2, bx + 0.2, by, 0.5);
    move(b.socket, 3, bx + 0.3, by, 0.5);
    const tick = await movedTick(a.socket);
    expect(tick.moved).toHaveLength(1);
    expect(tick.moved[0]).toMatchObject({ playerId: b.playerId, facing: 0.5 });
    expect(tick.moved[0]!.x).toBeCloseTo(bx + 0.3, 5);
    expect(tick.moved[0]!.y).toBeCloseTo(by, 5);
    expect(tick.moved[0]!.at).toBeGreaterThan(0);
  });

  it("clamps an out-of-bounds position to the room bounds", async () => {
    // A 4x4 room, so the BOUNDS are demonstrably what bind this move. The
    // default room is 80x40, where the speed clamp alone already holds a
    // far-away target inside the bounds and the assertion would pass with
    // the bounds clamp deleted. Here the clamped corner is 2.83 m from
    // spawn while the wait below buys ~7 m of travel, so the speed clamp
    // cannot reach — the exact landing position is the bounds and nothing
    // else.
    await db.insert(locationScenes).values({
      locationId: chicago, sceneKey: "tight",
      bounds: { minX: -2, minY: -2, maxX: 2, maxY: 2 },
      spawn: { x: 0, y: 0, facing: 0 },
    });
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await liveAnnounce(a.socket, b.playerId);
    // Past the 50 ms dt floor, so the speed clamp has slack to spare. The
    // static spot is clamped into these bounds too, so the whole diagonal
    // (2.83 m at most) is well inside the ~7 m this wait buys.
    await new Promise((r) => setTimeout(r, 1200));
    move(b.socket, 1, 100, -100);
    const tick = await movedTick(a.socket);
    expect(tick.moved[0]!.x).toBe(2);
    expect(tick.moved[0]!.y).toBe(-2);
  });

  it("rubber-bands a jump to maxSpeed × dt from the previous accepted position", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    const { x: sx, y: sy } = (await frameOfKind(b.socket, "presence.snapshot")).you;
    await liveAnnounce(a.socket, b.playerId);
    const started = Date.now();
    // Settles the clock at a position B demonstrably holds, so the jump
    // below is measured from a known point rather than from wherever
    // auto-join stood it.
    move(b.socket, 1, sx, sy);
    await movedTick(a.socket);
    await new Promise((r) => setTimeout(r, 100));
    move(b.socket, 2, sx + 30, sy);
    const tick = await movedTick(a.socket);
    const elapsed = Date.now() - started;
    const dx = tick.moved[0]!.x - sx;
    // The server clamps to 6 m/s × dt on ITS clock. This window strictly
    // contains that dt, so `6 × (elapsed + slack)` is a sound upper bound
    // however badly the box is scheduling — a fixed 6 m was not, and a
    // second of contention on a loaded gate would have failed it.
    expect(dx).toBeGreaterThan(0.3);
    expect(dx).toBeLessThanOrEqual(6 * (elapsed / 1000 + 0.25));
    // What the test actually proves: the 30 m jump was rubber-banded, not
    // granted, and not rejected outright either.
    expect(dx).toBeLessThan(30);
    expect(tick.moved[0]!.y).toBeCloseTo(sy, 5);
  });

  it("drops a stale seq", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    const { x: sx, y: sy } = (await frameOfKind(b.socket, "presence.snapshot")).you;
    await liveAnnounce(a.socket, b.playerId);
    move(b.socket, 5, sx + 0.1, sy);
    move(b.socket, 3, sx + 0.2, sy);
    const tick = await movedTick(a.socket);
    expect(tick.moved[0]!.x).toBeCloseTo(sx + 0.1, 5);
  });

  it("sends nothing to the room when nobody moves", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    expect(await receivedFrameOfKind(a.socket, "presence.tick", 600)).toBe(false);
  });

  it("spends a move token on an emote, so a move burst silences one", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await liveAnnounce(a.socket, b.playerId);
    // Forty back-to-back moves against a ten-token bucket refilling at
    // 10/s: the bucket is empty long before the burst ends, so it is still
    // empty for the emote behind it however fast or slow the burst lands.
    for (let seq = 1; seq <= 40; seq += 1) move(b.socket, seq, 0, -15);
    sendFrame(b.socket, { kind: "presence.emote", emote: "wave" });

    // Every tick the burst produced, not just the first: reading one tick
    // would pass whenever a flush fell before the emote arrived, whether
    // or not the emote was forwarded a tick later.
    const ticks = await drainTicks(a.socket, 900);
    expect(ticks.flatMap((t) => t.moved).length).toBeGreaterThan(0); // the burst did land
    expect(ticks.flatMap((t) => t.emoted)).toEqual([]);
    // Dropped, not refused: an over-budget frame is silent until dropLimit.
    expect(await receivedFrameOfKind(b.socket, "presence.error", 400)).toBe(false);
  });

  it("forwards an emote in the tick", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await liveAnnounce(a.socket, b.playerId);
    sendFrame(b.socket, { kind: "presence.emote", emote: "wave" });
    const tick = await emotedTick(a.socket);
    expect(tick.emoted).toEqual([{ playerId: b.playerId, emote: "wave" }]);
  });
});

describe("leaving", () => {
  it("presence.leave tells the room, and so does a closed socket", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await liveAnnounce(a.socket, b.playerId);
    sendFrame(b.socket, { kind: "presence.leave" });
    expect((await leftTick(a.socket)).left).toEqual([b.playerId]);

    const c = await joined(chicago);
    await frameOfKind(c.socket, "presence.snapshot");
    await liveAnnounce(a.socket, c.playerId);
    c.socket.close();
    expect((await leftTick(a.socket)).left).toEqual([c.playerId]);
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
    expect((await liveAnnounce(a.socket, b.playerId)).playerId).toBe(b.playerId);
    expect((await liveAnnounce(second, b.playerId)).playerId).toBe(b.playerId);
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

describe("a failing presence touch", () => {
  it("joins anyway, and leaves the socket able to detach", async () => {
    const p = await playerIn(chicago);
    // A REAL ioredis client, genuinely closed — the same shape as
    // gateway-routing-error.test.ts closing its Postgres connection. Every
    // command on it rejects immediately, so the ZSET touch inside join
    // fails deterministically rather than by a race, and no mock is
    // involved. Driving createRooms directly is what makes the broken
    // client injectable; the socket is a real one, opened by playerIn.
    const dead = createRedis(loadConfig(process.env).redisUrl);
    dead.disconnect();
    const frames: ServerFrame[] = [];
    const rooms = createRooms({
      db, redis: dead,
      scenes: createSceneService({ db, assetDriver, hooks: [], coreHooks: true }),
      send: (_socket, frame) => { frames.push(frame); },
      socketsOf: noSockets,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await rooms.join(p.playerId, p.socket, null);
      expect(frames.map((f) => f.kind)).toEqual(["presence.snapshot"]);
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({ playerId: p.playerId }), "presence: touch failed",
      );

      // The member is not stranded: the socket did get its state, so a
      // leave detaches it instead of answering `not_joined`.
      rooms.leave(p.socket);
      expect(frames.map((f) => f.kind)).toEqual(["presence.snapshot"]);
    } finally {
      errors.mockRestore();
      rooms.close();
    }
  });
});


describe("a failing join lookup", () => {
  it("answers not_joined rather than leaving the client waiting", async () => {
    const p = await playerIn(chicago);
    // A REAL Postgres client, genuinely ended — the shape
    // gateway-routing-error.test.ts uses, and the shape of the dead-Redis
    // test above. Every query on it rejects, so the select inside join
    // fails deterministically and no mock is involved.
    const dead = createDb(loadConfig(process.env).databaseUrl);
    await dead.sql.end();
    const frames: ServerFrame[] = [];
    const rooms = createRooms({
      db: dead.db, redis,
      scenes: createSceneService({ db: dead.db, assetDriver, hooks: [], coreHooks: true }),
      send: (_socket, frame) => { frames.push(frame); },
      socketsOf: noSockets,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await rooms.join(p.playerId, p.socket, null);
      expect(frames).toEqual([{ kind: "presence.error", code: "not_joined" }]);
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({ playerId: p.playerId }), "presence: join lookup failed",
      );
    } finally {
      errors.mockRestore();
      rooms.close();
    }
  });
});

describe("travel moves a present player between rooms", () => {
  it("old room sees left, the traveller gets a new snapshot, the new room sees joined", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    await liveAnnounce(a.socket, b.playerId);
    const c = await joined(miami);
    await frameOfKind(c.socket, "presence.snapshot");

    // Miami costs 250 and Chicago's cooldown is 60 s; a fresh player has no
    // cooldown. Fund the fare directly — this test is about rooms, not fares.
    await db.update(playerStats).set({ cash: 10_000n }).where(eq(playerStats.playerId, b.playerId));
    const res = await app.inject({ method: "POST", url: `/api/travel/${miami}`, headers: { authorization: `Bearer ${b.token}` } });
    expect(res.statusCode).toBe(200);

    expect((await leftTick(a.socket)).left).toEqual([b.playerId]);
    const snap = await frameOfKind(b.socket, "presence.snapshot");
    expect(snap.room.locationId).toBe(miami);
    expect(snap.players.map((p) => p.playerId)).toEqual([c.playerId]);
    // A driven traveller arrives at spawn, ready for its client to resume.
    expect(snap.you).toMatchObject({ x: snap.room.spawn.x, y: snap.room.spawn.y, static: false });
    expect((await liveAnnounce(c.socket, b.playerId)).playerId).toBe(b.playerId);
  });

  it("ignores a travelled event for a player with no room and no open socket", async () => {
    // Auto-join means "socket open, never joined" is no longer a player in
    // no room — that case is covered in the auto-join describe below. What
    // remains here is the one onEvent still has nothing to do about: a
    // traveller the gateway holds no socket for at all.
    const a = await playerIn(chicago);
    const sent: ServerFrame[] = [];
    const rooms = createRooms({
      db, redis,
      scenes: createSceneService({ db, assetDriver, hooks: [], coreHooks: true }),
      send: (_socket, frame) => { sent.push(frame); },
      socketsOf: noSockets,
    });
    try {
      await rooms.join(a.playerId, a.socket, null);
      sent.length = 0;
      await rooms.onEvent(travelled(uuidv7(), miami));
      await new Promise((r) => setTimeout(r, 400));
      expect(sent).toEqual([]);
    } finally {
      rooms.close();
    }
  });
});

describe("sentence on presence state", () => {
  const soon = () => new Date(Date.now() + 60_000);

  /** The envelope the bus delivers, built the way `base` in events.ts requires. */
  const sentenceEvent = (
    type: "player.jailed" | "player.released" | "player.discharged" | "player.backfired",
    actorId: string,
  ): GameEvent => {
    const envelope = {
      id: uuidv7(), at: new Date().toISOString(), actorId, actorName: "convict",
      audience: { kind: "player" as const, playerId: actorId },
    };
    if (type === "player.jailed") return { ...envelope, type, until: soon().toISOString(), reason: "test" };
    // A backfire hospitalises the SHOOTER, so the actor is the one confined.
    if (type === "player.backfired") return { ...envelope, type, selfDamage: 10, hospitalised: true };
    return { ...envelope, type };
  };

  it("carries jail to the sentenced player and to the room that sees them arrive", async () => {
    const a = await joined(chicago, "Watcher");
    await frameOfKind(a.socket, "presence.snapshot");

    const b = await playerIn(chicago, "Convict");
    await db.update(playerStats).set({ jailedUntil: soon() }).where(eq(playerStats.playerId, b.playerId));
    sendFrame(b.socket, { kind: "presence.join", client: "godot-desktop" });

    expect((await frameOfKind(b.socket, "presence.snapshot")).you.sentence).toBe("jail");
    // Past the static announce auto-join made before the row was written:
    // the announce that matters is the one that says B is being driven.
    expect((await liveAnnounce(a.socket, b.playerId)).sentence).toBe("jail");
  });

  it("carries hospital, and jail wins when both are set", async () => {
    const b = await playerIn(chicago, "Patient");
    await db.update(playerStats).set({ hospitalUntil: soon() }).where(eq(playerStats.playerId, b.playerId));
    sendFrame(b.socket, { kind: "presence.join", client: "godot-desktop" });
    expect((await frameOfKind(b.socket, "presence.snapshot")).you.sentence).toBe("hospital");

    const c = await playerIn(chicago, "Both");
    await db.update(playerStats).set({ jailedUntil: soon(), hospitalUntil: soon() }).where(eq(playerStats.playerId, c.playerId));
    sendFrame(c.socket, { kind: "presence.join", client: "godot-desktop" });
    expect((await frameOfKind(c.socket, "presence.snapshot")).you.sentence).toBe("jail");
  });

  it("is null for a free player, and for one whose sentence has already elapsed", async () => {
    const a = await joined(chicago, "Free");
    expect((await frameOfKind(a.socket, "presence.snapshot")).you.sentence).toBeNull();

    const b = await playerIn(chicago, "Served");
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() - 60_000), hospitalUntil: new Date(Date.now() - 60_000) })
      .where(eq(playerStats.playerId, b.playerId));
    sendFrame(b.socket, { kind: "presence.join", client: "godot-desktop" });
    expect((await frameOfKind(b.socket, "presence.snapshot")).you.sentence).toBeNull();
  });

  it("re-announces a released member through tick.joined", async () => {
    const a = await joined(chicago, "Witness");
    await frameOfKind(a.socket, "presence.snapshot");

    const b = await playerIn(chicago, "Released");
    await db.update(playerStats).set({ jailedUntil: soon() }).where(eq(playerStats.playerId, b.playerId));
    sendFrame(b.socket, { kind: "presence.join", client: "godot-desktop" });
    await frameOfKind(b.socket, "presence.snapshot");
    expect((await liveAnnounce(a.socket, b.playerId)).sentence).toBe("jail");

    // The row is the truth, not the event: clear it, then tell the bus.
    await db.update(playerStats).set({ jailedUntil: null }).where(eq(playerStats.playerId, b.playerId));
    await publishEvent(redis, sentenceEvent("player.released", b.playerId));

    const tick = await frameOfKind(a.socket, "presence.tick");
    const announced = tick.joined.find((p) => p.playerId === b.playerId);
    expect(announced, "the released member is re-announced").toBeDefined();
    expect(announced!.sentence).toBeNull();
  });

  it("re-announces a backfired shooter as hospitalised", async () => {
    const a = await joined(chicago, "Bystander");
    await frameOfKind(a.socket, "presence.snapshot");

    const b = await joined(chicago, "Shooter");
    await frameOfKind(b.socket, "presence.snapshot");
    // Consumed here so the only tick left for B is the refresh below.
    expect((await liveAnnounce(a.socket, b.playerId)).sentence).toBeNull();

    // The gun jams: combat hospitalises the shooter and publishes
    // player.backfired with the SHOOTER as actor — there is no player.killed.
    await db.update(playerStats).set({ hospitalUntil: soon() }).where(eq(playerStats.playerId, b.playerId));
    await publishEvent(redis, sentenceEvent("player.backfired", b.playerId));

    const tick = await frameOfKind(a.socket, "presence.tick");
    const announced = tick.joined.find((p) => p.playerId === b.playerId);
    expect(announced, "the backfired shooter is re-announced").toBeDefined();
    expect(announced!.sentence).toBe("hospital");
  });

  it("ignores a sentence event for a player the server could not place", async () => {
    const a = await joined(chicago, "Alone");
    await frameOfKind(a.socket, "presence.snapshot");
    // A socket alone is no longer enough to be out of every room — auto-join
    // sees to that. A player with no town still is: there is nowhere to put
    // them, so the sentence has no room to reach.
    const b = await playerIn(null, "Absent");
    await db.update(playerStats).set({ jailedUntil: soon() }).where(eq(playerStats.playerId, b.playerId));

    await publishEvent(redis, sentenceEvent("player.jailed", b.playerId));
    expect(await receivedFrameOfKind(a.socket, "presence.tick", 400)).toBe(false);
  });
});

describe("rate limiting", () => {
  it("drops a burst that outruns the bucket, without an error", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const b = await joined(chicago);
    const { x: sx, y: sy } = (await frameOfKind(b.socket, "presence.snapshot")).you;
    await liveAnnounce(a.socket, b.playerId);
    // `presence.join` spends a token from this same bucket, so give it time
    // to refill to its cap before the burst: at 10/s a full refill takes at
    // most one second.
    await new Promise((r) => setTimeout(r, 1200));
    for (let i = 1; i <= 40; i++) move(b.socket, i, sx + i * 0.01, sy);
    const moved = (await drainTicks(a.socket, 900)).flatMap((t) => t.moved);
    expect(moved.length).toBeGreaterThan(0);

    // Each move targets an absolute `sx + i × 0.01`, so the last position
    // the burst settled at names the LAST move that bought a token: ten
    // from the full bucket, plus at most a few refilled while the burst
    // landed — nothing like the forty asked for, which is the drop being
    // proven. Read as a count rather than compared as a float, because
    // `sx + 0.14` is not exact.
    const lastAccepted = Math.round((moved[moved.length - 1]!.x - sx) / 0.01);
    expect(lastAccepted).toBeGreaterThanOrEqual(10);
    expect(lastAccepted).toBeLessThanOrEqual(14);
    expect(await receivedFrameOfKind(b.socket, "presence.error", 300)).toBe(false);
  });

  it("closes a sustained flood with rate_limited", async () => {
    const b = await joined(chicago);
    await frameOfKind(b.socket, "presence.snapshot");
    const closed = new Promise<void>((resolve) => b.socket.once("close", () => resolve()));
    for (let i = 1; i <= 260; i++) move(b.socket, i, 0, 0);
    expect(await frameOfKind(b.socket, "presence.error")).toEqual({ kind: "presence.error", code: "rate_limited" });
    await closed;
  });
});

describe("presence ZSET", () => {
  it("a socket-only session shows in /api/online with its town, concealed when underground", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    await redis.zrem("presence", a.playerId); // forget the HTTP touches registration made
    sendFrame(a.socket, { kind: "presence.join", client: "godot-desktop" });
    await frameOfKind(a.socket, "presence.snapshot");
    expect(await redis.zscore("presence", a.playerId)).not.toBeNull();

    const viewer = await registerVerifiedPlayer({ app, redis });
    const online = await app.inject({ method: "GET", url: "/api/online", headers: { authorization: `Bearer ${viewer.token}` } });
    const me = (online.json() as { onlineNow: { playerId: string; locationName: string | null }[] }).onlineNow.find((e) => e.playerId === a.playerId);
    expect(me?.locationName).toBe("Chicago");

    await db.update(locations).set({ combatMode: "underground" }).where(eq(locations.id, chicago));
    const again = await app.inject({ method: "GET", url: "/api/online", headers: { authorization: `Bearer ${viewer.token}` } });
    expect((again.json() as { onlineNow: { playerId: string; locationName: string | null }[] }).onlineNow.find((e) => e.playerId === a.playerId)?.locationName).toBeNull();
  });
});

describe("travel to a town the server cannot resolve", () => {
  it("answers no_location for an unknown town, and the old room still sees left", async () => {
    const p = await playerIn(chicago);
    const q = await playerIn(chicago);
    const sent: { socket: WebSocket; frame: ServerFrame }[] = [];
    const rooms = createRooms({
      db, redis,
      scenes: createSceneService({ db, assetDriver, hooks: [], coreHooks: true }),
      send: (socket, frame) => { sent.push({ socket, frame }); },
      socketsOf: noSockets,
    });
    try {
      await rooms.join(p.playerId, p.socket, null);
      await rooms.join(q.playerId, q.socket, null);
      sent.length = 0;
      await rooms.onEvent(travelled(p.playerId, uuidv7())); // a town that does not exist

      // The traveller is answered rather than dropped in silence. Filtered
      // to errors first: a 200 ms tick can land in `sent` alongside them.
      const errorFrames = sent.filter((e) => isError(e.frame));
      expect(errorFrames.map((e) => e.frame)).toEqual([{ kind: "presence.error", code: "no_location" }]);
      expect(errorFrames[0]!.socket).toBe(p.socket);

      // ...and the room it left still hears about the departure.
      await new Promise((r) => setTimeout(r, 400));
      expect(sent.map((e) => e.frame).filter(isTick).flatMap((t) => t.left)).toEqual([p.playerId]);
    } finally {
      rooms.close();
    }
  });

  it("answers not_joined when the destination lookup throws", async () => {
    const p = await playerIn(chicago);
    // Joined against a live connection, then the connection is ended under
    // it: the destination read inside onEvent is what fails, not the join.
    const dying = createDb(loadConfig(process.env).databaseUrl);
    const frames: ServerFrame[] = [];
    const rooms = createRooms({
      db: dying.db, redis,
      scenes: createSceneService({ db: dying.db, assetDriver, hooks: [], coreHooks: true }),
      send: (_socket, frame) => { frames.push(frame); },
      socketsOf: noSockets,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await rooms.join(p.playerId, p.socket, null);
      expect(frames.filter(isSnapshot)).toHaveLength(1);
      await dying.sql.end();

      await rooms.onEvent(travelled(p.playerId, miami));
      expect(frames.filter(isError)).toEqual([{ kind: "presence.error", code: "not_joined" }]);
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({ playerId: p.playerId }), "presence: travel lookup failed",
      );
    } finally {
      errors.mockRestore();
      rooms.close();
    }
  });
});

describe("travel racing the traveller's own socket", () => {
  it("bails out when the last socket closes during the destination lookup", async () => {
    const p = await playerIn(chicago);
    const sent: ServerFrame[] = [];
    const rooms = createRooms({
      db, redis,
      scenes: createSceneService({ db, assetDriver, hooks: [], coreHooks: true }),
      send: (_socket, frame) => { sent.push(frame); },
      socketsOf: noSockets,
    });
    try {
      await rooms.join(p.playerId, p.socket, null);

      // The gateway fires onEvent without awaiting it, so a close CAN land
      // while the destination read is still in flight. Drive exactly that
      // interleaving rather than race it: onEvent suspends on its first
      // await, the close then runs to completion synchronously.
      const travelling = rooms.onEvent(travelled(p.playerId, miami));
      rooms.socketClosed(p.socket);
      await travelling;

      // Nobody arrived in Miami. Without the re-read, the stale member
      // captured before the await lands there holding an empty socket Set
      // — a ghost no close, leave or travel can ever remove, because
      // nothing is left to fire one.
      const q = await playerIn(miami);
      sent.length = 0;
      await rooms.join(q.playerId, q.socket, null);
      const snapshots = sent.filter(isSnapshot);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.players).toEqual([]);
    } finally {
      rooms.close();
    }
  });
});

describe("join racing the socket's own close", () => {
  it("bails out when the socket closes during the join lookup", async () => {
    const p = await playerIn(chicago);
    const sent: ServerFrame[] = [];
    const rooms = createRooms({
      db, redis,
      scenes: createSceneService({ db, assetDriver, hooks: [], coreHooks: true }),
      send: (_socket, frame) => { sent.push(frame); },
      socketsOf: noSockets,
    });
    try {
      // join suspends on its first await, so closing synchronously after
      // the call produces exactly the interleaving the gateway can produce
      // — it dispatches join un-awaited. Deterministic, not raced.
      const joining = rooms.join(p.playerId, p.socket, null);
      p.socket.close();
      rooms.socketClosed(p.socket);
      await joining;
      expect(sent).toEqual([]);

      // Without the liveness re-read, join resumes and inserts a member
      // holding one dead socket. `detach` already ran and found no member
      // to remove, and nothing will ever fire a close for that socket
      // again, so the ghost is listed to every later arrival forever.
      const q = await playerIn(chicago);
      sent.length = 0;
      await rooms.join(q.playerId, q.socket, null);
      const snapshots = sent.filter(isSnapshot);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.players).toEqual([]);
    } finally {
      rooms.close();
    }
  });
});

describe("join is bucketed", () => {
  it("drops a join burst that outruns the bucket, silently", async () => {
    const a = await playerIn(chicago);
    for (let i = 0; i < 40; i++) sendFrame(a.socket, { kind: "presence.join", client: "web" });

    // Count what the bucket paid for rather than pinning an exact number:
    // ten tokens, plus whatever refills while forty frames land — nothing
    // like the forty asked for, which is the drop being proven. Draining
    // by kind also covers "and no error", which an over-budget frame must
    // not produce until dropLimit; `receivedFrameOfKind` would have
    // discarded an error on its way past a snapshot.
    let snapshots = 0;
    const deadline = Date.now() + 900;
    for (let left = 900; left > 0; left = deadline - Date.now()) {
      let frame: ServerFrame;
      try { frame = await nextFrame(a.socket, left); } catch { break; }
      if (isSnapshot(frame)) snapshots += 1;
      expect(isError(frame)).toBe(false);
    }
    expect(snapshots).toBeGreaterThanOrEqual(10);
    expect(snapshots).toBeLessThanOrEqual(14);

    // A single join is untouched by any of this.
    const b = await joined(chicago);
    expect((await frameOfKind(b.socket, "presence.snapshot")).you.playerId).toBe(b.playerId);
  });
});


describe("auto-join", () => {
  it("puts a connected socket in the room as a static member, and sends it nothing", async () => {
    const watcher = await joined(chicago, "Watcher");
    const snapW = await frameOfKind(watcher.socket, "presence.snapshot");

    // Connects and asks for nothing. The watcher's tick is the auto-join
    // landing, so the wait below is a synchronisation point, not a sleep.
    const quiet = await playerIn(chicago, "Quiet");
    const tick = await frameOfKind(watcher.socket, "presence.tick");
    expect(tick.joined.map((p) => p.playerId)).toEqual([quiet.playerId]);
    expect(tick.joined[0]!.static).toBe(true);
    const spot = staticSpotFor(quiet.playerId, snapW.room);
    expect(tick.joined[0]).toMatchObject({ x: spot.x, y: spot.y, username: "Quiet" });

    // A player joining afterwards sees them in the snapshot, in the same spot.
    const late = await joined(chicago, "Late");
    const seen = (await frameOfKind(late.socket, "presence.snapshot")).players
      .find((p) => p.playerId === quiet.playerId);
    expect(seen).toMatchObject({ static: true, x: spot.x, y: spot.y });

    // ...and the socket that asked for nothing is told nothing, although it
    // is a member of a room where two other players just arrived.
    await expectNoPresenceFrames(quiet.socket, 700);
  });

  it("stands every player on the pavement on the spawn's side of the street", async () => {
    const watcher = await joined(chicago, "Surveyor");
    const { room } = await frameOfKind(watcher.socket, "presence.snapshot");
    const spot = staticSpotFor(watcher.playerId, room);
    // The pavement runs between the road edge (7.5) and the building line
    // (10.5), on the spawn's own side, across the spawn lot.
    expect(Math.abs(spot.y)).toBe(9);
    expect(Math.sign(spot.y)).toBe(room.spawn.y < 0 ? -1 : 1);
    expect(spot.x).toBeGreaterThanOrEqual(room.spawn.x - 8);
    expect(spot.x).toBeLessThanOrEqual(room.spawn.x + 8);
    // Pure: the same id and scene give the same answer, every time.
    expect(staticSpotFor(watcher.playerId, room)).toEqual(spot);
  });

  it("hands the avatar over on a later presence.join, without moving it", async () => {
    const watcher = await joined(chicago, "Watcher2");
    await frameOfKind(watcher.socket, "presence.snapshot");
    const p = await playerIn(chicago, "Quiet2");
    expect((await frameOfKind(watcher.socket, "presence.tick")).joined[0]!.static).toBe(true);

    sendFrame(p.socket, { kind: "presence.join", client: "android" });
    const snap = await frameOfKind(p.socket, "presence.snapshot");
    const spot = staticSpotFor(p.playerId, snap.room);
    expect(snap.you.static).toBe(false);
    expect(snap.you).toMatchObject({ x: spot.x, y: spot.y });

    const flip = await frameOfKind(watcher.socket, "presence.tick");
    expect(flip.joined.map((x) => x.playerId)).toEqual([p.playerId]);
    expect(flip.joined[0]!.static).toBe(false);

    // Driving works from there exactly as it does for any other member.
    move(p.socket, 1, spot.x + 0.2, spot.y);
    const moved = (await movedTick(watcher.socket)).moved[0]!;
    expect(moved.playerId).toBe(p.playerId);
    expect(moved.x).toBeCloseTo(spot.x + 0.2, 5);
  });

  it("tells the room left when a static member's only socket closes", async () => {
    const watcher = await joined(chicago, "Watcher3");
    await frameOfKind(watcher.socket, "presence.snapshot");
    const p = await playerIn(chicago, "Ghost");
    expect((await frameOfKind(watcher.socket, "presence.tick")).joined[0]!.static).toBe(true);
    p.socket.close();
    expect((await leftTick(watcher.socket)).left).toEqual([p.playerId]);
  });

  it("falls back to static at the last position when the driving socket closes", async () => {
    const p = await playerIn(chicago, "Driver");
    const second = await openSocket(`${baseUrl}?ticket=${await mintTicket(app, p.token)}`);
    opened.push(second);
    expect((await nextFrame(second)).kind).toBe("ready");
    const w = await playerIn(chicago, "Watcher4");

    // Driven directly rather than through the gateway: a second socket's
    // auto-join produces no frame anywhere (the member already exists and
    // nothing about it changes), so there is nothing to wait for, and racing
    // the close against it would decide this test by timing.
    const sent: ServerFrame[] = [];
    const rooms = createRooms({
      db, redis,
      scenes: createSceneService({ db, assetDriver, hooks: [], coreHooks: true }),
      send: (_socket, frame) => { sent.push(frame); },
      socketsOf: noSockets,
    });
    try {
      await rooms.join(w.playerId, w.socket, null);
      await rooms.autoJoin(p.playerId, second, null);
      await rooms.join(p.playerId, p.socket, null);
      const spot = staticSpotFor(p.playerId, sent.filter(isSnapshot)[0]!.room);
      // Drive it somewhere the static spot is not, so "no teleport" is a
      // claim the assertion can actually distinguish.
      await new Promise((r) => setTimeout(r, 120));
      rooms.move(p.socket, { seq: 1, x: spot.x + 0.5, y: spot.y, facing: 0 });
      await new Promise((r) => setTimeout(r, 400));
      sent.length = 0;

      rooms.socketClosed(p.socket);
      await new Promise((r) => setTimeout(r, 400));
      const ticks = sent.filter(isTick);
      const announced = ticks.flatMap((t) => t.joined).filter((j) => j.playerId === p.playerId);
      expect(announced.at(-1)?.static, "the member is re-announced as static").toBe(true);
      expect(announced.at(-1)!.x).toBeCloseTo(spot.x + 0.5, 5);
      // Still here: a socket of theirs is open, so nobody left.
      expect(ticks.flatMap((t) => t.left)).toEqual([]);
    } finally {
      rooms.close();
    }
  });

  it("auto-joins a player whose town only arrives with their first travel", async () => {
    const watcher = await joined(miami, "MiamiWatcher");
    await frameOfKind(watcher.socket, "presence.snapshot");
    // Registered nowhere, so the auto-join at connect has no room to use.
    const drifter = await playerIn(null, "Drifter");
    await db.update(playerStats).set({ cash: 10_000n }).where(eq(playerStats.playerId, drifter.playerId));
    const res = await app.inject({
      method: "POST", url: `/api/travel/${miami}`, headers: { authorization: `Bearer ${drifter.token}` },
    });
    expect(res.statusCode).toBe(200);

    const tick = await frameOfKind(watcher.socket, "presence.tick");
    expect(tick.joined.map((p) => p.playerId)).toEqual([drifter.playerId]);
    expect(tick.joined[0]!.static).toBe(true);
    // Still a socket that asked for nothing.
    await expectNoPresenceFrames(drifter.socket, 500);
  });

  it("never announces an auto-joined member in a concealed town", async () => {
    await db.update(locations).set({ combatMode: "underground" }).where(eq(locations.id, chicago));
    const watcher = await joined(chicago, "Undercover");
    expect((await frameOfKind(watcher.socket, "presence.snapshot")).concealed).toBe(true);

    const hidden = await playerIn(chicago, "Hidden");
    expect(await receivedFrameOfKind(watcher.socket, "presence.tick", 700)).toBe(false);
    const late = await joined(chicago, "Late2");
    expect((await frameOfKind(late.socket, "presence.snapshot")).players).toEqual([]);

    // Concealment is the only thing hiding them: the member was auto-joined
    // all along, and the room's mode is re-read on every arrival. Without
    // this the assertions above pass just as well with auto-join deleted.
    await db.update(locations).set({ combatMode: "open" }).where(eq(locations.id, chicago));
    const opened2 = await joined(chicago, "Late3");
    const snap = await frameOfKind(opened2.socket, "presence.snapshot");
    expect(snap.concealed).toBe(false);
    expect(snap.players.find((p) => p.playerId === hidden.playerId)?.static).toBe(true);
  });

  it("keeps an auto-joined socket unable to move, emote or leave", async () => {
    const p = await playerIn(chicago, "Passenger");
    move(p.socket, 1, 0, 0);
    expect(await frameOfKind(p.socket, "presence.error")).toEqual({ kind: "presence.error", code: "not_joined" });
    sendFrame(p.socket, { kind: "presence.emote", emote: "wave" });
    expect(await frameOfKind(p.socket, "presence.error")).toEqual({ kind: "presence.error", code: "not_joined" });
    sendFrame(p.socket, { kind: "presence.leave" });
    expect(await frameOfKind(p.socket, "presence.error")).toEqual({ kind: "presence.error", code: "not_joined" });

    // ...and it is still a member the room can see, so the refusals above
    // are about this socket's subscription, not about presence being absent.
    const watcher = await joined(chicago, "Watcher5");
    const seen = (await frameOfKind(watcher.socket, "presence.snapshot")).players
      .find((x) => x.playerId === p.playerId);
    expect(seen?.static).toBe(true);
  });
});
