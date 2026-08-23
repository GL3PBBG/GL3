import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { playerCrimeSkill } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migrateCrimes } from "../../src/migrators/crimes.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateCrimeSkill } from "../../src/migrators/crime-skill.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateCrimeSkill", () => {
  it("explodes US_crimes per SPEC §1.2's C_id-1 indexing quirk", async () => {
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
      await migrateCrimes(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      const report = createReport(false);
      await migrateCrimeSkill(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const underbossId = (await lookupV3Id(db, "users", 2))!;
      const soldierId = (await lookupV3Id(db, "users", 3))!;
      const crime1 = (await lookupV3Id(db, "crimes", 1))!;
      const crime2 = (await lookupV3Id(db, "crimes", 2))!;
      const crime3 = (await lookupV3Id(db, "crimes", 3))!;
      const crime5 = (await lookupV3Id(db, "crimes", 5))!;
      const crime6 = (await lookupV3Id(db, "crimes", 6))!;
      const crime16 = (await lookupV3Id(db, "crimes", 16))!;

      async function chanceFor(playerId: string, crimeId: string): Promise<string | undefined> {
        const [row] = await db.select().from(playerCrimeSkill)
          .where(and(eq(playerCrimeSkill.playerId, playerId), eq(playerCrimeSkill.crimeId, crimeId)));
        return row?.chance;
      }

      // DonVito: direct values for 1-3, fallback-to-base for 5 and 6 (V2's
      // real 15-wide schema default reaches both), nothing for 16 — beyond
      // every position of both his string and the default.
      expect(await chanceFor(vitoId, crime1)).toBe("50.00");
      expect(await chanceFor(vitoId, crime3)).toBe("30.00");
      expect(await chanceFor(vitoId, crime5)).toBe("5.00"); // base default index 4
      expect(await chanceFor(vitoId, crime6)).toBe("5.00"); // base default index 5
      expect(await chanceFor(vitoId, crime16)).toBeUndefined();

      // Underboss: every index direct, including the dropped id-4 gap.
      expect(await chanceFor(underbossId, crime1)).toBe("20.00");
      expect(await chanceFor(underbossId, crime6)).toBe("20.00");
      expect(report.droppedCrimePositions).toContainEqual({ playerV2Id: 2, position: 3 });

      // Soldier: direct for 1, fallback-to-base for 2/3/5/6, nothing for 16.
      expect(await chanceFor(soldierId, crime1)).toBe("10.00");
      expect(await chanceFor(soldierId, crime2)).toBe("25.00"); // base default index 1
      expect(await chanceFor(soldierId, crime6)).toBe("5.00");
      expect(await chanceFor(soldierId, crime16)).toBeUndefined();

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
