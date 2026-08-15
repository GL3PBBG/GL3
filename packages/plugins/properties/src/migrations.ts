/**
 * Two migrations: `runPluginMigrations` issues exactly one
 * `tx.execute(sql.raw(migration.sql))` per declaration, and postgres.js
 * rejects a multi-statement string through `unsafe()` unless `.simple()` is
 * used. So the index is its own entry.
 *
 * The foreign keys came ACROSS from the design verbatim, exactly as
 * `p_bounties_bounties` and `p_detectives_searches` kept theirs. Dropping
 * one to dodge a lock edge would change behaviour AND change the lock graph
 * the design doc reasons about; keeping them leaves the graph exactly as it
 * was.
 *
 * A unique INDEX, not an inline table constraint: the plugin migration runner
 * executes raw SQL and `CREATE UNIQUE INDEX` gives the same one-row-per-location
 * guarantee without depending on drizzle-kit's constraint naming.
 */
export const PROPERTIES_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_properties",
    sql: `CREATE TABLE p_properties_properties (
      id               uuid PRIMARY KEY,
      location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      plugin_id        text NOT NULL,
      owner_player_id  uuid REFERENCES players(id) ON DELETE SET NULL,
      cost             bigint NOT NULL DEFAULT 0,
      profit           bigint NOT NULL DEFAULT 0,
      last_claimed_at  timestamptz,
      rate             bigint NOT NULL DEFAULT 0
    )`,
  },
  {
    name: "0002_location_unique",
    sql: `CREATE UNIQUE INDEX p_properties_location_key ON p_properties_properties (location_id)`,
  },
];
