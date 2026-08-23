import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import mysql from "mysql2/promise";
import postgres from "postgres";
import bountiesPlugin from "@gl3/plugin-bounties";
import detectivesPlugin from "@gl3/plugin-detectives";
import forumPlugin from "@gl3/plugin-forum";
import membershipPlugin from "@gl3/plugin-membership";
import propertiesPlugin from "@gl3/plugin-properties";
import theftPlugin from "@gl3/plugin-theft";
import { createDb } from "../../../server/src/db/client.js";
import { runPluginMigrations } from "../../../server/src/plugins/migrate.js";

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
export async function createIsolatedMysqlFixture(
  options?: { flavor?: "gl2" | "openpbbg" },
): Promise<{ url: string; teardown: () => Promise<void> }> {
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
    // The openPBBG flavor is the GL2 framework without the gangster game:
    // same load, then the game tables and userStats' two game columns are
    // dropped — the shape a real openPBBG database has.
    if (options?.flavor === "openpbbg") {
      for (const table of [
        "cars", "crimes", "gangs", "gangPermissions", "gangInvites", "gangLogs", "garage",
        "locations", "theft", "weapons", "forums", "forumAccess", "topicReads", "topics",
        "posts", "properties", "detectives", "bounties",
      ]) {
        await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
      }
      await conn.query("ALTER TABLE userStats DROP COLUMN US_gang, DROP COLUMN US_crimes");
    }
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

const PG_MIGRATIONS_FOLDER = new URL("../../../server/drizzle", import.meta.url).pathname;

/**
 * Creates a uniquely-named Postgres database, runs every core migration from
 * apps/server/drizzle, then runs the bounties + detectives + properties +
 * theft + forum + membership plugin migrations (the ten plugin-owned target
 * tables — "Known unknowns" item 8, plus the three `p_forum_*` tables Task 16
 * adds and `p_membership_packages` this task adds). Returns a connection URL
 * plus a teardown function.
 */
export async function createIsolatedPgTarget(
  options?: { plugins?: "all" | "framework" | "none" },
): Promise<{ url: string; teardown: () => Promise<void> }> {
  const adminUrl = requireEnv("DATABASE_URL");
  const dbName = `gl3_test_migrate_pg_${randomBytes(8).toString("hex")}`;

  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = `/${dbName}`;

  const migrator = postgres(target.toString(), { max: 1 });
  try {
    await migrate(drizzle(migrator), { migrationsFolder: PG_MIGRATIONS_FOLDER });
  } finally {
    await migrator.end();
  }

  // The ten plugin-owned target tables ("Known unknowns" item 8, plus
  // forum's three and membership's one), created the same way apps/server's
  // loader creates them at boot. `{ plugins: "framework" }` runs only the
  // membership plugin's — the exact table set a GL3_PROFILE=framework boot
  // creates (membership is a framework plugin; the other five are gameplay).
  // `{ plugins: "none" }` runs none.
  const pluginSelection =
    options?.plugins === "framework" ? [membershipPlugin]
    : options?.plugins === "none" ? []
    : [bountiesPlugin, detectivesPlugin, propertiesPlugin, theftPlugin, forumPlugin, membershipPlugin];
  if (pluginSelection.length > 0) {
    const pluginDb = createDb(target.toString());
    try {
      await runPluginMigrations(pluginDb.db, pluginSelection);
    } finally {
      await pluginDb.sql.end();
    }
  }

  return {
    url: target.toString(),
    teardown: async () => {
      const dropAdmin = postgres(adminUrl, { max: 1 });
      try {
        // `client backend` only: an autovacuum worker attached to this database
        // also shows up here, runs as a superuser, and cannot be signalled by the
        // unprivileged test role — one such row made the whole statement fail with
        // "permission denied to terminate process". DROP DATABASE only needs the
        // client sessions gone; the worker exits on its own.
        await dropAdmin.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = '${dbName}' AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
        );
        await dropAdmin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await dropAdmin.end();
      }
    },
  };
}
