import { SINGLETON_ENTITY_ID } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { bindAsset, storeAsset, unbindAsset } from "../src/assets/service.js";
import { settings } from "../src/db/schema/index.js";
import { authEmail } from "../src/mail/auth.js";
import { CORE_SCOPE } from "../src/plugins/asset-slots.js";
import { GAME_NAME_KEY } from "../src/theme/presets.js";
import { makePng, testAssetDriver } from "./helpers/assets.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const driver = testAssetDriver();
const baseUrl = "https://game.example/";
const binding = { scope: CORE_SCOPE, entityId: SINGLETON_ENTITY_ID, slot: "logo-login" };

beforeEach(async () => { await resetDb(db); });
afterAll(async () => { await conn.end(); });

it("falls back to GL3 without rendering a missing logo and preserves verification details", async () => {
  const message = await authEmail(db, driver, baseUrl, "player@example.test", "verify", "123456");
  expect(message.subject).toBe("Verify your GL3 account");
  expect(message.html).not.toContain("<img");
  for (const body of [message.text, message.html]) {
    expect(body).toContain("GL3");
    expect(body).toContain("123456");
    expect(body).toContain("https://game.example/verify?code=123456");
    expect(body).toContain("24 hours");
  }
});

it("uses live game branding, escapes HTML, and resolves the login logo to an absolute URL", async () => {
  await db.insert(settings).values({ key: GAME_NAME_KEY, value: 'Mob & "City" <Game>' });
  const asset = await storeAsset(db, driver, {
    bytes: makePng(20, 10), declaredMime: "image/png", uploadedBy: null, maxBytes: 2048, maxDimension: 100,
  });
  await bindAsset(db, { ...binding, assetId: asset.id });
  const message = await authEmail(db, driver, baseUrl, "player@example.test", "reset", "reset-token");
  expect(message.subject).toBe('Reset your Mob & "City" <Game> password');
  expect(message.html).toContain('Mob &amp; &quot;City&quot; &lt;Game&gt;');
  expect(message.html).toContain(`src="https://game.example/assets/${asset.sha256}"`);
  expect(message.html).not.toContain("GL3");
  for (const body of [message.text, message.html]) {
    expect(body).toContain("https://game.example/reset?token=reset-token");
    expect(body).toContain("1 hour");
  }

  const urlSpy = vi.spyOn(driver, "urlFor").mockReturnValue("https://cdn.example/logo.png?v=1&size=2");
  try {
    const cdn = await authEmail(db, driver, baseUrl, "player@example.test", "verify", "654321");
    expect(cdn.html).toContain('src="https://cdn.example/logo.png?v=1&amp;size=2"');
  } finally {
    urlSpy.mockRestore();
  }

  await db.update(settings).set({ value: "New Game" }).where(eq(settings.key, GAME_NAME_KEY));
  await unbindAsset(db, binding);
  await bindAsset(db, { ...binding, slot: "logo-header", assetId: asset.id });
  const resend = await authEmail(db, driver, baseUrl, "player@example.test", "verify", "654321");
  expect(resend.subject).toBe("Verify your New Game account");
  expect(resend.html).not.toContain("<img");
});
