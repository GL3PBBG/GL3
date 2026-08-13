import type mysql from "mysql2/promise";
import { moneyRanks, ranks } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface RankRow { R_id: number; R_name: string; R_exp: number; R_cashReward: number; R_bulletReward: number; R_health: number; }
interface MoneyRankRow { MR_id: number; MR_label: string; MR_threshold: number; }

export async function migrateRanks(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rankRows] = await pool.query<(RankRow & mysql.RowDataPacket)[]>(
    "SELECT R_id, R_name, R_exp, R_cashReward, R_bulletReward, R_health FROM ranks",
  );
  for (const row of rankRows) {
    bumpTable(report, "ranks", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "ranks", row.R_id);
    const values = {
      id: v3Id, name: row.R_name, expRequired: BigInt(row.R_exp),
      cashReward: BigInt(row.R_cashReward), bulletReward: row.R_bulletReward, maxHealth: row.R_health,
    };
    await exec.insert(ranks).values(values).onConflictDoUpdate({ target: ranks.id, set: values });
    bumpTable(report, "ranks", "written");
  }

  const [moneyRankRows] = await pool.query<(MoneyRankRow & mysql.RowDataPacket)[]>(
    "SELECT MR_id, MR_label, MR_threshold FROM moneyRanks",
  );
  for (const row of moneyRankRows) {
    bumpTable(report, "moneyRanks", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "moneyRanks", row.MR_id);
    const values = { id: v3Id, label: row.MR_label, threshold: BigInt(row.MR_threshold) };
    await exec.insert(moneyRanks).values(values).onConflictDoUpdate({ target: moneyRanks.id, set: values });
    bumpTable(report, "moneyRanks", "written");
  }
}
