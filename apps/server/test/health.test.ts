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
