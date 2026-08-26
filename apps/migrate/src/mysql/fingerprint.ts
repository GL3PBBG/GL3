import type mysql from "mysql2/promise";

export interface FingerprintSpec {
  /** Tables the migrator cannot run without; absence fails the preflight. */
  readonly requiredTables: readonly string[];
  /** Columns the required tables must carry (the dialect's id column etc.). */
  readonly requiredColumns: Readonly<Record<string, readonly string[]>>;
  /**
   * Game-only columns absent from a framework-shaped source — informational:
   * they make the games phases skip and report, never fail the preflight.
   */
  readonly gameColumns?: Readonly<Record<string, readonly string[]>>;
  /** Every table this migrator actually migrates; anything else reports unknown. */
  readonly knownTables: readonly string[];
}

const V2_REQUIRED_TABLES = ["users", "userStats", "userTimers"] as const;

const V2_REQUIRED_COLUMNS: Record<(typeof V2_REQUIRED_TABLES)[number], string[]> = {
  users: ["U_id", "U_name", "U_password"],
  userStats: ["US_id", "US_money"],
  userTimers: ["UT_user", "UT_desc", "UT_time"],
};

/**
 * Gangster-game columns on otherwise-framework tables: `US_gang` (gang
 * membership) and `US_crimes` (per-crime skill chances) exist in GL2 but not
 * in the GL2 framework — openPBBG's `userStats` carries neither. Their
 * absence makes `ok` FALSE only never: the games phases skip and report
 * instead, which is why they surface in `missingGameColumns` (informational)
 * rather than `missingColumns` (fatal).
 */
const V2_GAME_COLUMNS: Record<"userStats", string[]> = {
  userStats: ["US_gang", "US_crimes"],
};

/** Every table the V2 migrator actually migrates (Tasks 11–28). Anything else
 *  present in the source database — core-but-unsupported V2 module or
 *  genuinely third-party — is reported the same way (§4.2 item 1). */
const V2_KNOWN_TABLES = [
  ...V2_REQUIRED_TABLES,
  "ranks", "moneyRanks", "userRoles", "roleAccess", "rounds",
  "crimes", "locations", "cars", "theft", "weapons", "items", "itemEffects", "itemMeta", "settings",
  "gangs", "gangPermissions", "gangInvites", "gangLogs",
  "userInventory", "garage", "properties",
  "bounties", "detectives", "mail", "notifications", "gameNews",
  "forums", "topics", "posts", "premiumMembership",
];

export interface FingerprintResult {
  ok: boolean;
  missingTables: string[];
  missingColumns: Record<string, string[]>;
  /** Game-only columns absent from a framework-shaped source — informational. */
  missingGameColumns: Record<string, string[]>;
  unknownTables: string[];
}

/**
 * The shared preflight core (B1 Task 6): one information-schema read, then
 * REQUIRED/KNOWN evaluation against a dialect's spec. `fingerprintV2Schema`
 * and the MCCodes fingerprint are both thin wrappers over this — identical
 * semantics, different tables.
 */
export async function fingerprintSchema(pool: mysql.Pool, spec: FingerprintSpec): Promise<FingerprintResult> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()",
  );

  const columnsByTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = row.TABLE_NAME as string;
    const column = row.COLUMN_NAME as string;
    const set = columnsByTable.get(table) ?? new Set<string>();
    set.add(column);
    columnsByTable.set(table, set);
  }

  const missingTables = spec.requiredTables.filter((t) => !columnsByTable.has(t));

  const missingColumns: Record<string, string[]> = {};
  for (const table of spec.requiredTables) {
    const cols = columnsByTable.get(table);
    if (!cols) continue;
    const missing = (spec.requiredColumns[table] ?? []).filter((c) => !cols.has(c));
    if (missing.length > 0) missingColumns[table] = missing;
  }

  const missingGameColumns: Record<string, string[]> = {};
  for (const [table, columns] of Object.entries(spec.gameColumns ?? {})) {
    const cols = columnsByTable.get(table);
    if (!cols) continue; // missing table already reported above
    const missing = columns.filter((c) => !cols.has(c));
    if (missing.length > 0) missingGameColumns[table] = missing;
  }

  const known = new Set(spec.knownTables);
  const unknownTables = [...columnsByTable.keys()].filter((t) => !known.has(t));

  return {
    ok: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
    missingTables,
    missingColumns,
    missingGameColumns,
    unknownTables,
  };
}

export function fingerprintV2Schema(pool: mysql.Pool): Promise<FingerprintResult> {
  return fingerprintSchema(pool, {
    requiredTables: V2_REQUIRED_TABLES,
    requiredColumns: V2_REQUIRED_COLUMNS,
    gameColumns: V2_GAME_COLUMNS,
    knownTables: V2_KNOWN_TABLES,
  });
}
