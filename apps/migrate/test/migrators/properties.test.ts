import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { propertiesPlugin } from "../../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateProperties } from "../../src/migrators/properties.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateProperties", () => {
  it("copies PR_module into plugin_id and drops the orphan-location row", async () => {
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
      await migrateProperties(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const rows = await db.select().from(propertiesPlugin);
      expect(rows).toHaveLength(1); // location 99 orphan dropped
      expect(rows[0]).toMatchObject({ pluginId: "casino", ownerPlayerId: vitoId, cost: 5000n, profit: 100n, rate: 500n });
      expect(rows[0].lastClaimedAt).not.toBeNull(); // owned row gets a timestamp
      expect(report.orphans).toContainEqual({ table: "properties", v2Id: 99, reason: "location 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
