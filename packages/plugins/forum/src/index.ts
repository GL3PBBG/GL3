import { count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { definePlugin, PluginError, route, type PluginTx } from "@gl3/plugin-sdk";
import { FORUM_MIGRATIONS } from "./migrations.js";
import { forums, players, posts, topics } from "./schema.js";

/** 20/page, both tiers (topics and posts) — V2 parity, restated per spec. */
export const PAGE_SIZE = 20;

const ForumIdParamsSchema = z.object({ forumId: z.string().uuid() });
const TopicIdParamsSchema = z.object({ topicId: z.string().uuid() });
const PageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1) });

function pageCountOf(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

/** Batch-hydrates author usernames for a set of possibly-null author ids — the news' `inArray` pattern. */
async function hydrateAuthorNames(
  tx: PluginTx,
  authorIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(authorIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await tx.db
    .select({ id: players.id, username: players.username })
    .from(players)
    .where(inArray(players.id, ids));
  return new Map(rows.map((r) => [r.id, r.username]));
}

/** Forums with topic counts — one query, a LEFT JOIN + GROUP BY rather than N+1 per forum. */
const listForumsRoute = route({
  method: "GET",
  path: "/api/forum",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const rows = await tx.db
        .select({
          id: forums.id,
          name: forums.name,
          sort: forums.sort,
          topicCount: count(topics.id),
        })
        .from(forums)
        .leftJoin(topics, eq(topics.forumId, forums.id))
        .groupBy(forums.id)
        .orderBy(forums.sort);

      return {
        status: 200,
        body: {
          forums: rows.map((r) => ({
            id: r.id,
            name: r.name,
            sort: r.sort,
            topicCount: Number(r.topicCount),
          })),
        },
      };
    });
  },
});

/**
 * Topics in one forum, paginated 20/page, sticky first then most recently
 * posted-to — one indexed ORDER BY (the `(forum_id, type, last_post_at DESC)`
 * index this plugin's `0003_topics_listing_idx` migration adds), no N+1.
 */
const listTopicsRoute = route({
  method: "GET",
  path: "/api/forum/:forumId/topics",
  params: ForumIdParamsSchema,
  query: PageQuerySchema,
  handler: async (ctx, { params, query }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const [forum] = await tx.db.select().from(forums).where(eq(forums.id, params.forumId));
      if (forum === undefined) throw new PluginError("forum_not_found", 404);

      const [counted] = await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(topics)
        .where(eq(topics.forumId, params.forumId));
      const pageCount = pageCountOf(counted?.n ?? 0);

      const rows = await tx.db
        .select()
        .from(topics)
        .where(eq(topics.forumId, params.forumId))
        // sticky first, then recency — one indexed ORDER BY, no N+1
        .orderBy(sql`case when ${topics.type} = 'sticky' then 0 else 1 end`, desc(topics.lastPostAt))
        .limit(PAGE_SIZE)
        .offset((query.page - 1) * PAGE_SIZE);

      const nameById = await hydrateAuthorNames(tx, rows.map((r) => r.authorId));

      return {
        status: 200,
        body: {
          forumId: forum.id,
          forumName: forum.name,
          topics: rows.map((r) => ({
            id: r.id,
            subject: r.subject,
            authorId: r.authorId,
            authorName: r.authorId ? nameById.get(r.authorId) ?? null : null,
            status: r.status,
            type: r.type,
            createdAt: r.createdAt.toISOString(),
            lastPostAt: r.lastPostAt.toISOString(),
            postCount: r.postCount,
          })),
          page: query.page,
          pageCount,
        },
      };
    });
  },
});

/** Posts in one topic, paginated 20/page, oldest first — a thread reads top to bottom. */
const viewTopicRoute = route({
  method: "GET",
  path: "/api/forum/topics/:topicId",
  params: TopicIdParamsSchema,
  query: PageQuerySchema,
  handler: async (ctx, { params, query }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const [topic] = await tx.db.select().from(topics).where(eq(topics.id, params.topicId));
      if (topic === undefined) throw new PluginError("topic_not_found", 404);

      const [counted] = await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(posts)
        .where(eq(posts.topicId, params.topicId));
      const pageCount = pageCountOf(counted?.n ?? 0);

      const rows = await tx.db
        .select()
        .from(posts)
        .where(eq(posts.topicId, params.topicId))
        .orderBy(posts.createdAt)
        .limit(PAGE_SIZE)
        .offset((query.page - 1) * PAGE_SIZE);

      const nameById = await hydrateAuthorNames(tx, [topic.authorId, ...rows.map((r) => r.authorId)]);

      return {
        status: 200,
        body: {
          topic: {
            id: topic.id,
            subject: topic.subject,
            authorId: topic.authorId,
            authorName: topic.authorId ? nameById.get(topic.authorId) ?? null : null,
            status: topic.status,
            type: topic.type,
            createdAt: topic.createdAt.toISOString(),
            lastPostAt: topic.lastPostAt.toISOString(),
            postCount: topic.postCount,
          },
          posts: rows.map((r) => ({
            id: r.id,
            authorId: r.authorId,
            authorName: r.authorId ? nameById.get(r.authorId) ?? null : null,
            body: r.body,
            createdAt: r.createdAt.toISOString(),
          })),
          page: query.page,
          pageCount,
        },
      };
    });
  },
});

export default definePlugin({
  id: "forum",
  version: "1.0.0",
  basePaths: ["/api/forum", "/api/admin/forum"],
  migrations: FORUM_MIGRATIONS,
  routes: [listForumsRoute, listTopicsRoute, viewTopicRoute],
});
