import type {
  AvatarBody, Emote, GameEvent, PresenceErrorCode, PresenceMoved, PresenceState,
  RoomDescriptor, Sentence, ServerFrame,
} from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import type { Db } from "../db/client.js";
import { players, playerStats } from "../db/schema/index.js";
import type { SceneService } from "../world/scene.js";
import { touchPresence } from "./touch.js";

/** Spec 2026-09-17 §1.3 — every figure here is a griefing control, not a security one. */
export const PRESENCE = {
  tickMs: 200,
  maxSpeed: 6,          // m/s
  minDtMs: 50,
  bucketSize: 10,
  refillPerSecond: 10,
  dropLimit: 200,       // drops within dropWindowMs → rate_limited + close
  dropWindowMs: 60_000,
  zsetTouchMs: 60_000,
} as const;

export interface RoomsDeps {
  db: Db;
  redis: Redis;
  scenes: SceneService;
  send(socket: WebSocket, frame: ServerFrame): void;
  /**
   * Every open socket of one player — the gateway's own map (spec 2026-09-19
   * §2 "Late location"). Required rather than defaulted, the `coreHooks`
   * discipline: an absent implementation would silently cost a fresh account
   * its first auto-join instead of failing loudly at the call site.
   */
  socketsOf(playerId: string): Iterable<WebSocket>;
  now?: () => number;
}

export interface Rooms {
  /**
   * `interior` is the reconnect hint (spec 2026-09-20 casino-interior §4.3):
   * the join answers with the street snapshot and then walks the player
   * through that door, so a client that was inside when it dropped lands
   * back inside in one round trip.
   */
  join(playerId: string, socket: WebSocket, ip: string | null, interior?: string): Promise<void>;
  autoJoin(playerId: string, socket: WebSocket, ip: string | null): Promise<void>;
  /** Walk the caller's avatar through a door of the room it stands in. */
  enter(socket: WebSocket, hookRef: string): Promise<void>;
  /** Walk the caller's avatar back out onto the street, in front of the door. */
  exit(socket: WebSocket): Promise<void>;
  move(socket: WebSocket, frame: { seq: number; x: number; y: number; facing: number }): void;
  emote(socket: WebSocket, emote: Emote): void;
  leave(socket: WebSocket): void;
  socketClosed(socket: WebSocket): void;
  onEvent(event: GameEvent): Promise<void>;
  close(): void;
}

interface Member {
  state: PresenceState;
  sockets: Set<WebSocket>;
  /**
   * The socket whose moves drive the avatar — the most recent joiner, or
   * `null` when nobody has asked to drive. `null` IS `state.static`: one
   * fact in two places, kept in step by `demote` and by `join`'s take-over.
   */
  controller: WebSocket | null;
  lastMoveAt: number;
  zsetTouchedAt: number;
  ip: string | null;
}

interface Room {
  /**
   * How this room is keyed in `rooms`, in `memberRoom` and in
   * `SocketState.roomId`. For a STREET room it is exactly the town's
   * `locationId`, so every key this file wrote before interiors existed is
   * unchanged — but a town can hold more than one room now (spec 2026-09-20
   * casino-interior §4.3), so nothing may key a room by its descriptor's
   * `locationId` any more.
   */
  key: string;
  descriptor: RoomDescriptor;
  concealed: boolean;
  members: Map<string, Member>;
  dirty: {
    joined: Map<string, PresenceState>;
    moved: Map<string, PresenceMoved>;
    emoted: { playerId: string; emote: Emote }[];
    left: Set<string>;
  };
}

interface SocketState {
  playerId: string;
  ip: string | null;
  /**
   * This socket sent `presence.join` and is therefore owed presence frames.
   * An auto-joined socket asked for nothing, so it is left `false` and the
   * room never writes to it (spec 2026-09-19 §2 "Recipients").
   */
  subscribed: boolean;
  roomId: string | null;
  lastSeq: number;
  tokens: number;
  tokensAt: number;
  drops: number;
  dropsWindowStart: number;
}

/** What `joinTarget` resolved: a room to join, or the code to answer with. */
type JoinTarget =
  | { ok: true; gangId: string | null; username: string; sentence: Sentence; room: Room }
  | { ok: false; code: "not_joined" | "no_location" };

const AVATARS: readonly AvatarBody[] = ["suit-dark", "suit-light", "coat", "dress"];

/** The one hash fold both derived-from-the-id facts below share. */
function fold(playerId: string): number {
  let h = 0;
  for (let i = 0; i < playerId.length; i++) h = (h * 31 + playerId.charCodeAt(i)) >>> 0;
  return h;
}

/** v1 avatar: a stable function of the id, so every client draws the same body (spec §1.1). */
export function avatarFor(playerId: string): AvatarBody {
  return AVATARS[fold(playerId) % AVATARS.length]!;
}

/**
 * Where a player stands while nobody is driving them (spec 2026-09-19 §2).
 *
 * Pure and deterministic, so every client in the town draws the same avatar
 * in the same spot: the spawn's side of the street, on the pavement between
 * the road edge (7.5 m) and the building line (10.5 m), spread across the
 * spawn lot `[spawn.x − 8, spawn.x + 8]` by the same fold `avatarFor` uses.
 * `spawn.y === 0` counts as the north side.
 *
 * Clamped to the scene bounds, which the formula alone does not guarantee: a
 * scene smaller than those offsets would otherwise stand its static members
 * outside their own room, and the first move any of them made would be
 * rubber-banded in from out there.
 */
export function staticSpotFor(playerId: string, descriptor: RoomDescriptor): { x: number; y: number } {
  const b = descriptor.bounds;
  const x = descriptor.spawn.x + (fold(playerId) % 17) - 8;
  const y = descriptor.spawn.y < 0 ? -9 : 9;
  return {
    x: Math.min(b.maxX, Math.max(b.minX, x)),
    y: Math.min(b.maxY, Math.max(b.minY, y)),
  };
}

/** The two columns every sentence read selects. */
interface SentenceRow { jailedUntil: Date | null; hospitalUntil: Date | null }

/**
 * Where a player is confined (spec 2026-09-18 §3). Pure. `jail` wins when
 * both columns are set, matching the sentence sweeper's own precedence; a
 * null column, or one already elapsed, is no sentence at all.
 */
export function sentenceOf(row: SentenceRow, now: number): Sentence {
  if (row.jailedUntil !== null && row.jailedUntil.getTime() > now) return "jail";
  if (row.hospitalUntil !== null && row.hospitalUntil.getTime() > now) return "hospital";
  return null;
}

const emptyDirty = (): Room["dirty"] => ({ joined: new Map(), moved: new Map(), emoted: [], left: new Set() });

export function createRooms(deps: RoomsDeps): Rooms {
  const now = deps.now ?? Date.now;
  const rooms = new Map<string, Room>();
  const socketStates = new WeakMap<WebSocket, SocketState>();
  /** playerId → the room they are a member of (one avatar per player). */
  const memberRoom = new Map<string, string>();

  const stateOf = (socket: WebSocket): SocketState | undefined => socketStates.get(socket);
  /** `ws` moves `readyState` off OPEN synchronously on close, so this is a live read. */
  const isOpen = (socket: WebSocket): boolean => socket.readyState === socket.OPEN;

  /**
   * The socket's frame budget, created on first use rather than on join, so
   * that `presence.join` — three round trips, two Redis writes and a full
   * snapshot, the most expensive frame there is — is bucketed like every
   * other frame instead of being the one way to flood the server for free.
   * A socket that has not joined carries `roomId: null` and `subscribed:
   * false`, which `move` and `emote` read as not-joined and which `detach`
   * reads as nothing to give up on an explicit `presence.leave`. Auto-join
   * creates the state too, and leaves both of those exactly as they are.
   */
  const bucketFor = (socket: WebSocket, playerId: string, ip: string | null, t: number): SocketState => {
    let s = socketStates.get(socket);
    if (s === undefined) {
      s = {
        playerId, ip, subscribed: false, roomId: null, lastSeq: -1,
        tokens: PRESENCE.bucketSize, tokensAt: t, drops: 0, dropsWindowStart: t,
      };
      socketStates.set(socket, s);
    }
    return s;
  };
  /** Only a socket that asked for presence is ever written to (spec 2026-09-19 §2). */
  const subscribed = (socket: WebSocket): boolean => socketStates.get(socket)?.subscribed === true;
  const error = (socket: WebSocket, code: PresenceErrorCode): void =>
    deps.send(socket, { kind: "presence.error", code });

  const roomFor = async (locationId: string): Promise<Room | null> => {
    const descriptor = await deps.scenes.forLocation(locationId);
    if (!descriptor) return null;
    const concealed = descriptor.combatMode === "underground";
    let room = rooms.get(locationId);
    if (room === undefined) {
      room = { key: locationId, descriptor, concealed, members: new Map(), dirty: emptyDirty() };
      rooms.set(locationId, room);
    } else {
      // Re-read on every join / travel-in (spec §1.3): an admin flipping a
      // live town's mode takes effect for the next arrival.
      room.descriptor = descriptor;
      room.concealed = concealed;
    }
    return room;
  };

  /** A resolved interior room, or the code to answer the caller with. */
  type InteriorRoom = { ok: true; room: Room } | { ok: false; code: "unknown_hook" | "no_interior" | "not_joined" };

  /**
   * The interior room for one door in one town, created on first use; its
   * concealment is the town's, re-read here exactly as `roomFor` re-reads a
   * street's, so an admin flipping a live town's combat mode reaches its
   * interiors too.
   *
   * `no_location` folds into `unknown_hook`: every caller already stands in a
   * room of that town, so a town the scene service cannot find is a hook this
   * caller cannot name, not a missing location the client could act on.
   */
  const interiorRoomFor = async (locationId: string, hookRef: string): Promise<InteriorRoom> => {
    let found: Awaited<ReturnType<SceneService["forInterior"]>>;
    try {
      found = await deps.scenes.forInterior(locationId, hookRef);
    } catch (err) {
      console.error({ err, locationId, hookRef }, "presence: interior lookup failed");
      return { ok: false, code: "not_joined" };
    }
    if (!found.ok) return { ok: false, code: found.code === "no_location" ? "unknown_hook" : found.code };
    const key = `${locationId}|${hookRef}`;
    const concealed = found.room.combatMode === "underground";
    let room = rooms.get(key);
    if (room === undefined) {
      room = { key, descriptor: found.room, concealed, members: new Map(), dirty: emptyDirty() };
      rooms.set(key, room);
    } else {
      room.descriptor = found.room;
      room.concealed = concealed;
    }
    return { ok: true, room };
  };

  const removeMember = (room: Room, playerId: string): void => {
    room.members.delete(playerId);
    memberRoom.delete(playerId);
    room.dirty.joined.delete(playerId);
    room.dirty.moved.delete(playerId);
    room.dirty.left.add(playerId);
  };

  const snapshotFor = (room: Room, me: Member): ServerFrame => ({
    kind: "presence.snapshot",
    room: room.descriptor,
    you: me.state,
    players: room.concealed
      ? []
      : [...room.members.values()].filter((m) => m !== me).map((m) => m.state),
    concealed: room.concealed,
  });

  /**
   * The joining player's row and the room for the town they stand in.
   *
   * Every failure is an answer, never a throw. A rejected query here would
   * propagate to the gateway's `guarded`, which logs it and drops the
   * frame — and the client, having asked to join, would wait forever for a
   * snapshot that never comes. A DB failure answers `not_joined`, which is
   * the code a client already has to handle and can retry from.
   */
  const joinTarget = async (playerId: string): Promise<JoinTarget> => {
    try {
      const [row] = await deps.db
        .select({
          locationId: playerStats.locationId, gangId: playerStats.gangId, username: players.username,
          jailedUntil: playerStats.jailedUntil, hospitalUntil: playerStats.hospitalUntil,
        })
        .from(playerStats)
        .innerJoin(players, eq(players.id, playerStats.playerId))
        .where(eq(playerStats.playerId, playerId));
      if (!row) return { ok: false, code: "not_joined" };
      if (!row.locationId) return { ok: false, code: "no_location" };
      const room = await roomFor(row.locationId);
      if (!room) return { ok: false, code: "no_location" };
      return { ok: true, gangId: row.gangId, username: row.username, sentence: sentenceOf(row, now()), room };
    } catch (err) {
      console.error({ err, playerId }, "presence: join lookup failed");
      return { ok: false, code: "not_joined" };
    }
  };

  /**
   * Every (auto-)join is a heartbeat, not only the first: /api/online reads
   * this ZSET, and a client that reconnects is present now. The touch is a
   * nicety, though — it is what makes a socket-only session visible there —
   * so no caller may depend on it, which is why every failure is swallowed
   * here. `zsetTouchedAt` is stamped only on success: a failed touch must
   * leave the move path's 60 s throttle open to retry, not suppress it for
   * a minute.
   */
  const touch = async (member: Member, playerId: string, ip: string | null, t: number): Promise<void> => {
    try {
      await touchPresence(deps.redis, deps.db, playerId, ip, new Date(t));
      member.zsetTouchedAt = t;
    } catch (err) {
      console.error({ err, playerId }, "presence: touch failed");
    }
  };

  /**
   * A member nobody drives any more: it stops where it was left (no teleport
   * to the static spot) and the flip is re-announced so every client in the
   * room stops interpolating it — a RE-ANNOUNCE through `dirty.joined`, which
   * the client upserts, not a second join.
   */
  const demote = (room: Room, playerId: string, member: Member): void => {
    member.controller = null;
    member.state = { ...member.state, static: true };
    room.dirty.joined.set(playerId, member.state);
  };

  /**
   * Whichever room of this town the player is already in — the street or
   * one of its interiors. A join or auto-join in a town the member already
   * stands in must attach to THAT room, never yank them back to the street.
   */
  const currentRoomInTown = (playerId: string, locationId: string): Room | undefined => {
    const key = memberRoom.get(playerId);
    const room = key === undefined ? undefined : rooms.get(key);
    return room !== undefined && room.descriptor.locationId === locationId ? room : undefined;
  };

  /**
   * Moves a member between rooms (spec 2026-09-20 casino-interior §4.3): the
   * old room is told `left`, the new one `joined`, and every SUBSCRIBED socket
   * of the member gets the new room's snapshot with a fresh sequence space. One
   * helper for travel, enter, exit and the forced exit, so "what a transition
   * does" is stated once. The member object is REPLACED (spreads share the
   * socket Set), which is what the post-await identity checks in `onEvent`
   * and `enter` rely on.
   */
  const relocate = (
    member: Member, playerId: string, from: Room, to: Room,
    arrival: { x: number; y: number; facing: number }, patch: Partial<PresenceState> = {},
  ): Member => {
    const t = now();
    // Every caller resolved `to` before at least one await (travel reads a
    // sentence after `roomFor`; `enter` reads one after `interiorRoomFor`),
    // and an EMPTY room is reclaimed by the tick — so the object in hand can
    // already be out of `rooms`. Inserting the member into it would leave a
    // member no lookup could find and `detach` could never remove. Adopt
    // whichever room is live under the key, or put this one back.
    const live = rooms.get(to.key);
    if (live === undefined) rooms.set(to.key, to);
    else to = live;
    removeMember(from, playerId);
    const moved: Member = {
      ...member,
      state: { ...member.state, ...patch, x: arrival.x, y: arrival.y, facing: arrival.facing, since: t },
      lastMoveAt: t,
    };
    to.members.set(playerId, moved);
    memberRoom.set(playerId, to.key);
    to.dirty.left.delete(playerId);
    to.dirty.joined.set(playerId, moved.state);
    for (const socket of moved.sockets) {
      // The new room is a new sequence space: a seq the client had already
      // spent in the old room must not silence its first move in this one.
      // An auto-joined socket carries no room and gets no snapshot — it
      // never asked to be told where it is standing.
      const s = stateOf(socket);
      if (s?.subscribed !== true) continue;
      s.roomId = to.key;
      s.lastSeq = -1;
      deps.send(socket, snapshotFor(to, moved));
    }
    return moved;
  };

  const join = async (
    playerId: string, socket: WebSocket, ip: string | null, interior?: string,
  ): Promise<void> => {
    const t0 = now();
    const s = bucketFor(socket, playerId, ip, t0);
    if (!spendOrDrop(s, socket, t0)) return;

    const target = await joinTarget(playerId);
    // `join` is dispatched un-awaited, so the socket can close while the
    // lookup is in flight — and at that moment `detach` finds `roomId:
    // null` and correctly does nothing, because there is no member yet.
    // Resuming into an insert here would therefore leave a member holding
    // one dead socket that no close, leave or travel will ever fire for
    // again: a ghost in every future snapshot and tick for the life of the
    // process. Nothing is inserted and nothing is sent to a socket that has
    // already gone.
    if (!isOpen(socket)) return;
    if (!target.ok) { error(socket, target.code); return; }
    let room = target.room;

    // Leaving a previous room (a stale join after travel the bus never told
    // us about) is a plain leave; the common case is no previous room.
    const previousKey = memberRoom.get(playerId);
    if (previousKey !== undefined && previousKey !== room.key) {
      const previous = rooms.get(previousKey);
      if (previous !== undefined && previous.descriptor.locationId === room.descriptor.locationId) {
        // Same town, different space: they are inside one of its buildings.
        // A (re-)join attaches there; only `presence.exit` brings them out.
        room = previous;
        // Refreshed the way `roomFor` refreshes a street (spec §1.3): an
        // admin flipping a live town's combat mode must reach its interiors
        // as it already reaches its street. A failed refresh keeps the room
        // exactly as it is — a stale descriptor is a far smaller fault than
        // refusing the re-join outright.
        const space = previous.descriptor.space;
        if (space?.kind === "interior") {
          const refreshed = await interiorRoomFor(space.locationId, space.hookId);
          // `join`'s rule, for `join`'s reason: nothing is inserted for, or
          // sent to, a socket that closed while this lookup was in flight.
          if (!isOpen(socket)) return;
          if (refreshed.ok) room = refreshed.room;
        }
      } else if (previous !== undefined) {
        removeMember(previous, playerId);   // stale membership of another town
      }
    }

    const t = now();
    let member = room.members.get(playerId);
    if (member === undefined) {
      // The static spot, not spawn — and deliberately so even though this
      // member is live from birth. Auto-join has a full round trip's head
      // start on any `presence.join`, so it normally creates the member and
      // this branch is the loser of that race; landing the two paths on the
      // same position is what stops a player's starting point depending on
      // which one won.
      const spot = staticSpotFor(playerId, room.descriptor);
      member = {
        state: {
          playerId, username: target.username, gangId: target.gangId,
          x: spot.x, y: spot.y, facing: room.descriptor.spawn.facing,
          avatar: { body: avatarFor(playerId) }, since: t, sentence: target.sentence,
          static: false,
        },
        sockets: new Set([socket]), controller: socket, lastMoveAt: t, zsetTouchedAt: t, ip,
      };
      room.members.set(playerId, member);
      memberRoom.set(playerId, room.key);
      room.dirty.left.delete(playerId);
      room.dirty.joined.set(playerId, member.state);
    } else {
      // Most recent join owns the avatar; the previous controller is told
      // once and keeps receiving ticks (spec §1.2).
      member.sockets.add(socket);
      if (member.controller !== socket) {
        const previous = member.controller;
        member.controller = socket;
        // A static member has no previous driver to supersede: nobody was
        // holding the wheel, so nobody is told they lost it.
        if (previous !== null && member.sockets.has(previous)) error(previous, "superseded");
      }
      // `joinTarget` just re-read the row, so this is the freshest view of
      // every fact the state carries. Taking the avatar over never moves it
      // (spec 2026-09-19 §2) — the client walks away from the static spot
      // rather than teleporting to spawn — so position is NOT touched here.
      const next: PresenceState = {
        ...member.state,
        username: target.username, gangId: target.gangId, sentence: target.sentence, static: false,
      };
      const changed = next.username !== member.state.username
        || next.gangId !== member.state.gangId
        || (next.sentence ?? null) !== (member.state.sentence ?? null)
        || (member.state.static ?? false);
      if (changed) {
        member.state = next;
        room.dirty.joined.set(playerId, next);
      }
    }

    // Mutated, not replaced: the budget and its drop window carry across a
    // re-join, which is the whole point of the bucket. A new room is a new
    // sequence space, so `lastSeq` resets.
    s.subscribed = true;
    s.roomId = room.key;
    s.lastSeq = -1;

    // The touch sits AFTER the socket-state set above: a throwable await
    // between the member insert and that set would strand the member — its
    // socket would have no room recorded, so `detach` would find nothing to
    // remove and leave a phantom in the room forever.
    await touch(member, playerId, ip, t);
    // Same window, second await: the member is in the room by now, so a
    // close that lands here IS seen by `detach` and cleaned up. Only the
    // snapshot needs suppressing.
    if (!isOpen(socket)) return;
    deps.send(socket, snapshotFor(room, member));

    // The reconnect hint, answered AFTER the street snapshot so a client that
    // cannot be let in still learns where it is standing (spec §4.3). It
    // spends a second token and treats "already inside this door" as a
    // no-op, both by design: the hint is an ordinary `presence.enter` the
    // client did not have to send.
    if (interior !== undefined) await enter(socket, interior);
  };

  /**
   * The socket's member and the room it stands in, or the code to answer
   * with. Shared by `enter` and `exit`, so one door and one doorway agree on
   * who may walk through: only the CONTROLLER, the socket that holds the
   * wheel. A superseded socket still receives every frame of the room, and
   * is told why its own transition was refused rather than dropped.
   */
  const controlled = (
    socket: WebSocket,
  ): { ok: true; s: SocketState; room: Room; member: Member } | { ok: false; code: "not_joined" | "superseded" } => {
    const s = stateOf(socket);
    if (!s || s.roomId === null) return { ok: false, code: "not_joined" };
    const room = rooms.get(s.roomId);
    const member = room?.members.get(s.playerId);
    if (!room || !member) return { ok: false, code: "not_joined" };
    if (member.controller !== socket) return { ok: false, code: "superseded" };
    return { ok: true, s, room, member };
  };

  /**
   * Walk the caller through a door of the room it is standing in (spec
   * 2026-09-20 casino-interior §4.3). Interiors are rooms like any other, so
   * this is a `relocate` with a lookup and two refusals in front of it.
   */
  const enter = async (socket: WebSocket, hookRef: string): Promise<void> => {
    const c = controlled(socket);
    if (!c.ok) { error(socket, c.code); return; }
    const { s, room, member } = c;
    if (!spendOrDrop(s, socket, now())) return;
    if (room.descriptor.space?.kind === "interior") {
      // Already inside THIS door: a join hint or a repeated enter is a
      // silent no-op. Any OTHER door is a transition an interior cannot
      // make — a player walks out before walking in somewhere else.
      if (room.descriptor.space.hookId !== hookRef) error(socket, "wrong_space");
      return;
    }
    const target = await interiorRoomFor(room.descriptor.locationId, hookRef);
    if (!isOpen(socket)) return;
    if (!target.ok) { error(socket, target.code); return; }
    // BOTH the row and the state, because neither alone is enough. The ROW
    // catches a sentence no event has announced yet — state is a display
    // fact refreshed by events, and a stale one must not open a door to a
    // jailed player. An `undefined` read is a failure, never "no sentence"
    // — it must leave a confined player confined, so it refuses too.
    const sentence = await readSentence(s.playerId);
    if (!isOpen(socket)) return;
    if (sentence === undefined) { error(socket, "not_joined"); return; }
    if (sentence !== null) { error(socket, "sentenced"); return; }
    // Two awaits have passed: revalidate the way `onEvent` does before
    // touching anything. Whoever moved this member owns the truth.
    if (memberRoom.get(s.playerId) !== room.key || room.members.get(s.playerId) !== member) return;
    if (member.sockets.size === 0 || member.controller !== socket) return;
    // And the STATE, because the read above can have STARTED before a jail
    // transaction committed and resolved after `refreshSentence` already
    // wrote "jail" here. By construction `member.state.sentence` is never
    // the staler of the two, so it decides — and nothing patches it back
    // onto the moved member: `refreshSentence` owns that field alone.
    if (member.state.sentence !== null && member.state.sentence !== undefined) { error(socket, "sentenced"); return; }
    relocate(member, s.playerId, room, target.room, target.room.descriptor.spawn);
  };

  /**
   * Walk the caller back out onto the street, at the door's own exit spot
   * (spec §4.2). No sentence check: leaving a building is never refused —
   * only entering one is.
   */
  const exit = async (socket: WebSocket): Promise<void> => {
    const c = controlled(socket);
    if (!c.ok) { error(socket, c.code); return; }
    const { s, room, member } = c;
    if (!spendOrDrop(s, socket, now())) return;
    const space = room.descriptor.space;
    if (space?.kind !== "interior") { error(socket, "wrong_space"); return; }
    let street: Room | null = null;
    try {
      street = await roomFor(space.locationId);
    } catch (err) {
      console.error({ err, playerId: s.playerId }, "presence: exit lookup failed");
    }
    if (!isOpen(socket)) return;
    if (street === null) { error(socket, "not_joined"); return; }
    if (memberRoom.get(s.playerId) !== room.key || room.members.get(s.playerId) !== member) return;
    if (member.sockets.size === 0 || member.controller !== socket) return;
    relocate(member, s.playerId, room, street, space.exit);
  };

  /**
   * Put an authenticated socket in its player's town without being asked
   * (spec 2026-09-19 §2), so a web or Android player standing in the town is
   * visible to a 3D client rather than invisible until they run one.
   *
   * Three differences from `join`, each of them because the client did not
   * ask for any of this: the socket is left UNSUBSCRIBED, so no presence
   * frame is ever sent to it; the member never becomes controller, so
   * nothing is superseded; and every failure is silence, because there is no
   * client waiting on an answer to drop. It spends no token either — this is
   * server-initiated traffic, and charging a client for it would let the
   * gateway empty its own budget before it sends a single frame.
   */
  const autoJoin = async (playerId: string, socket: WebSocket, ip: string | null): Promise<void> => {
    // Called for its side effect: the socket gets its budget, its player id
    // and its ip now, so whatever it sends later is bucketed and so that the
    // late auto-join in `onEvent` can recover the ip. `subscribed` and
    // `roomId` are left exactly as `bucketFor` creates them — see below.
    bucketFor(socket, playerId, ip, now());
    const target = await joinTarget(playerId);
    // `join`'s rule, for `join`'s reason: resuming into an insert for a
    // socket that has already gone leaves a member holding one dead socket
    // that no close, leave or travel will ever fire for again.
    if (!isOpen(socket)) return;
    // A null location is not an error, and `joinTarget` has already logged
    // any throw. Either way the client hears nothing.
    if (!target.ok) return;
    const { room } = target;

    // A `presence.join` on this same socket can win the race to `joinTarget`
    // — two reads started moments apart — so the member may already exist
    // and already be driven. Adding the socket is all that is ever safe
    // here: taking the wheel would demote a client that DID ask for it.
    const existing = currentRoomInTown(playerId, room.descriptor.locationId)?.members.get(playerId);
    if (existing !== undefined) {
      existing.sockets.add(socket);
      await touch(existing, playerId, ip, now());
      return;
    }

    // A stale membership of a DIFFERENT room (travel the bus never told us
    // about) is a plain leave — `join`'s rule again. A room of THIS town was
    // already handled above, so anything left here belongs to another town.
    const previousKey = memberRoom.get(playerId);
    if (previousKey !== undefined && previousKey !== room.key) {
      const previous = rooms.get(previousKey);
      if (previous) removeMember(previous, playerId);
    }

    const t = now();
    const spot = staticSpotFor(playerId, room.descriptor);
    const member: Member = {
      state: {
        playerId, username: target.username, gangId: target.gangId,
        x: spot.x, y: spot.y, facing: room.descriptor.spawn.facing,
        avatar: { body: avatarFor(playerId) }, since: t, sentence: target.sentence,
        static: true,
      },
      sockets: new Set([socket]), controller: null, lastMoveAt: t, zsetTouchedAt: t, ip,
    };
    room.members.set(playerId, member);
    memberRoom.set(playerId, room.key);
    room.dirty.left.delete(playerId);
    room.dirty.joined.set(playerId, member.state);

    // The socket's `roomId` and `subscribed` are deliberately left alone:
    // this socket has not joined, so `move`, `emote` and `presence.leave`
    // must keep answering it `not_joined`, and nothing may be sent to it.
    // `detach` finds the member through `memberRoom` instead, which is what
    // still cleans this member up when the socket closes.
    await touch(member, playerId, ip, t);
  };

  const takeToken = (s: SocketState, t: number): boolean => {
    const elapsed = Math.max(0, t - s.tokensAt) / 1000;
    s.tokens = Math.min(PRESENCE.bucketSize, s.tokens + elapsed * PRESENCE.refillPerSecond);
    s.tokensAt = t;
    if (s.tokens >= 1) { s.tokens -= 1; return true; }
    return false;
  };

  /**
   * One token buys one frame. A frame over budget is dropped silently and
   * counted; a socket that keeps spending past `dropLimit` inside
   * `dropWindowMs` is told `rate_limited` and closed.
   */
  const spendOrDrop = (s: SocketState, socket: WebSocket, t: number): boolean => {
    if (takeToken(s, t)) return true;
    if (t - s.dropsWindowStart >= PRESENCE.dropWindowMs) { s.drops = 0; s.dropsWindowStart = t; }
    s.drops += 1;
    if (s.drops >= PRESENCE.dropLimit) { error(socket, "rate_limited"); socket.close(); }
    return false;
  };

  const move = (socket: WebSocket, frame: { seq: number; x: number; y: number; facing: number }): void => {
    const s = stateOf(socket);
    if (!s || s.roomId === null) { error(socket, "not_joined"); return; }
    const room = rooms.get(s.roomId);
    const member = room?.members.get(s.playerId);
    if (!room || !member) { error(socket, "not_joined"); return; }
    const t = now();

    if (!spendOrDrop(s, socket, t)) return;
    if (frame.seq <= s.lastSeq) return;
    s.lastSeq = frame.seq;
    if (member.controller !== socket) return; // a superseded socket's moves are ignored, silently

    const b = room.descriptor.bounds;
    let x = Math.min(b.maxX, Math.max(b.minX, frame.x));
    let y = Math.min(b.maxY, Math.max(b.minY, frame.y));
    const dt = Math.max(PRESENCE.minDtMs, t - member.lastMoveAt) / 1000;
    const maxDist = PRESENCE.maxSpeed * dt;
    const dx = x - member.state.x;
    const dy = y - member.state.y;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDist) {
      const k = maxDist / dist;
      x = member.state.x + dx * k;
      y = member.state.y + dy * k;
    }
    member.state = { ...member.state, x, y, facing: frame.facing };
    member.lastMoveAt = t;
    room.dirty.moved.set(s.playerId, { playerId: s.playerId, x, y, facing: frame.facing, at: t });

    if (t - member.zsetTouchedAt >= PRESENCE.zsetTouchMs) {
      member.zsetTouchedAt = t;
      touchPresence(deps.redis, deps.db, s.playerId, member.ip, new Date(t)).catch((err: unknown) => {
        console.error({ err, playerId: s.playerId }, "presence: touch failed");
      });
    }
  };

  const emote = (socket: WebSocket, e: Emote): void => {
    const s = stateOf(socket);
    if (!s || s.roomId === null) { error(socket, "not_joined"); return; }
    const room = rooms.get(s.roomId);
    if (!room || !room.members.has(s.playerId)) { error(socket, "not_joined"); return; }
    // An emote costs a move token. One bucket covers every frame a client
    // can spam at the room, so an emote burst cannot slip past the budget a
    // move burst is already held to, and an over-budget emote is counted
    // toward the same `rate_limited` close rather than a second one.
    if (!spendOrDrop(s, socket, now())) return;
    room.dirty.emoted.push({ playerId: s.playerId, emote: e });
  };

  const detach = (socket: WebSocket, explicit: boolean): void => {
    const s = stateOf(socket);
    if (!s) { if (explicit) error(socket, "not_joined"); return; }
    // `presence.leave` from a socket that never joined is `not_joined`,
    // exactly as it was before auto-join existed: this socket asked for
    // nothing and holds nothing to give up. Its PLAYER may nonetheless be a
    // static member of a room, which a CLOSE still has to clean up — so the
    // refusal is scoped to the explicit frame, and the close below finds the
    // member through `memberRoom` rather than through `s.roomId`, which an
    // auto-joined socket never carries.
    if (explicit && !s.subscribed) { error(socket, "not_joined"); return; }
    s.subscribed = false;
    s.roomId = null;
    const roomId = memberRoom.get(s.playerId);
    const room = roomId === undefined ? undefined : rooms.get(roomId);
    const member = room?.members.get(s.playerId);
    if (!room || !member) return;
    if (!member.sockets.delete(socket)) return;
    if (member.sockets.size === 0) { removeMember(room, s.playerId); return; }
    // Sockets remain, so the player is still here — but the driver is gone,
    // and the avatar goes back to standing still where it was left (spec
    // 2026-09-19 §2 "Falling back"). A remaining socket that wants the wheel
    // asks for it with its own `presence.join`.
    if (member.controller === socket) demote(room, s.playerId, member);
  };

  /**
   * One recipient's view of a tick, or null when there is nothing to tell them.
   *
   * A joiner learns its own state from the snapshot that answered its join, so
   * re-announcing it here would make a lone player's own arrival look like
   * someone else walking in. `moved` deliberately still carries the recipient:
   * that is how a client learns the server rubber-banded it.
   */
  const tickFor = (
    recipientId: string, locationId: string, space: RoomDescriptor["space"], d: Room["dirty"],
  ): ServerFrame | null => {
    const joined = [...d.joined.values()].filter((p) => p.playerId !== recipientId);
    const moved = [...d.moved.values()];
    const left = [...d.left];
    if (joined.length === 0 && moved.length === 0 && d.emoted.length === 0 && left.length === 0) return null;
    // `space` is optional on the wire, so an undefined one (a descriptor from
    // before interiors) is dropped by JSON and the frame is byte-identical.
    return { kind: "presence.tick", locationId, space, joined, moved, emoted: d.emoted, left };
  };

  const flushRoom = (key: string, room: Room): void => {
    // Reclaimed BEFORE the dirty check, not only when dirty: a same-town
    // re-attach and an auto-join that finds its member already present both
    // leave behind a street room `roomFor` created and nobody ever joined,
    // and an empty room that is never dirty would otherwise live for the
    // life of the process. `relocate` re-registers a room it still holds —
    // which is why the dirty is cleared as well as the entry: `removeMember`
    // scrubs `joined` and `moved` but not `emoted` or `left`, so a room that
    // empties with a queued emote and is then resurrected would replay it.
    if (room.members.size === 0) { room.dirty = emptyDirty(); rooms.delete(key); return; }
    const d = room.dirty;
    const dirty = d.joined.size > 0 || d.moved.size > 0 || d.emoted.length > 0 || d.left.size > 0;
    if (!dirty) return;
    room.dirty = emptyDirty();
    if (room.concealed) return; // stored, never broadcast (spec §1.3)
    for (const [playerId, member] of room.members) {
      const frame = tickFor(playerId, room.descriptor.locationId, room.descriptor.space, d);
      if (frame === null) continue;
      for (const socket of member.sockets) {
        // A socket that never asked for presence is never written to: a web
        // tab that only holds the event feed costs the room nothing on the
        // wire (spec 2026-09-19 §2 "Recipients").
        if (!subscribed(socket)) continue;
        // One socket cannot cost the rest of the room its tick: a socket
        // that closed since this tick began, or a frame `send` refuses to
        // serialise, drops here and the loop carries on.
        try {
          deps.send(socket, frame);
        } catch (err) {
          console.error({ err, key, playerId }, "presence: tick send failed");
        }
      }
    }
  };

  /**
   * The tick runs on a timer, outside every per-frame `guarded` call, so it
   * is the one path with no caller to catch for it: an uncaught throw here
   * would take the whole process down rather than drop one room's tick.
   * Guarding per room rather than per tick also keeps one bad room from
   * silencing every other room in the same pass.
   */
  const flush = (): void => {
    for (const [key, room] of rooms) {
      try {
        flushRoom(key, room);
      } catch (err) {
        console.error({ err, key }, "presence: tick failed");
      }
    }
  };
  const timer = setInterval(flush, PRESENCE.tickMs);
  timer.unref?.();

  /**
   * One SELECT of the two sentence columns. `undefined` means the row is
   * gone or the read failed — deliberately NOT `null`, which is itself an
   * answer ("no sentence"): a failed read must leave a jailed member jailed
   * rather than quietly freeing them on every client in the room.
   */
  const readSentence = async (playerId: string): Promise<Sentence | undefined> => {
    try {
      const [row] = await deps.db
        .select({ jailedUntil: playerStats.jailedUntil, hospitalUntil: playerStats.hospitalUntil })
        .from(playerStats)
        .where(eq(playerStats.playerId, playerId));
      return row ? sentenceOf(row, now()) : undefined;
    } catch (err) {
      console.error({ err, playerId }, "presence: sentence lookup failed");
      return undefined;
    }
  };

  /**
   * Re-read the row rather than trust the event (spec §3): a released player
   * may still be hospitalised, and only the row knows which. A member whose
   * value changed is put back on `dirty.joined` — a RE-ANNOUNCE, not a
   * second join: the client upserts on `joined`, so this needs no new tick
   * field and no client change. A concealed room stores it and broadcasts
   * nothing, exactly as it does for every other dirty entry.
   */
  const refreshSentence = async (playerId: string): Promise<void> => {
    // Cheap pre-check: a jail event for one of the thousands of players who
    // are not in any room must not cost a query.
    if (!memberRoom.has(playerId)) return;
    const sentence = await readSentence(playerId);
    if (sentence === undefined) return;

    // Re-read after the await, for onEvent's own reason below: the member
    // can have left, closed its last socket or travelled while the row was
    // in flight.
    const roomId = memberRoom.get(playerId);
    if (roomId === undefined) return;
    const room = rooms.get(roomId);
    const member = room?.members.get(playerId);
    if (!room || !member) return;
    if ((member.state.sentence ?? null) === sentence) return;
    member.state = { ...member.state, sentence };
    room.dirty.joined.set(playerId, member.state);

    // A sentence acquired INSIDE a building puts the player back on the
    // street (spec 2026-09-20 casino-interior §4.3): the client confines a
    // sentenced avatar to a facility yard, and an interior has no yard. The
    // member already carries the new sentence, so `relocate` announces the
    // arrival and the confinement in the one `joined` entry.
    const space = room.descriptor.space;
    if (sentence === null || space?.kind !== "interior") return;
    let street: Room | null = null;
    try {
      street = await roomFor(space.locationId);
    } catch (err) {
      console.error({ err, playerId }, "presence: forced-exit lookup failed");
      return;
    }
    if (street === null) {
      // Best-effort, and therefore observable: the sentence re-announce
      // above stands, so the member stays inside rather than losing it.
      console.error({ playerId, locationId: space.locationId }, "presence: forced-exit street missing");
      return;
    }
    // A third await has passed: revalidate the way `onEvent` and `enter` do.
    // Whoever moved this member owns the truth, and a member whose last
    // socket closed must not be inserted into a room nothing can remove it
    // from. The re-announce above is already stored either way.
    if (memberRoom.get(playerId) !== room.key) return;
    if (room.members.get(playerId) !== member) return;
    if (member.sockets.size === 0) return;
    relocate(member, playerId, room, street, space.exit);
  };

  const onEvent = async (event: GameEvent): Promise<void> => {
    // A sentence changed hands: the actor was jailed, released, discharged
    // or hospitalised by their own backfiring gun — or, for a kill, the
    // VICTIM is the one hospitalised and the actor is the killer.
    if (
      event.type === "player.jailed" || event.type === "player.released"
      || event.type === "player.discharged" || event.type === "player.backfired"
    ) {
      await refreshSentence(event.actorId);
      return;
    }
    if (event.type === "player.killed") {
      await refreshSentence(event.victimId);
      return;
    }

    // Only travel moves a player between rooms. `actorId` is the traveller
    // (the travel plugin is the sole publisher), and the event is published
    // after the transaction committed — the outbox guarantees it — so the
    // scene read below sees the new town.
    if (event.type !== "player.travelled") return;
    const playerId = event.actorId;
    const fromId = memberRoom.get(playerId);
    if (fromId === undefined) {
      // Not present anywhere — but a socket of theirs may be open and have
      // simply had no town to be put in at connect: a fresh account whose
      // first travel is what sets `location_id` (spec 2026-09-19 §2 "Late
      // location"). Auto-join it now. For the thousands of players with no
      // socket at all this is one empty iteration and no query.
      for (const socket of deps.socketsOf(playerId)) {
        if (!isOpen(socket)) continue;
        await autoJoin(playerId, socket, stateOf(socket)?.ip ?? null);
      }
      return;
    }
    // `fromId` is a room KEY, which is the town's id only for a street room:
    // the traveller may be standing in an interior of it.
    const fromRoom = rooms.get(fromId);
    if (fromRoom?.descriptor.locationId === event.toLocationId) return;
    const from = rooms.get(fromId);
    const member = from?.members.get(playerId);
    if (!from || !member) return;

    // Resolve the destination BEFORE detaching, so the one await sits
    // outside the hand-over. Every outcome still answers the traveller:
    // `joinTarget`'s rule, for `joinTarget`'s reason — a silent drop would
    // leave a client standing in a town the server no longer has it in.
    let to: Room | null = null;
    let failure: "no_location" | "not_joined" = "no_location";
    try {
      to = await roomFor(event.toLocationId);
    } catch (err) {
      console.error({ err, playerId, toLocationId: event.toLocationId }, "presence: travel lookup failed");
      failure = "not_joined";
    }

    // Re-read rather than carried forward: the row is the truth, and a
    // sentence can have changed since the join. Only when there is a room to
    // arrive in — a failed destination lookup has nothing to announce. A
    // failed read keeps the value the member already carried.
    let sentence: Sentence = member.state.sentence ?? null;
    if (to !== null) {
      const read = await readSentence(playerId);
      if (read !== undefined) sentence = read;
    }

    // Everything above was read BEFORE those awaits, and the gateway fires
    // onEvent without awaiting it, so the room state can have moved on
    // underneath: the traveller's last socket can close (which empties the
    // `sockets` Set this member shares, and inserting it now would leave a
    // member nothing can ever remove), a fresh presence.join can replace
    // the member, or a second travelled event can re-room the player again.
    // Re-read before touching anything. Whoever changed it owns the truth
    // and has already answered the traveller, so bailing here is silence by
    // design rather than the dropped answer the branch below guards against.
    if (memberRoom.get(playerId) !== fromId) return;
    if (from.members.get(playerId) !== member) return;
    if (member.sockets.size === 0) return;

    // The traveller has left the old town whatever happens next, so the old
    // room is told `left` either way.
    removeMember(from, playerId);
    if (to === null) {
      for (const socket of member.sockets) {
        const s = stateOf(socket);
        const asked = s?.subscribed === true;
        if (s) { s.roomId = null; s.subscribed = false; }
        // Only a socket that asked is answered: an auto-joined one never
        // knew it was in a room, so it is not told it has left one.
        if (asked) error(socket, failure);
      }
      return;
    }

    // A static member arrives at the new town's static spot; a driven one
    // arrives at spawn, where its client expects to resume from.
    const arrival = member.controller === null
      ? { ...staticSpotFor(playerId, to.descriptor), facing: to.descriptor.spawn.facing }
      : { x: to.descriptor.spawn.x, y: to.descriptor.spawn.y, facing: to.descriptor.spawn.facing };
    relocate(member, playerId, from, to, arrival, { sentence });
  };

  return {
    join, autoJoin, enter, exit, move, emote,
    leave: (socket) => detach(socket, true),
    socketClosed: (socket) => detach(socket, false),
    onEvent,
    close: () => clearInterval(timer),
  };
}
