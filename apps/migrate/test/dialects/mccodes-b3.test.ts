import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../../../server/src/db/client.js";
import { crimes, gangs as gangsTable, gangMembers, gangLogs, items } from "../../../server/src/db/schema/index.js";
import { createReport } from "../../src/report.js";
import { runMigration } from "../../src/orchestrator.js";
import {
  coursesDone, coursesPlugin, educationProgress, housesPlugin, jobRanks, jobsPlugin, playerJobs, shopStock,
} from "../../src/pg/plugin-tables.js";
import { createIsolatedMccodesFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";

/**
 * B3 (plan Tasks 10-13): items/shops, crimes + the PERCFORM translation, the
 * houses/education/jobs catalogs with reconstructed progress, and gangs.
 */

async function runOnce() {
  const fixture = await createIsolatedMccodesFixture();
  const target = await createIsolatedPgTarget({ plugins: "mccodes" });
  const { db, sql } = createDb(target.url);
  const report = createReport(false);
  const mysql = (await import("mysql2/promise")).default;
  const pool = mysql.createPool(fixture.url);
  try {
    await runMigration({ mysql: pool, db, report, dryRun: false, dialect: "mccodes" });
  } finally {
    await pool.end();
  }
  return {
    db, sql, report,
    teardown: async () => { await sql.end(); await target.teardown(); await fixture.teardown(); },
  };
}

describe("mccodes dialect — B3 (content, progression, gangs)", () => {
  it("imports items with their models, meta and the shop stock", async () => {
    const run = await runOnce();
    try {
      const rows = await run.db.select().from(items);
      expect(rows).toHaveLength(4);

      const knife = rows.find((r) => r.name === "Rusty Knife")!;
      expect(knife.itemType).toBe("weapon");
      expect(knife.effects).toEqual({ power: 10 }); // the melee marker
      expect(knife.meta).toMatchObject({ buyPrice: 500, sellPrice: 250 });

      const vest = rows.find((r) => r.name === "Leather Vest")!;
      expect(vest.itemType).toBe("armor");
      expect(vest.effects).toEqual({ armor: 25 });

      // The PHP-serialized generic effect unserializes verbatim.
      const vial = rows.find((r) => r.name === "Vial of Will")!;
      expect(vial.effects).toEqual({
        inc_type: "percent", stat: "will", dir: "pos", inc_amount: 25,
      });

      // Shop listings: price from itmbuyprice, the infinite-stock sentinel.
      const stock = await run.db.select().from(shopStock);
      expect(stock).toHaveLength(2);
      const knifeListing = stock.find((s) => s.itemId === knife.id)!;
      expect(knifeListing.price).toBe(500n);
      expect(knifeListing.stock).toBe(2_000_000_000);
    } finally {
      await run.teardown();
    }
  });

  it("imports crimes: verbatim formulas, rejects with originals, the column mapping", async () => {
    const run = await runOnce();
    try {
      const rows = await run.db.select().from(crimes);
      expect(rows).toHaveLength(3);

      const pick = rows.find((r) => r.name === "Pickpocket")!;
      expect(pick).toMatchObject({
        minPayout: 300n, maxPayout: 300n,
        expReward: 37n, // trunc(300/8)
        crimeExpReward: 7n,
        jailChancePercent: 50,
        jailSeconds: 180, // 3 minutes
        braveCost: 2,
        cooldownSeconds: 0, // brave is the throttle in a pure-MCCodes profile
        minLevel: 0,
      });
      expect(pick.successFormula).toBe("min(95, 10 + CRIMEXP / 100)");

      const heist = rows.find((r) => r.name === "Museum Heist")!;
      expect(heist.successFormula).toBe("min(90, max(5, LEVEL * 8))");
      expect(heist.crimeExpReward).toBe(40n);

      // The rejectable PHP-ism imports NULL, stays playable, and the report
      // carries the original verbatim for manual rewrite.
      const cursed = rows.find((r) => r.name === "Cursed Job")!;
      expect(cursed.successFormula).toBeNull();
      expect(run.report.percformRejects).toEqual([
        { crimeV2Id: 3, original: "rand(1,100) + LEVEL" },
      ]);
      expect(run.report.droppedColumns.find((d) => d.table === "crimes")!.columns)
        .toContain("crimeSUCCESSCRYS");
    } finally {
      await run.teardown();
    }
  });

  it("imports the houses/courses/jobs catalogs and reconstructs progress", async () => {
    const run = await runOnce();
    try {
      const houses = await run.db.select().from(housesPlugin);
      expect(houses.map((h) => h.name).sort()).toEqual(["Default House", "Manor"]);
      expect(houses.find((h) => h.name === "Manor")).toMatchObject({ price: 250000n, will: 250 });

      const courses = await run.db.select().from(coursesPlugin);
      expect(courses.find((c) => c.name === "Basic Fitness")).toMatchObject({
        cost: 500n, days: 3, strengthGain: 2, guardGain: 1, labourGain: 1, iqGain: 0,
      });

      // u1 completed Study Group (course 2).
      const done = await run.db.select().from(coursesDone);
      expect(done).toHaveLength(1);

      // u3 is mid-Study-Group: 7 days total, 3 remaining -> 4 elapsed days ago.
      const progress = await run.db.select().from(educationProgress);
      expect(progress).toHaveLength(1);
      const elapsed = Date.now() - progress[0]!.startedAt.getTime();
      expect(elapsed).toBeGreaterThan(3 * 86_400_000);
      expect(elapsed).toBeLessThan(5 * 86_400_000);

      const jobs = await run.db.select().from(jobsPlugin);
      expect(jobs).toHaveLength(1);
      const ranks = await run.db.select().from(jobRanks);
      expect(ranks.map((r) => r.name).sort()).toEqual(["Apprentice", "Foreman"]);
      expect(ranks.find((r) => r.name === "Foreman")).toMatchObject({
        pay: 400n, strengthReq: 50, iqGain: 1,
      });
      expect(jobs[0]!.firstRankId).toBe(ranks.find((r) => r.name === "Apprentice")!.id);

      // u1 (jobrank 1) and u3 (jobrank 2) keep their employment, wage stamp now.
      const employment = await run.db.select().from(playerJobs);
      expect(employment).toHaveLength(2);
      expect(employment.every((e) => e.lastWageAt.getTime() <= Date.now())).toBe(true);

      expect(run.report.ordinalKeyedTables).toContain("coursesdone");
    } finally {
      await run.teardown();
    }
  });

  it("imports gangs: vault, points, respect, leadership, members, feed", async () => {
    const run = await runOnce();
    try {
      const gangs = await run.db.select().from(gangsTable);
      expect(gangs).toHaveLength(1);
      const g = gangs[0]!;
      expect(g).toMatchObject({
        name: "The Syndicate", bank: 750000n, points: 30n, respect: 240n,
      });
      expect(g.bossPlayerId).not.toBeNull();
      expect(g.underbossPlayerId).not.toBeNull();

      const members = await run.db.select().from(gangMembers);
      expect(members).toHaveLength(2); // u1 + u2
      // player_stats.gang_id filled by this phase, not players.
      const stats = await run.db.execute(
        (await import("drizzle-orm")).sql`SELECT gang_id FROM player_stats`);
      const withGang = (stats as unknown as { gang_id: string }[]).filter((r) => r.gang_id !== null);
      expect(withGang).toHaveLength(2);

      const logs = await run.db.select().from(gangLogs);
      expect(logs).toHaveLength(1);
      expect(logs[0]!.message).toBe("The vault received a donation.");

      // Wars/surrenders/orgcrimes drop with counted report entries. (B4's
      // sweep adds many more "*" drops, so containment, not equality.)
      const dropped = run.report.droppedColumns.filter((d) => d.columns.includes("*"));
      expect(dropped.map((d) => d.table)).toEqual(
        expect.arrayContaining(["gangwars", "oclogs", "orgcrimes", "surrenders", "applications"]));
      expect(dropped.find((d) => d.table === "gangwars")!.rows).toBe(1);
      expect(dropped.find((d) => d.table === "oclogs")!.rows).toBe(1);
    } finally {
      await run.teardown();
    }
  });

  it("the equipment classifier runs against migrated items now (B2's orphans resolved)", async () => {
    const run = await runOnce();
    try {
      // u1 equips melee 1 + melee 2 + armor 3: primary melee wins the melee
      // slot, the differing secondary merges with a report entry. Pin the
      // row to u1 — the gangs phase UPDATEs other players' stats rows after
      // the players phase, so an unordered SELECT's first row is not u1.
      const { sql: dsql } = await import("drizzle-orm");
      const rows = await run.db.execute(
        dsql`SELECT ps.weapon_item_id, ps.weapon_melee_item_id, ps.armor_item_id
             FROM player_stats ps JOIN players p ON p.id = ps.player_id
             WHERE p.username = 'Muggy'`);
      const u1 = (rows as unknown as Record<string, string | null>[])[0]!;
      expect(u1.weapon_item_id).toBeNull(); // both MCCodes weapons are melee
      expect(u1.weapon_melee_item_id).not.toBeNull();
      expect(u1.armor_item_id).not.toBeNull();
      expect(run.report.equipMerges).toEqual([{ playerV2Id: 1, kept: 1, dropped: 2 }]);
      // No more "was not migrated" orphans from the players phase.
      expect(run.report.orphans.filter((o) => o.reason.includes("was not migrated"))).toEqual([]);
    } finally {
      await run.teardown();
    }
  });
});
