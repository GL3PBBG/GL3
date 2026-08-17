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
  {
    // V2 has no unique constraint at all; its logical key is
    // (PR_location, PR_module). GL3's original unique(location_id) was a GL3
    // invention and it is what stops a town having both a casino and a bullet
    // factory. The old constraint was strictly stronger, so no existing row
    // can violate the new one.
    name: "0003_drop_location_unique",
    sql: `DROP INDEX IF EXISTS p_properties_location_key`,
  },
  {
    name: "0004_location_plugin_unique",
    sql: `CREATE UNIQUE INDEX p_properties_location_plugin_key
            ON p_properties_properties (location_id, plugin_id)`,
  },
  {
    // Income is no longer a clock: a property earns what its consumer plugin
    // pays it. Nothing reads these two columns after this migration.
    name: "0005_drop_rate",
    sql: `ALTER TABLE p_properties_properties DROP COLUMN rate`,
  },
  {
    name: "0006_drop_last_claimed_at",
    sql: `ALTER TABLE p_properties_properties DROP COLUMN last_claimed_at`,
  },
  {
    // `cost` changes meaning from purchase price to the owner-set lever the
    // consumer reads (V2's PR_cost). Existing values are purchase prices and
    // would be nonsense as levers, so they are zeroed — and 0 is exactly what
    // V2's transfer() writes on handover, meaning "owner has set no lever".
    name: "0007_cost_becomes_lever",
    sql: `UPDATE p_properties_properties SET cost = 0`,
  },
];
