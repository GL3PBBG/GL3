import { describe, expect, it, beforeAll } from "vitest";
import { z } from "zod";
import { definePlugin, route, PluginError, type PluginManifest } from "@gl3/plugin-sdk";
import { bootTestServer } from "./helpers/server.js";
import { registerVerifiedPlayer } from "./helpers/register.js";

/**
 * A driver plugin: one route per operation, so the test can exercise
 * `tx.attributes` without a real gameplay plugin existing yet.
 */
const driverPlugin: PluginManifest = definePlugin({
  id: "attrtest",
  version: "1.0.0",
  basePaths: ["/api/attrtest"],
  providesAttributes: [
    { pool: "energy", defaultMax: 10, regenAmount: 1, regenIntervalSeconds: 60 },
  ],
  routes: [
    route({
      method: "GET",
      path: "/api/attrtest/read",
      handler: async (ctx) => {
        const player = ctx.player;
        if (player === null) throw new PluginError("unauthorized", 401);
        const attrs = await ctx.transaction(async (tx) => {
          await tx.locks.player([player.id]);
          return tx.attributes.read(player.id);
        });
        return {
          status: 200,
          body: {
            energy: attrs.energy, energyMax: attrs.energyMax,
            strength: attrs.strength.toString(), level: attrs.level,
          },
        };
      },
    }),
    route({
      method: "POST",
      path: "/api/attrtest/spend",
      body: z.object({ amount: z.number().int() }),
      handler: async (ctx, { body }) => {
        const player = ctx.player;
        if (player === null) throw new PluginError("unauthorized", 401);
        await ctx.transaction(async (tx) => {
          await tx.locks.player([player.id]);
          await tx.attributes.spend(player.id, "energy", body.amount);
        });
        return { status: 200, body: { ok: true } };
      },
    }),
    route({
      method: "POST",
      path: "/api/attrtest/grant",
      body: z.object({ amount: z.number().int() }),
      handler: async (ctx, { body }) => {
        const player = ctx.player;
        if (player === null) throw new PluginError("unauthorized", 401);
        await ctx.transaction(async (tx) => {
          await tx.locks.player([player.id]);
          await tx.attributes.grant(player.id, "energy", body.amount);
        });
        return { status: 200, body: { ok: true } };
      },
    }),
    route({
      method: "POST",
      path: "/api/attrtest/train",
      body: z.object({ delta: z.string() }),
      handler: async (ctx, { body }) => {
        const player = ctx.player;
        if (player === null) throw new PluginError("unauthorized", 401);
        const next = await ctx.transaction(async (tx) => {
          await tx.locks.player([player.id]);
          return tx.attributes.train(player.id, "strength", BigInt(body.delta));
        });
        return { status: 200, body: { strength: next.toString() } };
      },
    }),
  ],
});

describe("tx.attributes", () => {
  let app: Awaited<ReturnType<typeof bootTestServer>>;
  beforeAll(async () => { app = await bootTestServer({ plugins: [driverPlugin] }); });

  it("seeds the max from the declaration on first read", async () => {
    const { token } = await registerVerifiedPlayer(app);
    const res = await app.app.inject({
      method: "GET", url: "/api/attrtest/read",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().energyMax).toBe(10);
  });

  it("grants and clamps at the max", async () => {
    const { token } = await registerVerifiedPlayer(app);
    const auth = { authorization: `Bearer ${token}` };
    await app.app.inject({ method: "POST", url: "/api/attrtest/grant", headers: auth, payload: { amount: 99 } });
    const res = await app.app.inject({ method: "GET", url: "/api/attrtest/read", headers: auth });
    expect(res.json().energy).toBe(10);
  });

  it("spends", async () => {
    const { token } = await registerVerifiedPlayer(app);
    const auth = { authorization: `Bearer ${token}` };
    await app.app.inject({ method: "POST", url: "/api/attrtest/grant", headers: auth, payload: { amount: 10 } });
    const spend = await app.app.inject({ method: "POST", url: "/api/attrtest/spend", headers: auth, payload: { amount: 4 } });
    expect(spend.statusCode).toBe(200);
    const res = await app.app.inject({ method: "GET", url: "/api/attrtest/read", headers: auth });
    expect(res.json().energy).toBe(6);
  });

  it("refuses a spend it cannot cover, and moves nothing", async () => {
    const { token } = await registerVerifiedPlayer(app);
    const auth = { authorization: `Bearer ${token}` };
    await app.app.inject({ method: "POST", url: "/api/attrtest/grant", headers: auth, payload: { amount: 3 } });
    const spend = await app.app.inject({ method: "POST", url: "/api/attrtest/spend", headers: auth, payload: { amount: 4 } });
    expect(spend.statusCode).toBe(409);
    expect(spend.json().error).toBe("insufficient_energy");
    const res = await app.app.inject({ method: "GET", url: "/api/attrtest/read", headers: auth });
    expect(res.json().energy).toBe(3);
  });

  it("trains a bigint attribute past 2^31", async () => {
    const { token } = await registerVerifiedPlayer(app);
    const auth = { authorization: `Bearer ${token}` };
    const res = await app.app.inject({
      method: "POST", url: "/api/attrtest/train", headers: auth,
      payload: { delta: "5000000000" },
    });
    expect(res.json().strength).toBe("5000000000");
  });
});
