import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import housesPlugin from "@gl3/plugin-houses";
import educationPlugin from "@gl3/plugin-education";
import jobsPlugin from "@gl3/plugin-jobs";
import mccodesAttributesPlugin from "@gl3/plugin-mccodes-attributes";
import { parseSuccessFormula } from "@gl3/plugin-crimes";
import { crimes, settings } from "../src/db/schema/index.js";
import { bootSeedsFor, seedCrimes, seedFamilyContent, seedTempleExchanges } from "../src/db/seed.js";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

async function resetCrimes(): Promise<void> {
  await db.delete(crimes);
}

describe("gl3 seed pack (gl3-hybrid spec §3)", () => {
  it("gl3 crimes are blended: brave AND cooldown AND a parseable formula", async () => {
    await resetCrimes();
    await seedCrimes(db, "gl3");
    const rows = await db.select().from(crimes);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const c of rows) {
      expect(c.braveCost, c.name).toBeGreaterThan(0);
      expect(c.cooldownSeconds, c.name).toBeGreaterThan(0);
      expect(c.successFormula, c.name).not.toBeNull();
      expect(() => parseSuccessFormula(c.successFormula!), c.name).not.toThrow();
      expect(c.crimeExpReward).toBeGreaterThan(0n);
    }
  });

  it("v2 crimes seed stays the historical three, formula-less", async () => {
    await resetCrimes();
    await seedCrimes(db, "v2");
    const rows = await db.select().from(crimes);
    expect(rows.map((c) => c.name).sort()).toEqual(["Armoured Van", "Pickpocket", "Rob a Store"]);
    expect(rows.every((c) => c.braveCost === 0 && c.successFormula === null)).toBe(true);
  });

  it("seeds are idempotent — a second call adds nothing", async () => {
    await resetCrimes();
    await seedCrimes(db, "gl3");
    const first = (await db.select().from(crimes)).length;
    await seedCrimes(db, "gl3");
    expect((await db.select().from(crimes)).length).toBe(first);
  });

  it("family content seeds after plugin migrations, gated on plugin ids, idempotent", async () => {
    await runPluginMigrations(db, [mccodesAttributesPlugin, housesPlugin, educationPlugin, jobsPlugin]);
    await seedFamilyContent(db, ["houses", "education", "jobs"]);
    const houses = (await db.execute(sql`SELECT name FROM p_houses`)) as unknown as { name: string }[];
    expect(houses.length).toBeGreaterThanOrEqual(4); // plugin's Default House + three seeds
    const courses = (await db.execute(sql`SELECT name FROM p_courses`)) as unknown as { name: string }[];
    expect(courses.length).toBeGreaterThanOrEqual(3);
    const ranks = (await db.execute(sql`SELECT name, job_id FROM p_job_ranks`)) as unknown as { name: string }[];
    expect(ranks.length).toBeGreaterThanOrEqual(4);
    const jobs = (await db.execute(sql`SELECT id, first_rank_id FROM p_jobs`)) as unknown as { id: string; first_rank_id: string }[];
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    // Every job's entry rank exists and belongs to that job.
    for (const job of jobs) {
      const [rank] = (await db.execute(
        sql`SELECT job_id FROM p_job_ranks WHERE id = ${job.first_rank_id}`,
      )) as unknown as { job_id: string }[];
      expect(rank?.job_id).toBe(job.id);
    }

    await seedFamilyContent(db, ["houses", "education", "jobs"]); // idempotent
    const again = (await db.execute(sql`SELECT name FROM p_houses`)) as unknown as unknown[];
    expect(again.length).toBe(houses.length);

    // Gating: a boot without the plugins seeds nothing new.
    await seedFamilyContent(db, []);
    expect(((await db.execute(sql`SELECT name FROM p_courses`)) as unknown as unknown[]).length)
      .toBe(courses.length);
  });

  it("seedTempleExchanges writes refill once and never clobbers an admin edit", async () => {
    await db.delete(settings).where(eq(settings.key, "temple.exchanges"));
    await seedTempleExchanges(db);
    const [row] = await db.select().from(settings).where(eq(settings.key, "temple.exchanges"));
    expect(row?.value).toBe("refill");
    await db.update(settings).set({ value: "refill,iq" }).where(eq(settings.key, "temple.exchanges"));
    await seedTempleExchanges(db); // a reboot must not undo the operator
    const [edited] = await db.select().from(settings).where(eq(settings.key, "temple.exchanges"));
    expect(edited?.value).toBe("refill,iq");
  });

  it("bootSeedsFor gates the temple seed on profile AND plugin, family on its plugins", () => {
    expect(bootSeedsFor(["temple"], "gl3").templeExchanges).toBe(true);
    expect(bootSeedsFor(["temple"], "mccodes").templeExchanges).toBe(false); // faithful port
    expect(bootSeedsFor([], "gl3").templeExchanges).toBe(false);
    expect(bootSeedsFor(["houses"], "gl3").family).toBe(true);
    expect(bootSeedsFor(["crimes"], "gl3").family).toBe(false);
  });
});
