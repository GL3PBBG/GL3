import type mysql from "mysql2/promise";
import { combatLog, targetHas } from "../pg/plugin-tables.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import {
  bumpTable, recordAbsentTargetTable, recordDroppedColumns, recordOrphan, recordStoleSentinel,
  type MigrationReport,
} from "../report.js";
import type { Executor } from "../pg/types.js";

/**
 * MCCodes `attacklogs` -> the combat plugin's `p_combat_log` (B4 Task 15,
 * spec §4 phase 7): actors, timestamp, won/lost as `hit`. Every `stole`
 * value records a per-value report entry — −1 (hospitalized) and −2 (left)
 * are sentinels riding the deferred KO-outcome wave; a positive value is
 * the mug amount and lands as `payout`. The page-HTML transcripts drop.
 *
 * Everything else in the log family drops wholesale with counted entries:
 * the ledger is append-only and the import writes balance-SETS, so
 * transfer/commerce history would be fabricated, not migrated; markets are
 * the premium market plugin's territory; IPN/cron bookkeeping and the
 * battletent have no GL3 surface.
 */
interface AttackLogRow {
  log_id: number; attacker: number; attacked: number;
  result: string; time: number; stole: number;
}

/** Log-family tables that drop wholesale when present in the source. */
const SWEEP_TABLES = [
  "cashxferlogs", "bankxferlogs", "crystalxferlogs", "itemxferlogs",
  "itembuylogs", "itemselllogs", "imarketaddlogs", "imbuylogs", "imremovelogs",
  "jaillogs", "unjaillogs", "stafflog", "staffnotelogs", "preports",
  "crystalmarket", "itemmarket", "dps_accepted", "willps_accepted",
  "cron_times", "logs_cron_fails", "logs_cron_runtimes",
  "challengebots", "challengesbeaten",
] as const;

export async function migrateMcLogs(
  pool: mysql.Pool, exec: Executor, report: MigrationReport,
  sourceTables: ReadonlySet<string>, targetTables?: ReadonlySet<string>,
): Promise<void> {
  const [logRows] = await pool.query<(AttackLogRow & mysql.RowDataPacket)[]>(
    "SELECT log_id, attacker, attacked, result, time, stole FROM attacklogs",
  );
  if (!targetHas(targetTables, "p_combat_log")) {
    recordAbsentTargetTable(report, "p_combat_log");
  } else {
    for (const row of logRows) {
      bumpTable(report, "attacklogs", "read");
      const attackerId = await lookupV3Id(exec, "users", row.attacker);
      const targetId = await lookupV3Id(exec, "users", row.attacked);
      if (attackerId === null || targetId === null) {
        recordOrphan(report, "attacklogs", row.log_id,
          `user ${attackerId === null ? row.attacker : row.attacked} does not exist`);
        bumpTable(report, "attacklogs", "skipped");
        continue;
      }
      recordStoleSentinel(report, {
        logV2Id: row.log_id, attacker: row.attacker, attacked: row.attacked, stole: row.stole,
      });
      const { v3Id } = await getOrCreateV3Id(exec, "attacklogs", row.log_id);
      const values = {
        id: v3Id, attackerId, targetId,
        hit: row.result === "won",
        damage: 0, // MCCodes logs carry no damage figure
        fatal: false, // the KO outcome rides the deferred wave's enum
        weaponItemId: null,
        payout: row.stole > 0 ? BigInt(row.stole) : 0n,
        createdAt: row.time > 0 ? new Date(row.time * 1000) : new Date(),
      };
      await exec.insert(combatLog).values(values).onConflictDoUpdate({ target: combatLog.id, set: values });
      bumpTable(report, "attacklogs", "written");
    }
  }
  recordDroppedColumns(report, "attacklogs", ["attacklog"], logRows.length);

  for (const table of SWEEP_TABLES) {
    if (!sourceTables.has(table)) continue;
    const [rows] = await pool.query<(mysql.RowDataPacket & { n: number })[]>(
      `SELECT COUNT(*) AS n FROM \`${table}\``,
    );
    recordDroppedColumns(report, table, ["*"], Number(rows[0]?.n ?? 0));
  }
}
