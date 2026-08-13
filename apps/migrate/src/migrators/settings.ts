import type mysql from "mysql2/promise";
import { settings } from "../../../server/src/db/schema/index.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface SettingRow { S_key: string; S_value: string | null; }

/**
 * No id_map here: settings.key is a natural key, identical on both sides
 * (V2's S_key IS the GL3 key). ON CONFLICT (key) DO UPDATE alone gives
 * idempotency — see Global Constraints, "Not every table needs id_map".
 */
export async function migrateSettings(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(SettingRow & mysql.RowDataPacket)[]>("SELECT S_key, S_value FROM settings");
  for (const row of rows) {
    bumpTable(report, "settings", "read");
    await exec.insert(settings).values({ key: row.S_key, value: row.S_value ?? "" })
      .onConflictDoUpdate({ target: settings.key, set: { value: row.S_value ?? "" } });
    bumpTable(report, "settings", "written");
  }
}
