import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { gangInvites, gangLogs, gangPermissions } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateGangs } from "../../src/migrators/gangs.js";
import { migrateGangSocial } from "../../src/migrators/gang-social.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateGangSocial", () => {
  it("derives gang_id for permissions (dropping the gangless user's row), migrates invites and logs, dropping orphans", async () => {
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

      const report = createReport(false);
      await migrateGangSocial(pool, db, report);

      const gang1Id = (await lookupV3Id(db, "gangs", 1))!;
      const soldierId = (await lookupV3Id(db, "users", 3))!;
      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const loneWolfId = (await lookupV3Id(db, "users", 4))!;

      const permRows = await db.select().from(gangPermissions);
      expect(permRows).toHaveLength(1); // LoneWolf (gangless) and user 999 (nonexistent) both dropped
      expect(permRows[0]).toMatchObject({ gangId: gang1Id, playerId: soldierId, permission: "kick" });
      expect(report.orphans).toContainEqual({ table: "gangPermissions", v2Id: 4, reason: "user 4 is gangless" });
      expect(report.orphans).toContainEqual({ table: "gangPermissions", v2Id: 999, reason: "user 999 does not exist" });

      const inviteRows = await db.select().from(gangInvites);
      expect(inviteRows).toHaveLength(1); // gang 99 orphan dropped
      expect(inviteRows[0]).toMatchObject({ gangId: gang1Id, invitedPlayerId: loneWolfId, invitedByPlayerId: vitoId });
      expect(report.orphans).toContainEqual({ table: "gangInvites", v2Id: 2, reason: "gang 99 does not exist" });

      const logRows = await db.select().from(gangLogs).where(eq(gangLogs.gangId, gang1Id));
      expect(logRows).toHaveLength(2); // "Founded" (user) + "System: round started" (null user)
      expect(logRows.some((l) => l.playerId === null && l.message.startsWith("System:"))).toBe(true);
      expect(report.orphans).toContainEqual({ table: "gangLogs", v2Id: 3, reason: "gang 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
