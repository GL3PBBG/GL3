import type mysql from "mysql2/promise";
import { rounds } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

interface RoundRow { R_id: number; R_name: string | null; R_start: number; R_end: number | null; }

export async function migrateRounds(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(RoundRow & mysql.RowDataPacket)[]>(
    "SELECT R_id, R_name, R_start, R_end FROM rounds",
  );

  for (const row of rows) {
    bumpTable(report, "rounds", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "rounds", row.R_id);
    await exec.insert(rounds).values({
      id: v3Id, name: row.R_name ?? "",
      startsAt: unixToDate(row.R_start), endsAt: unixToDate(row.R_end),
    }).onConflictDoUpdate({
      target: rounds.id,
      set: { name: row.R_name ?? "", startsAt: unixToDate(row.R_start), endsAt: unixToDate(row.R_end) },
    });
    bumpTable(report, "rounds", "written");
  }
}
