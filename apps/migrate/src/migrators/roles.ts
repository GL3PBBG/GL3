import type mysql from "mysql2/promise";
import { roleModuleAccess, roles } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface UserRoleRow { UR_id: number; UR_name: string; UR_color: string | null; }
interface RoleAccessRow { RA_role: number; RA_module: string; }

export async function migrateRoles(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [roleRows] = await pool.query<(UserRoleRow & mysql.RowDataPacket)[]>(
    "SELECT UR_id, UR_name, UR_color FROM userRoles",
  );

  for (const row of roleRows) {
    bumpTable(report, "userRoles", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "userRoles", row.UR_id);
    await exec.insert(roles).values({ id: v3Id, name: row.UR_name, color: row.UR_color })
      .onConflictDoUpdate({ target: roles.id, set: { name: row.UR_name, color: row.UR_color } });
    bumpTable(report, "userRoles", "written");
  }

  const [accessRows] = await pool.query<(RoleAccessRow & mysql.RowDataPacket)[]>(
    "SELECT RA_role, RA_module FROM roleAccess",
  );

  for (const row of accessRows) {
    bumpTable(report, "roleAccess", "read");
    const roleId = await lookupV3Id(exec, "userRoles", row.RA_role);
    if (!roleId) {
      recordOrphan(report, "roleAccess", row.RA_role, `role ${row.RA_role} does not exist`);
      bumpTable(report, "roleAccess", "skipped");
      continue;
    }
    await exec.insert(roleModuleAccess).values({ roleId, moduleKey: row.RA_module })
      .onConflictDoNothing({ target: [roleModuleAccess.roleId, roleModuleAccess.moduleKey] });
    bumpTable(report, "roleAccess", "written");
  }
}
