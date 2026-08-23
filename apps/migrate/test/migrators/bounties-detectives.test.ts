import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { bounties, detectiveSearches } from "../../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateBountiesAndDetectives } from "../../src/migrators/bounties-detectives.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateBountiesAndDetectives", () => {
  it("migrates open bounties (claimed_by always null, created_at defaulted) and detective searches with their hired count", async () => {
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

      const report = createReport(false);
      await migrateBountiesAndDetectives(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const soldierId = (await lookupV3Id(db, "users", 3))!;

      const bountyRows = await db.select().from(bounties);
      expect(bountyRows).toHaveLength(1); // target-999 orphan dropped
      expect(bountyRows[0]).toMatchObject({ placedBy: vitoId, target: soldierId, amount: 1000n, claimedBy: null });
      expect(report.orphans.some((o) => o.table === "bounties" && o.reason === "target 999 does not exist")).toBe(true);

      const detectiveRows = await db.select().from(detectiveSearches);
      expect(detectiveRows).toHaveLength(1);
      // D_detectives = 2 hired, D_success = 0 (rolled at insert, failed).
      expect(detectiveRows[0]).toMatchObject({ playerId: vitoId, targetPlayerId: soldierId, detectives: 2, succeeded: false });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
