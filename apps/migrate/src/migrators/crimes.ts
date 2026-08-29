import type mysql from "mysql2/promise";
import { crimes } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface CrimeRow {
  C_id: number; C_name: string | null; C_cooldown: number;
  C_money: number; C_maxMoney: number; C_bullets: number; C_maxBullets: number;
  C_exp: number; C_level: number;
}

export async function migrateCrimes(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(CrimeRow & mysql.RowDataPacket)[]>(
    "SELECT C_id, C_name, C_cooldown, C_money, C_maxMoney, C_bullets, C_maxBullets, C_exp, C_level " +
    "FROM crimes ORDER BY C_id",
  );

  let sort = 0;
  for (const row of rows) {
    bumpTable(report, "crimes", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "crimes", row.C_id);
    // V2's crimes table has no description column — the field is a GL3
    // addition, so migrated rows start empty rather than inventing text.
    const values = {
      id: v3Id, name: row.C_name ?? "", description: "",
      cooldownSeconds: row.C_cooldown, minPayout: BigInt(row.C_money), maxPayout: BigInt(row.C_maxMoney),
      minBullets: row.C_bullets, maxBullets: row.C_maxBullets, expReward: BigInt(row.C_exp),
      minLevel: row.C_level, sort: sort++,
    };
    await exec.insert(crimes).values(values).onConflictDoUpdate({ target: crimes.id, set: values });
    bumpTable(report, "crimes", "written");
  }
}
