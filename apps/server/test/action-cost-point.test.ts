import { describe, expect, it } from "vitest";
import { definePlugin, on, route, coreActionCost, PluginError, type PluginManifest } from "@gl3/plugin-sdk";
import { bootTestServer } from "./helpers/server.js";
import { registerVerifiedPlayer } from "./helpers/register.js";

/** Applies the chain and reports what it resolved to. */
const applierPlugin: PluginManifest = definePlugin({
  id: "costapply",
  version: "1.0.0",
  basePaths: ["/api/costapply"],
  routes: [
    route({
      method: "GET",
      path: "/api/costapply/resolve",
      handler: async (ctx) => {
        if (ctx.player === null) throw new PluginError("unauthorized", 401);
        const resolved = await ctx.filters.apply(coreActionCost, {
          action: "costapply.resolve",
          costs: {},
        });
        return { status: 200, body: { costs: resolved.costs } };
      },
    }),
  ],
});

const contributorPlugin: PluginManifest = definePlugin({
  id: "costadd",
  version: "1.0.0",
  basePaths: ["/api/costadd"],
  filters: [on(coreActionCost, (_ctx, value) => ({
    ...value,
    costs: { ...value.costs, energy: 3 },
  }))],
});

const throwingPlugin: PluginManifest = definePlugin({
  id: "costboom",
  version: "1.0.0",
  basePaths: ["/api/costboom"],
  filters: [on(coreActionCost, () => { throw new Error("subscriber exploded"); })],
});

describe("core.actionCost", () => {
  it("resolves to an empty cost map when nothing subscribes", async () => {
    const server = await bootTestServer({ plugins: [applierPlugin] });
    const { token } = await registerVerifiedPlayer(server);
    const res = await server.app.inject({
      method: "GET", url: "/api/costapply/resolve",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().costs).toEqual({});
    await server.close();
  });

  it("collects a subscriber's contribution", async () => {
    const server = await bootTestServer({ plugins: [applierPlugin, contributorPlugin] });
    const { token } = await registerVerifiedPlayer(server);
    const res = await server.app.inject({
      method: "GET", url: "/api/costapply/resolve",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().costs).toEqual({ energy: 3 });
    await server.close();
  });

  it("ABORTS when a subscriber throws, rather than dropping it", async () => {
    // The propagate-vs-collect break. Under "collect" this would answer 200
    // with an empty cost map and the action would silently run FREE, which is
    // why this point does not share the five UI points' policy.
    const server = await bootTestServer({ plugins: [applierPlugin, throwingPlugin] });
    const { token } = await registerVerifiedPlayer(server);
    const res = await server.app.inject({
      method: "GET", url: "/api/costapply/resolve",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(500);
    await server.close();
  });
});
