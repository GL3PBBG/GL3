/**
 * `p_bounties_bounties` was core-owned until now: it shipped in core migration
 * `0000_core_schema` because the core schema was written before plugins
 * existed, not because core ever touched it. Nothing outside this plugin ever
 * read or wrote it, so core relinquished it in `0007_relinquish_plugin_tables`
 * and it is created here instead.
 *
 * One statement per migration, not one file: `runPluginMigrations` issues
 * exactly one `tx.execute(sql.raw(migration.sql))` per declared migration, and
 * postgres.js rejects a multi-statement string through `unsafe()` unless
 * `.simple()` is used — the same constraint inventory's SHOP_MIGRATIONS
 * documents. Hence the index is its own migration.
 *
 * The foreign keys are carried over deliberately, unlike `p_inventory_shop_stock`
 * and `p_oc_*`, which have none. Those two are new tables that chose to add no
 * lock edges (CLAUDE.md rule 6); this one is an existing table being moved, and
 * dropping its FKs would both change behaviour (a deleted player would leave
 * orphan bounty rows, and nothing cleans those up) and change the lock graph.
 * Keeping them makes the move a pure rename of ownership: the edges into
 * `players` are exactly the ones `bounties-lock-order.test.ts` already pins.
 */
export const BOUNTIES_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_bounties",
    sql: `CREATE TABLE p_bounties_bounties (
      id         uuid        PRIMARY KEY,
      placed_by  uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      target     uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      amount     bigint      NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      claimed_by uuid        REFERENCES players(id) ON DELETE SET NULL
    )`,
  },
  {
    // Was `bounties_target_idx`. The claim sweep looks up every open bounty on
    // one victim on every fatal shot, which is the only read this backs.
    name: "0002_target_idx",
    sql: `CREATE INDEX p_bounties_target_idx ON p_bounties_bounties (target)`,
  },
];
