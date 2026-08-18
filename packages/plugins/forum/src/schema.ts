import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * `players` and `role_module_access` are read/write mirrors of core-owned
 * tables — the pattern `packages/plugins/bounties/src/schema.ts` documents,
 * and the same pair `packages/plugins/news/src/schema.ts` already mirrors
 * for this exact purpose (moderation's ABAC check, `loadGrants`' own query
 * restated here since a plugin cannot import `apps/server` code). Core owns
 * and migrates both; only the touched columns are listed.
 *
 * The three `p_forum_*` tables are NOT mirrors: this plugin owns and
 * migrates them (`migrations.ts`). Unlike `p_bounties_bounties`, they were
 * never core-owned — forum is new, not relinquished.
 */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
  roleId: uuid("role_id"),
});

export const roleModuleAccess = pgTable("role_module_access", {
  roleId: uuid("role_id").notNull(),
  moduleKey: text("module_key").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.roleId, t.moduleKey] }) }));

export const forums = pgTable("p_forum_forums", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
});

export const topics = pgTable("p_forum_topics", {
  id: uuid("id").primaryKey(),
  forumId: uuid("forum_id").notNull(),
  authorId: uuid("author_id"),
  subject: text("subject").notNull(),
  status: text("status").notNull().default("open"),
  type: text("type").notNull().default("normal"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastPostAt: timestamp("last_post_at", { withTimezone: true }).notNull().defaultNow(),
  postCount: integer("post_count").notNull().default(0),
});

export const posts = pgTable("p_forum_posts", {
  id: uuid("id").primaryKey(),
  topicId: uuid("topic_id").notNull(),
  authorId: uuid("author_id"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
