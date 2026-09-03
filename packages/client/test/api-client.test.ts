import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/api/client.js";
import { configureClient, resetClientConfigForTests, type GateKind } from "../src/config.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("api()", () => {
  const gates: GateKind[] = [];
  let token: string | null = "tok";
  beforeEach(() => {
    gates.length = 0;
    configureClient({
      baseUrl: "https://game.test/",
      wsUrl: "wss://game.test/ws",
      tokenStore: { get: () => token, set: (t) => { token = t; }, clear: () => { token = null; } },
      onGate: (k) => { gates.push(k); },
    });
  });
  afterEach(() => { resetClientConfigForTests(); vi.restoreAllMocks(); });

  it("prefixes baseUrl and sends the bearer from the injected store", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(200, { ok: true }));
    await api<{ ok: boolean }>("/api/auth/me");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://game.test/api/auth/me");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
  });

  it("calls onGate('email_unverified') on 403 and still throws", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(403, { error: "email_unverified" }));
    await expect(api("/api/crimes")).rejects.toBeInstanceOf(ApiError);
    expect(gates).toEqual(["email_unverified"]);
  });

  it("calls onGate('challenge_required') on 409 challenge_required", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(409, { error: "challenge_required" }));
    await expect(api("/api/crimes", { method: "POST" })).rejects.toBeInstanceOf(ApiError);
    expect(gates).toEqual(["challenge_required"]);
  });

  it("does not call onGate for other errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(401, { error: "unauthorized" }));
    await expect(api("/api/auth/me")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(gates).toEqual([]);
  });
});
