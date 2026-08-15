import type mysql from "mysql2/promise";
import { propertiesPlugin } from "../pg/plugin-tables.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface PropertyRow {
  PR_id: number; PR_location: number; PR_module: string; PR_owner: number | null; PR_cost: number; PR_profit: number;
}

export async function migrateProperties(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(PropertyRow & mysql.RowDataPacket)[]>(
    "SELECT PR_id, PR_location, PR_module, PR_owner, PR_cost, PR_profit FROM properties",
  );
  for (const row of rows) {
    bumpTable(report, "properties", "read");
    const locationId = await lookupV3Id(exec, "locations", row.PR_location);
    if (!locationId) {
      recordOrphan(report, "properties", row.PR_location, `location ${row.PR_location} does not exist`);
      bumpTable(report, "properties", "skipped");
      continue;
    }
    const ownerPlayerId = row.PR_owner ? await lookupV3Id(exec, "users", row.PR_owner) : null;
    const { v3Id } = await getOrCreateV3Id(exec, "properties", row.PR_id);
    // SPEC §1.2: PR_module is the implementing module's name -> plugin_id.
    // SPEC §2: migrated owners must not inherit phantom back-accrual from
    // 2015 — stamp lastClaimedAt so the plugin's lazy-income collector
    // treats the row as already claimed.
    const values = {
      id: v3Id, locationId, pluginId: row.PR_module, ownerPlayerId,
      cost: BigInt(row.PR_cost), profit: BigInt(row.PR_profit),
      lastClaimedAt: ownerPlayerId ? new Date() : null,
      rate: 500n, // default from properties.income.default_rate setting
    };
    await exec.insert(propertiesPlugin).values(values).onConflictDoUpdate({ target: propertiesPlugin.id, set: values });
    bumpTable(report, "properties", "written");
  }
}
