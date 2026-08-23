import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../server/src/db/client.js";
import { crimes, mailMessages, playerItems, playerStats, players, settings } from "../../server/src/db/schema/index.js";
import { membershipPackages } from "../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "./helpers/fixtures.js";
import { createMysqlPool } from "../src/mysql/client.js";
import { fingerprintV2Schema } from "../src/mysql/fingerprint.js";
import { createReport } from "../src/report.js";
import { runMigration } from "../src/orchestrator.js";

describe("openPBBG-shaped source (GL2 framework without the game)", () => {
  it("fingerprint passes and reports the absent game columns informationally", async () => {
    const fixture = await createIsolatedMysqlFixture({ flavor: "openpbbg" });
    try {
      const pool = await createMysqlPool(fixture.url);
      const result = await fingerprintV2Schema(pool);
      expect(result.ok).toBe(true);
      expect(result.missingTables).toEqual([]);
      expect(result.missingColumns).toEqual({});
      expect(result.missingGameColumns.userStats?.sort()).toEqual(["US_crimes", "US_gang"]);
      // forumAccess/topicReads were dropped with the rest of the game; the
      // custom blackjackHands stand-in remains the one unknown table.
      expect(result.unknownTables).toEqual(["blackjackHands"]);
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });

  it("migrates accounts and framework content into a framework-profile target, skipping every game phase", async () => {
    const fixture = await createIsolatedMysqlFixture({ flavor: "openpbbg" });
    const target = await createIsolatedPgTarget({ plugins: "framework" });
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await runMigration({ mysql: pool, db, report, dryRun: false });

      // Accounts and framework content all landed.
      const playerRows = await db.select().from(players);
      expect(playerRows).toHaveLength(6);
      const stats = await db.select().from(playerStats);
      expect(stats).toHaveLength(6);
      expect(stats.every((s) => s.gangId === null)).toBe(true); // no gangs existed to join
      expect(await db.select().from(mailMessages)).toHaveLength(3);
      expect(await db.select().from(settings)).toHaveLength(12);
      expect(await db.select().from(playerItems)).toHaveLength(1); // userInventory survived; garage did not
      expect(await db.select().from(membershipPackages)).toHaveLength(1); // membership is a framework plugin
      expect(await db.select().from(crimes)).toHaveLength(0); // core table exists, stays empty

      // Every guarded game table the source lacked is named in the report.
      expect(report.missingSourceTables.sort()).toEqual([
        "bounties", "cars", "crimes", "detectives", "forums", "gangInvites", "gangLogs",
        "gangPermissions", "gangs", "garage", "locations", "posts", "properties", "theft",
        "topics", "userStats.US_crimes", "userStats.US_gang", "weapons",
      ].sort());
      // The garage half of the inventory migrator skipped for the source's
      // sake (recorded above), so nothing reached a target-side skip here.
      expect(report.absentTargetTables).toEqual([]);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("a full GL2 source into a framework target skips only the plugin-table sections", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget({ plugins: "framework" });
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await runMigration({ mysql: pool, db, report, dryRun: false });

      // The source had everything, so nothing was skipped for its sake.
      expect(report.missingSourceTables).toEqual([]);
      // The target lacked every gameplay plugin table — each named.
      expect(report.absentTargetTables.sort()).toEqual([
        "p_bounties_bounties", "p_detectives_searches", "p_forum_forums", "p_forum_posts",
        "p_forum_topics", "p_properties_properties", "p_theft_cars", "p_theft_garage", "p_theft_tiers",
      ].sort());
      // Players still migrated in full.
      expect((await db.select().from(players)).length).toBe(6);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
