export const OC_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_heists",
    sql: `CREATE TABLE p_oc_heists (
      id          uuid        PRIMARY KEY,
      leader_id   uuid        NOT NULL,
      location_id uuid        NOT NULL,
      status      text        NOT NULL,
      buy_in      bigint      NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      executed_at timestamptz
    )`,
  },
  {
    name: "0002_members",
    sql: `CREATE TABLE p_oc_members (
      heist_id  uuid    NOT NULL,
      player_id uuid    NOT NULL,
      role      text    NOT NULL,
      state     text    NOT NULL,
      released  boolean NOT NULL DEFAULT false,
      PRIMARY KEY (heist_id, player_id)
    )`,
  },
  {
    // One active heist per player is a DB constraint, not a check-then-act
    // (spec §2). Binds on ACCEPTED rows only — multiple pending invites are
    // fine. The accept/create routes catch 23505 on THIS constraint name.
    name: "0003_active_member_idx",
    sql: `CREATE UNIQUE INDEX p_oc_members_active_player
      ON p_oc_members (player_id)
      WHERE NOT released AND state = 'accepted'`,
  },
];
