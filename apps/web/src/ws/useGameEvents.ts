import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ServerFrameSchema } from "@gl3/shared";
import { z } from "zod";
import { api } from "../api/client.js";
import { eventStore } from "../store/events.js";

const TicketResponseSchema = z.object({ ticket: z.string() });

const RECONNECT_DELAY_MS = 2_000;
const PING_INTERVAL_MS = 30_000;

/**
 * Opens the live event socket.
 *
 * SPEC §2.2 (amended): the `/ws` upgrade no longer accepts the session token
 * at all — a long-lived credential must never ride in a URL, since URLs leak
 * into access logs, proxy logs, and `Referer` headers. Instead we mint a
 * short-lived (~30s), single-use *ticket* via `POST /api/ws/ticket` (bearer
 * auth on the normal REST path) and pass only that ticket as `?ticket=`.
 *
 * The ticket is consumed atomically on first use, so it can never be
 * replayed — a dropped connection cannot reconnect with the same ticket.
 * Every (re)connect, including the very first one, therefore fetches a
 * fresh ticket immediately before opening the socket.
 *
 * `playerId` is passed in (rather than read once from storage) so the
 * effect re-runs — tearing down any stale connection and opening a fresh
 * one with a fresh ticket — the moment login/logout changes who we are.
 */
export function useGameEvents(playerId: string | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!playerId) return;

    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (): Promise<void> => {
      if (cancelled) return;

      let ticket: string;
      try {
        const response = await api<unknown>("/api/ws/ticket", { method: "POST" });
        ticket = TicketResponseSchema.parse(response).ticket;
      } catch {
        // Not authenticated (or logged out mid-flight) — give up quietly;
        // a future login will re-run this effect with a new playerId.
        return;
      }
      if (cancelled) return;

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws?ticket=${ticket}`);
      socket = ws;

      ws.addEventListener("message", (message) => {
        const parsed = ServerFrameSchema.safeParse(JSON.parse(message.data as string));
        if (!parsed.success || parsed.data.kind !== "event") return;
        eventStore.push(parsed.data.event);
        // A resolved crime changed cash and cooldowns — pull the fresh numbers.
        if (parsed.data.event.type === "crime.resolved") {
          void queryClient.invalidateQueries({ queryKey: ["me"] });
          void queryClient.invalidateQueries({ queryKey: ["crimes"] });
        }
      });

      ws.addEventListener("close", () => {
        if (cancelled) return;
        // Whatever spent this ticket is gone either way — reconnecting
        // means fetching a brand new one, never replaying this socket's.
        reconnectTimer = setTimeout(() => { void connect(); }, RECONNECT_DELAY_MS);
      });
    };

    void connect();

    const ping = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: "ping" }));
    }, PING_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(ping);
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [playerId, queryClient]);
}
