import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgres://gl3:gl3@localhost:5432/gl3",
  REDIS_URL: "redis://localhost:6379",
  PORT: "3000",
  SESSION_TTL: "604800",
  NODE_ENV: "test",
};

describe("loadConfig", () => {
  it("coerces numeric vars to numbers", () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(3000);
    expect(config.sessionTtlSeconds).toBe(604800);
  });

  it("throws when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it("defaults CORS origins to the vite dev server and never to a wildcard", () => {
    expect(loadConfig(valid).corsOrigins).toEqual(["http://localhost:5173"]);
  });
});
