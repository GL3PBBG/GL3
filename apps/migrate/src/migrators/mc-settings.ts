import type mysql from "mysql2/promise";
import { settings } from "../../../server/src/db/schema/index.js";
import { bumpTable, recordDroppedColumns, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

/**
 * MCCodes `settings` -> GL3 `settings` (B4 Task 16, spec §4 phase 8). Only
 * keys with a live GL3 surface migrate, and each one is stored NAMESPACED —
 * `ctx.settings.get` prefixes the reading plugin's id, so a bare key
 * silently reads as the built-in default (the C-era trap the V2 dialect's
 * rename map already documents). Everything else drops by name with one
 * counted report entry: unlike V2's settings (GL3-adjacent by lineage),
 * MCCodes keys mean nothing to any GL3 reader, and `game_name`/`game_owner`
 * have no core surface to land on.
 */
const RENAMES: Readonly<Record<string, string>> = {
  ct_refillprice: "temple.refill_points",
  ct_iqpercrys: "temple.iq_per_point",
  ct_moneypercrys: "temple.money_per_point",
};

interface SettingRow { conf_name: string; conf_value: string | null; }

export async function migrateMcSettings(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(SettingRow & mysql.RowDataPacket)[]>(
    "SELECT conf_name, conf_value FROM settings",
  );
  const droppedKeys: string[] = [];
  for (const row of rows) {
    bumpTable(report, "settings", "read");
    const key = RENAMES[row.conf_name];
    if (key === undefined) {
      droppedKeys.push(row.conf_name);
      bumpTable(report, "settings", "skipped");
      continue;
    }
    await exec.insert(settings).values({ key, value: row.conf_value ?? "" })
      .onConflictDoUpdate({ target: settings.key, set: { value: row.conf_value ?? "" } });
    bumpTable(report, "settings", "written");
  }
  if (droppedKeys.length > 0) {
    recordDroppedColumns(report, "settings", droppedKeys, droppedKeys.length);
  }
}
