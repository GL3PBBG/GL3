import type mysql from "mysql2/promise";
import { propertiesPlugin } from "../pg/plugin-tables.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordAbsentTargetTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { targetHas } from "../pg/plugin-tables.js";

interface PropertyRow {
  PR_id: number; PR_location: number; PR_module: string; PR_user: number; PR_cost: number; PR_profit: number;
}

export async function migrateProperties(
  pool: mysql.Pool, exec: Executor, report: MigrationReport,
  targetTables?: ReadonlySet<string>,
): Promise<void> {
  if (!targetHas(targetTables, "p_properties_properties")) {
    recordAbsentTargetTable(report, "p_properties_properties");
    return;
  }
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
    // No lastClaimedAt or rate: income is paid by the consumer plugin, not
    // accrued from a clock, so there is no accrual epoch to stamp and nothing
    // for a migrated owner to inherit.
    //
    // PR_cost migrates verbatim into `cost`, which is the owner's lever on
    // both sides (V2's PR_cost is the bullet price / max bet).
    const values = {
      id: v3Id, locationId, pluginId: row.PR_module, ownerPlayerId,
      cost: BigInt(row.PR_cost), profit: BigInt(row.PR_profit),
    };
    await exec.insert(propertiesPlugin).values(values).onConflictDoUpdate({ target: propertiesPlugin.id, set: values });
    bumpTable(report, "properties", "written");
  }
}
