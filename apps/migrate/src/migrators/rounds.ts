import type mysql from "mysql2/promise";
import { rounds } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { unixToDate } from "../time.js";

interface RoundRow { RND_id: number; RND_name: string; RND_start: number; RND_end: number | null; }

export async function migrateRounds(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(RoundRow & mysql.RowDataPacket)[]>(
    "SELECT RND_id, RND_name, RND_start, RND_end FROM rounds",
  );

  for (const row of rows) {
    bumpTable(report, "rounds", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "rounds", row.RND_id);
    await exec.insert(rounds).values({
      id: v3Id, name: row.RND_name,
      startsAt: unixToDate(row.RND_start), endsAt: unixToDate(row.RND_end),
    }).onConflictDoUpdate({
      target: rounds.id,
      set: { name: row.RND_name, startsAt: unixToDate(row.RND_start), endsAt: unixToDate(row.RND_end) },
    });
    bumpTable(report, "rounds", "written");
  }
}
