import { sql } from "drizzle-orm";
import type mysql from "mysql2/promise";
import type { Db } from "../../server/src/db/client.js";
import { runPhase } from "./pg/run-phase.js";
import type { Executor } from "./pg/types.js";
import { recordMissingSourceTable, type MigrationReport } from "./report.js";
import { migrateRoles } from "./migrators/roles.js";
import { migrateRounds } from "./migrators/rounds.js";
import { migrateRanks } from "./migrators/ranks.js";
import { migrateCrimes } from "./migrators/crimes.js";
import { migrateLocations } from "./migrators/locations.js";
import { migrateCars } from "./migrators/cars.js";
import { migrateWeapons } from "./migrators/weapons.js";
import { migrateItems } from "./migrators/items.js";
import { migratePlayers } from "./migrators/players.js";
import { migrateTimers } from "./migrators/timers.js";
import { migrateCrimeSkill } from "./migrators/crime-skill.js";
import { migrateGangs } from "./migrators/gangs.js";
import { migrateGangSocial } from "./migrators/gang-social.js";
import { migrateInventory } from "./migrators/inventory.js";
import { migrateProperties } from "./migrators/properties.js";
import { migrateSocial } from "./migrators/social.js";
import { migrateBountiesAndDetectives } from "./migrators/bounties-detectives.js";
import { migrateForum } from "./migrators/forum.js";
import { migrateMembership } from "./migrators/membership.js";
import { migrateSettings } from "./migrators/settings.js";

export interface RunMigrationOptions {
  mysql: mysql.Pool;
  db: Db;
  report: MigrationReport;
  dryRun: boolean;
  townCombatMode?: "open" | "underground";
}

/** The tables a migrator reads on the V2 side; every one must exist or the
 *  migrator skips whole (see `guard`). Empty = framework tables only. */
type SourceTables = readonly string[];

/**
 * What the run can see of both databases before any phase starts. A
 * framework-shaped V2 source (openPBBG: GL2's engine without the gangster
 * game) lacks crimes/gangs/cars/... entirely; a framework-profile GL3 target
 * lacks the gameplay plugins' p_* tables. Both are normal, not errors — the
 * affected migrators skip and the report says which.
 */
interface Inventory {
  sourceTables: Set<string>;
  /** userStats' columns only — the one framework-vs-game table that matters column-wise. */
  userStatsColumns: Set<string>;
  targetTables: Set<string>;
}

async function readInventory(pool: mysql.Pool, db: Db): Promise<Inventory> {
  const [tables] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  );
  const [columns] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS " +
    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'userStats'",
  );
  // drizzle's postgres-js `execute` resolves to the rows array itself.
  const targetRows = (await db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)) as
    unknown as Record<string, unknown>[];
  return {
    sourceTables: new Set(tables.map((r) => r.TABLE_NAME as string)),
    userStatsColumns: new Set(columns.map((r) => r.COLUMN_NAME as string)),
    targetTables: new Set(targetRows.map((r) => r.tablename as string)),
  };
}

/**
 * SPEC §4.2 item 2's exact dependency order: roles -> rounds -> content
 * (ranks/locations/cars/weapons/items/crimes/membership packages) ->
 * players(+stats,timers,crime-skill) -> gangs(+members,permissions,invites,
 * logs) -> inventory/garage/properties -> social(mail,notifications,news,
 * bounties,detectives) -> forum -> settings. One Postgres transaction per
 * phase (§4.2 item 3, Task 10's runPhase) — a failure partway through a
 * later phase does not undo an earlier, already-committed phase; re-running
 * is always safe because every migrator is id_map-idempotent (Task 30 proves
 * this end to end). Forum (Task 16) got its own phase, not a slot in the
 * social phase above, per the SDD controller ruling: it only needs players
 * already in id_map, and nothing later in the pipeline reads forum tables.
 */
export async function runMigration(
  { mysql: pool, db, report, dryRun, townCombatMode = "open" }: RunMigrationOptions,
): Promise<void> {
  const inventory = await readInventory(pool, db);

  // A migrator whose source tables (or the game columns its queries name)
  // are absent skips entirely — the missing tables land in the report, and
  // MySQL 1146 never happens. Coarse by design: a migrator that reads two
  // tables needs both (the one-table-at-a-time split inside a migrator is
  // not worth the surface area for the hybrid-database case).
  const guard = (tables: SourceTables, needs: { userStatsColumns?: string[] } = {}) =>
    (run: (exec: Executor) => Promise<void>) =>
      async (exec: Executor): Promise<void> => {
        const missing = tables.filter((t) => !inventory.sourceTables.has(t));
        const missingColumns = (needs.userStatsColumns ?? []).filter((c) => !inventory.userStatsColumns.has(c));
        if (missing.length > 0 || missingColumns.length > 0) {
          for (const t of missing) recordMissingSourceTable(report, t);
          for (const c of missingColumns) recordMissingSourceTable(report, `userStats.${c}`);
          return;
        }
        await run(exec);
      };

  const target = inventory.targetTables;

  await runPhase(db, dryRun, guard(["userRoles", "roleAccess"])((tx) => migrateRoles(pool, tx, report)));
  await runPhase(db, dryRun, guard(["rounds"])((tx) => migrateRounds(pool, tx, report)));

  await runPhase(db, dryRun, async (tx) => {
    await guard(["ranks", "moneyRanks"])((tx) => migrateRanks(pool, tx, report))(tx);
    await guard(["locations"])((tx) => migrateLocations(pool, tx, report, townCombatMode))(tx);
    await guard(["cars", "theft"])((tx) => migrateCars(pool, tx, report, target))(tx);
    await guard(["weapons"])((tx) => migrateWeapons(pool, tx, report))(tx);
    await guard(["items", "itemEffects", "itemMeta"])((tx) => migrateItems(pool, tx, report))(tx);
    await guard(["crimes"])((tx) => migrateCrimes(pool, tx, report))(tx);
    await guard(["premiumMembership"])((tx) => migrateMembership(pool, tx, report, target))(tx);
  });

  await runPhase(db, dryRun, async (tx) => {
    await guard(["users", "userStats"])((tx) => migratePlayers(pool, tx, report))(tx);
    await guard(["userTimers"])((tx) => migrateTimers(pool, tx, report))(tx);
    await guard(["crimes"], { userStatsColumns: ["US_crimes"] })((tx) => migrateCrimeSkill(pool, tx, report))(tx);
  });

  await runPhase(db, dryRun, async (tx) => {
    await guard(["gangs"], { userStatsColumns: ["US_gang"] })((tx) => migrateGangs(pool, tx, report))(tx);
    await guard(["gangPermissions", "gangInvites", "gangLogs"], { userStatsColumns: ["US_gang"] })(
      (tx) => migrateGangSocial(pool, tx, report),
    )(tx);
  });

  await runPhase(db, dryRun, async (tx) => {
    await guard(["userInventory"])((tx) => migrateInventory(pool, tx, report, target))(tx);
    await guard(["properties"])((tx) => migrateProperties(pool, tx, report, target))(tx);
  });

  await runPhase(db, dryRun, async (tx) => {
    await guard(["mail", "notifications", "gameNews"])((tx) => migrateSocial(pool, tx, report))(tx);
    await guard(["bounties", "detectives"])((tx) => migrateBountiesAndDetectives(pool, tx, report, target))(tx);
  });

  // Its own phase, after social: forum posts/topics need players already in
  // id_map (author lookups), and nothing later in the pipeline reads forum
  // tables, so it has no ordering constraint against settings.
  await runPhase(db, dryRun, guard(["forums", "topics", "posts"])((tx) => migrateForum(pool, tx, report, target)));

  await runPhase(db, dryRun, guard(["settings"])((tx) => migrateSettings(pool, tx, report)));
}
