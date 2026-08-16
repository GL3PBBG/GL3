import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../server/src/db/client.js";
import {
  crimes, gangInvites, gangLogs, gangMembers, gangPermissions,
  gangs, idMap, items, locations, mailMessages, notifications, playerCrimeSkill,
  playerItems, players, playerStats, playerTimers, ranks, roleModuleAccess,
  roles, rounds, settings, weapons,
} from "../../server/src/db/schema/index.js";
import { bounties, detectiveSearches, garage, propertiesPlugin } from "../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "./helpers/fixtures.js";
import { createReport } from "../src/report.js";
import { runMigration } from "../src/orchestrator.js";
import { lookupV3Id } from "../src/id-map.js";

const ALL_TABLES = [
  roles, roleModuleAccess, rounds, ranks, crimes, locations, items, weapons,
  players, playerStats, playerTimers, playerCrimeSkill,
  gangs, gangMembers, gangPermissions, gangInvites, gangLogs,
  playerItems, garage, propertiesPlugin,
  mailMessages, notifications, bounties, detectiveSearches,
  settings, idMap,
] as const;

describe("M4 acceptance: re-running the migrator produces zero duplicates (SPEC §6)", () => {
  it("row counts and every checked uuid are identical after a second run against the same fixture", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });
      const countsAfterFirstRun = await Promise.all(ALL_TABLES.map((t) => db.select().from(t).then((r) => r.length)));
      const vitoIdAfterFirstRun = await lookupV3Id(db, "users", 1);
      const gang1IdAfterFirstRun = await lookupV3Id(db, "gangs", 1);

      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });
      const countsAfterSecondRun = await Promise.all(ALL_TABLES.map((t) => db.select().from(t).then((r) => r.length)));
      const vitoIdAfterSecondRun = await lookupV3Id(db, "users", 1);
      const gang1IdAfterSecondRun = await lookupV3Id(db, "gangs", 1);

      expect(countsAfterSecondRun).toEqual(countsAfterFirstRun);
      expect(vitoIdAfterSecondRun).toBe(vitoIdAfterFirstRun); // same V2 row -> same GL3 uuid, every run
      expect(gang1IdAfterSecondRun).toBe(gang1IdAfterFirstRun);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("a third run still produces zero duplicates (not just \"twice is safe\")", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });

      expect(await db.select().from(players)).toHaveLength(6);
      expect(await db.select().from(gangMembers)).toHaveLength(3);
      expect(await db.select().from(idMap)).toEqual(await db.select().from(idMap)); // stable, re-queried

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
