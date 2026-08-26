import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import { playerStats, playerTimers } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

/**
 * The member multiplier end to end (C spec §1.3): the anchor declares energy
 * with memberMultiplier 2, one player carries a live membership timer, both
 * sit two 5-minute intervals in the past at energy 4 of max 12. Base regen
 * is 8% of 12 = 0.96/interval: the non-member regains round(2 × 0.96) = 2,
 * the member round(2 × 0.96 × 2) = 4 — asserted through /api/auth/me's
 * DISPLAY settle, which shares memberRegenMultiplier with the authoritative
 * settleAll, so what the member sees is what they get.
 */
describe("member-scaled regen (E2E)", () => {
  it("regenerates the member's energy at exactly the declared multiplier", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const plain = await registerVerifiedPlayer(server, { remoteAddress: "10.18.1.1" });
      const member = await registerVerifiedPlayer(server, { remoteAddress: "10.18.1.2" });
      const past = new Date(Date.now() - 600_000); // two 300s intervals

      for (const p of [plain, member]) {
        await db.update(playerStats)
          .set({ energy: 4, energyRegenAt: past })
          .where(eq(playerStats.playerId, p.playerId));
      }
      await db.insert(playerTimers).values({
        playerId: member.playerId, key: "membership",
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const me = async (token: string): Promise<number> => {
        const res = await server.app.inject({
          method: "GET", url: "/api/auth/me",
          headers: { authorization: `Bearer ${token}` },
        });
        return res.json().attributes.energy as number;
      };

      expect(await me(plain.token)).toBe(6);   // 4 + round(2 × 0.96)
      expect(await me(member.token)).toBe(8);  // 4 + round(2 × 0.96 × 2)
    } finally {
      await server.close();
    }
  });
});
