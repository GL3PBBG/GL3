import type mysql from "mysql2/promise";
import { locations } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface LocationRow { L_id: number; L_name: string; L_cost: number; L_cooldown: number; L_bullets: number; L_bulletCost: number; }

export async function migrateLocations(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(LocationRow & mysql.RowDataPacket)[]>(
    "SELECT L_id, L_name, L_cost, L_cooldown, L_bullets, L_bulletCost FROM locations",
  );
  for (const row of rows) {
    bumpTable(report, "locations", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "locations", row.L_id);
    const values = {
      id: v3Id, name: row.L_name, travelCost: BigInt(row.L_cost),
      travelCooldownSeconds: row.L_cooldown, bulletStock: row.L_bullets, bulletCost: BigInt(row.L_bulletCost),
    };
    await exec.insert(locations).values(values).onConflictDoUpdate({ target: locations.id, set: values });
    bumpTable(report, "locations", "written");
  }
}
