// Every boot here pins { profile: "v2" }: this file tests the attribute
// family's OPT-IN property (baselines without a pool, or a custom test
// pool plugin that would collide with the gl3 union's mccodes-attributes).
// The suite's default boot is the gl3 union — see helpers/server.ts.
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { definePlugin, type PluginManifest } from "@gl3/plugin-sdk";
import { loadConfig } from "../src/config.js";
import { playerStats } from "../src/db/schema/index.js";
import { createRedis } from "../src/redis.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

afterAll(async () => { await conn.end(); redis.disconnect(); });

/**
 * Declares only the `energy` pool — no routes, no filters — just enough to
 * make `/api/auth/me`'s display-only settle have something to settle.
 * `basePaths` must be non-empty even for a subscriber-only manifest (the
 * schema enforces `.min(1)`).
 */
const gymPlugin: PluginManifest = definePlugin({
  id: "authmeattrgym",
  version: "1.0.0",
  basePaths: ["/api/authmeattrgym"],
  providesAttributes: [
    { pool: "energy", defaultMax: 10, regenAmount: 1, regenIntervalSeconds: 60 },
  ],
});

describe("GET /api/auth/me — attributes", () => {
  it("omits the attributes field entirely when no pool is declared", async () => {
    const server = await bootTestServer({ profile: "v2" });
    try {
      const { token } = await registerVerifiedPlayer(server, { remoteAddress: "10.9.2.1" });
      const res = await server.app.inject({
        method: "GET", url: "/api/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty("attributes");
    } finally {
      await server.close();
    }
  });

  it("seeds declared pools full at registration; the read stays display-only", async () => {
    const server = await bootTestServer({ profile: "v2", plugins: [gymPlugin] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.9.2.2" });
      const res = await server.app.inject({
        method: "GET", url: "/api/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Full at signup (spec §7 item 7): a fresh player on a game running the
      // pool family can act immediately, exactly like MCCodes' register.php.
      expect(body.attributes.energy).toBe(10);
      expect(body.attributes.energyMax).toBe(10);
      expect(body.attributes.strength).toBe("0");
      expect(body.attributes.iq).toBe("0");

      // The row was written by REGISTRATION (current = max = defaultMax,
      // stamp NULL), not by this read: the display-only settle still takes no
      // lock, opens no transaction and writes nothing — the stamp is NULL
      // because the clock has never started, not because a write was undone.
      const [stored] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(stored?.energy).toBe(10);
      expect(stored?.energyMax).toBe(10);
      expect(stored?.energyRegenAt).toBeNull();
    } finally {
      await server.close();
    }
  });
});
