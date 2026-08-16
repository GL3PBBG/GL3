import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { idMap } from "../../../server/src/db/schema/index.js";
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

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const location1Id = (await lookupV3Id(db, "locations", 1))!;

      // Map the -1 sentinel onto a REAL player's uuid. No V2 database contains
      // user -1; this row exists only to make the migrator's `PR_user > 0` guard
      // observable. Pointing it at an existing player (rather than a fresh uuid)
      // is deliberate: without the guard, `lookupV3Id(exec, "users", -1)` resolves
      // here and the insert SUCCEEDS with a bogus owner, so the assertion below is
      // what fails. A dangling uuid would instead trip the owner_player_id foreign
      // key inside migrateProperties, and the test would never reach any expect().
      await db.insert(idMap).values({ v2Table: "users", v2Id: -1, v3Id: vitoId })
        .onConflictDoNothing({ target: [idMap.v2Table, idMap.v2Id] });

      const report = createReport(false);
      await migrateProperties(pool, db, report);

      const rows = await db.select().from(propertiesPlugin);

      // Location 1 'casino' (owned) and location 1 'bullets' (PR_user = 0 ->
      // unowned), location 2 'bullets' (PR_user = -1 -> unowned). The
      // location-99 row is dropped as an orphan. Location 1 carries two rows
      // under (location_id, plugin_id) — the re-keyed constraint from Task 4.
      const casino1 = rows.find((r) => r.pluginId === "casino" && r.ownerPlayerId !== null);
      expect(rows).toHaveLength(3);
      expect(casino1).toMatchObject({ pluginId: "casino", ownerPlayerId: vitoId, cost: 5000n, profit: 100n, rate: 500n });
      expect(casino1!.lastClaimedAt).not.toBeNull();

      const closedRows = rows.filter((r) => r.ownerPlayerId === null);
      expect(closedRows).toHaveLength(2);
      for (const closed of closedRows) {
        expect(closed.ownerPlayerId).toBeNull();
        expect(closed.lastClaimedAt).toBeNull(); // unowned rows get no accrual clock
      }

      // PR_user = 0 (location 1, 'bullets') migrates unowned, same as the
      // PR_user = -1 sentinel — this is the case Task 1 deferred to Task 4.
      const unownedBullets1 = rows.find((r) => r.locationId === location1Id && r.pluginId === "bullets");
      expect(unownedBullets1).toBeDefined();
      expect(unownedBullets1!.ownerPlayerId).toBeNull();
      expect(unownedBullets1!.lastClaimedAt).toBeNull();

      expect(report.orphans).toContainEqual({ table: "properties", v2Id: 99, reason: "location 99 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
