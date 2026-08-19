/**
 * `forum` is the 19th plugin and the 9th to own tables. Nothing here was ever
 * core-owned — unlike `p_bounties_bounties`/`p_detectives_searches`/
 * `p_combat_log`, forum content is new, so there is no relinquish migration
 * to reference.
 *
 * One statement per migration, not one file: `runPluginMigrations` issues
 * exactly one `tx.execute(sql.raw(migration.sql))` per declared migration,
 * and postgres.js rejects a multi-statement string through `unsafe()` unless
 * `.simple()` is used (the constraint bounties' migrations.ts documents).
 * Hence each index is its own migration.
 *
 * Rule-6 audit (NOTES.md): inserting a topic takes FOR KEY SHARE on
 * `p_forum_forums` (the `forum_id` FK) and, when `author_id` is set, on
 * `players`; inserting a post takes FOR KEY SHARE on `p_forum_topics` and,
 * when `author_id` is set, on `players`. No forum route takes an explicit
 * lock — there is no money movement here, only plain `UPDATE ... SET
 * post_count = post_count + 1` / `last_post_at = now()` self-serializing
 * counter writes — so there is no ordering to invert, and deliberately no
 * lock-order test.
 */
export const FORUM_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_forums",
    sql: `CREATE TABLE p_forum_forums (
      id   uuid PRIMARY KEY,
      name text NOT NULL,
      sort integer NOT NULL DEFAULT 0
    )`,
  },
  {
    name: "0002_topics",
    sql: `CREATE TABLE p_forum_topics (
      id           uuid PRIMARY KEY,
      forum_id     uuid NOT NULL REFERENCES p_forum_forums(id) ON DELETE CASCADE,
      author_id    uuid REFERENCES players(id) ON DELETE SET NULL,
      subject      text NOT NULL,
      status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked')),
      type         text NOT NULL DEFAULT 'normal' CHECK (type IN ('normal', 'sticky')),
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_post_at timestamptz NOT NULL DEFAULT now(),
      post_count   integer NOT NULL DEFAULT 0
    )`,
  },
  {
    name: "0003_topics_listing_idx",
    sql: `CREATE INDEX p_forum_topics_listing_idx ON p_forum_topics (forum_id, type, last_post_at DESC)`,
  },
  {
    name: "0004_posts",
    sql: `CREATE TABLE p_forum_posts (
      id         uuid PRIMARY KEY,
      topic_id   uuid NOT NULL REFERENCES p_forum_topics(id) ON DELETE CASCADE,
      author_id  uuid REFERENCES players(id) ON DELETE SET NULL,
      body       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: "0005_posts_topic_idx",
    sql: `CREATE INDEX p_forum_posts_topic_idx ON p_forum_posts (topic_id, created_at)`,
  },
];
