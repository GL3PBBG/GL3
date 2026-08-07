import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
  DATABASE_URL: "postgres://gl3:gl3@localhost:5432/gl3",
  REDIS_URL: "redis://localhost:6379",
  NODE_ENV: "test",
});

describe("GET /health", () => {
  it("reports ok", async () => {
    const app = await buildApp(config);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
