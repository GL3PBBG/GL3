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
      // `bounties` is a core plugin (always loaded by bootTestServer) and
      // itself subscribes to core.profileView, contributing an always-on
      // "Place bounty" link ahead of the test plugins here.
      expect(parsed.extras).toEqual([
        { kind: "link", pluginId: "bounties", label: "Place bounty", to: `/bounties?target=${playerId}` },
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
