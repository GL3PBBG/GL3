import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdSchema } from "@gl3/shared";
import type { Db } from "../../db/client.js";
import { notifications } from "../../db/schema/index.js";

const NotificationParamsSchema = z.object({ notificationId: IdSchema });

export function registerNotificationRoutes(
  app: FastifyInstance, db: Db,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/notifications", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const rows = await db.select().from(notifications)
      .where(eq(notifications.playerId, playerId))
      .orderBy(desc(notifications.createdAt));

    return reply.send({
      notifications: rows.map((n) => ({
        id: n.id,
        body: n.body,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
    });
  });

  app.post("/api/notifications/:notificationId/read", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const params = NotificationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const [updated] = await db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, params.data.notificationId), eq(notifications.playerId, playerId)))
      .returning({ id: notifications.id });

    if (!updated) return reply.code(404).send({ error: "notification_not_found" });
    return reply.code(204).send();
  });
}
