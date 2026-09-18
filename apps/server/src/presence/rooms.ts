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

  const join = async (playerId: string, socket: WebSocket, ip: string | null): Promise<void> => {
    const [row] = await deps.db
      .select({ locationId: playerStats.locationId, gangId: playerStats.gangId, username: players.username })
      .from(playerStats)
      .innerJoin(players, eq(players.id, playerStats.playerId))
      .where(eq(playerStats.playerId, playerId));
    if (!row) { error(socket, "not_joined"); return; }
    if (!row.locationId) { error(socket, "no_location"); return; }
    const room = await roomFor(row.locationId);
    if (!room) { error(socket, "no_location"); return; }

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
          playerId, username: row.username, gangId: row.gangId,
          x: room.descriptor.spawn.x, y: room.descriptor.spawn.y, facing: room.descriptor.spawn.facing,
          avatar: { body: avatarFor(playerId) }, since: t,
        },
        sockets: new Set([socket]), controller: socket, lastMoveAt: t, zsetTouchedAt: t, ip,
      };
      room.members.set(playerId, member);
      memberRoom.set(playerId, room.descriptor.locationId);
      room.dirty.left.delete(playerId);
      room.dirty.joined.set(playerId, member.state);
      // The ZSET touch is a nicety: it is what makes a socket-only session
      // show up in /api/online. Join must not depend on it. A throwable
      // await between the member insert above and the socket-state set
      // below would strand the member — the socket would have no
      // SocketState, so `detach` would return early on close and leave a
      // phantom in the room forever.
      try {
        await touchPresence(deps.redis, deps.db, playerId, ip, new Date(t));
      } catch (err) {
        console.error({ err, playerId }, "presence: touch failed");
      }
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
    deps.send(socket, snapshotFor(room, member));
  };

  const takeToken = (s: SocketState, t: number): boolean => {
    const elapsed = Math.max(0, t - s.tokensAt) / 1000;
    s.tokens = Math.min(PRESENCE.bucketSize, s.tokens + elapsed * PRESENCE.refillPerSecond);
    s.tokensAt = t;
    if (s.tokens >= 1) { s.tokens -= 1; return true; }
    return false;
  };

  const move = (socket: WebSocket, frame: { seq: number; x: number; y: number; facing: number }): void => {
    const s = stateOf(socket);
    if (!s || s.roomId === null) { error(socket, "not_joined"); return; }
    const room = rooms.get(s.roomId);
    const member = room?.members.get(s.playerId);
    if (!room || !member) { error(socket, "not_joined"); return; }
    const t = now();

    if (!takeToken(s, t)) {
      if (t - s.dropsWindowStart >= PRESENCE.dropWindowMs) { s.drops = 0; s.dropsWindowStart = t; }
      s.drops += 1;
      if (s.drops >= PRESENCE.dropLimit) { error(socket, "rate_limited"); socket.close(); }
      return;
    }
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
    if (event.type !== "player.travelled") return;
    // Task 8 fills this in.
  };

  return {
    join, move, emote,
    leave: (socket) => detach(socket, true),
    socketClosed: (socket) => detach(socket, false),
    onEvent,
    close: () => clearInterval(timer),
  };
}
