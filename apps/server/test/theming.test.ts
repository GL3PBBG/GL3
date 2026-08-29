import { TableRowsResponseSchema, ThemeResponseSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles, settings } from "../src/db/schema/index.js";
import { makePng } from "./helpers/assets.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Theming — one theme for the whole game, admin-picked. `GET /api/theme` is
 * PUBLIC (the login page renders before any session exists) and reads the
 * settings TABLE live on every request, not the boot snapshot, so a theme
 * change lands on the next page load with no restart — same table-not-snapshot
 * choice detectives' admin settings routes made, for the same reason.
 *
 * Storage: `theme.preset` plus `theme.override.<var>` rows in `settings`.
 * Resolution: preset palette merged with overrides, returned fully resolved so
 * the client applies colors without knowing any palette.
 */

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

async function registerPlayer(username: string): Promise<{ token: string; playerId: string }> {
  return registerVerifiedPlayer({ app, redis }, { username });
}

async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}-${roleId.slice(-6)}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

const auth = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

/** The midnight preset IS theme.css's current palette — the fallback and the
 *  default must agree or an unthemed install flashes from one to the other. */
const MIDNIGHT = {
  bg: "#101014", fg: "#e6e6ea", accent: "#c8963e", success: "#5bbd7a",
  danger: "#d2564f", muted: "#8d8d99", panel: "#17171c", line: "#2a2a30",
};

const BLANK_OVERRIDES = {
  bg: "", fg: "", accent: "", success: "", danger: "", muted: "", panel: "", line: "",
};

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("GET /api/theme", () => {
  it("is public and answers the midnight defaults on a fresh install", async () => {
    const res = await app.inject({ method: "GET", url: "/api/theme" });
    expect(res.statusCode, res.body).toBe(200);
    const parsed = ThemeResponseSchema.safeParse(res.json());
    expect(parsed.success, res.body).toBe(true);
    expect(parsed.data).toEqual({
      preset: "midnight", colors: MIDNIGHT, layout: { nav: "top" },
      branding: { gameName: "GL3", logoLogin: null, logoHeader: null },
    });
  });

  it("falls back to midnight when the stored preset name is unknown", async () => {
    // Hand-edited or stale row — resolution must not 500 or half-apply.
    await db.insert(settings).values({ key: "theme.preset", value: "no-such-theme" });
    const res = await app.inject({ method: "GET", url: "/api/theme" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      preset: "midnight", colors: MIDNIGHT, layout: { nav: "top" },
      branding: { gameName: "GL3", logoLogin: null, logoHeader: null },
    });
  });

  it("ignores a stored override that is not a hex color", async () => {
    await db.insert(settings).values({ key: "theme.override.bg", value: "purple" });
    const res = await app.inject({ method: "GET", url: "/api/theme" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { colors: { bg: string } }).colors.bg).toBe(MIDNIGHT.bg);
  });
});

describe("POST /api/admin/theme", () => {
  it("switches the preset and the public read reflects it live, no restart", async () => {
    const admin = await registerPlayer("Founder");
    const post = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "noir", ...BLANK_OVERRIDES },
    });
    expect(post.statusCode, post.body).toBe(204);

    const res = await app.inject({ method: "GET", url: "/api/theme" });
    const body = res.json() as { preset: string; colors: Record<string, string> };
    expect(body.preset).toBe("noir");
    // A preset that resolved to midnight's accent would mean the palette
    // lookup is a no-op — the two presets must actually differ.
    expect(body.colors.accent).not.toBe(MIDNIGHT.accent);
  });

  it("merges overrides over the preset: overridden var changes, the rest keep the preset value", async () => {
    const admin = await registerPlayer("Founder");
    const post = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "midnight", ...BLANK_OVERRIDES, bg: "#000000" },
    });
    expect(post.statusCode, post.body).toBe(204);

    const body = (await app.inject({ method: "GET", url: "/api/theme" })).json() as {
      preset: string; colors: Record<string, string>;
    };
    expect(body.colors.bg).toBe("#000000");
    expect(body.colors.fg).toBe(MIDNIGHT.fg);
  });

  it("a blank field clears its override — the POST replaces the whole override set", async () => {
    const admin = await registerPlayer("Founder");
    await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "midnight", ...BLANK_OVERRIDES, bg: "#000000" },
    });
    const clear = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "midnight", ...BLANK_OVERRIDES },
    });
    expect(clear.statusCode, clear.body).toBe(204);

    const body = (await app.inject({ method: "GET", url: "/api/theme" })).json() as {
      colors: Record<string, string>;
    };
    expect(body.colors.bg).toBe(MIDNIGHT.bg);
    // Cleared means the row is gone, not stored as "".
    const rows = await db.select().from(settings).where(eq(settings.key, "theme.override.bg"));
    expect(rows).toEqual([]);
  });

  it("moves the nav to the left and the public read reflects it", async () => {
    const admin = await registerPlayer("Founder");
    const post = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "midnight", navPosition: "left", ...BLANK_OVERRIDES },
    });
    expect(post.statusCode, post.body).toBe(204);

    const body = (await app.inject({ method: "GET", url: "/api/theme" })).json() as {
      layout: { nav: string };
    };
    expect(body.layout.nav).toBe("left");
  });

  it("a POST without navPosition keeps the nav on top — old clients stay valid", async () => {
    const admin = await registerPlayer("Founder");
    const post = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "midnight", ...BLANK_OVERRIDES },
    });
    expect(post.statusCode, post.body).toBe(204);
    const body = (await app.inject({ method: "GET", url: "/api/theme" })).json() as {
      layout: { nav: string };
    };
    expect(body.layout.nav).toBe("top");
  });

  it("400s invalid_request on an unknown nav position", async () => {
    const admin = await registerPlayer("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "midnight", navPosition: "diagonal", ...BLANK_OVERRIDES },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  it("400s invalid_color on a non-hex override and stores nothing", async () => {
    const admin = await registerPlayer("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "midnight", ...BLANK_OVERRIDES, accent: "not-a-color" },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_color" });
    expect(await db.select().from(settings)).toEqual([]);
  });

  it("400s invalid_preset on an unknown preset name", async () => {
    const admin = await registerPlayer("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "vaporwave", ...BLANK_OVERRIDES },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_preset" });
  });

  it("401s with no token and 403s a role with no grant", async () => {
    await registerPlayer("Founder"); // soaks up the auto-admin slot
    const pleb = await registerPlayer("Pleb");

    const anon = await app.inject({
      method: "POST", url: "/api/admin/theme",
      payload: { preset: "midnight", ...BLANK_OVERRIDES },
    });
    expect(anon.statusCode).toBe(401);

    const forbidden = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(pleb.token),
      payload: { preset: "midnight", ...BLANK_OVERRIDES },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: "forbidden" });
  });

  it("200s a role holding the theme module key", async () => {
    await registerPlayer("Founder");
    const mod = await registerPlayer("Themer");
    await giveRole(mod.playerId, "theme");
    const res = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(mod.token),
      payload: { preset: "noir", ...BLANK_OVERRIDES },
    });
    expect(res.statusCode, res.body).toBe(204);
  });
});

describe("GET /api/admin/theme/table", () => {
  it("parses under TableRowsResponseSchema and shows the active preset plus overrides", async () => {
    const admin = await registerPlayer("Founder");
    await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "noir", navPosition: "left", ...BLANK_OVERRIDES, accent: "#ff0000" },
    });

    const res = await app.inject({
      method: "GET", url: "/api/admin/theme/table", headers: auth(admin.token),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(TableRowsResponseSchema.safeParse(body).success, res.body).toBe(true);
    const rows = (body as { rows: Record<string, string>[] }).rows;
    expect(rows.find((r) => r.setting === "preset")?.value).toBe("noir");
    expect(rows.find((r) => r.setting === "nav")?.value).toBe("left");
    expect(rows.find((r) => r.setting === "accent")?.value).toBe("#ff0000");
  });

  it("403s a role with no grant", async () => {
    await registerPlayer("Founder");
    const pleb = await registerPlayer("Pleb");
    const res = await app.inject({
      method: "GET", url: "/api/admin/theme/table", headers: auth(pleb.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * Branding rides the theme payload because the login page needs it before any
 * session exists and `GET /api/theme` is the one public settings read — the
 * slot-image route requires auth, so it cannot carry the login logo.
 *
 * Storage: `game.name` row in `settings` (blank/absent -> "GL3"), plus the two
 * core singleton asset slots `logo-login` / `logo-header` bound through the
 * ordinary art admin.
 */
describe("branding on GET /api/theme", () => {
  it("defaults to GL3 with no logos on a fresh install", async () => {
    const res = await app.inject({ method: "GET", url: "/api/theme" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { branding: unknown }).branding).toEqual({
      gameName: "GL3", logoLogin: null, logoHeader: null,
    });
  });

  it("serves a stored game name live — a hand-edited row lands with no restart", async () => {
    await db.insert(settings).values({ key: "game.name", value: "Mob City" });
    const res = await app.inject({ method: "GET", url: "/api/theme" });
    expect((res.json() as { branding: { gameName: string } }).branding.gameName).toBe("Mob City");
  });

  it("POST /api/admin/theme stores the game name; a blank clears back to the default", async () => {
    const admin = await registerPlayer("Founder");
    const post = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "midnight", gameName: "Mob City", ...BLANK_OVERRIDES },
    });
    expect(post.statusCode, post.body).toBe(204);
    let body = (await app.inject({ method: "GET", url: "/api/theme" })).json() as {
      branding: { gameName: string };
    };
    expect(body.branding.gameName).toBe("Mob City");

    const clear = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "midnight", gameName: "", ...BLANK_OVERRIDES },
    });
    expect(clear.statusCode, clear.body).toBe(204);
    body = (await app.inject({ method: "GET", url: "/api/theme" })).json() as {
      branding: { gameName: string };
    };
    expect(body.branding.gameName).toBe("GL3");
    // Cleared means the row is gone, not stored as "" — the theme-override rule.
    expect(await db.select().from(settings).where(eq(settings.key, "game.name"))).toEqual([]);
  });

  it("400s invalid_game_name on a name longer than 60 characters and stores nothing", async () => {
    const admin = await registerPlayer("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/theme", headers: auth(admin.token),
      payload: { preset: "midnight", gameName: "x".repeat(61), ...BLANK_OVERRIDES },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_game_name" });
    expect(await db.select().from(settings)).toEqual([]);
  });

  it("resolves a bound logo slot into a public URL on the theme payload", async () => {
    const admin = await registerPlayer("Founder");
    const png = makePng(8, 8);
    const uploaded = await app.inject({
      method: "POST", url: "/api/admin/assets", headers: { ...auth(admin.token), "content-type": "image/png" },
      payload: png,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const { assetId, url } = uploaded.json() as { assetId: string; url: string };

    const bind = await app.inject({
      method: "PUT", url: "/api/admin/assets/bind", headers: auth(admin.token),
      payload: { scope: "core", slot: "logo-header", assetId },
    });
    expect(bind.statusCode, bind.body).toBe(200);

    const body = (await app.inject({ method: "GET", url: "/api/theme" })).json() as {
      branding: { logoLogin: string | null; logoHeader: string | null };
    };
    expect(body.branding.logoHeader).toBe(url);
    // The other slot stays unbound — the two sizes are independent.
    expect(body.branding.logoLogin).toBe(null);
  });
});
