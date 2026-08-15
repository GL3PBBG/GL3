import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { playerItems } from "../../../server/src/db/schema/index.js";
import { garage } from "../../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migrateCars } from "../../src/migrators/cars.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateInventory } from "../../src/migrators/inventory.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateInventory", () => {
  it("migrates player_items and garage, dropping every orphan row", async () => {
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
      await migrateCars(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      const report = createReport(false);
      await migrateInventory(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const items = await db.select().from(playerItems);
      expect(items).toHaveLength(1); // user 4/item 99 and user 88/item 1 both orphans
      expect(items[0]).toMatchObject({ playerId: vitoId, qty: 5 });

      const garageRows = await db.select().from(garage);
      expect(garageRows).toHaveLength(1); // user 77 orphan dropped
      expect(garageRows[0]).toMatchObject({ playerId: vitoId, damage: 10 });

      expect(report.orphans).toContainEqual({ table: "userInventory", v2Id: 4, reason: "item 99 does not exist" });
      expect(report.orphans).toContainEqual({ table: "userInventory", v2Id: 88, reason: "user 88 does not exist" });
      expect(report.orphans).toContainEqual({ table: "garage", v2Id: 77, reason: "user 77 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
