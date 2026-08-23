import { writeFile } from "node:fs/promises";

export interface TableReport { table: string; read: number; written: number; skipped: number; }
export interface OrphanEntry { table: string; v2Id: number; reason: string; }
export interface DroppedCrimePosition { playerV2Id: number; position: number; }

export interface MigrationReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  tables: TableReport[];
  orphans: OrphanEntry[];
  unknownTables: string[];
  /**
   * V2 tables this pipeline knows how to migrate but the source database
   * lacks — an openPBBG source (the GL2 framework without the game) has no
   * crimes/gangs/cars/... tables at all. Each migrator whose required source
   * tables are all present runs normally; one that is missing any records
   * them here and skips, rather than dying on MySQL 1146.
   */
  missingSourceTables: string[];
  /**
   * GL3 plugin-owned tables the TARGET lacks — a framework-profile GL3
   * (`GL3_PROFILE=framework`) never creates p_bounties_bounties and
   * friends. The corresponding plugin-table migrators skip and record the
   * table name here instead of dying on Postgres 42P01.
   */
  absentTargetTables: string[];
  unknownTimerKeys: string[];
  droppedCrimePositions: DroppedCrimePosition[];
  bossNotInGang: Array<{ gangV2Id: number; bossV2Id: number }>;
  underbossNotInGang: Array<{ gangV2Id: number; underbossV2Id: number }>;
}

export function createReport(dryRun: boolean): MigrationReport {
  return {
    dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    tables: [],
    orphans: [],
    unknownTables: [],
    missingSourceTables: [],
    absentTargetTables: [],
    unknownTimerKeys: [],
    droppedCrimePositions: [],
    bossNotInGang: [],
    underbossNotInGang: [],
  };
}

function tableEntry(report: MigrationReport, table: string): TableReport {
  let entry = report.tables.find((t) => t.table === table);
  if (!entry) {
    entry = { table, read: 0, written: 0, skipped: 0 };
    report.tables.push(entry);
  }
  return entry;
}

export function bumpTable(report: MigrationReport, table: string, field: "read" | "written" | "skipped"): void {
  tableEntry(report, table)[field] += 1;
}

export function recordOrphan(report: MigrationReport, table: string, v2Id: number, reason: string): void {
  report.orphans.push({ table, v2Id, reason });
}

export function recordUnknownTimerKey(report: MigrationReport, key: string): void {
  if (!report.unknownTimerKeys.includes(key)) report.unknownTimerKeys.push(key);
}

export function recordMissingSourceTable(report: MigrationReport, table: string): void {
  if (!report.missingSourceTables.includes(table)) report.missingSourceTables.push(table);
}

export function recordAbsentTargetTable(report: MigrationReport, table: string): void {
  if (!report.absentTargetTables.includes(table)) report.absentTargetTables.push(table);
}

export function recordDroppedCrimePosition(report: MigrationReport, playerV2Id: number, position: number): void {
  report.droppedCrimePositions.push({ playerV2Id, position });
}

export function finishReport(report: MigrationReport): void {
  report.finishedAt = new Date().toISOString();
  report.durationMs = new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime();
}

export async function writeReportFile(report: MigrationReport, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
}

export function formatHumanSummary(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push(`gl3-migrate ${report.dryRun ? "(dry run) " : ""}— ${report.durationMs ?? 0}ms`);
  for (const t of report.tables) {
    lines.push(`  ${t.table.padEnd(20)} read=${t.read} written=${t.written} skipped=${t.skipped}`);
  }
  lines.push(`${report.orphans.length} orphan row(s) skipped`);
  if (report.unknownTables.length > 0) {
    lines.push(`Unknown tables (custom module tables, not migrated): ${report.unknownTables.join(", ")}`);
  }
  if (report.missingSourceTables.length > 0) {
    lines.push(`Source tables absent, migrators skipped (framework-shaped V2 source?): ${report.missingSourceTables.join(", ")}`);
  }
  if (report.absentTargetTables.length > 0) {
    lines.push(`Target plugin tables absent, sections skipped (framework-profile GL3?): ${report.absentTargetTables.join(", ")}`);
  }
  if (report.unknownTimerKeys.length > 0) {
    lines.push(`Unknown userTimers keys (migrated anyway): ${report.unknownTimerKeys.join(", ")}`);
  }
  if (report.droppedCrimePositions.length > 0) {
    lines.push(`${report.droppedCrimePositions.length} US_crimes position(s) dropped (deleted crime id gaps)`);
  }
  if (report.bossNotInGang.length > 0 || report.underbossNotInGang.length > 0) {
    lines.push(`${report.bossNotInGang.length} boss / ${report.underbossNotInGang.length} underboss row(s) added to their own gang`);
  }
  return lines.join("\n");
}
