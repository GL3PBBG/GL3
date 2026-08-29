/**
 * The estate catalog. Plugin-owned `p_*` (the `p_membership_packages`
 * pattern): PK only, no FK — an FK is a lock (NOTES.md rule 6) and a
 * content row needs none. One statement per migration (bounties' rule).
 * The seed mirrors MCCodes' single shipped house (`dbdata.sql:572`):
 * Default House, free, will 100 — every player's implicit starting home.
 */
export const HOUSES_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_houses",
    sql: `CREATE TABLE p_houses (
      id    uuid    PRIMARY KEY,
      name  text    NOT NULL,
      price bigint  NOT NULL,
      will  integer NOT NULL
    )`,
  },
  {
    name: "0002_default_house",
    sql: `INSERT INTO p_houses (id, name, price, will)
      VALUES (gen_random_uuid(), 'Default House', 0, 100)`,
  },
  {
    // `p_houses` predates the migration runner's prefix guard; the convention
    // is `p_<id>_*` (p_bounties_bounties precedent). History above keeps the
    // old name — migrations are append-only — and the guard checks only the
    // final state.
    name: "0003_prefix_rename",
    sql: `ALTER TABLE p_houses RENAME TO p_houses_houses`,
  },
];
