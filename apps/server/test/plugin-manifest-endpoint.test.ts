import { definePlugin } from "@gl3/plugin-sdk";
import { membershipPage } from "@gl3/plugin-membership";
import { DEFAULT_MONEY_FORMAT } from "@gl3/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { createRedis } from "../src/redis.js";
import { buildPluginsPayload } from "../src/plugins/manifest-endpoint.js";
import { stampAssetBinderScope } from "../src/plugins/asset-slots.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const redis = createRedis(loadConfig(process.env).redisUrl);

const alpha = definePlugin({
  id: "alpha", version: "1.0.0", basePaths: ["/api/alpha"],
  pages: [
    { id: "alpha.index", path: "/alpha", menu: { label: "Alpha", order: 20 },
      view: { kind: "text", value: "a" } },
    { id: "alpha.hidden", path: "/alpha/hidden", view: { kind: "text", value: "h" } },
  ],
  events: [{ name: "pinged", payload: z.object({}), describe: "{actorName} pinged", invalidates: ["alpha"] }],
});
const beta = definePlugin({
  id: "beta", version: "1.0.0", basePaths: ["/api/beta"],
  pages: [{ id: "beta.index", path: "/beta", menu: { label: "Beta", order: 10 },
    view: { kind: "text", value: "b" } }],
});

let regCounter = 0;

/** Register a player and return { token } — inline because no shared factories file exists. */
async function register(app: FastifyInstance): Promise<{ token: string }> {
  regCounter++;
  // Distinct IP per registration to keep this file's rate-limit bucket private.
  return registerVerifiedPlayer({ app, redis }, {
    username: `PMUser${regCounter}`,
    remoteAddress: `10.21.${regCounter >> 8 & 0xff}.${regCounter & 0xff}`,
  });
}

describe("buildPluginsPayload", () => {
  // "framework" throughout this describe: these cases are about how PLUGIN
  // menus merge with each other, and the full profile additionally appends
  // the synthetic jail/hospital core pages — asserted in
  // framework-profile.test.ts, kept out of the way here.
  it("merges menus across plugins and sorts by order", () => {
    expect(buildPluginsPayload([alpha, beta], "framework").menu.map((m) => m.label)).toEqual(["Beta", "Alpha"]);
  });

  it("omits pages that declare no menu entry", () => {
    expect(buildPluginsPayload([alpha], "framework").menu).toHaveLength(1);
  });

  it("still describes a menu-less page so it can be routed to directly", () => {
    expect(buildPluginsPayload([alpha], "framework").pages.map((p) => p.id)).toContain("alpha.hidden");
  });

  it("carries a declared nav category through to the menu item", () => {
    const gamma = definePlugin({
      id: "gamma", version: "1.0.0", basePaths: ["/api/gamma"],
      pages: [{ id: "gamma.index", path: "/gamma",
        menu: { label: "Gamma", order: 30, category: "crimes" },
        view: { kind: "text", value: "g" } }],
    });
    expect(buildPluginsPayload([gamma], "framework").menu[0]).toEqual({
      pageId: "gamma.index", path: "/gamma", label: "Gamma", order: 30, category: "crimes",
    });
  });

  it("omits the category key entirely for a page that declares none", () => {
    expect(buildPluginsPayload([alpha], "framework").menu[0]).not.toHaveProperty("category");
  });

  it("carries each event's describe template and invalidation keys", () => {
    expect(buildPluginsPayload([alpha]).events).toEqual([
      { pluginId: "alpha", name: "pinged", describe: "{actorName} pinged", invalidates: ["alpha"] },
    ]);
  });

  // `toEqual` above is the other half of this pair: it fails if a `silent`
  // key appears on a declaration that never asked for one, which is what
  // keeps a pre-flag manifest's payload byte-for-byte what it was.
  it("carries the silent flag through for a declaration that sets it", () => {
    const quiet = definePlugin({
      id: "quiet", version: "1.0.0", basePaths: ["/api/quiet"],
      events: [{
        name: "ticked", payload: z.object({}), describe: "{actorName} ticked",
        invalidates: ["quiet"], silent: true,
      }],
    });
    expect(buildPluginsPayload([quiet]).events).toEqual([
      {
        pluginId: "quiet", name: "ticked", describe: "{actorName} ticked",
        invalidates: ["quiet"], silent: true,
      },
    ]);
  });
});

describe("GET /api/plugins", () => {
  it("401s without a token", async () => {
    const { app, close } = await bootTestServer({ plugins: [alpha] });
    try {
      expect((await app.inject({ method: "GET", url: "/api/plugins" })).statusCode).toBe(401);
    } finally {
      await close();
    }
  });

  it("returns the merged payload to an authenticated player", async () => {
    const { app, close } = await bootTestServer({ profile: "framework", plugins: [alpha, beta] });
    try {
      const { token } = await register(app);
      const res = await app.inject({ method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      // A framework boot merges only `membership`'s menu entry under
      // `alpha`/`beta` — the gameplay plugins' pages (and the synthetic
      // jail/hospital entries) are the full profile's, covered below and in
      // framework-profile.test.ts.
      expect(res.json().menu.map((m: { label: string }) => m.label)).toEqual([
        "Beta", "Alpha", "Membership",
      ]);
    } finally {
      await close();
    }
  });

  // A framework boot keeps this census small and stable: the eight
  // game-agnostic plugins only. The full-profile payload (gameplay pages,
  // synthetic jail/hospital, the gameplay plugins' events) is covered by
  // framework-profile.test.ts's payload assertions — an exact-equality
  // census of all twenty would break on every plugin tweak, which this
  // file's history (see the casino entry saga below, now trimmed away with
  // the gameplay plugins) shows is not a hypothetical.
  //
  // bootTestServer() builds `deps.plugins` itself for every option shape,
  // so the branch where `deps.plugins` is undefined is exercised the same
  // way here as it ever was by the old no-arg call.
  it("returns the framework payload for a framework boot", async () => {
    const { app, close } = await bootTestServer({ profile: "framework" });
    try {
      const { token } = await register(app);
      const res = await app.inject({ method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        menu: [
          { pageId: "membership.index", path: "/membership", label: "Membership", order: 60 },
        ],
        // Mirrors `buildPluginsPayload`'s own `PagePayload` shape: `menu` lives
        // only in the top-level `menu` array, not duplicated onto each page.
        pages: [
          // The loader stamps every slotImage/assetBinder with the declaring
          // plugin's scope, so the expected view is the STAMPED one — the raw
          // manifest view differs by exactly that field.
          { pluginId: "membership", id: membershipPage.id, path: membershipPage.path, view: stampAssetBinderScope(membershipPage.view, "membership") },
        ],
        events: [{
          pluginId: "inventory",
          name: "purchased",
          describe: "Bought {qty}x {name}",
          invalidates: ["inventory", "me"],
        }, {
          pluginId: "membership",
          name: "purchased",
          describe: "{actorName} bought {packageName}",
          invalidates: ["membership", "me", "hudExtras"],
        }, {
          pluginId: "membership",
          name: "gifted",
          describe: "{actorName} gifted {packageName} to {recipientName}",
          invalidates: ["membership", "me", "hudExtras"],
        }],
        // Feature detection for the client (HUD stat gating): every installed
        // plugin id, sorted.
        installed: [
          "bank", "forum", "inventory", "mail", "membership", "news", "notifications", "ranks",
        ],
        // `core.moneyFormat` is applied fresh per request in
        // `registerPluginsEndpoint`, not baked into the boot-built payload —
        // this asserts the no-subscriber default that chain resolves to when
        // nothing overrides it.
        moneyFormat: DEFAULT_MONEY_FORMAT,
      });
    } finally {
      await close();
    }
  });
});
