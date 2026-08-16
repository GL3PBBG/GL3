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
import { getOrCreateV3Id, lookupV3Id } from "../../src/id-map.js";

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

      // A user mapping for the -1 sentinel, which no real V2 database has.
      // Its only purpose is to make the migrator's `PR_user > 0` guard
      // OBSERVABLE: without the guard, `lookupV3Id(exec, "users", -1)` would
      // resolve to this uuid and land in owner_player_id. With it, the row
      // stays unowned. Delete this seeding and the test proves nothing.
      const sentinelId = (await getOrCreateV3Id(db, "users", -1)).v3Id;

      const report = createReport(false);
      await migrateProperties(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const rows = await db.select().from(propertiesPlugin);

      // Location 1 'casino' (owned), location 2 'bullets' (PR_user = -1 ->
      // unowned). The location-99 row is dropped as an orphan.
      const casino1 = rows.find((r) => r.pluginId === "casino" && r.ownerPlayerId !== null);
      expect(rows).toHaveLength(2);
      expect(casino1).toMatchObject({ pluginId: "casino", ownerPlayerId: vitoId, cost: 5000n, profit: 100n, rate: 500n });
      expect(casino1!.lastClaimedAt).not.toBeNull();

      const closed = rows.find((r) => r.ownerPlayerId === null);
      expect(closed).toBeDefined();
      expect(closed!.ownerPlayerId).toBeNull();
      expect(closed!.ownerPlayerId).not.toBe(sentinelId);
      expect(closed!.lastClaimedAt).toBeNull(); // unowned rows get no accrual clock

      expect(report.orphans).toContainEqual({ table: "properties", v2Id: 99, reason: "location 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
