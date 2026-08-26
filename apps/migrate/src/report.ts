import { writeFile } from "node:fs/promises";

export interface TableReport { table: string; read: number; written: number; skipped: number; }
export interface OrphanEntry { table: string; v2Id: number; reason: string; }
export interface DroppedCrimePosition { playerV2Id: number; position: number; }

/** B: per-value entries an admin must act on, not just counts. */
export interface BankFoldSplit { v2Id: number; bank: number; cyber: number; folded: string; }
export interface PercformReject { crimeV2Id: number; original: string; }
export interface EquipMerge { playerV2Id: number; kept: number; dropped: number; }
export interface LoginNameDivergence { v2Id: number; username: string; loginName: string; }
export interface DroppedProgress { playerV2Id: number; kind: string; detail: string; }
export interface StoleSentinel { logV2Id: number; attacker: number; attacked: number; stole: number; }
export interface DroppedColumns { table: string; columns: string[]; rows: number; }

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
  /** B (cluster B): the MCCodes dialect's per-value entries. Empty for V2. */
  bankFoldSplits: BankFoldSplit[];
  percformRejects: PercformReject[];
  equipMerges: EquipMerge[];
  loginNameDivergences: LoginNameDivergence[];
  droppedProgress: DroppedProgress[];
  stoleSentinels: StoleSentinel[];
  droppedColumns: DroppedColumns[];
  /** Tables keyed by row ordinal in id_map — re-runs assume a fixed source. */
  ordinalKeyedTables: string[];
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
    bankFoldSplits: [],
    percformRejects: [],
    equipMerges: [],
    loginNameDivergences: [],
    droppedProgress: [],
    stoleSentinels: [],
    droppedColumns: [],
    ordinalKeyedTables: [],
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

export function recordBankFoldSplit(report: MigrationReport, entry: BankFoldSplit): void {
  report.bankFoldSplits.push(entry);
}

export function recordPercformReject(report: MigrationReport, crimeV2Id: number, original: string): void {
  report.percformRejects.push({ crimeV2Id, original });
}

export function recordEquipMerge(report: MigrationReport, playerV2Id: number, kept: number, dropped: number): void {
  report.equipMerges.push({ playerV2Id, kept, dropped });
}

export function recordLoginNameDivergence(report: MigrationReport, entry: LoginNameDivergence): void {
  report.loginNameDivergences.push(entry);
}

export function recordDroppedProgress(report: MigrationReport, playerV2Id: number, kind: string, detail: string): void {
  report.droppedProgress.push({ playerV2Id, kind, detail });
}

export function recordStoleSentinel(report: MigrationReport, entry: StoleSentinel): void {
  report.stoleSentinels.push(entry);
}

/** Table-level dropped columns, recorded ONCE per table (with the row count
 *  the table read), not per row — §4's drops are table-level facts. */
export function recordDroppedColumns(report: MigrationReport, table: string, columns: string[], rows: number): void {
  const existing = report.droppedColumns.find((d) => d.table === table);
  if (existing) {
    existing.columns = [...new Set([...existing.columns, ...columns])];
    existing.rows = Math.max(existing.rows, rows);
  } else {
    report.droppedColumns.push({ table, columns: [...columns], rows });
  }
}

export function recordOrdinalKeyedTable(report: MigrationReport, table: string): void {
  if (!report.ordinalKeyedTables.includes(table)) report.ordinalKeyedTables.push(table);
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
  // Cluster B's per-value entries — each line names something an admin acts on.
  if (report.bankFoldSplits.length > 0) {
    lines.push(`${report.bankFoldSplits.length} player bank fold(s): bank + cyber -> player_stats.bank (splits in the report file)`);
  }
  if (report.percformRejects.length > 0) {
    lines.push(`${report.percformRejects.length} crimePERCFORM(s) outside the dialect -> imported NULL (originals in the report file)`);
  }
  if (report.equipMerges.length > 0) {
    lines.push(`${report.equipMerges.length} equipped-weapon collision(s): primary kept, secondary reported`);
  }
  if (report.loginNameDivergences.length > 0) {
    lines.push(`${report.loginNameDivergences.length} player(s) whose login_name differed from username (list in the report file)`);
  }
  if (report.droppedProgress.length > 0) {
    lines.push(`${report.droppedProgress.length} in-flight progress row(s) dropped (details in the report file)`);
  }
  if (report.stoleSentinels.length > 0) {
    lines.push(`${report.stoleSentinels.length} attacklog stole sentinel(s) recorded for the KO-outcome wave`);
  }
  if (report.droppedColumns.length > 0) {
    for (const d of report.droppedColumns) {
      lines.push(`${d.table}: dropped columns [${d.columns.join(", ")}] across ${d.rows} row(s)`);
    }
  }
  if (report.ordinalKeyedTables.length > 0) {
    lines.push(`Ordinal-keyed (PK-less) tables: ${report.ordinalKeyedTables.join(", ")} — re-runs assume a fixed source`);
  }
  return lines.join("\n");
}
