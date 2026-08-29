import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "../config.js";
import { createDb } from "./client.js";

const config = loadConfig(process.env);
const { db, sql } = createDb(config.databaseUrl);

// Guard against the half-reset database. Drizzle's tracking table lives in
// the `drizzle` SCHEMA, not `public`, so a "fresh start" that only cleared
// public (DROP SCHEMA public CASCADE, a table-dropping script, a restore)
// leaves drizzle.__drizzle_migrations behind. The migrator then believes
// everything up to the last recorded entry is applied, skips straight to the
// newest migration, and dies on the first ALTER of a table that no longer
// exists — a cryptic 42P01 deep inside a migration that is not at fault.
// Detect that state up front and name the remedy instead.
const [tracking] = await sql`
  SELECT count(*)::int AS n FROM pg_tables
  WHERE schemaname = 'drizzle' AND tablename = '__drizzle_migrations'
`;
if ((tracking?.n ?? 0) > 0) {
  const [applied] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  const [core] = await sql`
    SELECT count(*)::int AS n FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'players'
  `;
  if ((applied?.n ?? 0) > 0 && (core?.n ?? 0) === 0) {
    console.error(
      "refusing to migrate: drizzle.__drizzle_migrations records " +
        `${applied?.n} applied migration(s), but the core schema is gone ` +
        "(public.players does not exist). This database was reset without " +
        "dropping the drizzle schema, so the migrator would skip the " +
        "migrations that create the schema. For a truly fresh start drop " +
        "BOTH schemas (or the whole database/volume): " +
        'DROP SCHEMA public CASCADE; DROP SCHEMA drizzle CASCADE; CREATE SCHEMA public;',
    );
    await sql.end();
    process.exit(1);
  }
}

await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
await sql.end();
