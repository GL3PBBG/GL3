import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import { playerStats } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

/**
 * The anchor plugin's whole job is the three declarations — this is the
 * spec §6 C1 checklist: a fresh player on a boot that selects the anchor is
 * full (MCCodes' register.php: 12/12 energy, 5/5 brave, 100/100 will), and a
 * default boot stays all-zero because the family never joins the bundled
 * arrays (the opt-in property, re-proven).
 */
describe("mccodes-attributes anchor", () => {
  it("seeds the declared pools full at registration (12/5/100)", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.10.1.1" });
      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.energy).toBe(12);
      expect(row?.energyMax).toBe(12);
      expect(row?.brave).toBe(5);
      expect(row?.braveMax).toBe(5);
      expect(row?.will).toBe(100);
      expect(row?.willMax).toBe(100);
      expect(row?.energyRegenAt).toBeNull();
      expect(row?.braveRegenAt).toBeNull();

      const res = await server.app.inject({
        method: "GET", url: "/api/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().attributes).toMatchObject({ energy: 12, brave: 5, will: 100, level: 1 });
    } finally {
      await server.close();
    }
  });

  it("changes nothing on a default boot — the opt-in property", async () => {
    const server = await bootTestServer();
    try {
      const { playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.10.1.2" });
      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.energy).toBe(0);
      expect(row?.energyMax).toBe(0);
      expect(row?.brave).toBe(0);
      expect(row?.will).toBe(0);
    } finally {
      await server.close();
    }
  });
});
