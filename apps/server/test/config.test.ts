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

  it("rejects a bare wildcard CORS_ORIGINS", () => {
    expect(() => loadConfig({ ...valid, CORS_ORIGINS: "*" })).toThrow(/wildcard/);
  });

  it("rejects a wildcard mixed into an otherwise valid allowlist", () => {
    expect(() => loadConfig({ ...valid, CORS_ORIGINS: "http://a.com,*" })).toThrow(/wildcard/);
  });

  it("defaults clientIpHeader to null and passes a configured header through", () => {
    expect(loadConfig(valid).clientIpHeader).toBeNull();
    expect(loadConfig({ ...valid, CLIENT_IP_HEADER: "cf-connecting-ip" }).clientIpHeader).toBe("cf-connecting-ip");
    // Blank means unset, not "trust the empty-named header".
    expect(loadConfig({ ...valid, CLIENT_IP_HEADER: "  " }).clientIpHeader).toBeNull();
  });

  it("defaults SWEEP_INTERVAL_MS to 2000 and allows 0 to disable", () => {
    const base = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" };
    expect(loadConfig({ ...base }).sweepIntervalMs).toBe(2000);
    expect(loadConfig({ ...base, SWEEP_INTERVAL_MS: "0" }).sweepIntervalMs).toBe(0);
    expect(loadConfig({ ...base, SWEEP_INTERVAL_MS: "500" }).sweepIntervalMs).toBe(500);
  });

  it("leaves push off by default and reads no Expo token", () => {
    expect(loadConfig(valid).push).toEqual({ enabled: false, expoAccessToken: null });
  });

  it("enables push on true or 1 and carries the Expo access token", () => {
    expect(loadConfig({ ...valid, PUSH_ENABLED: "true" }).push.enabled).toBe(true);
    expect(loadConfig({ ...valid, PUSH_ENABLED: "1" }).push.enabled).toBe(true);
    expect(loadConfig({ ...valid, PUSH_ENABLED: "false" }).push.enabled).toBe(false);
    expect(loadConfig({ ...valid, PUSH_ENABLED: "0" }).push.enabled).toBe(false);
    expect(loadConfig({ ...valid, EXPO_ACCESS_TOKEN: "expo_abc" }).push.expoAccessToken).toBe("expo_abc");
    // Blank means unset, not "send an empty bearer".
    expect(loadConfig({ ...valid, EXPO_ACCESS_TOKEN: "  " }).push.expoAccessToken).toBeNull();
  });

  it("rejects a PUSH_ENABLED value that is neither on nor off, rather than guessing", () => {
    expect(() => loadConfig({ ...valid, PUSH_ENABLED: "yes" })).toThrow();
  });

  it("accepts PUSH_ENABLED with no access token — that is a valid configuration", () => {
    expect(() => loadConfig({ ...valid, PUSH_ENABLED: "true" })).not.toThrow();
  });
});
