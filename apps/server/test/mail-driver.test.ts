import { describe, expect, it, vi } from "vitest";
import { createMailDriver } from "../src/mail/driver.js";
import { loadConfig } from "../src/config.js";

const BASE_ENV = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" };

describe("mail config", () => {
  it("defaults to the log driver with gl3.dev sender", () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.mail).toEqual({ driver: "log", apiKey: null, from: "noreply@gl3.dev", appBaseUrl: "http://localhost:5173" });
  });
  it("rejects resend without an API key at boot", () => {
    expect(() => loadConfig({ ...BASE_ENV, EMAIL_DRIVER: "resend" })).toThrow(/RESEND_API_KEY/);
  });
});

describe("log driver", () => {
  it("resolves true and never throws", async () => {
    const driver = createMailDriver({ driver: "log", apiKey: null, from: "noreply@gl3.dev", appBaseUrl: "http://localhost:5173" });
    await expect(driver.send({ to: "a@x.com", subject: "s", text: "t" })).resolves.toBe(true);
  });
});

describe("resend driver", () => {
  it("POSTs to the Resend API and reports non-2xx as false without throwing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("nope", { status: 422 }));
    const driver = createMailDriver({ driver: "resend", apiKey: "re_123", from: "noreply@gl3.dev", appBaseUrl: "http://localhost:5173" });
    await expect(driver.send({ to: "a@x.com", subject: "s", text: "t" })).resolves.toBe(true);
    await expect(driver.send({ to: "a@x.com", subject: "s", text: "t" })).resolves.toBe(false);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer re_123");
    fetchSpy.mockRestore();
  });
});
