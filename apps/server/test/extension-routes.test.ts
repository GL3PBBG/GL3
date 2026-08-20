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
      expect(widgets.widgets).toEqual([
        { pluginId: "extras-contributor", title: "pid", view: { kind: "text", value: playerId } },
      ]);
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
