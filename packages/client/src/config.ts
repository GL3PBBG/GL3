export interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
}

export type GateKind = "email_unverified" | "challenge_required";

export interface ClientConfig {
  /** Origin the REST paths are appended to. "" = same origin (web). No trailing slash. */
  baseUrl: string;
  /** Absolute WebSocket URL of the event feed, e.g. "wss://gangster.land/ws". */
  wsUrl: string;
  tokenStore: TokenStore;
  /** 403 email_unverified / 409 challenge_required — the host decides what to show. */
  onGate: (kind: GateKind) => void;
}

let current: ClientConfig | null = null;

export function configureClient(config: ClientConfig): void {
  current = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, "") };
}

export function clientConfig(): ClientConfig {
  if (current === null) throw new Error("configureClient() has not been called");
  return current;
}

/** Test seam only. */
export function resetClientConfigForTests(): void {
  current = null;
}

/** Same import name the web app has always used; forwards to the configured store. */
export const tokenStore: TokenStore = {
  get: () => clientConfig().tokenStore.get(),
  set: (token) => clientConfig().tokenStore.set(token),
  clear: () => clientConfig().tokenStore.clear(),
};
