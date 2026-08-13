import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { gangMembers, gangs, playerStats } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateGangs } from "../../src/migrators/gangs.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateGangs", () => {
  it("migrates gangs, US_gang membership, and cross-checks boss+underboss into their own gang", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      // Gang 2: boss=Soldier(3), underboss=LoneWolf(4) — neither has US_gang=2 in the
      // fixture (Soldier's US_gang=1, LoneWolf's is 0), so both cross-checks fire here
      // distinctly from gang 1 (which only exercises the boss case).
      await pool.query(
        "INSERT INTO gangs (G_id, G_name, G_boss, G_underboss, G_bank, G_money, G_level, G_location) " +
        "VALUES (2, 'Small Crew', 3, 4, 1000, 500, 1, 2)",
      );

      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      const report = createReport(false);
      await migrateGangs(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const underbossId = (await lookupV3Id(db, "users", 2))!;
      const soldierId = (await lookupV3Id(db, "users", 3))!;
      const loneWolfId = (await lookupV3Id(db, "users", 4))!;
      const gang1Id = (await lookupV3Id(db, "gangs", 1))!;
      const gang2Id = (await lookupV3Id(db, "gangs", 2))!;

      const gangRows = await db.select().from(gangs);
      expect(gangRows).toHaveLength(2);
      const family = gangRows.find((g) => g.name === "The Family");
      expect(family?.bossPlayerId).toBe(vitoId);
      expect(family?.underbossPlayerId).toBe(underbossId);
      expect(family?.bank).toBe(900000000n);

      // Gang 1: underboss + soldier from US_gang=1, plus Vito added by the boss cross-check.
      const gang1Members = await db.select().from(gangMembers).where(eq(gangMembers.gangId, gang1Id));
      expect(gang1Members.map((m) => m.playerId).sort()).toEqual([underbossId, soldierId, vitoId].sort());

      // Gang 2: both boss and underboss added purely by the cross-check.
      const gang2Members = await db.select().from(gangMembers).where(eq(gangMembers.gangId, gang2Id));
      expect(gang2Members.map((m) => m.playerId).sort()).toEqual([loneWolfId, soldierId].sort());

      expect(report.bossNotInGang).toContainEqual({ gangV2Id: 1, bossV2Id: 1 });
      expect(report.bossNotInGang).toContainEqual({ gangV2Id: 2, bossV2Id: 3 });
      expect(report.underbossNotInGang).toContainEqual({ gangV2Id: 2, underbossV2Id: 4 });

      // player_stats.gang_id is back-filled here (Task 20 left it null).
      const vitoStats = (await db.select().from(playerStats).where(eq(playerStats.playerId, vitoId)))[0];
      expect(vitoStats?.gangId).toBe(gang1Id);

      // GhostGangMember (user 5, US_gang=99) is an orphan — no gang, never crashes.
      const ghostId = (await lookupV3Id(db, "users", 5))!;
      const ghostStats = (await db.select().from(playerStats).where(eq(playerStats.playerId, ghostId)))[0];
      expect(ghostStats?.gangId).toBeNull();
      expect(report.orphans).toContainEqual({ table: "US_gang", v2Id: 5, reason: "gang 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("is idempotent: re-running does not duplicate members or re-report the same cross-check", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      await migrateGangs(pool, db, createReport(false));
      const secondReport = createReport(false);
      await migrateGangs(pool, db, secondReport);

      const gang1Id = (await lookupV3Id(db, "gangs", 1))!;
      const members = await db.select().from(gangMembers).where(eq(gangMembers.gangId, gang1Id));
      expect(members).toHaveLength(3); // still 3, not 6
      expect(secondReport.bossNotInGang).toEqual([]); // Vito is already a member the second time around

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
