import { definePlugin, newId, PluginError, route } from "@gl3/plugin-sdk";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { gameNews, players, roleModuleAccess } from "./schema.js";

/**
 * Ported verbatim from `apps/server/src/game/news/routes.ts` and
 * `access.ts`: paths, status codes, response bodies and the `news.posted`
 * event are byte-identical. `apps/server/test/news.test.ts` is unchanged and
 * is the proof.
 *
 * Two deliberate differences:
 *  - A 400 from a bad body carries `{ error: "invalid_request" }` with no
 *    `issues` array, because the plugin route layer owns body validation
 *    (`apps/server/src/plugins/routes.ts`). Nothing in `apps/web` reads
 *    `issues`.
 *  - The reads happen inside `ctx.transaction`, since that is a plugin's only
 *    database handle. The POST's insert and its event were already ordered
 *    this way (CLAUDE.md rule 5); `publishCore` buffers and flushes on commit.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `PostNewsRequestSchema`
 * and `noNulByte` are restated below. The NUL-byte refinement is load-bearing:
 * Postgres `text` rejects an embedded NUL outright (SQLSTATE 22021), turning
 * an otherwise-legal post into a 500 without it.
 */
// Write the six-character escape (backslash-u-0-0-0-0), never a literal NUL
// character: a raw NUL is invisible in every editor, makes the file binary
// to grep, and will not survive a copy/paste — the refinement would then
// silently accept everything it exists to reject. This plan file caught
// exactly that during its own review.
const noNulByte = <T extends z.ZodString>(schema: T): z.ZodEffects<T, string, string> =>
  schema.refine((value) => !value.includes("\u0000"), { message: "must not contain a NUL byte" });

const PostNewsBodySchema = z.object({
  title: noNulByte(z.string().min(1).max(200)),
  body: noNulByte(z.string().min(1).max(10_000)),
});

export default definePlugin({
  id: "news",
  version: "1.0.0",
  basePaths: ["/api/news"],
  routes: [
    route({
      method: "POST",
      path: "/api/news",
      body: PostNewsBodySchema,
      handler: async (ctx, { body }) => {
        const playerId = ctx.player?.id;
        if (playerId === undefined) throw new PluginError("unauthorized", 401);

        return ctx.transaction(async (tx) => {
          // Role/module access gate, ported from access.ts. Three cases the
          // suite covers explicitly: no role denies; a role granting a
          // DIFFERENT module denies (so the check cannot degrade to
          // "has any row"); and `*` is the V2-preserved admin wildcard.
          const [author] = await tx.db
            .select({ roleId: players.roleId, username: players.username })
            .from(players)
            .where(eq(players.id, playerId));
          if (!author?.roleId) throw new PluginError("forbidden", 403);
          const grants = await tx.db
            .select({ moduleKey: roleModuleAccess.moduleKey })
            .from(roleModuleAccess)
            .where(eq(roleModuleAccess.roleId, author.roleId));
          if (!grants.some((g) => g.moduleKey === "news" || g.moduleKey === "*")) {
            throw new PluginError("forbidden", 403);
          }

          const id = newId();
          await tx.db.insert(gameNews).values({
            id, authorId: playerId, title: body.title, body: body.body,
          });

          // Buffered here, published after commit — events are facts, not
          // commands (CLAUDE.md rule 5). events.ts documents news.posted as
          // "actor = the author", audience global. Falls back to "unknown"
          // rather than "", matching every other event-publishing site in
          // this codebase (gangs/routes.ts, mail/routes.ts) and core's prior
          // news route.
          await tx.events.publishCore({
            type: "news.posted",
            actorId: playerId,
            actorName: author.username ?? "unknown",
            audience: { kind: "global" },
            newsId: id,
            title: body.title,
          });

          return { status: 201, body: { id } };
        });
      },
    }),
    route({
      method: "GET",
      path: "/api/news",
      auth: "public",
      handler: async (ctx) => ctx.transaction(async (tx) => {
        const rows = await tx.db.select().from(gameNews).orderBy(desc(gameNews.createdAt)).limit(50);
        const authorIds = [...new Set(rows.map((r) => r.authorId).filter((id): id is string => id !== null))];
        const authors = authorIds.length > 0
          ? await tx.db.select({ id: players.id, username: players.username })
              .from(players).where(inArray(players.id, authorIds))
          : [];
        const nameById = new Map(authors.map((a) => [a.id, a.username]));

        return {
          status: 200,
          body: {
            news: rows.map((n) => ({
              id: n.id,
              authorId: n.authorId,
              authorName: n.authorId ? nameById.get(n.authorId) ?? null : null,
              title: n.title,
              body: n.body,
              createdAt: n.createdAt.toISOString(),
            })),
          },
        };
      }),
    }),
  ],
});
