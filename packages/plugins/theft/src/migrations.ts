/**
 * Four migrations, not one: `runPluginMigrations` issues exactly one
 * `tx.execute(sql.raw(migration.sql))` per declaration, and postgres.js
 * rejects a multi-statement string through `unsafe()` unless `.simple()` is
 * used. So the index is its own entry.
 *
 * The foreign keys came ACROSS from core's schema verbatim, exactly as
 * `p_bounties_bounties` and `p_detectives_searches` kept theirs. Dropping
 * one to dodge a lock edge would change behaviour AND change the lock graph
 * the design doc reasons about; keeping them leaves the graph exactly as it
 * was.
 *
 * Order matters: `p_theft_garage` references `p_theft_cars`, so the cars
 * table must be created first.
 */
export const THEFT_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_cars",
    sql: `CREATE TABLE p_theft_cars (
      id           uuid    PRIMARY KEY,
      name         text    NOT NULL,
      value        bigint  NOT NULL,
      theft_weight integer NOT NULL DEFAULT 1
    )`,
  },
  {
    name: "0002_tiers",
    sql: `CREATE TABLE p_theft_tiers (
      id             uuid    PRIMARY KEY,
      name           text    NOT NULL,
      success_chance integer NOT NULL,
      max_damage     integer NOT NULL,
      min_car_value  bigint  NOT NULL,
      max_car_value  bigint  NOT NULL
    )`,
  },
  {
    name: "0003_garage",
    sql: `CREATE TABLE p_theft_garage (
      id          uuid    PRIMARY KEY,
      player_id   uuid    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      car_id      uuid    NOT NULL REFERENCES p_theft_cars(id) ON DELETE CASCADE,
      damage      integer NOT NULL DEFAULT 0,
      location_id uuid    REFERENCES locations(id) ON DELETE SET NULL
    )`,
  },
  {
    name: "0004_garage_player_idx",
    sql: `CREATE INDEX p_theft_garage_player_idx ON p_theft_garage (player_id)`,
  },
];
