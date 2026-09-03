import type { ClientConfig, GateKind } from "@gl3/client";

const TOKEN_KEY = "gl3.token";
const GATE_PATH: Record<GateKind, string> = { email_unverified: "/verify", challenge_required: "/challenge" };

/**
 * The gate redirect, guarded against self-redirect loops: a gated player's own
 * useGameEvents on /verify (POST /api/ws/ticket, not gate-exempt) would
 * otherwise 403 into a full reload of the same URL, forever. Same for /challenge.
 */
export function webOnGate(kind: GateKind, location: { pathname: string; assign: (url: string) => void }): void {
  const path = GATE_PATH[kind];
  if (location.pathname !== path) location.assign(path);
}

export function webClientConfig(win: Window): ClientConfig {
  const protocol = win.location.protocol === "https:" ? "wss" : "ws";
  return {
    baseUrl: "",
    wsUrl: `${protocol}://${win.location.host}/ws`,
    tokenStore: {
      get: () => win.localStorage.getItem(TOKEN_KEY),
      set: (token) => win.localStorage.setItem(TOKEN_KEY, token),
      clear: () => win.localStorage.removeItem(TOKEN_KEY),
    },
    onGate: (kind) => webOnGate(kind, win.location),
  };
}
