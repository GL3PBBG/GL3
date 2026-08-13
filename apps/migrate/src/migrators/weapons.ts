import type mysql from "mysql2/promise";
import { weapons } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface WeaponRow { W_id: number; W_name: string; W_accuracy: number; }

export async function migrateWeapons(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(WeaponRow & mysql.RowDataPacket)[]>("SELECT W_id, W_name, W_accuracy FROM weapons");
  for (const row of rows) {
    bumpTable(report, "weapons", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "weapons", row.W_id);
    const values = { id: v3Id, name: row.W_name, accuracy: row.W_accuracy };
    await exec.insert(weapons).values(values).onConflictDoUpdate({ target: weapons.id, set: values });
    bumpTable(report, "weapons", "written");
  }
}
