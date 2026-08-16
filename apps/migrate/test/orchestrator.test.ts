import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../server/src/db/client.js";
import {
  crimes, gangMembers, gangs, idMap, items,
  mailMessages, notifications, playerItems, players, ranks, roles,
  rounds, settings,
} from "../../server/src/db/schema/index.js";
import { bounties, detectiveSearches, garage, propertiesPlugin } from "../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "./helpers/fixtures.js";
import { createReport } from "../src/report.js";
import { runMigration } from "../src/orchestrator.js";

describe("runMigration", () => {
  it("runs all 8 phases in SPEC §4.2 dependency order against the full fixture", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      const report = createReport(false);

      await runMigration({ mysql: pool, db, report, dryRun: false });

      expect(await db.select().from(roles)).toHaveLength(2);
      expect(await db.select().from(rounds)).toHaveLength(1);
      expect(await db.select().from(ranks)).toHaveLength(2);
      expect(await db.select().from(crimes)).toHaveLength(5);
      expect(await db.select().from(items)).toHaveLength(2);
      expect(await db.select().from(players)).toHaveLength(6);
      expect(await db.select().from(gangs)).toHaveLength(1);
      expect(await db.select().from(gangMembers)).toHaveLength(3); // underboss, soldier, + Vito via boss cross-check
      expect(await db.select().from(playerItems)).toHaveLength(1);
      expect(await db.select().from(garage)).toHaveLength(1);
      expect(await db.select().from(propertiesPlugin)).toHaveLength(2); // owned + PR_user=-1 closed-as-unowned
      expect(await db.select().from(mailMessages)).toHaveLength(3);
      expect(await db.select().from(notifications)).toHaveLength(1);
      expect(await db.select().from(bounties)).toHaveLength(1);
      expect(await db.select().from(detectiveSearches)).toHaveLength(1);
      expect(await db.select().from(settings)).toHaveLength(3);
      expect((await db.select().from(idMap)).length).toBeGreaterThan(20); // every migrated row got a mapping

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("--dry-run leaves every table empty across the whole pipeline", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      await runMigration({ mysql: pool, db, report: createReport(true), dryRun: true });

      expect(await db.select().from(players)).toHaveLength(0);
      expect(await db.select().from(gangs)).toHaveLength(0);
      expect(await db.select().from(settings)).toHaveLength(0);
      expect(await db.select().from(idMap)).toHaveLength(0);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
