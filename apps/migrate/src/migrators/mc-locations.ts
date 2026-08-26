import type mysql from "mysql2/promise";
import { locations } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface CityRow { cityid: number; cityname: string; citydesc: string; cityminlevel: number; }

/**
 * MCCodes `cities` -> GL3 `locations` (B2 Task 8, spec §4 phase 2).
 * `cityminlevel` lands on the level gate 0017 added. Travel is MCCodes'
 * flat 1000 (monorail.php, audit §4.11) with no cooldown; the bullet shop
 * columns stay 0 — bullets idle as a store currency in an MCCodes profile
 * by audit §7 item 9's ruling. Descriptions drop (locations has none).
 */
export async function migrateMcLocations(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(CityRow & mysql.RowDataPacket)[]>(
    "SELECT cityid, cityname, citydesc, cityminlevel FROM cities",
  );
  for (const row of rows) {
    bumpTable(report, "cities", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "cities", row.cityid);
    const values = {
      id: v3Id,
      name: row.cityname,
      minLevel: row.cityminlevel,
      travelCost: 1000n,
      travelCooldownSeconds: 0,
      bulletStock: 0,
      bulletCost: 0n,
    };
    await exec.insert(locations).values(values)
      .onConflictDoUpdate({ target: locations.id, set: values });
    bumpTable(report, "cities", "written");
  }
}
