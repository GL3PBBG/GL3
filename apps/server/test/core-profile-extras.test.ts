import { coreMoneyFormat, coreProfileView, definePlugin, on } from "@gl3/plugin-sdk";
import { ProfileDtoSchema } from "@gl3/shared";
import { describe, expect, it } from "vitest";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const contributorPlugin = definePlugin({
  id: "profile-contributor",
  version: "1.0.0",
  basePaths: ["/api/profile-contributor"],
  filters: [
    on(coreProfileView, async (ctx, value) => ({
      ...value,
      extras: [
        ...value.extras,
        { kind: "stat", pluginId: ctx.pluginId, label: "Contributed", value: "1" },
        { kind: "link", pluginId: ctx.pluginId, label: "See more", to: "/profile-contributor" },
      ],
    })),
    on(coreMoneyFormat, async () => ({ symbol: "£", position: "prefix", thousandsSep: "." })),
  ],
});

const throwingPlugin = definePlugin({
  id: "profile-thrower",
  version: "1.0.0",
  basePaths: ["/api/profile-thrower"],
  filters: [
    on(coreProfileView, async () => {
      throw new Error("boom");
    }),
  ],
});

describe("core.profileView and core.moneyFormat applied at their real seams", () => {
  it("collects extras onto a public profile and rides the money format onto /api/plugins", async () => {
    const { app, close, redis } = await bootTestServer({ plugins: [contributorPlugin, throwingPlugin] });
    try {
      const { token, playerId } = await registerVerifiedPlayer({ app, redis }, {
        username: "ProfileExtrasPlayer",
        remoteAddress: "10.31.0.1",
      });

      const profileRes = await app.inject({ method: "GET", url: `/api/players/${playerId}/profile` });
      expect(profileRes.statusCode).toBe(200);
      const body = profileRes.json();
      const parsed = ProfileDtoSchema.parse(body);
      // `bounties`, `detectives` and `progression` are all part of
      // `bootTestServer`'s default gl3 union and each subscribes to
      // core.profileView, contributing an always-on entry ahead of the test
      // plugins here, in plugin load order (core-plugins.ts:
      // `[...FRAMEWORK_PLUGINS, ...GAMEPLAY_PLUGINS, ...MCCODES_PLUGINS]` —
      // bounties/detectives from GAMEPLAY_PLUGINS, progression last in
      // MCCODES_PLUGINS, ahead of the optional test-local plugins). The
      // family frontend wave's Task 7 added progression's "Level" stat
      // subscriber; this test wasn't touched in that wave (task-scoped runs
      // don't reach a cross-cutting drift guard like this one), so it went
      // red on the first bare `npm run verify` after — the rounds cluster's
      // "twelve green scoped runs, then the full suite catches it" shape,
      // caught and fixed at Task 8.
      expect(parsed.extras).toEqual([
        { kind: "link", pluginId: "bounties", label: "Place bounty", to: `/plugins/bounties.index?target=${playerId}` },
        { kind: "link", pluginId: "detectives", label: "Hire detective", to: `/plugins/detectives.index?target=${playerId}` },
        { kind: "stat", pluginId: "progression", label: "Level", value: "1" },
        { kind: "stat", pluginId: "profile-contributor", label: "Contributed", value: "1" },
        { kind: "link", pluginId: "profile-contributor", label: "See more", to: "/profile-contributor" },
      ]);
      // The throwing plugin's subscriber ran and was dropped under "collect"
      // policy — its contribution is absent, but the route still answered 200.
      expect(parsed.extras?.some((e) => e.pluginId === "profile-thrower")).toBe(false);

      const pluginsRes = await app.inject({
        method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` },
      });
      expect(pluginsRes.statusCode).toBe(200);
      expect(pluginsRes.json().moneyFormat).toEqual({ symbol: "£", position: "prefix", thousandsSep: "." });
    } finally {
      await close();
    }
  });
});
