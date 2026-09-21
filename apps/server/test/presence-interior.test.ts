import type { AddressInfo } from "node:net";
import type { GameEvent, ServerFrame } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { publishEvent } from "../src/bus/publish.js";
import { locations, playerStats } from "../src/db/schema/index.js";
import { seedLocations } from "../src/db/seed.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { frameOfKind, mintTicket, nextFrame, openSocket, sendFrame } from "./helpers/ws.js";

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
const isTick = (f: ServerFrame): f is Extract<ServerFrame, { kind: "presence.tick" }> =>
  f.kind === "presence.tick";

type Tick = Extract<ServerFrame, { kind: "presence.tick" }>;

/**
 * Every tick a socket receives over `withinMs`, not just the first — the
 * `presence-rooms` harness's helper, for its reason: a burst bigger than one
 * 200 ms flush window straddles a flush, so the FIRST tick after it can carry
 * a partial result.
 */
async function drainTicks(socket: WebSocket, withinMs: number): Promise<Tick[]> {
  const ticks: Tick[] = [];
  const deadline = Date.now() + withinMs;
  for (let left = withinMs; left > 0; left = deadline - Date.now()) {
    let frame: ServerFrame;
    try { frame = await nextFrame(socket, left); } catch { break; }
    if (isTick(frame)) ticks.push(frame);
  }
  return ticks;
}

/**
 * The next tick this socket receives that says something about `ok`.
 *
 * Auto-join announces every connecting socket as a static member and the
 * `presence.join` that takes the avatar over re-announces it, so a bare
 * `frameOfKind(socket, "presence.tick")` is not a reliable way to read the
 * tick a test means. This skips the ones carrying something else — it never
 * weakens an assertion, it only aims it.
 */
async function tickWhere(socket: WebSocket, ok: (t: Tick) => boolean, timeoutMs = 4000): Promise<Tick> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tick = await frameOfKind(socket, "presence.tick", Math.max(1, deadline - Date.now()));
    if (ok(tick)) return tick;
  }
}

const enter = (socket: WebSocket, hookId = "casino.casino") => sendFrame(socket, { kind: "presence.enter", hookId });
const exit = (socket: WebSocket) => sendFrame(socket, { kind: "presence.exit" });

/** A joined player who has walked through the casino door and holds the interior snapshot. */
async function joinedInside(locationId: string, username?: string) {
  const p = await joined(locationId, username);
  await frameOfKind(p.socket, "presence.snapshot");
  enter(p.socket);
  const snap = await frameOfKind(p.socket, "presence.snapshot");
  expect(snap.room.space?.kind).toBe("interior");
  return { ...p, snap };
}

describe("presence.enter / presence.exit (spec 2026-09-20 casino-interior §4.3)", () => {
  it("moves the caller into the casino: interior snapshot, left on the street, joined inside", async () => {
    const watcher = await joined(chicago, "watcher");        // stays on the street
    await frameOfKind(watcher.socket, "presence.snapshot");
    const inside = await joined(chicago, "insider");         // already inside
    await frameOfKind(inside.socket, "presence.snapshot");
    enter(inside.socket);
    await frameOfKind(inside.socket, "presence.snapshot");
    const a = await joined(chicago, "alice");
    await frameOfKind(a.socket, "presence.snapshot");
    enter(a.socket);
    const snap = await frameOfKind(a.socket, "presence.snapshot");
    expect(snap.room.sceneKey).toBe("casino-floor-v2");
    expect(snap.room.space).toMatchObject({ kind: "interior", locationId: chicago, hookId: "casino.casino" });
    expect(snap.room.points?.length).toBe(10);
    expect(snap.you).toMatchObject({ x: snap.room.spawn.x, y: snap.room.spawn.y, facing: snap.room.spawn.facing });
    expect(snap.players.map((p) => p.playerId)).toEqual([inside.playerId]);
    const street = await tickWhere(watcher.socket, (t) => t.left.includes(a.playerId));
    expect(street.space?.kind).toBe("street");
    const floor = await tickWhere(inside.socket, (t) => t.joined.some((p) => p.playerId === a.playerId));
    expect(floor.space?.kind).toBe("interior");
  });

  it("scopes movement to the space: inside sees inside, the street does not", async () => {
    const watcher = await joined(chicago);
    await frameOfKind(watcher.socket, "presence.snapshot");
    const a = await joinedInside(chicago);
    const b = await joinedInside(chicago);
    // Only A's socket is drained, and only to let the 6 m/s rubber band's
    // `dt` grow past the step below: a `nextFrame` that times out leaves its
    // resolver armed in `helpers/ws.ts`, so the next frame on THAT socket is
    // swallowed — draining a socket a later assertion waits on would eat the
    // very tick it is waiting for. `tickWhere` filters by predicate, so the
    // arrival ticks already queued on B and the watcher need no draining.
    await drainTicks(a.socket, 400);
    // A metre from the casino floor's spawn (0, -7.5): a longer step is
    // clamped by the rubber band, which would prove nothing about scoping.
    move(a.socket, 1, -1, -7);
    const seen = await tickWhere(b.socket, (t) => t.moved.some((m) => m.playerId === a.playerId));
    expect(seen.moved.find((m) => m.playerId === a.playerId)).toMatchObject({ x: -1, y: -7 });
    expect((await drainTicks(watcher.socket, 500)).some((t) => t.moved.some((m) => m.playerId === a.playerId))).toBe(false);
  });

  it("exit lands on the street at the door's exit spot and tells both rooms", async () => {
    const watcher = await joined(chicago);
    const streetSnap = await frameOfKind(watcher.socket, "presence.snapshot");
    const door = streetSnap.room.hooks.find((h) => h.id === "casino.casino")!;
    const a = await joinedInside(chicago);
    const b = await joinedInside(chicago);
    // Neither B nor the watcher is drained: both are waited on below, and a
    // timed-out `nextFrame` swallows the next frame on its socket (see the
    // test above). `tickWhere` skips the arrival ticks already queued.
    exit(a.socket);
    const snap = await frameOfKind(a.socket, "presence.snapshot");
    expect(snap.room.space).toEqual({ kind: "street", locationId: chicago });
    expect(a.snap.room.space?.kind === "interior" ? a.snap.room.space.exit : null)
      .toMatchObject({ x: door.position.x, y: 7.5, facing: Math.PI });
    expect(snap.you).toMatchObject({ x: door.position.x, y: 7.5, facing: Math.PI });
    await tickWhere(b.socket, (t) => t.left.includes(a.playerId));
    // Qualified by the ARRIVAL position, not just the id: the watcher's queue
    // still holds the tick from A's original street auto-join, which carries
    // `joined: [A]` at A's static spot and would satisfy a bare id match
    // whether or not the exit re-announced anything.
    await tickWhere(watcher.socket, (t) =>
      t.joined.some((p) => p.playerId === a.playerId && p.x === door.position.x && p.y === 7.5));
  });

  it("refuses each bad transition with its code", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    exit(a.socket);
    expect((await frameOfKind(a.socket, "presence.error")).code).toBe("wrong_space");
    enter(a.socket, "casino.nope");
    expect((await frameOfKind(a.socket, "presence.error")).code).toBe("unknown_hook");
    enter(a.socket, "travel.station");
    expect((await frameOfKind(a.socket, "presence.error")).code).toBe("no_interior");
    enter(a.socket);
    await frameOfKind(a.socket, "presence.snapshot");
    enter(a.socket, "travel.station");
    expect((await frameOfKind(a.socket, "presence.error")).code).toBe("wrong_space");
    const never = await playerIn(chicago);            // auto-joined static, never sent join
    enter(never.socket);
    expect((await frameOfKind(never.socket, "presence.error")).code).toBe("not_joined");
    const nowhere = await joined(null);
    expect((await frameOfKind(nowhere.socket, "presence.error")).code).toBe("no_location");
    enter(nowhere.socket);
    expect((await frameOfKind(nowhere.socket, "presence.error")).code).toBe("not_joined");
  });

  it("refuses a sentenced player and re-reads the row rather than trusting state", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    await db.update(playerStats).set({ jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, a.playerId));
    enter(a.socket);
    expect((await frameOfKind(a.socket, "presence.error")).code).toBe("sentenced");
    await db.update(playerStats).set({ jailedUntil: null, hospitalUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, a.playerId));
    enter(a.socket);
    expect((await frameOfKind(a.socket, "presence.error")).code).toBe("sentenced");
  });

  it("only the controller may enter; a superseded socket is told so", async () => {
    const a = await joined(chicago);
    await frameOfKind(a.socket, "presence.snapshot");
    const second = await openSocket(`${baseUrl}?ticket=${await mintTicket(app, a.token)}`);
    opened.push(second);
    expect((await nextFrame(second)).kind).toBe("ready");
    sendFrame(second, { kind: "presence.join", client: "web" });
    await frameOfKind(second, "presence.snapshot");
    expect((await frameOfKind(a.socket, "presence.error")).code).toBe("superseded");
    enter(a.socket);
    expect((await frameOfKind(a.socket, "presence.error")).code).toBe("superseded");
    enter(second);
    const snap = await frameOfKind(second, "presence.snapshot");
    expect(snap.room.space?.kind).toBe("interior");
    // The superseded socket is still a socket of the member: it gets the interior snapshot too.
    expect((await frameOfKind(a.socket, "presence.snapshot")).room.space?.kind).toBe("interior");
  });
});

describe("presence.join with an interior hint (spec §4.3, §7)", () => {
  it("lands a fresh socket straight inside", async () => {
    const p = await playerIn(chicago);
    sendFrame(p.socket, { kind: "presence.join", client: "godot-desktop", interior: "casino.casino" });
    const street = await frameOfKind(p.socket, "presence.snapshot");
    expect(street.room.space?.kind).toBe("street");
    const inside = await frameOfKind(p.socket, "presence.snapshot");
    expect(inside.room.space?.kind).toBe("interior");
  });

  it("a hint that cannot be honoured leaves the player on the street with the code", async () => {
    const p = await playerIn(chicago);
    sendFrame(p.socket, { kind: "presence.join", client: "godot-desktop", interior: "travel.station" });
    await frameOfKind(p.socket, "presence.snapshot");
    expect((await frameOfKind(p.socket, "presence.error")).code).toBe("no_interior");
  });

  it("a second socket of a member already inside snapshots the interior, and a bare re-join does not pull them out", async () => {
    const a = await joinedInside(chicago);
    const second = await openSocket(`${baseUrl}?ticket=${await mintTicket(app, a.token)}`);
    opened.push(second);
    expect((await nextFrame(second)).kind).toBe("ready");
    sendFrame(second, { kind: "presence.join", client: "web" });
    expect((await frameOfKind(second, "presence.snapshot")).room.space?.kind).toBe("interior");
    sendFrame(a.socket, { kind: "presence.join", client: "godot-desktop" });
    expect((await frameOfKind(a.socket, "presence.snapshot")).room.space?.kind).toBe("interior");
  });
});

/** The `player.jailed` the bus delivers, built the way `base` in events.ts requires. */
const jailed = (actorId: string): GameEvent => ({
  id: uuidv7(), type: "player.jailed", at: new Date().toISOString(),
  actorId, actorName: "convict", audience: { kind: "player", playerId: actorId },
  until: new Date(Date.now() + 60_000).toISOString(), reason: "test",
});

/** A `player.travelled`, the way the bus delivers one. */
const travelled = (actorId: string, toLocationId: string): GameEvent => ({
  id: uuidv7(), type: "player.travelled", at: new Date().toISOString(),
  actorId, actorName: "traveller", audience: { kind: "player", playerId: actorId },
  fromLocationId: null, toLocationId, cost: "0",
});

describe("bus events and lifecycle inside an interior (spec §4.3)", () => {
  it("a jail event forces the member out to the exit spot and re-announces the sentence", async () => {
    const watcher = await joined(chicago, "watcher");
    await frameOfKind(watcher.socket, "presence.snapshot");
    const a = await joinedInside(chicago, "alice");
    const space = a.snap.room.space;
    if (space?.kind !== "interior") throw new Error("expected the casino interior");

    // The row is the truth, not the event — `refreshSentence` re-reads it.
    await db.update(playerStats).set({ jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, a.playerId));
    await publishEvent(redis, jailed(a.playerId));

    const snap = await frameOfKind(a.socket, "presence.snapshot");
    expect(snap.room.space).toEqual({ kind: "street", locationId: chicago });
    expect(snap.you.sentence).toBe("jail");
    expect(snap.you).toMatchObject({ x: space.exit.x, y: space.exit.y });
    // Qualified by the ARRIVAL position rather than drained: the watcher's
    // queue still holds A's original street auto-join, which carries
    // `joined: [A]` at A's static spot and would satisfy a bare id match. A
    // drain would be worse than useless here — a timed-out `nextFrame`
    // leaves its resolver armed, so it would eat the tick waited on next.
    const t = await tickWhere(watcher.socket, (f) =>
      f.joined.some((p) => p.playerId === a.playerId && p.x === space.exit.x && p.y === space.exit.y));
    expect(t.joined.find((p) => p.playerId === a.playerId)?.sentence).toBe("jail");
  });

  it("travel from inside lands on the destination street", async () => {
    const a = await joinedInside(chicago);
    await db.update(playerStats).set({ locationId: miami }).where(eq(playerStats.playerId, a.playerId));
    await publishEvent(redis, travelled(a.playerId, miami));
    const snap = await frameOfKind(a.socket, "presence.snapshot");
    expect(snap.room.locationId).toBe(miami);
    expect(snap.room.space).toEqual({ kind: "street", locationId: miami });
  });

  it("an underground town conceals its interior too", async () => {
    await db.update(locations).set({ combatMode: "underground" }).where(eq(locations.id, chicago));
    const a = await joinedInside(chicago);
    expect(a.snap.concealed).toBe(true);
    expect(a.snap.players).toEqual([]);
    const b = await joinedInside(chicago);
    expect(b.snap.concealed).toBe(true);
    expect(b.snap.players).toEqual([]);
    move(a.socket, 1, 1, 1);
    // B is not waited on again, so this drain is safe as the last read.
    expect((await drainTicks(b.socket, 600)).length).toBe(0);
  });

  it("closing the driving socket with a second socket open demotes in place, inside", async () => {
    const b = await joinedInside(chicago, "bystander");
    const a = await joinedInside(chicago, "alice");
    const second = await openSocket(`${baseUrl}?ticket=${await mintTicket(app, a.token)}`);
    opened.push(second);
    expect((await nextFrame(second)).kind).toBe("ready");
    // The SECOND socket takes the wheel, and is the one closed below. That
    // is what makes this deterministic rather than timed: `ready` is sent
    // before the gateway dispatches its un-awaited auto-join
    // (`ws/gateway.ts`), and adding a static socket to an existing member
    // produces no frame to wait on — but `join` adds the socket AND answers
    // it with a snapshot in the one call, so that snapshot is a hard
    // barrier. A re-join never moves the avatar and a member already inside
    // re-joins into its interior room, so A stays at its interior spawn.
    sendFrame(second, { kind: "presence.join", client: "web" });
    expect((await frameOfKind(second, "presence.snapshot")).room.space?.kind).toBe("interior");
    // A's first socket is told `superseded` here; nothing reads it again.
    second.close();
    // `static: true` identifies the demote announce exactly: A entered the
    // interior driven, so the arrival tick already queued on B carries
    // `static: false` and cannot satisfy this — which is why B needs no
    // draining, and must not be drained, since it is waited on here.
    const t = await tickWhere(b.socket, (f) =>
      f.joined.some((p) => p.playerId === a.playerId && p.static === true));
    // A never moved, so its interior spawn IS "in place".
    expect(t.joined.find((p) => p.playerId === a.playerId))
      .toMatchObject({ static: true, x: a.snap.you.x, y: a.snap.you.y });
    expect(t.space?.kind).toBe("interior");
  });

  it("closing the only socket inside tells the interior left, and the street nothing", async () => {
    const watcher = await joined(chicago, "watcher");
    await frameOfKind(watcher.socket, "presence.snapshot");
    const b = await joinedInside(chicago, "bystander");
    const a = await joinedInside(chicago, "alice");
    // A positive barrier, not a drain: both players' departures from the
    // street must be consumed before the negative below, and a timed-out
    // drain would leave its resolver armed and eat that read's first frame.
    // B entered first, so its `left` is in this tick or an earlier one this
    // skips — either way both are behind us when it returns.
    await tickWhere(watcher.socket, (t) => t.left.includes(a.playerId));
    a.socket.close();
    await tickWhere(b.socket, (t) => t.left.includes(a.playerId));
    expect((await drainTicks(watcher.socket, 500)).some((t) => t.left.includes(a.playerId))).toBe(false);
  });
});
