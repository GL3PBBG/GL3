/**
 * `p_detectives_searches` was core-owned until now: it shipped in core
 * migration `0000_core_schema` because the core schema was written before
 * plugins existed, not because core ever touched it. Nothing outside this
 * plugin ever read or wrote it, so core relinquished it in
 * `0007_relinquish_plugin_tables` and it is created here instead.
 *
 * One statement per migration — see `packages/plugins/bounties/src/migrations.ts`
 * for why. This table carried no indexes beyond its primary key in core, so
 * there is only the one.
 *
 * The foreign keys are carried over deliberately; the reasoning is the same as
 * bounties'. Both point at `players`, the same edge the searches already took.
 */
export const DETECTIVES_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_searches",
    sql: `CREATE TABLE p_detectives_searches (
      id               uuid        PRIMARY KEY,
      player_id        uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      target_player_id uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      detectives       integer     NOT NULL DEFAULT 1,
      started_at       timestamptz NOT NULL DEFAULT now(),
      ends_at          timestamptz NOT NULL,
      succeeded        boolean
    )`,
  },
  {
    name: "0002_report_expiry",
    sql: `ALTER TABLE p_detectives_searches ADD COLUMN expires_at timestamptz`,
  },
];
