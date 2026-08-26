import type mysql from "mysql2/promise";
import { roles, roleModuleAccess } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, setV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

/**
 * MCCodes `staff_roles` -> GL3 `roles` + `role_module_access` (B2 Task 8,
 * spec §4 phase 1). The 24 permission bools become module keys verbatim —
 * module_key is free text and the V2 migrator's precedent imports V2's
 * RA_module strings unchanged; `administrator` becomes the `*` wildcard.
 * `users_roles` is read by mc-players (it carries the per-user mapping this
 * table doesn't). The user_level fallbacks (2 = admin, 3 = assistant, audit
 * §2's sentinel table) are keyed in id_map under the synthetic
 * "mc_user_level" table so mc-players resolves them by lookup, no join.
 */
interface StaffRoleRow {
  id: number; name: string; administrator: boolean;
  credit_all_users: boolean; credit_item: boolean; credit_user: boolean;
  edit_newspaper: boolean; manage_challenge_bots: boolean; manage_cities: boolean;
  manage_courses: boolean; manage_crimes: boolean; manage_donator_packs: boolean;
  manage_forums: boolean; manage_gangs: boolean; manage_houses: boolean;
  manage_items: boolean; manage_jobs: boolean; manage_player_reports: boolean;
  manage_polls: boolean; manage_punishments: boolean; manage_roles: boolean;
  manage_shops: boolean; manage_staff: boolean; manage_users: boolean;
  mass_mail: boolean; use_staff_forums: boolean; view_logs: boolean;
  view_user_inventory: boolean;
}

export async function migrateMcRoles(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [roleRows] = await pool.query<(StaffRoleRow & mysql.RowDataPacket)[]>(
    "SELECT * FROM staff_roles",
  );

  let administratorV3Id: string | null = null;
  let assistantV3Id: string | null = null;
  for (const row of roleRows) {
    bumpTable(report, "staff_roles", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "staff_roles", row.id);
    const values = { id: v3Id, name: row.name, color: null };
    await exec.insert(roles).values(values)
      .onConflictDoUpdate({ target: roles.id, set: values });
    bumpTable(report, "staff_roles", "written");

    // administrator -> the `*` wildcard; each true permission bool -> its
    // own column name as the module key, exactly as V2 imported RA_module.
    // mysql2 hands BOOL back as 0/1 numbers, so truthy, not === true.
    const enabled = (v: unknown): boolean => v === true || v === 1;
    if (enabled(row.administrator)) {
      await exec.insert(roleModuleAccess).values({ roleId: v3Id, moduleKey: "*" })
        .onConflictDoNothing({ target: [roleModuleAccess.roleId, roleModuleAccess.moduleKey] });
    }
    for (const [column, value] of Object.entries(row)) {
      if (column === "id" || column === "name" || column === "administrator") continue;
      if (enabled(value)) {
        await exec.insert(roleModuleAccess).values({ roleId: v3Id, moduleKey: column })
          .onConflictDoNothing({ target: [roleModuleAccess.roleId, roleModuleAccess.moduleKey] });
      }
    }

    // First matching row wins — the stock seed makes those exactly the
    // Administrator and Secretary rows the fallbacks mean.
    if (administratorV3Id === null && enabled(row.administrator)) administratorV3Id = v3Id;
    if (assistantV3Id === null && !enabled(row.administrator)) assistantV3Id = v3Id;
  }

  if (administratorV3Id !== null) await setV3Id(exec, "mc_user_level", 2, administratorV3Id);
  if (assistantV3Id !== null) await setV3Id(exec, "mc_user_level", 3, assistantV3Id);
}
