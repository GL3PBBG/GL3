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
  {
    // The shared table a multi-seat hand lives at. `property_id` has NO FK
    // (frozen house, pins the row not the person — the sessions precedent).
    // `state` is NULLABLE, unlike sessions: between hands there is no game
    // state at all. `turn_seat` is hub-owned: `state` is opaque jsonb, so
    // without it the hub could not answer 409 not_your_turn.
    name: "0003_tables",
    sql: `CREATE TABLE p_casino_tables (
      id           uuid PRIMARY KEY,
      game_id      text NOT NULL,
      location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      property_id  uuid,
      phase        text NOT NULL DEFAULT 'betting',
      turn_seat    smallint,
      deadline_at  timestamptz,
      hand_no      integer NOT NULL DEFAULT 0,
      state        jsonb,
      seed         text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    // A player's chair. `wager > 0` means "in the current hand"; it is reset
    // to 0 at settle. Both FKs cascade; both rows are already held FOR UPDATE
    // by every inserting transaction (rule 6 — see the lock order in
    // table-routes.ts), so the FOR KEY SHARE they take conflicts with nothing
    // new. seat_no's CHECK is the hard five-seat ceiling.
    name: "0004_seats",
    sql: `CREATE TABLE p_casino_seats (
      id           uuid PRIMARY KEY,
      table_id     uuid NOT NULL REFERENCES p_casino_tables(id) ON DELETE CASCADE,
      player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      seat_no      smallint NOT NULL CHECK (seat_no BETWEEN 0 AND 4),
      wager        bigint NOT NULL DEFAULT 0,
      leaving      boolean NOT NULL DEFAULT false,
      idle_hands   integer NOT NULL DEFAULT 0,
      joined_at    timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: "0005_seat_no_unique",
    sql: `CREATE UNIQUE INDEX p_casino_seats_table_seat ON p_casino_seats (table_id, seat_no)`,
  },
  {
    // One seat per player game-wide — the table-flow sibling of
    // p_casino_sessions_one_open. Plain unique (seat rows are deleted, not
    // status-flagged), so no WHERE clause.
    name: "0006_one_seat_per_player",
    sql: `CREATE UNIQUE INDEX p_casino_seats_one_seat ON p_casino_seats (player_id)`,
  },
];
