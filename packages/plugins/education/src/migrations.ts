/**
 * Plugin-owned `p_*` tables (the membership pattern): PK only, no FKs — an
 * FK is a lock (NOTES.md rule 6) and none of these needs one. One
 * statement per migration (bounties' rule). Courses ship EMPTY, exactly
 * like MCCodes' seed — they are admin content, never engine data.
 */
export const EDUCATION_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_courses",
    sql: `CREATE TABLE p_courses (
      id          uuid    PRIMARY KEY,
      name        text    NOT NULL,
      description text    NOT NULL,
      cost        bigint  NOT NULL,
      days        integer NOT NULL,
      strength_gain integer NOT NULL,
      agility_gain  integer NOT NULL,
      guard_gain    integer NOT NULL,
      labour_gain   integer NOT NULL,
      iq_gain       integer NOT NULL
    )`,
  },
  {
    name: "0002_progress",
    sql: `CREATE TABLE p_education_progress (
      player_id  uuid        PRIMARY KEY,
      course_id  uuid        NOT NULL,
      started_at timestamptz NOT NULL
    )`,
  },
  {
    name: "0003_done",
    sql: `CREATE TABLE p_courses_done (
      player_id uuid,
      course_id uuid,
      PRIMARY KEY (player_id, course_id)
    )`,
  },
];
