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
    const server = await bootTestServer();
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

  it("reports the seeded max when a pool is declared, without writing", async () => {
    const server = await bootTestServer({ plugins: [gymPlugin] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.9.2.2" });
      const res = await server.app.inject({
        method: "GET", url: "/api/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.attributes.energyMax).toBe(10);
      expect(body.attributes.strength).toBe("0");

      // Display-only: the stored row is still untouched — core took no
      // lock, opened no transaction, and wrote nothing. The authoritative
      // write only happens on the next plugin action via tx.attributes.
      const [stored] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(stored?.energyMax).toBe(0);
      expect(stored?.energyRegenAt).toBeNull();
    } finally {
      await server.close();
    }
  });
});
