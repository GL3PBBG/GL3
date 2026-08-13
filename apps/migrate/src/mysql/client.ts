import mysql from "mysql2/promise";

/**
 * SPEC §1.1: V2 is `utf8`, not `utf8mb4`; real dumps may contain mojibake
 * a strict utf8mb4 connection charset can reject outright. Try utf8mb4
 * first (the correct modern choice when the source data happens to be
 * clean), and fall back to utf8 — matching the source charset exactly —
 * if the connection itself fails to establish under it.
 */
export async function createMysqlPool(mysqlUrl: string): Promise<mysql.Pool> {
  const preferred = mysql.createPool({ uri: mysqlUrl, charset: "UTF8MB4_GENERAL_CI", supportBigNumbers: true });
  try {
    const probe = await preferred.getConnection();
    probe.release();
    return preferred;
  } catch {
    await preferred.end();
    return mysql.createPool({ uri: mysqlUrl, charset: "UTF8_GENERAL_CI", supportBigNumbers: true });
  }
}
