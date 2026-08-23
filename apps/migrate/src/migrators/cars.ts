import type mysql from "mysql2/promise";
import { cars, theftTiers } from "../pg/plugin-tables.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, recordAbsentTargetTable, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";
import { targetHas } from "../pg/plugin-tables.js";

interface CarRow { CA_id: number; CA_name: string; CA_value: number; CA_theftChance: number; }
interface TheftRow { T_id: number; T_name: string; T_chance: number; T_maxDamage: number; T_worstCar: number; T_bestCar: number; }

export async function migrateCars(
  pool: mysql.Pool, exec: Executor, report: MigrationReport,
  targetTables?: ReadonlySet<string>,
): Promise<void> {
  // The theft plugin owns both target tables; a framework GL3 has neither.
  if (!targetHas(targetTables, "p_theft_cars") || !targetHas(targetTables, "p_theft_tiers")) {
    for (const t of ["p_theft_cars", "p_theft_tiers"]) {
      if (!targetHas(targetTables, t)) recordAbsentTargetTable(report, t);
    }
    return;
  }
  const [carRows] = await pool.query<(CarRow & mysql.RowDataPacket)[]>(
    "SELECT CA_id, CA_name, CA_value, CA_theftChance FROM cars",
  );
  for (const row of carRows) {
    bumpTable(report, "cars", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "cars", row.CA_id);
    // SPEC §1.2: CA_theftChance is a weight, not a percentage — copied as-is.
    const values = { id: v3Id, name: row.CA_name, value: BigInt(row.CA_value), theftWeight: row.CA_theftChance };
    await exec.insert(cars).values(values).onConflictDoUpdate({ target: cars.id, set: values });
    bumpTable(report, "cars", "written");
  }

  const [theftRows] = await pool.query<(TheftRow & mysql.RowDataPacket)[]>(
    "SELECT T_id, T_name, T_chance, T_maxDamage, T_worstCar, T_bestCar FROM theft",
  );
  for (const row of theftRows) {
    bumpTable(report, "theft", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "theft", row.T_id);
    // SPEC §1.2: T_worstCar/T_bestCar are cash value bounds, not car ids.
    const values = {
      id: v3Id, name: row.T_name, successChance: row.T_chance, maxDamage: row.T_maxDamage,
      minCarValue: BigInt(row.T_worstCar), maxCarValue: BigInt(row.T_bestCar),
    };
    await exec.insert(theftTiers).values(values).onConflictDoUpdate({ target: theftTiers.id, set: values });
    bumpTable(report, "theft", "written");
  }
}
