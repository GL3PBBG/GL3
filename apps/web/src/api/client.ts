const TOKEN_KEY = "gl3.token";

export const tokenStore = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  set: (token: string): void => localStorage.setItem(TOKEN_KEY, token),
  clear: (): void => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
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
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? "unknown_error");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
