import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll } from "vitest";

/**
 * Vitest runs server test files in parallel by default (see
 * vitest.workspace.ts). Every DB-touching file calls resetDb() (helpers/db.ts),
 * which issues `TRUNCATE ... CASCADE` across all game tables — two files
 * doing that concurrently against one shared database produce Postgres
 * deadlocks (40P01) and FK violations against rows another file just
 * truncated.
 *
 * This is a Vitest `setupFile`, so it runs once per test file regardless of
 * whether Vitest reuses the underlying worker process (`setupFiles` are
 * re-executed per file — that's their contract, unlike `globalSetup`). Each
 * run creates a fresh, privately-migrated database and points
 * `process.env.DATABASE_URL` at it before the test file's own top-level code
 * (e.g. `testDb()`, `bootTestServer()`) executes, so every file gets a
 * genuinely isolated Postgres database without needing to know isolation
 * exists.
 */

const MIGRATIONS_FOLDER = new URL("../../drizzle", import.meta.url).pathname;

const originalDatabaseUrl = process.env.DATABASE_URL;
if (!originalDatabaseUrl) {
  throw new Error("DATABASE_URL must be set before running tests (see .env.example)");
}

// Self-generated hex suffix — never external input — so direct interpolation
// into DDL (which can't parameterize identifiers) is safe.
const dbName = `gl3_test_${randomBytes(8).toString("hex")}`;

const isolatedUrl = new URL(originalDatabaseUrl);
isolatedUrl.pathname = `/${dbName}`;

async function createIsolatedDatabase(): Promise<void> {
  const admin = postgres(originalDatabaseUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

async function dropIsolatedDatabase(): Promise<void> {
  const admin = postgres(originalDatabaseUrl, { max: 1 });
  try {
    // Force-disconnect this file's own pool. afterAll hooks run in
    // registration order, and this setup file's afterAll is registered
    // before the test file's own (which closes its pool) — so this file's
    // connections may still be open here. Terminating them first makes
    // cleanup order-independent instead of racing DROP DATABASE against
    // "database is being accessed by other users".
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
}

await createIsolatedDatabase();

// Every helper that reads DATABASE_URL from process.env (testDb,
// bootTestServer via loadConfig) now resolves to this file's private
// database — no call site needs to change.
process.env.DATABASE_URL = isolatedUrl.toString();

const migrator = postgres(isolatedUrl.toString(), { max: 1 });
try {
  await migrate(drizzle(migrator), { migrationsFolder: MIGRATIONS_FOLDER });
} finally {
  await migrator.end();
}

afterAll(async () => {
  await dropIsolatedDatabase();
});
