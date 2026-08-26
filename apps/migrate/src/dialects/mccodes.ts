import { sql } from "drizzle-orm";
import type mysql from "mysql2/promise";
import type { Db } from "../../../server/src/db/client.js";
import { runPhase } from "../pg/run-phase.js";
import type { Executor } from "../pg/types.js";
import { recordMissingSourceTable, type MigrationReport } from "../report.js";
import { fingerprintMccodesSchema } from "../mysql/fingerprint-mccodes.js";
import { migrateMcRoles } from "../migrators/mc-roles.js";
import { migrateMcLocations } from "../migrators/mc-locations.js";
import { migrateMcItems } from "../migrators/mc-items.js";
import { migrateMcCrimes } from "../migrators/mc-crimes.js";
import { migrateMcHousesEducationJobs, migrateMcProgress } from "../migrators/mc-houses-education-jobs.js";
import { migrateMcPlayers } from "../migrators/mc-players.js";
import { migrateMcGangs } from "../migrators/mc-gangs.js";
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

  // The target-table inventory the plugin-table migrators consult (a
  // family-less boot skips those sections with a report entry, not a 42P01).
  const targetRows = (await db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)) as
    unknown as Record<string, unknown>[];
  const target = new Set(targetRows.map((r) => r.tablename as string));

  // Phase 1: roles (players' roleId lookups depend on these id_map rows).
  await runPhase(db, dryRun, guard(["staff_roles"])((tx) => migrateMcRoles(pool, tx, report)));

  // Phase 2: the world and its content — BEFORE players, because the
  // equipment classifier reads migrated items and the employment/progress
  // imports read migrated catalogs (the V2 dependency law).
  await runPhase(db, dryRun, guard(["cities"])((tx) => migrateMcLocations(pool, tx, report)));
  await runPhase(db, dryRun, async (tx) => {
    await guard(["items", "itemtypes", "shops", "shopitems"])(
      (tx) => migrateMcItems(pool, tx, report, target))(tx);
    await guard(["crimes", "crimegroups"])((tx) => migrateMcCrimes(pool, tx, report))(tx);
    await guard(["houses", "courses", "jobs", "jobranks", "coursesdone"])(
      (tx) => migrateMcHousesEducationJobs(pool, tx, report, target))(tx);
  });

  // Phase 3: players, then the progress rows that resolve them (completed/
  // in-flight courses, employment — their `users` id_map lookups and player
  // FKs both need the players phase committed first).
  await runPhase(db, dryRun, guard(["users", "userstats", "users_roles", "fedjail"])(
    (tx) => migrateMcPlayers(pool, tx, report),
  ));
  await runPhase(db, dryRun, guard(["coursesdone", "courses", "users"])(
    (tx) => migrateMcProgress(pool, tx, report, target),
  ));

  // Phase 4: gangs (fills player_stats.gang_id + gang_members).
  await runPhase(db, dryRun, guard(["gangs", "gangevents"])((tx) => migrateMcGangs(pool, tx, report)));
}

export const mccodesDialect: SourceDialect = {
  id: "mccodes",
  label: "MCCodes v2",
  sourceKind: "mysql",
  fingerprint: fingerprintMccodesSchema,
  run: runMccodes,
};
