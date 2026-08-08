import { desc, eq, or } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { PostNewsRequestSchema, type GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { gameNews, players } from "../../db/schema/index.js";
import { hasModuleAccess } from "./access.js";

export function registerNewsRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.post("/api/news", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = PostNewsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });

    if (!(await hasModuleAccess(db, playerId, "news"))) return reply.code(403).send({ error: "forbidden" });

    const id = uuidv7();
    await db.insert(gameNews).values({ id, authorId: playerId, title: parsed.data.title, body: parsed.data.body });

    // Publish only after the insert above has committed — events are facts,
    // not commands (NOTES.md rule 5). A plain (non-transactional) insert
    // commits as soon as it resolves, so this read-then-publish sequencing
    // after it already satisfies that.
    const [author] = await db.select({ username: players.username }).from(players).where(eq(players.id, playerId));
    const event: GameEvent = {
      id: uuidv7(), type: "news.posted", at: new Date().toISOString(),
      // The brief's sample used `?? ""` here. Every other event-publishing
      // site in this codebase (gangs/routes.ts, mail/routes.ts) falls back
      // to "unknown" instead — matching that convention.
      actorId: playerId, actorName: author?.username ?? "unknown", audience: { kind: "global" },
      newsId: id, title: parsed.data.title,
    };
    await publishEvent(redis, event);

    return reply.code(201).send({ id });
  });

  app.get("/api/news", async (_request, reply) => {
    const rows = await db.select().from(gameNews).orderBy(desc(gameNews.createdAt)).limit(50);
    const authorIds = [...new Set(rows.map((r) => r.authorId).filter((id): id is string => id !== null))];
    const authors = authorIds.length > 0
      ? await db.select({ id: players.id, username: players.username }).from(players).where(or(...authorIds.map((id) => eq(players.id, id))))
      : [];
    const nameById = new Map(authors.map((a) => [a.id, a.username]));

    return reply.send({
      news: rows.map((n) => ({
        id: n.id, authorId: n.authorId, authorName: n.authorId ? nameById.get(n.authorId) ?? null : null,
        title: n.title, body: n.body, createdAt: n.createdAt.toISOString(),
      })),
    });
  });
}
