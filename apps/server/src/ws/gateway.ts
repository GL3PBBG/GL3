import type { Server } from "node:http";
import { ServerFrameSchema, ClientFrameSchema, type GameEvent, type ServerFrame } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { WebSocketServer, type WebSocket } from "ws";
import { consumeTicket } from "../auth/session.js";
import { subscribeToEvents } from "../bus/subscribe.js";
import type { Db } from "../db/client.js";
import { gangMembers } from "../db/schema/index.js";

export interface GatewayDeps { db: Db; redis: Redis; subscriber: Redis; corsOrigins: string[] }
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
      wss.handleUpgrade(request, socket, head, (ws) => {
        const existing = sockets.get(playerId) ?? new Set<WebSocket>();
        existing.add(ws);
        sockets.set(playerId, existing);

        ws.on("message", (raw) => {
          const parsed = ClientFrameSchema.safeParse(JSON.parse(raw.toString()));
          if (!parsed.success) { send(ws, { kind: "error", message: "invalid_frame" }); return; }
          if (parsed.data.kind === "ping") send(ws, { kind: "pong" });
        });

        ws.on("close", () => {
          const set = sockets.get(playerId);
          set?.delete(ws);
          if (set && set.size === 0) sockets.delete(playerId);
        });

        send(ws, { kind: "ready", playerId });
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

  await subscribeToEvents(deps.subscriber, (event) => { void route(event); });

  return {
    connectionCount: () => [...sockets.values()].reduce((n, set) => n + set.size, 0),
    close: async () => {
      for (const set of sockets.values()) for (const socket of set) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
