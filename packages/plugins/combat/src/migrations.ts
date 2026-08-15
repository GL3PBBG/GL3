/**
 * `p_combat_log` was core-owned until now: it shipped in core migration
 * `0005_combat_log`, written during the PvP work before any plugin owned a
 * table at all (`inventory` was the first, and it came later). Nothing outside
 * this plugin ever read or wrote it, so core relinquished it in
 * `0007_relinquish_plugin_tables` and it is created here instead.
 *
 * One statement per migration — see `packages/plugins/bounties/src/migrations.ts`
 * for why. Both indexes are therefore separate declarations.
 *
 * The foreign keys are carried over deliberately; see bounties' migrations for
 * the reasoning. What matters more here is what is still ABSENT: there is no
 * `location_id` column and no `locations` FK, for exactly the reason
 * `social.ts` recorded before the move — these FKs are taken while the
 * transaction holds two `player_stats` rows FOR UPDATE, so a `locations` FK
 * would take FOR KEY SHARE on a location row at that point, giving
 * player-then-location and closing an ABBA cycle against the location-first
 * order `travel` and `bullets` follow (NOTES.md rule 6). Pinned by
 * `combat-log-schema.test.ts`.
 */
export const COMBAT_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_combat_log",
    sql: `CREATE TABLE p_combat_log (
      id             uuid        PRIMARY KEY,
      attacker_id    uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      target_id      uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      hit            boolean     NOT NULL,
      damage         integer     NOT NULL DEFAULT 0,
      fatal          boolean     NOT NULL DEFAULT false,
      weapon_item_id uuid        REFERENCES items(id) ON DELETE SET NULL,
      payout         bigint      NOT NULL DEFAULT 0,
      created_at     timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    // Was `combat_log_target_idx`. Backs "who shot at me", the log route's
    // default read.
    name: "0002_target_idx",
    sql: `CREATE INDEX p_combat_log_target_idx ON p_combat_log (target_id, created_at)`,
  },
  {
    // Was `combat_log_attacker_idx`. Backs "who I shot at".
    name: "0003_attacker_idx",
    sql: `CREATE INDEX p_combat_log_attacker_idx ON p_combat_log (attacker_id, created_at)`,
  },
  {
    /**
     * No foreign keys, and that is the design. See the file header on
     * `p_combat_log`: these rows are written while two `player_stats` rows
     * are held FOR UPDATE, so an FK would take FOR KEY SHARE on its referent
     * right there. A `players` FK would be player-then-player, which
     * `tx.locks.player` already orders safely, but an `items` FK would open
     * a player-then-item edge that exists nowhere else. Declaring neither
     * leaves NOTES.md rule 6's lock graph exactly as it was — the same
     * choice `p_inventory_shop_stock` made.
     *
     * A row whose player or item has since been deleted is harmless: it is
     * only ever read by full primary key, from a path that has already
     * loaded both, and is never joined back.
     *
     * No index beyond the primary key: every read is by full key.
     */
    name: "0004_weapon_condition",
    sql: `CREATE TABLE p_combat_weapon_condition (
      player_id  uuid        NOT NULL,
      item_id    uuid        NOT NULL,
      condition  integer     NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (player_id, item_id)
    )`,
  },
];
