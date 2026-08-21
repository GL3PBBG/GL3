import { HudExtrasResponseSchema, ProfileDtoSchema } from "@gl3/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db } = testDb();

async function seedMembership(playerId: string, msFromNow: number): Promise<Date> {
  const until = new Date(Date.now() + msFromNow);
  await db.execute(sql`
    INSERT INTO player_timers (player_id, key, expires_at)
    VALUES (${playerId}, 'membership', ${until.toISOString()})`);
  return until;
}

describe("membership retrofit: HUD countdown + profile Member stat", () => {
  it("a member gets a HUD countdown entry and a profile Member stat", async () => {
    const { app, close, redis } = await bootTestServer();
    try {
      const { token, playerId } = await registerVerifiedPlayer({ app, redis }, {
        username: "MembershipHudPlayer",
        remoteAddress: "10.33.0.1",
      });
      const until = await seedMembership(playerId, 3600 * 1000);

      const hudRes = await app.inject({
        method: "GET", url: "/api/hud/extras", headers: { authorization: `Bearer ${token}` },
      });
      expect(hudRes.statusCode).toBe(200);
      const hud = HudExtrasResponseSchema.parse(hudRes.json());
      const entry = hud.entries.find((e) => e.pluginId === "membership");
      expect(entry).toEqual({
        pluginId: "membership", label: "Membership", value: "Member", countdownTo: until.toISOString(),
      });

      const profileRes = await app.inject({
        method: "GET", url: `/api/players/${playerId}/profile`,
      });
      expect(profileRes.statusCode).toBe(200);
      const profile = ProfileDtoSchema.parse(profileRes.json());
      expect(profile.extras).toContainEqual({
        kind: "stat", pluginId: "membership", label: "Membership", value: "Member",
      });
    } finally {
      await close();
    }
  });

  it("a non-member gets neither the HUD entry nor the profile stat", async () => {
    const { app, close, redis } = await bootTestServer();
    try {
      const { token, playerId } = await registerVerifiedPlayer({ app, redis }, {
        username: "MembershipHudNonMember",
        remoteAddress: "10.33.0.2",
      });

      const hudRes = await app.inject({
        method: "GET", url: "/api/hud/extras", headers: { authorization: `Bearer ${token}` },
      });
      expect(hudRes.statusCode).toBe(200);
      const hud = HudExtrasResponseSchema.parse(hudRes.json());
      expect(hud.entries.some((e) => e.pluginId === "membership")).toBe(false);

      const profileRes = await app.inject({
        method: "GET", url: `/api/players/${playerId}/profile`,
      });
      expect(profileRes.statusCode).toBe(200);
      const profile = ProfileDtoSchema.parse(profileRes.json());
      expect(profile.extras?.some((e) => e.pluginId === "membership")).toBe(false);
    } finally {
      await close();
    }
  });
});
