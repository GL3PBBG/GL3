import { count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  definePlugin, hasPermission, newId, PluginError, route,
  type PageSchema, type PluginTx,
} from "@gl3/plugin-sdk";
import { FORUM_MIGRATIONS } from "./migrations.js";
import { forums, players, posts, roleModuleAccess, topics } from "./schema.js";

/** 20/page, both tiers (topics and posts) — V2 parity, restated per spec. */
export const PAGE_SIZE = 20;

/** V2 cooldowns: 60s between topics, 15s between posts, per player. */
const TOPIC_COOLDOWN_SECONDS = 60;
const POST_COOLDOWN_SECONDS = 15;

/** The ABAC module key that gates moderation — same string the admin section's
 *  `auth: "admin"` loader tier checks (`hasPermission(grants, manifest.id)` in
 *  `apps/server/src/plugins/routes.ts`), so a role granted "forum" clears both. */
const MODULE_KEY = "forum";

const ForumIdParamsSchema = z.object({ forumId: z.string().uuid() });
const TopicIdParamsSchema = z.object({ topicId: z.string().uuid() });
const PostIdParamsSchema = z.object({ postId: z.string().uuid() });
const PageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1) });

const LockBodySchema = z.object({ locked: z.boolean() }).strict();
const TypeBodySchema = z.object({ type: z.enum(["normal", "sticky"]) }).strict();

const AdminCreateForumBodySchema = z.object({
  name: z.string().min(1).max(120),
  sort: z.number().int(),
}).strict();

const AdminUpdateForumBodySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  sort: z.number().int(),
}).strict();

/**
 * Module keys granted by the player's role — `loadGrants`
 * (`apps/server/src/plugins/routes.ts`) restated, since a plugin cannot
 * import `apps/server` code and reaches `role_module_access` only through
 * the mirrored schema `schema.ts` documents. `[]` when roleless, same as
 * the original.
 */
async function loadForumGrants(tx: PluginTx, playerId: string): Promise<string[]> {
  const rows = await tx.db
    .select({ moduleKey: roleModuleAccess.moduleKey })
    .from(players)
    .innerJoin(roleModuleAccess, eq(roleModuleAccess.roleId, players.roleId))
    .where(eq(players.id, playerId));
  return rows.map((r) => r.moduleKey);
}

/**
 * `@gl3/shared` is off-limits to a plugin package, so `noNulByte` and the
 * `CreateTopicRequestSchema`/`CreatePostRequestSchema` bounds are restated
 * here, matching `packages/shared/src/dto/forum.ts` exactly (the pattern
 * `packages/plugins/mail/src/index.ts:26` documents). The NUL guard is
 * load-bearing the same way: Postgres `text` rejects an embedded NUL
 * outright (SQLSTATE 22021).
 */
const noNulByte = <T extends z.ZodString>(schema: T): z.ZodEffects<T, string, string> =>
  schema.refine((value) => !value.includes("\u0000"), { message: "must not contain a NUL byte" });

const CreateTopicBodySchema = z.object({
  subject: noNulByte(z.string().min(6).max(120)),
  body: noNulByte(z.string().min(6).max(10_000)),
});

const CreatePostBodySchema = z.object({
  body: noNulByte(z.string().min(6).max(10_000)),
});

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
 * posted-to, no N+1. The `(forum_id, type, last_post_at DESC)` index this
 * plugin's `0003_topics_listing_idx` migration adds serves the `WHERE
 * forum_id = ?` filter, but not the ORDER BY: the `CASE WHEN type =
 * 'sticky' ...` expression below is what actually ranks sticky topics
 * first, and Postgres can't walk an index by an expression over one of its
 * columns — only by the column's own value — so the sort still costs a
 * pass over the matched rows. The index earns its keep on the filter and on
 * the `count(*)` just above; the ordering is a genuine sort.
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
        // sticky first, then recency. The CASE expression can't ride the
        // (forum_id, type, last_post_at) index — see the route doc above —
        // so this is a real sort, just over an already-filtered row set.
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

/**
 * Creates a topic and its opening post in ONE transaction — a topic with no
 * posts is not a state V2 ever produced. `post_count` starts at 1 and
 * `last_post_at` equals `created_at`, both set explicitly rather than left to
 * column defaults so the two rows agree even if the defaults ever drift.
 *
 * The cooldown is claimed BEFORE the transaction (CLAUDE.md rule 2 — the
 * `ctx.cooldown.acquire` outcome, an atomic Redis `SET NX EX` under the hood,
 * is the decision) and deliberately never released on a later 4xx: combat's
 * shot cooldown documents why (releasing would itself be a check-then-act,
 * and keeping it denies a free retry probe).
 */
const createTopicRoute = route({
  method: "POST",
  path: "/api/forum/:forumId/topics",
  params: ForumIdParamsSchema,
  body: CreateTopicBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const acquired = await ctx.cooldown.acquire("forum.topic", player.id, TOPIC_COOLDOWN_SECONDS);
    if (!acquired) {
      const retryAfter = await ctx.cooldown.peek("forum.topic", player.id);
      throw new PluginError("on_cooldown", 429, { retryAfter: Math.max(retryAfter, 1) });
    }

    return ctx.transaction(async (tx) => {
      const [forum] = await tx.db.select().from(forums).where(eq(forums.id, params.forumId));
      if (forum === undefined) throw new PluginError("forum_not_found", 404);

      const topicId = newId();
      const now = new Date();
      await tx.db.insert(topics).values({
        id: topicId,
        forumId: forum.id,
        authorId: player.id,
        subject: body.subject,
        createdAt: now,
        lastPostAt: now,
        postCount: 1,
      });
      await tx.db.insert(posts).values({
        id: newId(),
        topicId,
        authorId: player.id,
        body: body.body,
        createdAt: now,
      });

      return { status: 201, body: { topicId } };
    });
  },
});

/**
 * Replies to a topic. `last_post_at`/`post_count` are advanced with a plain
 * `UPDATE ... SET post_count = post_count + 1` — no explicit lock, because
 * the UPDATE itself self-serializes concurrent replies to the same topic.
 *
 * Notifies the topic's author via `tx.notify`, which writes the notification
 * row in the same transaction (the established semantics every other
 * `tx.notify` caller relies on — `gangs`/`bounties`/`casino` all call it
 * in-transaction, no post-commit step). Skipped entirely on a self-reply and
 * when the topic has no author (a migrated V2 row can have `author_id NULL`).
 */
const replyRoute = route({
  method: "POST",
  path: "/api/forum/topics/:topicId/posts",
  params: TopicIdParamsSchema,
  body: CreatePostBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const acquired = await ctx.cooldown.acquire("forum.post", player.id, POST_COOLDOWN_SECONDS);
    if (!acquired) {
      const retryAfter = await ctx.cooldown.peek("forum.post", player.id);
      throw new PluginError("on_cooldown", 429, { retryAfter: Math.max(retryAfter, 1) });
    }

    return ctx.transaction(async (tx) => {
      const [topic] = await tx.db.select().from(topics).where(eq(topics.id, params.topicId));
      if (topic === undefined) throw new PluginError("topic_not_found", 404);
      if (topic.status === "locked") throw new PluginError("topic_locked", 409);

      const postId = newId();
      const now = new Date();
      await tx.db.insert(posts).values({
        id: postId,
        topicId: topic.id,
        authorId: player.id,
        body: body.body,
        createdAt: now,
      });
      await tx.db
        .update(topics)
        .set({ lastPostAt: now, postCount: sql`${topics.postCount} + 1` })
        .where(eq(topics.id, topic.id));

      if (topic.authorId !== null && topic.authorId !== player.id) {
        await tx.notify(topic.authorId, `New reply to "${topic.subject}".`);
      }

      return { status: 201, body: { postId } };
    });
  },
});

// --- Moderation: player-facing paths under /api/forum, gated IN-HANDLER by
// the ABAC "forum" grant (`loadForumGrants` + `hasPermission`) rather than
// the loader's `auth: "admin"` tier — a moderator is not necessarily an
// admin, and these routes are reached by ordinary players who happen to hold
// the grant, not through the admin section at all.

const lockRoute = route({
  method: "POST",
  path: "/api/forum/topics/:topicId/lock",
  params: TopicIdParamsSchema,
  body: LockBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      if (!hasPermission(await loadForumGrants(tx, player.id), MODULE_KEY)) {
        throw new PluginError("forbidden", 403);
      }

      const result = await tx.db
        .update(topics)
        .set({ status: body.locked ? "locked" : "open" })
        .where(eq(topics.id, params.topicId))
        .returning({ id: topics.id });
      if (result.length === 0) throw new PluginError("topic_not_found", 404);

      return { status: 204 };
    });
  },
});

const typeRoute = route({
  method: "POST",
  path: "/api/forum/topics/:topicId/type",
  params: TopicIdParamsSchema,
  body: TypeBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      if (!hasPermission(await loadForumGrants(tx, player.id), MODULE_KEY)) {
        throw new PluginError("forbidden", 403);
      }

      const result = await tx.db
        .update(topics)
        .set({ type: body.type })
        .where(eq(topics.id, params.topicId))
        .returning({ id: topics.id });
      if (result.length === 0) throw new PluginError("topic_not_found", 404);

      return { status: 204 };
    });
  },
});

/**
 * Deletes one post and decrements the parent topic's `post_count` — the
 * stored counter `listTopicsRoute` renders as a badge would otherwise drift
 * from the live table the moment a post is removed (`viewTopicRoute`'s own
 * pagination recomputes its count live, so only the badge is at risk).
 * `last_post_at` is left untouched: recomputing "most recent surviving post"
 * needs its own query and no route here depends on it being exact.
 */
const deletePostRoute = route({
  method: "DELETE",
  path: "/api/forum/posts/:postId",
  params: PostIdParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      if (!hasPermission(await loadForumGrants(tx, player.id), MODULE_KEY)) {
        throw new PluginError("forbidden", 403);
      }

      const [post] = await tx.db.select().from(posts).where(eq(posts.id, params.postId));
      if (post === undefined) throw new PluginError("post_not_found", 404);

      await tx.db.delete(posts).where(eq(posts.id, post.id));
      await tx.db
        .update(topics)
        .set({ postCount: sql`greatest(${topics.postCount} - 1, 0)` })
        .where(eq(topics.id, post.topicId));

      return { status: 204 };
    });
  },
});

/** Deletes a topic. Its posts cascade at the database level — `0002_topics`'s
 *  `p_forum_posts.topic_id REFERENCES p_forum_topics(id) ON DELETE CASCADE`. */
const deleteTopicRoute = route({
  method: "DELETE",
  path: "/api/forum/topics/:topicId",
  params: TopicIdParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      if (!hasPermission(await loadForumGrants(tx, player.id), MODULE_KEY)) {
        throw new PluginError("forbidden", 403);
      }

      const result = await tx.db
        .delete(topics)
        .where(eq(topics.id, params.topicId))
        .returning({ id: topics.id });
      if (result.length === 0) throw new PluginError("topic_not_found", 404);

      return { status: 204 };
    });
  },
});

// --- Admin: /api/admin/forum, loader-tier gated (`auth: "admin"` checks
// `hasPermission(grants, "forum")` in `apps/server/src/plugins/routes.ts`
// before the handler ever runs). The rename/re-sort route is a fixed path
// with the target forum's id carried in the body rather than the URL,
// matching `packages/plugins/travel/src/index.ts`'s
// `/api/admin/travel/locations/update` — the declarative `adminPage`'s
// `form.action` is a static `METHOD /path` string (`PageRenderer.tsx`'s
// `action.split(" ")`), so it cannot carry a per-row `:forumId` segment; the
// row is instead picked via a `select` field whose `valueKey` is the id.

const adminListForumsRoute = route({
  method: "GET",
  path: "/api/admin/forum/forums",
  auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select().from(forums).orderBy(forums.sort));
    return {
      status: 200,
      body: { rows: rows.map((r) => ({ id: r.id, name: r.name, sort: r.sort })) },
    };
  },
});

const adminCreateForumRoute = route({
  method: "POST",
  path: "/api/admin/forum/forums",
  auth: "admin",
  body: AdminCreateForumBodySchema,
  handler: async (ctx, { body }) => {
    const id = newId();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(forums).values({ id, name: body.name, sort: body.sort });
    });
    return { status: 201, body: { id } };
  },
});

const adminUpdateForumRoute = route({
  method: "POST",
  path: "/api/admin/forum/forums/update",
  auth: "admin",
  body: AdminUpdateForumBodySchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db
        .update(forums)
        .set({ name: body.name, sort: body.sort })
        .where(eq(forums.id, body.id))
        .returning({ id: forums.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("forum_not_found", 404);
    return { status: 204 };
  },
});

const adminPage: PageSchema = {
  id: "forum-admin",
  path: "/admin/forum",
  view: {
    kind: "panel", title: "Forums",
    children: [
      { kind: "table", source: "GET /api/admin/forum/forums", columns: [
        { key: "name", label: "Name" },
        { key: "sort", label: "Sort" },
      ] },
      { kind: "form", action: "POST /api/admin/forum/forums", submitLabel: "Add forum", fields: [
        { name: "name", label: "Name", type: "text" },
        { name: "sort", label: "Sort", type: "number" },
      ] },
      { kind: "form", action: "POST /api/admin/forum/forums/update", submitLabel: "Update forum", fields: [
        { name: "id", label: "Forum", type: "select", optionsSource: "GET /api/admin/forum/forums", valueKey: "id", labelKey: "name" },
        { name: "name", label: "Name", type: "text" },
        { name: "sort", label: "Sort", type: "number" },
      ] },
    ],
  },
};

export default definePlugin({
  id: "forum",
  version: "1.0.0",
  basePaths: ["/api/forum", "/api/admin/forum"],
  migrations: FORUM_MIGRATIONS,
  routes: [
    listForumsRoute, listTopicsRoute, viewTopicRoute, createTopicRoute, replyRoute,
    lockRoute, typeRoute, deletePostRoute, deleteTopicRoute,
    adminListForumsRoute, adminCreateForumRoute, adminUpdateForumRoute,
  ],
  adminPages: [adminPage],
});
