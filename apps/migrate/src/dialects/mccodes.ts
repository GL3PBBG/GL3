import type mysql from "mysql2/promise";
import type { Db } from "../../../server/src/db/client.js";
import { runPhase } from "../pg/run-phase.js";
import type { Executor } from "../pg/types.js";
import { recordMissingSourceTable, type MigrationReport } from "../report.js";
import { fingerprintMccodesSchema } from "../mysql/fingerprint-mccodes.js";
import { migrateMcRoles } from "../migrators/mc-roles.js";
import { migrateMcLocations } from "../migrators/mc-locations.js";
import { migrateMcPlayers } from "../migrators/mc-players.js";
import type { RunMigrationOptions, SourceDialect } from "./types.js";

/**
 * The MCCodes v2 dialect (B1 Task 6). Phases land milestone by milestone in
 * the V2 dependency law's order — roles -> content -> players -> gangs ->
 * inventory -> social -> logs -> settings (plan 2026-08-26-mccodes-migrator.md,
 * spec §4). B2 wires identity and progression; later milestones insert the
 * content phases BEFORE players (the equipment classifier reads migrated
 * items), exactly as V2's pipeline does.
 */

type SourceTables = readonly string[];

async function readSourceTables(pool: mysql.Pool): Promise<Set<string>> {
  const [tables] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  );
  return new Set(tables.map((r) => r.TABLE_NAME as string));
}

/** Same coarse skip-and-report guard as the V2 dialect; MCCodes has no
 *  framework-vs-game column variant, so table presence is the only probe. */
function makeGuard(pool: mysql.Pool, report: MigrationReport, sourceTables: Set<string>) {
  return (tables: SourceTables) =>
    (run: (exec: Executor) => Promise<void>) =>
    async (exec: Executor): Promise<void> => {
      const missing = tables.filter((t) => !sourceTables.has(t));
      if (missing.length > 0) {
        for (const t of missing) recordMissingSourceTable(report, t);
        return;
      }
      await run(exec);
    };
}

async function runMccodes({ mysql: pool, db, report, dryRun }: RunMigrationOptions): Promise<void> {
  const guard = makeGuard(pool, report, await readSourceTables(pool));

  // Phase 1: roles (players' roleId lookups depend on these id_map rows).
  await runPhase(db, dryRun, guard(["staff_roles"])((tx) => migrateMcRoles(pool, tx, report)));

  // Phase 2: the world (cities -> locations; content joins with B3).
  await runPhase(db, dryRun, guard(["cities"])((tx) => migrateMcLocations(pool, tx, report)));

  // Phase 3: players. Runs after the content phases once B3 lands.
  await runPhase(db, dryRun, guard(["users", "userstats", "users_roles", "fedjail"])(
    (tx) => migrateMcPlayers(pool, tx, report),
  ));
}

export const mccodesDialect: SourceDialect = {
  id: "mccodes",
  label: "MCCodes v2",
  sourceKind: "mysql",
  fingerprint: fingerprintMccodesSchema,
  run: runMccodes,
};
