import type mysql from "mysql2/promise";
import { membershipPackages } from "../pg/plugin-tables.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface MembershipRow { PM_id: number; PM_desc: string; PM_seconds: number; PM_cost: number }

export async function migrateMembership(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(MembershipRow & mysql.RowDataPacket)[]>(
    "SELECT PM_id, PM_desc, PM_seconds, PM_cost FROM premiumMembership",
  );
  for (const row of rows) {
    bumpTable(report, "premiumMembership", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "premiumMembership", row.PM_id);
    const values = {
      id: v3Id, name: row.PM_desc,
      costPoints: BigInt(row.PM_cost), durationSeconds: row.PM_seconds,
    };
    await exec.insert(membershipPackages).values(values)
      .onConflictDoUpdate({ target: membershipPackages.id, set: values });
    bumpTable(report, "premiumMembership", "written");
  }
}
