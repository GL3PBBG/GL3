import { describe, expect, it, beforeEach } from "vitest";
import { clientConfig, configureClient, resetClientConfigForTests, type ClientConfig } from "../src/config.js";

const memoryStore = () => {
  let token: string | null = null;
  return { get: () => token, set: (t: string) => { token = t; }, clear: () => { token = null; } };
};

const base = (): ClientConfig => ({ baseUrl: "https://example.test", wsUrl: "wss://example.test/ws", tokenStore: memoryStore(), onGate: () => undefined });

describe("client config", () => {
  beforeEach(() => resetClientConfigForTests());
  it("throws until configured", () => {
    expect(() => clientConfig()).toThrow(/configureClient/);
  });
  it("returns what was configured", () => {
    const c = base();
    configureClient(c);
    expect(clientConfig()).toEqual({ ...c, baseUrl: "https://example.test" });
  });
  it("strips a trailing slash from baseUrl", () => {
    configureClient({ ...base(), baseUrl: "https://example.test/" });
    expect(clientConfig().baseUrl).toBe("https://example.test");
  });
});
