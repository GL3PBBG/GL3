import { coreDashboard, coreHud, coreMenuBadges, definePlugin, on } from "@gl3/plugin-sdk";
import { DashboardWidgetsResponseSchema, HudExtrasResponseSchema, MenuBadgesResponseSchema } from "@gl3/shared";
import { describe, expect, it } from "vitest";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const contributorPlugin = definePlugin({
  id: "extras-contributor",
  version: "1.0.0",
  basePaths: ["/api/extras-contributor"],
  filters: [
    on(coreHud, async (ctx, value) => [
      ...value,
      { pluginId: ctx.pluginId, label: "pid", value: ctx.player!.id },
    ]),
    on(coreMenuBadges, async (ctx, value) => [
      ...value,
      { path: `/extras-contributor/${ctx.player!.id}`, count: 1 },
    ]),
    on(coreDashboard, async (ctx, value) => [
      ...value,
      { pluginId: ctx.pluginId, title: "pid", view: { kind: "text", value: ctx.player!.id } },
    ]),
  ],
});

describe("hud extras, menu badges and dashboard widget routes", () => {
  it("applies the caller's own snapshot through each core extension point", async () => {
    const { app, close, redis } = await bootTestServer({ plugins: [contributorPlugin] });
    try {
      const { token, playerId } = await registerVerifiedPlayer({ app, redis }, {
        username: "ExtrasPlayer",
        remoteAddress: "10.32.0.1",
      });

      const hudRes = await app.inject({
        method: "GET", url: "/api/hud/extras", headers: { authorization: `Bearer ${token}` },
      });
      expect(hudRes.statusCode).toBe(200);
      const hud = HudExtrasResponseSchema.parse(hudRes.json());
      expect(hud.entries).toEqual([{ pluginId: "extras-contributor", label: "pid", value: playerId }]);

      const badgesRes = await app.inject({
        method: "GET", url: "/api/menu/badges", headers: { authorization: `Bearer ${token}` },
      });
      expect(badgesRes.statusCode).toBe(200);
      const badges = MenuBadgesResponseSchema.parse(badgesRes.json());
      expect(badges.badges).toEqual([{ path: `/extras-contributor/${playerId}`, count: 1 }]);

      const widgetsRes = await app.inject({
        method: "GET", url: "/api/dashboard/widgets", headers: { authorization: `Bearer ${token}` },
      });
      expect(widgetsRes.statusCode).toBe(200);
      const widgets = DashboardWidgetsResponseSchema.parse(widgetsRes.json());
      // toContainEqual, not toEqual: bootTestServer always loads the CORE_PLUGINS
      // alongside `contributorPlugin`, and crimes (a core plugin) now contributes
      // its own dashboard widget unconditionally for any authenticated player —
      // see the crimes dashboard-widget retrofit.
      expect(widgets.widgets).toContainEqual(
        { pluginId: "extras-contributor", title: "pid", view: { kind: "text", value: playerId } },
      );
    } finally {
      await close();
    }
  });

  it("401s an unauthenticated GET on all three routes", async () => {
    const { app, close } = await bootTestServer({ plugins: [] });
    try {
      for (const url of ["/api/hud/extras", "/api/menu/badges", "/api/dashboard/widgets"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(401);
      }
    } finally {
      await close();
    }
  });
});

// A malformed contribution (an extra property `HudEntrySchema` rejects, and a
// non-ISO `countdownTo`) must lose only its own entry — never fail the whole
// route (and never the whole `PluginsPayloadSchema` parse client-side) for
// every caller of `/api/hud/extras`. This is the server-side counterpart of
// `runFilterChain`'s "collect" policy: that isolates a subscriber's *throw*,
// this isolates a subscriber's *malformed return value*.
const malformedHudPlugin = definePlugin({
  id: "malformed-hud",
  version: "1.0.0",
  basePaths: ["/api/malformed-hud"],
  filters: [
    on(coreHud, async (ctx, value) => [
      ...value,
      // Valid entry — proves a well-formed sibling contribution survives.
      { pluginId: ctx.pluginId, label: "ok", value: "fine" },
      // Malformed: `extra` is not a field `HudEntrySchema` (`.strict()`) allows.
      { pluginId: ctx.pluginId, label: "bad-extra", value: "x", extra: "nope" } as never,
      // Malformed: `countdownTo` fails `TimestampSchema`'s ISO-8601 parse.
      { pluginId: ctx.pluginId, label: "bad-countdown", value: "x", countdownTo: "not-a-date" },
    ]),
  ],
});

describe("hud extras drops a malformed contribution rather than failing the whole route", () => {
  it("returns 200 with the malformed entries absent and the valid ones present", async () => {
    const { app, close, redis } = await bootTestServer({ plugins: [malformedHudPlugin] });
    try {
      const { token } = await registerVerifiedPlayer({ app, redis }, {
        username: "MalformedHudPlayer",
        remoteAddress: "10.32.0.2",
      });

      const res = await app.inject({
        method: "GET", url: "/api/hud/extras", headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const hud = HudExtrasResponseSchema.parse(res.json());
      expect(hud.entries).toContainEqual({ pluginId: "malformed-hud", label: "ok", value: "fine" });
      expect(hud.entries.some((e) => e.label === "bad-extra")).toBe(false);
      expect(hud.entries.some((e) => e.label === "bad-countdown")).toBe(false);
    } finally {
      await close();
    }
  });
});
