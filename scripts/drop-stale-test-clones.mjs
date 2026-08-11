/**
 * Drops leftover per-file test clones (`gl3_test_*`) and is safe to run at any
 * time: it skips any database that still has connections.
 *
 * Why this is a manual script and not part of `globalSetup`:
 * clone names are random hex with no run marker (isolated-db.setup.ts:38), so
 * an automatic sweep can only tell an orphan from a live clone by looking for
 * connections — and there is a window between `CREATE DATABASE` and the test
 * file's first connect where a fresh clone looks exactly like an orphan. Two
 * projects (`@gl3/server:db-only` and `@gl3/server`) each run globalSetup, so
 * one project's sweep can overlap another's file startup. Reaping
 * automatically would trade a disk leak for an intermittent
 * "database does not exist", and flaky is worse than leaky here.
 *
 * Clones leak when teardown cannot drop them — `DROP DATABASE ... WITH (FORCE)`
 * terminates other backends, and the `gl3` role is neither superuser nor a
 * member of `pg_signal_backend`, so a backend it cannot signal raises 42501.
 * Teardown treats that as non-fatal (the tests have already passed by then)
 * and leaves the clone here.
 *
 *   node scripts/drop-stale-test-clones.mjs
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set (see .env.example)");
  process.exit(1);
}

const admin = postgres(url, { max: 1 });
let dropped = 0;
let skipped = 0;
try {
  const rows = await admin`
    SELECT datname FROM pg_database d WHERE datname LIKE 'gl3\_test\_%'
  `;
  for (const { datname } of rows) {
    const active = await admin`SELECT 1 FROM pg_stat_activity WHERE datname = ${datname}`;
    if (active.length > 0) {
      console.warn(`skipping "${datname}": still has connections`);
      skipped += 1;
      continue;
    }
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`);
      dropped += 1;
    } catch (err) {
      console.warn(`failed to drop "${datname}":`, err);
      skipped += 1;
    }
  }
} finally {
  await admin.end();
}
console.log(`dropped ${dropped} stale clone(s), skipped ${skipped}`);
