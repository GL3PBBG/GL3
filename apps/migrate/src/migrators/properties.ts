import type mysql from "mysql2/promise";
import { propertiesPlugin } from "../pg/plugin-tables.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface PropertyRow {
  PR_id: number; PR_location: number; PR_module: string; PR_user: number; PR_cost: number; PR_profit: number;
}

export async function migrateProperties(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(PropertyRow & mysql.RowDataPacket)[]>(
    "SELECT PR_id, PR_location, PR_module, PR_user, PR_cost, PR_profit FROM properties",
  );
  for (const row of rows) {
    bumpTable(report, "properties", "read");
    const locationId = await lookupV3Id(exec, "locations", row.PR_location);
    if (!locationId) {
      recordOrphan(report, "properties", row.PR_location, `location ${row.PR_location} does not exist`);
      bumpTable(report, "properties", "skipped");
      continue;
    }
    // V2's PR_user is NOT NULL DEFAULT 0 and carries two sentinels: 0 means
    // unowned, -1 means "closed" (class/property.php getOwnership special-cases
    // it). GL3 has no closed state, so both become a null owner. Only a
    // positive id is a real user reference - passing 0 or -1 to lookupV3Id
    // would report a spurious orphan.
    const ownerPlayerId = row.PR_user > 0 ? await lookupV3Id(exec, "users", row.PR_user) : null;
    const { v3Id } = await getOrCreateV3Id(exec, "properties", row.PR_id);
    // SPEC §1.2: PR_module is the implementing module's name -> plugin_id.
    // SPEC §2: migrated owners must not inherit phantom back-accrual from
    // 2015 — stamp lastClaimedAt so the plugin's lazy-income collector
    // treats the row as already claimed.
    const values = {
      id: v3Id, locationId, pluginId: row.PR_module, ownerPlayerId,
      cost: BigInt(row.PR_cost), profit: BigInt(row.PR_profit),
      lastClaimedAt: ownerPlayerId ? new Date() : null,
      // Hardcoded, NOT read from properties.income.default_rate — the
      // migrator has no connection to the plugin's settings reader. The
      // constant happens to match the setting's own default (500), so
      // no migrated row is wrong today, but an operator who changes the
      // setting will not see it reflected here (docs/STATUS.md).
      rate: 500n,
    };
    await exec.insert(propertiesPlugin).values(values).onConflictDoUpdate({ target: propertiesPlugin.id, set: values });
    bumpTable(report, "properties", "written");
  }
}
