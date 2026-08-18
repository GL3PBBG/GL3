import type mysql from "mysql2/promise";
import type { Db } from "../../server/src/db/client.js";
import { runPhase } from "./pg/run-phase.js";
import type { MigrationReport } from "./report.js";
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
import { migrateSettings } from "./migrators/settings.js";

export interface RunMigrationOptions {
  mysql: mysql.Pool;
  db: Db;
  report: MigrationReport;
  dryRun: boolean;
  townCombatMode?: "open" | "underground";
}

/**
 * SPEC §4.2 item 2's exact dependency order: roles -> rounds -> content ->
 * players(+stats,timers,crime-skill) -> gangs(+members,permissions,invites,
 * logs) -> inventory/garage/properties -> social(mail,notifications,news,
 * bounties,detectives) -> settings. One Postgres transaction per phase
 * (§4.2 item 3, Task 10's runPhase) — a failure partway through a later
 * phase does not undo an earlier, already-committed phase; re-running is
 * always safe because every migrator is id_map-idempotent (Task 30 proves
 * this end to end).
 */
export async function runMigration(
  { mysql: pool, db, report, dryRun, townCombatMode = "open" }: RunMigrationOptions,
): Promise<void> {
  await runPhase(db, dryRun, (tx) => migrateRoles(pool, tx, report));
  await runPhase(db, dryRun, (tx) => migrateRounds(pool, tx, report));

  await runPhase(db, dryRun, async (tx) => {
    await migrateRanks(pool, tx, report);
    await migrateLocations(pool, tx, report, townCombatMode);
    await migrateCars(pool, tx, report);
    await migrateWeapons(pool, tx, report);
    await migrateItems(pool, tx, report);
    await migrateCrimes(pool, tx, report);
  });

  await runPhase(db, dryRun, async (tx) => {
    await migratePlayers(pool, tx, report);
    await migrateTimers(pool, tx, report);
    await migrateCrimeSkill(pool, tx, report);
  });

  await runPhase(db, dryRun, async (tx) => {
    await migrateGangs(pool, tx, report);
    await migrateGangSocial(pool, tx, report);
  });

  await runPhase(db, dryRun, async (tx) => {
    await migrateInventory(pool, tx, report);
    await migrateProperties(pool, tx, report);
  });

  await runPhase(db, dryRun, async (tx) => {
    await migrateSocial(pool, tx, report);
    await migrateBountiesAndDetectives(pool, tx, report);
  });

  await runPhase(db, dryRun, (tx) => migrateSettings(pool, tx, report));
}
