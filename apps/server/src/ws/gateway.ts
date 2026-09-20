import type { Server } from "node:http";
import type { WorldHook } from "@gl3/plugin-sdk";
import { ServerFrameSchema, ClientFrameSchema, type GameEvent, type ServerFrame } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { WebSocketServer, type WebSocket } from "ws";
import type { StorageDriver } from "../assets/driver.js";
import { clientIp } from "../auth/rate-limit.js";
import { consumeTicket } from "../auth/session.js";
import { subscribeToEvents } from "../bus/subscribe.js";
import type { Db } from "../db/client.js";
import { gangMembers } from "../db/schema/index.js";
import { createRooms } from "../presence/rooms.js";
import { createSceneService } from "../world/scene.js";

export interface GatewayDeps {
  db: Db; redis: Redis; subscriber: Redis; corsOrigins: string[];
  /** Presence rooms build scene descriptors from these (spec 2026-09-17 §1.4). */
  worldHooks: readonly WorldHook[];
  assetDriver: StorageDriver;
  /** `config.clientIpHeader` — the presence ZSET touch records the real client address behind a proxy. */
  clientIpHeader: string | null;
  /** `config.profile !== "framework"` — whether presence scenes carry the core jail/hospital hooks (spec 2026-09-18 §1). */
  coreHooks: boolean;
}
export interface GatewayHandle { close(): Promise<void>; connectionCount(): number }

export async function attachGateway(server: Server, deps: GatewayDeps): Promise<GatewayHandle> {
  const wss = new WebSocketServer({ noServer: true });
  /** One player may hold several sockets (multiple tabs). */
  const sockets = new Map<string, Set<WebSocket>>();

  const send = (socket: WebSocket, frame: ServerFrame): void => {
    socket.send(JSON.stringify(ServerFrameSchema.parse(frame)));
  };

  const sendToPlayer = (playerId: string, frame: ServerFrame): void => {
    for (const socket of sockets.get(playerId) ?? []) send(socket, frame);
  };

  const rooms = createRooms({
    db: deps.db, redis: deps.redis, send,
    scenes: createSceneService({ db: deps.db, assetDriver: deps.assetDriver, hooks: deps.worldHooks, coreHooks: deps.coreHooks }),
    // The gateway owns the socket map; presence borrows a read of it to
    // auto-join a player whose location only arrives with their first travel.
    socketsOf: (playerId) => sockets.get(playerId) ?? [],
  });
  /** Same posture as route(): a throw in one frame's handler logs and drops that frame, never the process. */
  const guarded = (what: string, fn: () => void | Promise<void>): void => {
    try {
      const result = fn();
      if (result instanceof Promise) result.catch((err: unknown) => console.error({ err, what }, "presence: handler failed"));
    } catch (err) {
      console.error({ err, what }, "presence: handler failed");
    }
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return;

    // Cross-Site WebSocket Hijacking defense, same allowlist as CORS. A
    // browser always sends Origin on a WS handshake, so a *present* Origin
    // outside the allowlist means a malicious page in a victim's browser —
    // reject before the handshake completes. An *absent* Origin means a
    // non-browser client (our own tests, a future CLI/service): rejecting
    // that would block every legitimate non-browser client while adding no
    // protection, since the attack this defends against is specifically a
    // page that cannot suppress its own Origin header.
    const origin = request.headers.origin;
    if (origin !== undefined && !deps.corsOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // SPEC §2.2: the upgrade takes a short-lived, single-use ticket, never
    // the session token itself — a long-lived credential must never ride in
    // a URL, since URLs leak into access logs, proxy logs, and Referer
    // headers. `consumeTicket` invalidates it atomically on first read, so a
    // captured ticket is worthless to replay even within its ~30s TTL.
    const ticket = url.searchParams.get("ticket");
    void (async () => {
      const playerId = ticket ? await consumeTicket(deps.redis, ticket) : null;
      if (!playerId) {
        // Reject before the handshake completes — no half-open authed socket.
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const ip = clientIp({ ip: request.socket.remoteAddress ?? "", headers: request.headers }, deps.clientIpHeader);
      wss.handleUpgrade(request, socket, head, (ws) => {
        const existing = sockets.get(playerId) ?? new Set<WebSocket>();
        existing.add(ws);
        sockets.set(playerId, existing);

        ws.on("message", (raw) => {
          const parsed = ClientFrameSchema.safeParse(JSON.parse(raw.toString()));
          if (!parsed.success) { send(ws, { kind: "error", message: "invalid_frame" }); return; }
          const frame = parsed.data;
          switch (frame.kind) {
            case "ping": send(ws, { kind: "pong" }); return;
            // The gateway dispatches presence frames and knows nothing else
            // about them — every rule lives in presence/rooms.ts.
            case "presence.join": guarded("join", () => rooms.join(playerId, ws, ip || null, frame.interior)); return;
            case "presence.enter": guarded("enter", () => rooms.enter(ws, frame.hookId)); return;
            case "presence.exit": guarded("exit", () => rooms.exit(ws)); return;
            case "presence.move": guarded("move", () => rooms.move(ws, frame)); return;
            case "presence.emote": guarded("emote", () => rooms.emote(ws, frame.emote)); return;
            case "presence.leave": guarded("leave", () => rooms.leave(ws)); return;
          }
        });

        ws.on("close", () => {
          guarded("close", () => rooms.socketClosed(ws));
          const set = sockets.get(playerId);
          set?.delete(ws);
          if (set && set.size === 0) sockets.delete(playerId);
        });

        send(ws, { kind: "ready", playerId });
        // Every authenticated socket is put in its player's town without
        // being asked (spec 2026-09-19 §2), so a web or Android player
        // standing there is visible to a 3D client instead of invisible
        // until they run one. Nothing is sent to this socket as a result —
        // `autoJoin` leaves it unsubscribed — and every failure is silence.
        guarded("autojoin", () => rooms.autoJoin(playerId, ws, ip || null));
      });
    })();
  });

  /** Routing is driven entirely by event.audience — the gateway knows no game rules. */
  const route = async (event: GameEvent): Promise<void> => {
    const frame: ServerFrame = { kind: "event", event };
    switch (event.audience.kind) {
      case "global":
        for (const set of sockets.values()) for (const socket of set) send(socket, frame);
        return;
      case "player":
        sendToPlayer(event.audience.playerId, frame);
        return;
      case "gang": {
        const members = await deps.db.select({ playerId: gangMembers.playerId })
          .from(gangMembers).where(eq(gangMembers.gangId, event.audience.gangId));
        for (const member of members) sendToPlayer(member.playerId, frame);
        return;
      }
    }
  };

  await subscribeToEvents(deps.subscriber, (event) => {
    // route() can reject (the "gang" branch queries Postgres) — same hole
    // subscribe.ts already guards for a malformed frame ("must not take
    // this process down"): an unhandled rejection here can crash the whole
    // process and drop every connected socket, not just this one event.
    route(event).catch((err: unknown) => {
      console.error({ err, eventType: event.type, audienceKind: event.audience.kind }, "gateway: failed to route event");
    });
    rooms.onEvent(event).catch((err: unknown) => {
      console.error({ err, eventType: event.type }, "presence: failed to apply event");
    });
  });

  return {
    connectionCount: () => [...sockets.values()].reduce((n, set) => n + set.size, 0),
    close: async () => {
      rooms.close();
      for (const set of sockets.values()) for (const socket of set) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
