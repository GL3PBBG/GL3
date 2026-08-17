/**
 * One migration per entry: `runPluginMigrations` issues exactly one
 * `tx.execute(sql.raw(...))` per declaration and postgres.js rejects a
 * multi-statement string, so the partial index is its own entry.
 *
 * The two foreign keys are deliberate and are what rule 6's lock graph is
 * reasoned about (spec §5): inserting a session takes FOR KEY SHARE on the
 * player and location rows, which this transaction already holds FOR UPDATE.
 */
export const CASINO_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_sessions",
    sql: `CREATE TABLE p_casino_sessions (
      id           uuid PRIMARY KEY,
      player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      game_id      text NOT NULL,
      location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      property_id  uuid,
      wager        bigint NOT NULL DEFAULT 0,
      state        jsonb NOT NULL,
      status       text NOT NULL,
      seed         text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      settled_at   timestamptz
    )`,
  },
  {
    // One open hand per player across ALL games — OC's one-active-heist shape.
    // It is what makes the escrow accounting single-threaded per player.
    name: "0002_one_open_session",
    sql: `CREATE UNIQUE INDEX p_casino_sessions_one_open
            ON p_casino_sessions (player_id) WHERE status = 'open'`,
  },
];
