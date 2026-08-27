import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { definePlugin, PluginError, route, type PluginManifest } from "@gl3/plugin-sdk";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import progressionPlugin from "@gl3/plugin-progression";
import { playerStats } from "../src/db/schema/index.js";
import { loadConfig } from "../src/config.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redisUrl = loadConfig(process.env).redisUrl;
const redis = createRedis(redisUrl);
const subscriber = createSubscriber(redisUrl);

afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

/** A driver route so the test can push exp through the routing seam. */
const expDriver: PluginManifest = definePlugin({
  id: "exptest",
  version: "1.0.0",
  basePaths: ["/api/exptest"],
  routes: [route({
    method: "POST",
    path: "/api/exptest/grant",
    body: z.object({ exp: z.string().regex(/^\d+$/) }).strict(),
    handler: async (ctx, { body }) => {
      const player = ctx.player;
      if (player === null) throw new PluginError("unauthorized", 401);
      const promotion = await ctx.transaction(async (tx) => {
        await tx.locks.player([player.id]);
        return tx.economy.applyExpAndRankUp(player.id, BigInt(body.exp));
      });
      return { status: 200, body: { promoted: promotion !== null } };
    },
  })],
});

describe("progression (exp routing claimed)", () => {
  it("applies exp to the level ladder: levels, grants, no rank rewards, no rankedUp", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, progressionPlugin, expDriver] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.13.1.1" });
      const auth = { authorization: `Bearer ${token}` };

      await subscriber.subscribe(GAME_EVENTS_CHANNEL);
      const waiting = awaitOwnEvent(subscriber, playerId);

      // 200 exp crosses exactly two levels: needed(1)=17, needed(2)=59,
      // remainder 124 below needed(3)=140.
      const res = await server.app.inject({
        method: "POST", url: "/api/exptest/grant", headers: auth,
        payload: { exp: "200" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().promoted).toBe(false); // no RankUpResult on a routed boot

      const event = await waiting;
      expect(event.type).toBe("player.levelUp");
      if (event.type === "player.levelUp") expect(event.level).toBe(2);

      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.level).toBe(3);
      expect(row?.exp).toBe(124n);
      // Grants: +2 energy and +2 brave per level, current AND max.
      expect(row?.energy).toBe(16);
      expect(row?.energyMax).toBe(16);
      expect(row?.brave).toBe(9);
      expect(row?.braveMax).toBe(9);
      // +50 hp and max hp per level; first level-up adopts the cap from 100.
      expect(row?.health).toBe(200);
      expect(row?.healthMax).toBe(200);
      // The economy guard: ranks got nothing — no rank row, no rewards.
      expect(row?.rankId).toBeNull();
      expect(row?.cash).toBe(0n);
      expect(row?.bullets).toBe(0n);
    } finally {
      await server.close();
    }
  });

  it("leaves a below-threshold grant untouched on the ladder", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, progressionPlugin, expDriver] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.13.1.2" });
      const res = await server.app.inject({
        method: "POST", url: "/api/exptest/grant",
        headers: { authorization: `Bearer ${token}` },
        payload: { exp: "10" }, // below needed(1)=17
      });
      expect(res.statusCode).toBe(200);

      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.level).toBe(1);
      expect(row?.exp).toBe(10n);
      expect(row?.energy).toBe(12);
      expect(row?.healthMax).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe("progression's core.profileView / core.dashboard subscribers", () => {
  it("carries the CALLING player's Level + exp on GET /api/dashboard/widgets", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, progressionPlugin] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.13.2.1" });
      await db.update(playerStats).set({ level: 4, exp: 30n }).where(eq(playerStats.playerId, playerId));

      const res = await server.app.inject({
        method: "GET", url: "/api/dashboard/widgets",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const widgets = (res.json() as { widgets: { pluginId: string; title: string; view: unknown }[] }).widgets;
      const widget = widgets.find((w) => w.pluginId === "progression");
      expect(widget?.title).toBe("Progression");
      expect(JSON.stringify(widget?.view)).toContain("Level 4");
      expect(JSON.stringify(widget?.view)).toContain("30 exp");
    } finally {
      await server.close();
    }
  });

  it("carries the TARGET player's Level as a profile extra, not the viewer's", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, progressionPlugin] });
    try {
      const target = await registerVerifiedPlayer(server, { remoteAddress: "10.13.2.2" });
      await db.update(playerStats).set({ level: 7 }).where(eq(playerStats.playerId, target.playerId));

      // Public route — no auth header, exactly like ProfileDto's own tests.
      const res = await server.app.inject({
        method: "GET", url: `/api/players/${target.playerId}/profile`,
      });
      expect(res.statusCode).toBe(200);
      const extras = (res.json() as { extras: { kind: string; pluginId: string; label: string; value: string }[] }).extras;
      expect(extras).toContainEqual({ kind: "stat", pluginId: "progression", label: "Level", value: "7" });
    } finally {
      await server.close();
    }
  });
});
