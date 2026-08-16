import { definePlugin } from "@gl3/plugin-sdk";
import { garagePage, theftPage } from "@gl3/plugin-theft";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildPluginsPayload } from "../src/plugins/manifest-endpoint.js";
import { bootTestServer } from "./helpers/server.js";

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
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    // Distinct IP per registration to keep this file's rate-limit bucket private.
    remoteAddress: `10.21.${regCounter >> 8 & 0xff}.${regCounter & 0xff}`,
    payload: {
      username: `PMUser${regCounter}`,
      password: "hunter2hunter2",
    },
  });
  return reg.json();
}

describe("buildPluginsPayload", () => {
  it("merges menus across plugins and sorts by order", () => {
    expect(buildPluginsPayload([alpha, beta]).menu.map((m) => m.label)).toEqual(["Beta", "Alpha"]);
  });

  it("omits pages that declare no menu entry", () => {
    expect(buildPluginsPayload([alpha]).menu).toHaveLength(1);
  });

  it("still describes a menu-less page so it can be routed to directly", () => {
    expect(buildPluginsPayload([alpha]).pages.map((p) => p.id)).toContain("alpha.hidden");
  });

  it("carries each event's describe template and invalidation keys", () => {
    expect(buildPluginsPayload([alpha]).events).toEqual([
      { pluginId: "alpha", name: "pinged", describe: "{actorName} pinged", invalidates: ["alpha"] },
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
    const { app, close } = await bootTestServer({ plugins: [alpha, beta] });
    try {
      const { token } = await register(app);
      const res = await app.inject({ method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      // `bootTestServer` always merges CORE_PLUGINS (`withCorePlugins`) under
      // `alpha`/`beta`, so `theft`'s two menu entries ride along here too —
      // sorted by `order` with everyone else's.
      expect(res.json().menu.map((m: { label: string }) => m.label)).toEqual([
        "Beta", "Alpha", "Car theft", "Garage",
      ]);
    } finally {
      await close();
    }
  });

  // bootTestServer() with no argument is the only path that leaves
  // `deps.plugins` undefined, which is the branch this case exists for.
  // Passing `{ plugins: [] }` would run the loader and reach the endpoint
  // through the *defined* branch, proving nothing about a plugin-less boot.
  //
  // "No plugins loaded" is about that branch, not an actually-empty plugin
  // set: `bootTestServer()`'s no-arg path still merges `CORE_PLUGINS` via
  // `withCorePlugins`, so any core plugin's own menu/pages/events surface
  // here. `inventory` declares the `purchased` event (`shop.ts`), the first
  // core plugin to declare any, and `theft` declares two — hence the
  // non-empty `events` array below. Order follows `CORE_PLUGINS`, where
  // `theft` is appended after `inventory`.
  it("returns an empty 200 payload when no plugins are loaded", async () => {
    const { app, close } = await bootTestServer();
    try {
      const { token } = await register(app);
      const res = await app.inject({ method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        menu: [
          { pageId: "theft.index", path: "/theft", label: "Car theft", order: 40 },
          { pageId: "theft.garage", path: "/garage", label: "Garage", order: 41 },
        ],
        // Mirrors `buildPluginsPayload`'s own `PagePayload` shape: `menu` lives
        // only in the top-level `menu` array, not duplicated onto each page.
        pages: [theftPage, garagePage].map((p) => ({
          pluginId: "theft", id: p.id, path: p.path, view: p.view,
        })),
        events: [{
          pluginId: "inventory",
          name: "purchased",
          describe: "Bought {qty}x {name}",
          invalidates: ["inventory", "me"],
        }, {
          pluginId: "theft",
          name: "resolved",
          describe: "{actorName} {outcome}",
          invalidates: ["theft", "garage", "me"],
        }, {
          pluginId: "theft",
          name: "sold",
          describe: "{actorName} sold a {carName} for {payout}",
          invalidates: ["garage", "me"],
        }, {
          pluginId: "properties",
          name: "bought",
          describe: "{actorName} bought {propertyName} for {cost}",
          invalidates: ["properties", "me"],
        }, {
          pluginId: "properties",
          name: "sold",
          describe: "{actorName} sold {propertyName} for {payout}",
          invalidates: ["properties", "me"],
        }, {
          pluginId: "properties",
          name: "income",
          describe: "{actorName} claimed {amount} from {propertyName}",
          invalidates: ["properties", "me"],
        }],
      });
    } finally {
      await close();
    }
  });
});
