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
];
