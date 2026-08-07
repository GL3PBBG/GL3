import type { Server } from "node:http";
import { ServerFrameSchema, ClientFrameSchema, type GameEvent, type ServerFrame } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { WebSocketServer, type WebSocket } from "ws";
import { readSession } from "../auth/session.js";
import { subscribeToEvents } from "../bus/subscribe.js";
import type { Db } from "../db/client.js";
import { gangMembers } from "../db/schema/index.js";

export interface GatewayDeps { db: Db; redis: Redis; subscriber: Redis }
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

    const token = url.searchParams.get("token");
    void (async () => {
      const playerId = token ? await readSession(deps.redis, token) : null;
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
