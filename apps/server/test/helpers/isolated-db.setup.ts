import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll } from "vitest";
import { templateDatabaseName, withDatabaseName } from "./template-db.js";

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
 * run clones a fresh, private database from the pre-migrated template that
 * global-setup.ts built once for the whole run, and points
 * `process.env.DATABASE_URL` at it before the test file's own top-level code
 * (e.g. `testDb()`, `bootTestServer()`) executes, so every file gets a
 * genuinely isolated Postgres database without needing to know isolation
 * exists.
 *
 * Cloning (`CREATE DATABASE ... TEMPLATE`) is a Postgres file-level copy, not
 * a migration replay, so per-file setup cost no longer scales with the
 * number of migrations — only global-setup.ts pays that cost, once per run.
 */

const originalDatabaseUrl = process.env.DATABASE_URL;
if (!originalDatabaseUrl) {
  throw new Error("DATABASE_URL must be set before running tests (see .env.example)");
}

const templateName = templateDatabaseName();

// Self-generated hex suffix — never external input — so direct interpolation
// into DDL (which can't parameterize identifiers) is safe.
const dbName = `gl3_test_${randomBytes(8).toString("hex")}`;

const isolatedUrl = withDatabaseName(originalDatabaseUrl, dbName);

async function createIsolatedDatabase(): Promise<void> {
  const admin = postgres(originalDatabaseUrl, { max: 1 });
  try {
    // STRATEGY = WAL_LOG (PG15+) matters as much as the template itself:
    // the default FILE_COPY strategy forces a checkpoint before and after
    // every CREATE DATABASE, which serializes concurrent clones against
    // each other cluster-wide — measured at ~10s wall time for 14
    // concurrent FILE_COPY clones on this box vs. ~0.3s for the same 14
    // under WAL_LOG. Without this, the suite would still blow past
    // hookTimeout as more files run in parallel, even with the template.
    await admin.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${templateName}" STRATEGY = WAL_LOG`);
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
    // connections may still be open here, and a plain DROP would lose the
    // race with "database is being accessed by other users".
    //
    // WITH (FORCE) rather than a hand-rolled pg_terminate_backend sweep over
    // pg_stat_activity. The sweep terminated every pid reported against this
    // database, and the test role is neither superuser nor a member of
    // pg_signal_backend — so any row it matched that it did not own failed
    // the whole statement with 42501 "permission denied to terminate
    // process", taking teardown with it and failing the file at suite level
    // for a reason nothing in the test touched. Postgres does this itself
    // with the right privileges: FORCE needs only database ownership, which
    // this role has by having created the clone.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

await createIsolatedDatabase();

// Every helper that reads DATABASE_URL from process.env (testDb,
// bootTestServer via loadConfig) now resolves to this file's private
// database — no call site needs to change. It's already fully migrated:
// TEMPLATE cloning copies the template's schema (and data — but the
// template only ever has the migrator's own bookkeeping rows) file-for-file,
// so there is nothing left to migrate here.
process.env.DATABASE_URL = isolatedUrl;

afterAll(async () => {
  await dropIsolatedDatabase();
});
