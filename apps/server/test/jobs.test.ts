import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import jobsPlugin from "@gl3/plugin-jobs";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import progressionPlugin from "@gl3/plugin-progression";
import { notifications, playerStats } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

async function seedJob(): Promise<{ jobId: string; loaderId: string; foremanId: string }> {
  const jobId = crypto.randomUUID();
  const loaderId = crypto.randomUUID();
  const foremanId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO p_jobs_ranks (id, job_id, name, pay,
      strength_gain, labour_gain, iq_gain, strength_req, labour_req, iq_req)
    VALUES
      (${loaderId}, ${jobId}, ${"Loader"}, ${100}, ${2}, ${0}, ${1}, ${0}, ${0}, ${0}),
      (${foremanId}, ${jobId}, ${"Foreman"}, ${200}, ${3}, ${0}, ${2}, ${10}, ${0}, ${0})
  `);
  await db.execute(sql`
    INSERT INTO p_jobs_jobs (id, name, description, first_rank_id)
    VALUES (${jobId}, ${"Dock Worker"}, ${"Heavy boxes, honest pay."}, ${loaderId})
  `);
  return { jobId, loaderId, foremanId };
}

describe("jobs plugin (exp routing claimed — wages feed levels, never ranks)", () => {
  it("interviews, settles whole backdated days lazily, and leaves the remainder", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, progressionPlugin, jobsPlugin] });
    try {
      const { jobId } = await seedJob();
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.15.1.1" });
      const auth = { authorization: `Bearer ${token}` };

      const hired = await server.app.inject({
        method: "POST", url: "/api/jobs/interview", headers: auth, payload: { jobId },
      });
      expect(hired.statusCode).toBe(200);
      expect(hired.json().rankName).toBe("Loader");

      // 3.5 days elapsed: exactly 3 whole days pay out, half a day survives.
      await db.execute(sql`
        UPDATE p_jobs_players SET last_wage_at = now() - interval '3 days 12 hours'
        WHERE player_id = ${playerId}
      `);

      const mine = await server.app.inject({ method: "GET", url: "/api/jobs/mine", headers: auth });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().daysSettled).toBe(3);
      expect(mine.json().job.rankName).toBe("Loader");

      const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.cash).toBe(300n);                       // 100 × 3
      expect(row?.exp).toBe(15n);                         // (100 × 3) / 20 — through the seam
      expect(row?.level).toBe(1);                         // 15 < needed(1)=17
      expect(row?.rankId).toBeNull();                     // the economy guard: no rank
      expect(row?.strength).toBe(6n);                     // 2 × 3
      expect(row?.iq).toBe(3n);                           // 1 × 3
      // The stamp advanced exactly 3 days: the remaining half day survives.
      const wageAgeMs = Date.now() - new Date(mine.json().job.lastWageAt).getTime();
      expect(wageAgeMs).toBeGreaterThan(11 * 3_600_000);
      expect(wageAgeMs).toBeLessThan(13 * 3_600_000);

      // The payout is visible, not silent: a lazy settle the player never
      // asked for must leave a record they can see — the notification.
      const notes = await db.select().from(notifications)
        .where(eq(notifications.playerId, playerId));
      const payday = notes.filter((n) => n.body.includes("Payday"));
      expect(payday, JSON.stringify(notes.map((n) => n.body))).toHaveLength(1);
      expect(payday[0]?.body).toContain("3");
      expect(payday[0]?.body).toContain("$300");
      expect(payday[0]?.body).toContain("Loader");

      // An immediate re-read settles nothing.
      const again = await server.app.inject({ method: "GET", url: "/api/jobs/mine", headers: auth });
      expect(again.json().daysSettled).toBe(0);
      const [unchanged] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(unchanged?.cash).toBe(300n);
      // And notifies nothing — zero-day reads must not spam paydays.
      const notesAfter = await db.select().from(notifications)
        .where(eq(notifications.playerId, playerId));
      expect(notesAfter.filter((n) => n.body.includes("Payday"))).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("promotes by stat requirements and refuses a second interview while employed", async () => {
    const server = await bootTestServer({ plugins: [mccodesAttributes, progressionPlugin, jobsPlugin] });
    try {
      const { jobId, foremanId } = await seedJob();
      const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.15.1.2" });
      const auth = { authorization: `Bearer ${token}` };

      await server.app.inject({ method: "POST", url: "/api/jobs/interview", headers: auth, payload: { jobId } });

      const premature = await server.app.inject({ method: "POST", url: "/api/jobs/promote", headers: auth });
      expect(premature.statusCode).toBe(409);
      expect(premature.json().error).toBe("no_promotion");

      await db.update(playerStats).set({ strength: 10n }).where(eq(playerStats.playerId, playerId));
      const promoted = await server.app.inject({ method: "POST", url: "/api/jobs/promote", headers: auth });
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json().rankId).toBe(foremanId);
      expect(promoted.json().pay).toBe("200");

      const rehire = await server.app.inject({ method: "POST", url: "/api/jobs/interview", headers: auth, payload: { jobId } });
      expect(rehire.statusCode).toBe(409);
      expect(rehire.json().error).toBe("already_employed");

      const quit = await server.app.inject({ method: "POST", url: "/api/jobs/quit", headers: auth });
      expect(quit.statusCode).toBe(200);
      const mine = await server.app.inject({ method: "GET", url: "/api/jobs/mine", headers: auth });
      expect(mine.json().job).toBeNull();
      const requit = await server.app.inject({ method: "POST", url: "/api/jobs/quit", headers: auth });
      expect(requit.statusCode).toBe(409);
    } finally {
      await server.close();
    }
  });
});
