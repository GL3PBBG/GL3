import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";

const SCHEMA_SQL = new URL("../fixtures/v2-schema.sql", import.meta.url);
const SEED_SQL = new URL("../fixtures/v2-seed.sql", import.meta.url);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set before running apps/migrate tests (see .env.example)`);
  return value;
}

/**
 * Creates a uniquely-named MariaDB database, loads the reconstructed V2
 * schema and seed into it, and returns a connection URL plus a teardown
 * function. Every test file gets its own — vitest runs files in parallel by
 * default, so a single shared V2 fixture database would race the same way
 * apps/server's isolated-db.setup.ts documents for Postgres.
 *
 * Only the MySQL/V2 half — the Postgres/GL3 target half (Task 5) will
 * export `createIsolatedPgTarget` from the same file.
 */
export async function createIsolatedMysqlFixture(): Promise<{ url: string; teardown: () => Promise<void> }> {
  const adminUrl = requireEnv("MYSQL_ADMIN_URL");
  const dbName = `gl3_test_mysql_${randomBytes(8).toString("hex")}`;

  // The admin URL may include a database name the user cannot access (e.g.
  // /mysql). Strip the pathname so the connection opens with no default
  // database — the user only needs CREATE DATABASE + DROP on gl3_%.
  const adminBase = new URL(adminUrl);
  adminBase.pathname = "/";

  const admin = await mysql.createConnection(adminBase.toString());
  try {
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminBase.toString());
  target.pathname = `/${dbName}`;

  // V2 ran on MySQL 5.x which defaulted to non-strict sql_mode — values
  // that overflow INT(11) (e.g. unix timestamps past 2038) were silently
  // clamped rather than rejected. MariaDB 10.11 defaults to strict mode.
  // Reproduce V2 behaviour by disabling strict mode for the fixture, so the
  // seed data loads exactly as it would have on the original server.
  const conn = await mysql.createConnection({ uri: target.toString(), multipleStatements: true });
  try {
    await conn.query("SET SESSION sql_mode = ''");
    const schema = await readFile(SCHEMA_SQL, "utf8");
    const seed = await readFile(SEED_SQL, "utf8");
    await conn.query(schema);
    await conn.query(seed);
  } finally {
    await conn.end();
  }

  return {
    url: target.toString(),
    teardown: async () => {
      // MySQL has no DROP DATABASE … WITH (FORCE); we must terminate active
      // connections before dropping. The grant is scoped to gl3_% so only
      // connections our own tests opened can be holding a lock.
      const dropAdmin = await mysql.createConnection(adminBase.toString());
      try {
        const [procs] = await dropAdmin.query<mysql.RowDataPacket[]>(
          `SELECT id FROM information_schema.processlist WHERE db = ?`,
          [dbName],
        );
        for (const row of procs) {
          try {
            await dropAdmin.query(`KILL CONNECTION ${row.id}`);
          } catch {
            // Connection may have already closed between the SELECT and KILL.
          }
        }
        await dropAdmin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      } finally {
        await dropAdmin.end();
      }
    },
  };
}
