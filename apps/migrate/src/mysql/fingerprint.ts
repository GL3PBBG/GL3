import type mysql from "mysql2/promise";

const REQUIRED_TABLES = ["users", "userStats", "userTimers"] as const;

const REQUIRED_COLUMNS: Record<(typeof REQUIRED_TABLES)[number], string[]> = {
  users: ["U_id", "U_name", "U_password"],
  userStats: ["US_id", "US_money", "US_gang", "US_crimes"],
  userTimers: ["UT_user", "UT_key", "UT_time"],
};

/** Every table this migrator actually migrates (Tasks 11–28). Anything else
 * present in the source database — core-but-unsupported V2 module or
 * genuinely third-party — is reported the same way (§4.2 item 1). */
const KNOWN_TABLES = new Set([
  ...REQUIRED_TABLES,
  "ranks", "moneyRanks", "userRoles", "roleAccess", "rounds",
  "crimes", "locations", "cars", "theft", "weapons", "items", "itemEffects", "itemMeta", "settings",
  "gangs", "gangPermissions", "gangInvites", "gangLogs",
  "userInventory", "garage", "properties",
  "bounties", "detectives", "mail", "notifications", "gameNews",
  "forums", "topics", "posts",
]);

export interface FingerprintResult {
  ok: boolean;
  missingTables: string[];
  missingColumns: Record<string, string[]>;
  unknownTables: string[];
}

export async function fingerprintV2Schema(pool: mysql.Pool): Promise<FingerprintResult> {
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

  const missingTables = REQUIRED_TABLES.filter((t) => !columnsByTable.has(t));

  const missingColumns: Record<string, string[]> = {};
  for (const table of REQUIRED_TABLES) {
    const cols = columnsByTable.get(table);
    if (!cols) continue;
    const missing = REQUIRED_COLUMNS[table].filter((c) => !cols.has(c));
    if (missing.length > 0) missingColumns[table] = missing;
  }

  const unknownTables = [...columnsByTable.keys()].filter((t) => !KNOWN_TABLES.has(t));

  return {
    ok: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
    missingTables,
    missingColumns,
    unknownTables,
  };
}
