import type { AvatarBody, Emote, GameEvent, PresenceMoved, PresenceState, RoomDescriptor, ServerFrame } from "@gl3/shared";
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
  now?: () => number;
}

export interface Rooms {
  join(playerId: string, socket: WebSocket, ip: string | null): Promise<void>;
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
  /** The socket whose moves drive the avatar — the most recent joiner. */
  controller: WebSocket;
  lastMoveAt: number;
  zsetTouchedAt: number;
  ip: string | null;
}

interface Room {
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
  roomId: string | null;
  lastSeq: number;
  tokens: number;
  tokensAt: number;
  drops: number;
  dropsWindowStart: number;
}

/** What `joinTarget` resolved: a room to join, or the code to answer with. */
type JoinTarget =
  | { ok: true; gangId: string | null; username: string; room: Room }
  | { ok: false; code: "not_joined" | "no_location" };

const AVATARS: readonly AvatarBody[] = ["suit-dark", "suit-light", "coat", "dress"];

/** v1 avatar: a stable function of the id, so every client draws the same body (spec §1.1). */
export function avatarFor(playerId: string): AvatarBody {
  let h = 0;
  for (let i = 0; i < playerId.length; i++) h = (h * 31 + playerId.charCodeAt(i)) >>> 0;
  return AVATARS[h % AVATARS.length]!;
}

const emptyDirty = (): Room["dirty"] => ({ joined: new Map(), moved: new Map(), emoted: [], left: new Set() });

export function createRooms(deps: RoomsDeps): Rooms {
  const now = deps.now ?? Date.now;
  const rooms = new Map<string, Room>();
  const socketStates = new WeakMap<WebSocket, SocketState>();
  /** playerId → the room they are a member of (one avatar per player). */
  const memberRoom = new Map<string, string>();

  const stateOf = (socket: WebSocket): SocketState | undefined => socketStates.get(socket);
  const error = (socket: WebSocket, code: "not_joined" | "no_location" | "rate_limited" | "superseded"): void =>
    deps.send(socket, { kind: "presence.error", code });

  const roomFor = async (locationId: string): Promise<Room | null> => {
    const descriptor = await deps.scenes.forLocation(locationId);
    if (!descriptor) return null;
    const concealed = descriptor.combatMode === "underground";
    let room = rooms.get(locationId);
    if (room === undefined) {
      room = { descriptor, concealed, members: new Map(), dirty: emptyDirty() };
      rooms.set(locationId, room);
    } else {
      // Re-read on every join / travel-in (spec §1.3): an admin flipping a
      // live town's mode takes effect for the next arrival.
      room.descriptor = descriptor;
      room.concealed = concealed;
    }
    return room;
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
        .select({ locationId: playerStats.locationId, gangId: playerStats.gangId, username: players.username })
        .from(playerStats)
        .innerJoin(players, eq(players.id, playerStats.playerId))
        .where(eq(playerStats.playerId, playerId));
      if (!row) return { ok: false, code: "not_joined" };
      if (!row.locationId) return { ok: false, code: "no_location" };
      const room = await roomFor(row.locationId);
      if (!room) return { ok: false, code: "no_location" };
      return { ok: true, gangId: row.gangId, username: row.username, room };
    } catch (err) {
      console.error({ err, playerId }, "presence: join lookup failed");
      return { ok: false, code: "not_joined" };
    }
  };

  const join = async (playerId: string, socket: WebSocket, ip: string | null): Promise<void> => {
    const target = await joinTarget(playerId);
    if (!target.ok) { error(socket, target.code); return; }
    const { room } = target;

    // Leaving a previous room (a stale join after travel the bus never told
    // us about) is a plain leave; the common case is no previous room.
    const previousId = memberRoom.get(playerId);
    if (previousId !== undefined && previousId !== room.descriptor.locationId) {
      const previous = rooms.get(previousId);
      if (previous) removeMember(previous, playerId);
    }

    const t = now();
    let member = room.members.get(playerId);
    if (member === undefined) {
      member = {
        state: {
          playerId, username: target.username, gangId: target.gangId,
          x: room.descriptor.spawn.x, y: room.descriptor.spawn.y, facing: room.descriptor.spawn.facing,
          avatar: { body: avatarFor(playerId) }, since: t,
        },
        sockets: new Set([socket]), controller: socket, lastMoveAt: t, zsetTouchedAt: t, ip,
      };
      room.members.set(playerId, member);
      memberRoom.set(playerId, room.descriptor.locationId);
      room.dirty.left.delete(playerId);
      room.dirty.joined.set(playerId, member.state);
    } else {
      // Most recent join owns the avatar; the previous controller is told
      // once and keeps receiving ticks (spec §1.2).
      member.sockets.add(socket);
      if (member.controller !== socket) {
        const previous = member.controller;
        member.controller = socket;
        if (member.sockets.has(previous)) error(previous, "superseded");
      }
    }

    const existing = stateOf(socket);
    socketStates.set(socket, {
      playerId, roomId: room.descriptor.locationId, lastSeq: -1,
      tokens: existing?.tokens ?? PRESENCE.bucketSize, tokensAt: existing?.tokensAt ?? t,
      drops: existing?.drops ?? 0, dropsWindowStart: existing?.dropsWindowStart ?? t,
    });

    // Every join is a heartbeat, not only the first: /api/online reads this
    // ZSET, and a client that reconnects and re-joins is present now. The
    // touch is a nicety, though — it is what makes a socket-only session
    // visible there — so join must not depend on it, and it sits AFTER the
    // socket-state set above for that reason. A throwable await between the
    // member insert and that set would strand the member: its socket would
    // have no SocketState, so `detach` would return early on close and
    // leave a phantom in the room forever.
    try {
      await touchPresence(deps.redis, deps.db, playerId, ip, new Date(t));
      // Stamped only on success: a failed touch must leave the move path's
      // 60 s throttle open to retry, not suppress it for a minute.
      member.zsetTouchedAt = t;
    } catch (err) {
      console.error({ err, playerId }, "presence: touch failed");
    }
    deps.send(socket, snapshotFor(room, member));
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
    if (s.roomId === null) { if (explicit) error(socket, "not_joined"); return; }
    const room = rooms.get(s.roomId);
    const member = room?.members.get(s.playerId);
    s.roomId = null;
    if (!room || !member) return;
    member.sockets.delete(socket);
    if (member.sockets.size === 0) { removeMember(room, s.playerId); return; }
    if (member.controller === socket) member.controller = [...member.sockets][0]!;
  };

  /**
   * One recipient's view of a tick, or null when there is nothing to tell them.
   *
   * A joiner learns its own state from the snapshot that answered its join, so
   * re-announcing it here would make a lone player's own arrival look like
   * someone else walking in. `moved` deliberately still carries the recipient:
   * that is how a client learns the server rubber-banded it.
   */
  const tickFor = (recipientId: string, locationId: string, d: Room["dirty"]): ServerFrame | null => {
    const joined = [...d.joined.values()].filter((p) => p.playerId !== recipientId);
    const moved = [...d.moved.values()];
    const left = [...d.left];
    if (joined.length === 0 && moved.length === 0 && d.emoted.length === 0 && left.length === 0) return null;
    return { kind: "presence.tick", locationId, joined, moved, emoted: d.emoted, left };
  };

  const flushRoom = (locationId: string, room: Room): void => {
    const d = room.dirty;
    const dirty = d.joined.size > 0 || d.moved.size > 0 || d.emoted.length > 0 || d.left.size > 0;
    if (!dirty) return;
    room.dirty = emptyDirty();
    if (room.members.size === 0) { rooms.delete(locationId); return; }
    if (room.concealed) return; // stored, never broadcast (spec §1.3)
    for (const [playerId, member] of room.members) {
      const frame = tickFor(playerId, locationId, d);
      if (frame === null) continue;
      for (const socket of member.sockets) {
        // One socket cannot cost the rest of the room its tick: a socket
        // that closed since this tick began, or a frame `send` refuses to
        // serialise, drops here and the loop carries on.
        try {
          deps.send(socket, frame);
        } catch (err) {
          console.error({ err, locationId, playerId }, "presence: tick send failed");
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
    for (const [locationId, room] of rooms) {
      try {
        flushRoom(locationId, room);
      } catch (err) {
        console.error({ err, locationId }, "presence: tick failed");
      }
    }
  };
  const timer = setInterval(flush, PRESENCE.tickMs);
  timer.unref?.();

  const onEvent = async (event: GameEvent): Promise<void> => {
    // Only travel moves a player between rooms. `actorId` is the traveller
    // (the travel plugin is the sole publisher), and the event is published
    // after the transaction committed — the outbox guarantees it — so the
    // scene read below sees the new town.
    if (event.type !== "player.travelled") return;
    const playerId = event.actorId;
    const fromId = memberRoom.get(playerId);
    if (fromId === undefined) return; // not present anywhere: nothing to move
    if (fromId === event.toLocationId) return;
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

    // Everything above was read BEFORE that await, and the gateway fires
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
        if (s) s.roomId = null;
        error(socket, failure);
      }
      return;
    }

    const t = now();
    const moved: Member = {
      ...member,
      state: {
        ...member.state,
        x: to.descriptor.spawn.x, y: to.descriptor.spawn.y, facing: to.descriptor.spawn.facing, since: t,
      },
      lastMoveAt: t,
    };
    to.members.set(playerId, moved);
    memberRoom.set(playerId, to.descriptor.locationId);
    to.dirty.left.delete(playerId);
    to.dirty.joined.set(playerId, moved.state);
    for (const socket of moved.sockets) {
      // The new room is a new sequence space: a seq the client had already
      // spent in the old town must not silence its first move in this one.
      const s = stateOf(socket);
      if (s) { s.roomId = to.descriptor.locationId; s.lastSeq = -1; }
      deps.send(socket, snapshotFor(to, moved));
    }
  };

  return {
    join, move, emote,
    leave: (socket) => detach(socket, true),
    socketClosed: (socket) => detach(socket, false),
    onEvent,
    close: () => clearInterval(timer),
  };
}
