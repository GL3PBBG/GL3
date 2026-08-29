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
  // `p_courses`/`p_courses_done` predate the migration runner's prefix guard;
  // the convention is `p_<id>_*`. History above keeps the old names —
  // migrations are append-only — and the guard checks only the final state.
  {
    name: "0004_prefix_rename_courses",
    sql: `ALTER TABLE p_courses RENAME TO p_education_courses`,
  },
  {
    name: "0005_prefix_rename_done",
    sql: `ALTER TABLE p_courses_done RENAME TO p_education_courses_done`,
  },
];
