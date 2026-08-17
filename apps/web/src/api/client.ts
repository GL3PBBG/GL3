const TOKEN_KEY = "gl3.token";

export const tokenStore = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  set: (token: string): void => localStorage.setItem(TOKEN_KEY, token),
  clear: (): void => localStorage.removeItem(TOKEN_KEY),
};

/**
 * The extra fields the server attaches to specific failures.
 *
 * Written `?: number | undefined` rather than `?: number` because
 * `exactOptionalPropertyTypes` is on: the construction site below always
 * supplies all three keys, so they must be allowed to hold `undefined`.
 */
export interface ApiErrorDetail {
  /** 429 on_cooldown — seconds until the action is available again. */
  retryAfter?: number | undefined;
  /** 423 jailed — seconds left on the sentence. */
  remainingSeconds?: number | undefined;
  /** 409 insufficient_stock — how many bullets the location actually has. */
  available?: number | undefined;
  /** 400 quantity_above_max — the admin's per-purchase bullet cap. */
  maxBuy?: number | undefined;
}

export class ApiError extends Error {
  readonly retryAfter: number | undefined;
  readonly remainingSeconds: number | undefined;
  readonly available: number | undefined;
  readonly maxBuy: number | undefined;

  constructor(readonly status: number, readonly code: string, detail: ApiErrorDetail = {}) {
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.retryAfter = detail.retryAfter;
    this.remainingSeconds = detail.remainingSeconds;
    this.available = detail.available;
    this.maxBuy = detail.maxBuy;
  }
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const response = await fetch(path, {
    ...init,
    headers: {
      // Only declare a JSON body when we're actually sending one — the
      // server's JSON parser rejects `content-type: application/json` on a
      // bodyless request (e.g. POST /commit, POST /ws/ticket) with 400
      // FST_ERR_CTP_EMPTY_JSON_BODY.
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // 423 and both 429 variants also carry the wait as a `retry-after` header;
    // fall back to it so a proxy that strips the body still leaves us a number
    // to lock the button with.
    const header = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const fromHeader = Number.isFinite(header) && header >= 0 ? header : undefined;
    const code = typeof body["error"] === "string" ? body["error"] : "unknown_error";
    throw new ApiError(response.status, code, {
      retryAfter: asCount(body["retryAfter"]) ?? fromHeader,
      remainingSeconds: asCount(body["remainingSeconds"]) ?? fromHeader,
      available: asCount(body["available"]),
      maxBuy: asCount(body["maxBuy"]),
    });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
