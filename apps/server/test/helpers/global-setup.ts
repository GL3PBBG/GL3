import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { MIGRATIONS_FOLDER, templateDatabaseName, withDatabaseName } from "./template-db.js";

/**
 * Vitest `globalSetup` (unlike the `setupFiles` in isolated-db.setup.ts)
 * runs exactly once per project per run, in the main process, before any
 * test file starts. That single-execution guarantee is what makes building
 * the shared template database here safe from the sixteen-plus-file
 * "check then create" race the team explicitly wants to avoid a third
 * instance of: no test file's setup runs until this has already returned,
 * so there is nothing for them to race against.
 *
 * The advisory lock below is a second, independent line of defence for the
 * one scenario `globalSetup`'s guarantee doesn't cover: two separate
 * `vitest` invocations (e.g. two CI jobs, or a watch-mode restart racing a
 * fresh run) hitting the same Postgres instance at once. Without it, two
 * concurrent builders could both pass the "does it exist" check before
 * either has created it, and the second `CREATE DATABASE` would fail.
 *
 * Migrating into a real (non-template) database first and only flipping
 * IS_TEMPLATE at the end means a process that crashes mid-migration leaves
 * an ordinary, non-template, half-migrated database behind — never a
 * template that later `CREATE DATABASE ... TEMPLATE` calls could clone
 * from a schema-incomplete disk copy.
 */
export default async function setup(): Promise<void> {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  if (!originalDatabaseUrl) {
    throw new Error("DATABASE_URL must be set before running tests (see .env.example)");
  }

  const templateName = templateDatabaseName();
  const admin = postgres(originalDatabaseUrl, { max: 1 });
  try {
    await withAdvisoryLock(admin, async () => {
      await dropStaleTemplates(admin, templateName);

      const existing = await admin`SELECT 1 FROM pg_database WHERE datname = ${templateName}`;
      if (existing.length > 0) return;

      await admin.unsafe(`CREATE DATABASE "${templateName}"`);

      const migrator = postgres(withDatabaseName(originalDatabaseUrl, templateName), { max: 1 });
      try {
        await migrate(drizzle(migrator), { migrationsFolder: MIGRATIONS_FOLDER });
      } finally {
        // CREATE DATABASE ... TEMPLATE fails while any session — including
        // this one — is connected to the source database, so this pool
        // must be fully closed before any test file can clone it.
        await migrator.end();
      }

      // `gl3` owns whatever it creates, so it could clone this database
      // even without IS_TEMPLATE (Postgres lets a database's owner use it
      // as a template regardless of the flag). Setting it anyway makes the
      // intent explicit and matches the pg_database convention for
      // template databases.
      await admin.unsafe(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE true`);
    });
  } finally {
    // Nothing may hold a connection to the template once test files start
    // cloning it — this admin connection talks to the maintenance database
    // (originalDatabaseUrl), never the template itself, but it still must
    // not outlive globalSetup.
    await admin.end();
  }
}

async function withAdvisoryLock(admin: postgres.Sql, fn: () => Promise<void>): Promise<void> {
  // A fixed lock key (not one derived from templateName) is intentional:
  // it serializes *all* template-build attempts against each other,
  // including a build racing a concurrent stale-template cleanup, not just
  // two attempts to build the same hash.
  await admin`SELECT pg_advisory_lock(hashtext('gl3_test_template_build'))`;
  try {
    await fn();
  } finally {
    await admin`SELECT pg_advisory_unlock(hashtext('gl3_test_template_build'))`;
  }
}

/**
 * Removes templates left behind by earlier migration sets. Every previous
 * hash is dead weight (no test file addresses it anymore, since both
 * sides of every clone derive the same name from the same content), so
 * this keeps the `gl3_tmpl_*` namespace from growing without bound as
 * migrations evolve across M2–M5. Queries by name prefix rather than
 * `datistemplate = true` so it also catches a database that crashed
 * between `CREATE DATABASE` and the `ALTER DATABASE ... IS_TEMPLATE true`
 * that marks it — those are stale too, just not yet flagged as templates.
 * Best-effort: a database that still has connections is left for a later
 * run rather than force-terminated, since an active connection means
 * something else may genuinely still be using it (e.g. a concurrent
 * `vitest` run mid-clone).
 */
async function dropStaleTemplates(admin: postgres.Sql, currentTemplateName: string): Promise<void> {
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE 'gl3\_tmpl\_%'
  `;
  for (const { datname } of rows) {
    if (datname === currentTemplateName) continue;
    try {
      const activity = await admin`
        SELECT 1 FROM pg_stat_activity WHERE datname = ${datname}
      `;
      if (activity.length > 0) {
        console.warn(`[global-setup] skipping stale template "${datname}": still has connections`);
        continue;
      }
      await admin.unsafe(`ALTER DATABASE "${datname}" WITH IS_TEMPLATE false`);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`);
    } catch (err) {
      console.warn(`[global-setup] failed to drop stale template "${datname}":`, err);
    }
  }
}
