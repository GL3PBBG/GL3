import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { playerStats, playerTimers } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateTimers } from "../../src/migrators/timers.js";
import { lookupV3Id } from "../../src/id-map.js";

async function seedThroughPlayers(pool: mysql.Pool, db: ReturnType<typeof createDb>["db"]): Promise<void> {
  await migrateRoles(pool, db, createReport(false));
  await migrateRounds(pool, db, createReport(false));
  await migrateRanks(pool, db, createReport(false));
  await migrateLocations(pool, db, createReport(false));
  await migrateItems(pool, db, createReport(false));
  await migratePlayers(pool, db, createReport(false));
}

describe("migrateTimers", () => {
  it("drops past timers, promotes jail/hospital, keeps unknown keys, drops the orphan user row", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await seedThroughPlayers(pool, db);

      const report = createReport(false);
      await migrateTimers(pool, db, report);

      const vitoId = await lookupV3Id(db, "users", 1);
      const vitoStats = (await db.select().from(playerStats).where(eq(playerStats.playerId, vitoId!)))[0];
      expect(vitoStats?.jailedUntil).toEqual(new Date(2100000000 * 1000)); // future 'jail' promoted
      expect(vitoStats?.hospitalUntil).toBeNull(); // past 'hospital' dropped entirely

      const soldierId = await lookupV3Id(db, "users", 3);
      const genericTimers = await db.select().from(playerTimers).where(eq(playerTimers.playerId, soldierId!));
      expect(genericTimers).toHaveLength(2); // 'crime' + 'someCustomModuleKey', both future
      expect(genericTimers.map((t) => t.key).sort()).toEqual(["crime", "someCustomModuleKey"]);

      expect(report.unknownTimerKeys).toEqual(["someCustomModuleKey"]);
      expect(report.orphans).toContainEqual({ table: "userTimers", v2Id: 999, reason: "user 999 does not exist" });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
