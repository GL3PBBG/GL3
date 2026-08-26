import type mysql from "mysql2/promise";
import type { Db } from "../../../server/src/db/client.js";
import type { FingerprintResult } from "../mysql/fingerprint.js";
import type { MigrationReport } from "../report.js";

/**
 * A source game dialect (B spec §1, decision 2026-08-26): `--mccodes`
 * selects the MCCodes v2 pipeline, no flag stays V2 — backward compatible —
 * and the planned fourth hybrid dialect `--gl3` joins the same registry.
 * Selection is an explicit CLI flag, never auto-detection: a wrong guess
 * migrates the wrong game.
 */

export type DialectId = "v2" | "mccodes";

export interface RunMigrationOptions {
  mysql: mysql.Pool;
  db: Db;
  report: MigrationReport;
  dryRun: boolean;
  townCombatMode?: "open" | "underground";
}

export interface SourceDialect {
  readonly id: DialectId;
  readonly label: string;
  /**
   * The `--gl3` hybrid's source will be a GL3 Postgres database, not MySQL —
   * `sourceKind` is the seam that keeps the shared machinery (id_map,
   * report, runPhase, CLI dispatch) from ever assuming MySQL. It is the
   * only implementation until that wave.
   */
  readonly sourceKind: "mysql";
  /** Preflight: REQUIRED tables/columns present, everything else unknown. */
  readonly fingerprint: (pool: mysql.Pool) => Promise<FingerprintResult>;
  /** Runs the dialect's whole phase pipeline. Reads its own inventory. */
  run: (opts: RunMigrationOptions) => Promise<void>;
}
