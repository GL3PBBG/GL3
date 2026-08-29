/**
 * Plugin-owned `p_*` tables: PK only, no FKs, one statement per migration.
 * Jobs and ranks ship EMPTY — admin content, exactly like MCCodes' seed
 * (the audit's §1.2: "there is no exact list to replicate").
 */
export const JOBS_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_jobs",
    sql: `CREATE TABLE p_jobs (
      id            uuid PRIMARY KEY,
      name          text NOT NULL,
      description   text NOT NULL,
      first_rank_id uuid NOT NULL
    )`,
  },
  {
    name: "0002_ranks",
    sql: `CREATE TABLE p_job_ranks (
      id            uuid   PRIMARY KEY,
      job_id        uuid   NOT NULL,
      name          text   NOT NULL,
      pay           bigint NOT NULL,
      strength_gain integer NOT NULL,
      labour_gain   integer NOT NULL,
      iq_gain       integer NOT NULL,
      strength_req  integer NOT NULL,
      labour_req    integer NOT NULL,
      iq_req        integer NOT NULL
    )`,
  },
  {
    name: "0003_employment",
    sql: `CREATE TABLE p_player_jobs (
      player_id    uuid        PRIMARY KEY,
      rank_id      uuid        NOT NULL,
      last_wage_at timestamptz NOT NULL
    )`,
  },
  // `p_jobs`/`p_job_ranks`/`p_player_jobs` predate the migration runner's
  // prefix guard; the convention is `p_<id>_*`. History above keeps the old
  // names — migrations are append-only — and the guard checks only the final
  // state.
  {
    name: "0004_prefix_rename_jobs",
    sql: `ALTER TABLE p_jobs RENAME TO p_jobs_jobs`,
  },
  {
    name: "0005_prefix_rename_ranks",
    sql: `ALTER TABLE p_job_ranks RENAME TO p_jobs_ranks`,
  },
  {
    name: "0006_prefix_rename_players",
    sql: `ALTER TABLE p_player_jobs RENAME TO p_jobs_players`,
  },
];
