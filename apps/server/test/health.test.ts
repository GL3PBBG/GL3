import { describe, expect, it } from "vitest";
import { bootTestServer } from "./helpers/server.js";

describe("GET /health", () => {
  it("reports ok", async () => {
    const { app, close } = await bootTestServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await close();
  });
});

describe("CORS (spec §7 — strict allowlist, never a wildcard)", () => {
  // Swapping app.ts's `origin: config.corsOrigins` for a hardcoded "*" would
  // pass every other test in the suite; only a real Origin-header round trip
  // can catch that regression.
  it("echoes the allow-origin header for an allowed origin", async () => {
    const { app, close } = await bootTestServer();
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:5173" } });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    await close();
  });

  it("does not send an allow-origin header for a disallowed origin", async () => {
    const { app, close } = await bootTestServer();
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://evil.test" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await close();
  });
});
