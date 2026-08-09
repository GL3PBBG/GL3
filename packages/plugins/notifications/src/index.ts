import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { notifications } from "./schema.js";

const NotificationParamsSchema = z.object({ notificationId: z.string().uuid() });

/**
 * `GET /api/notifications` and `POST /api/notifications/:notificationId/read`.
 * Ported verbatim from `apps/server/src/game/notifications/routes.ts`:
 * response bodies, status codes and error strings are byte-identical. The
 * only shape change is plumbing — `db` becomes `tx.db` via `ctx.transaction`,
 * `request.playerId` becomes `ctx.player?.id`.
 *
 * `insertNotification` (`apps/server/src/game/notifications/service.ts`)
 * stays in core — other modules call it directly and it reaches plugins as
 * `tx.notify`.
 *
 * No `menu`, no `pages`, no `events` (spec Ruling 1): the test boot now
 * default-loads every `CORE_PLUGINS` manifest, and
 * `plugin-manifest-endpoint.test.ts`'s no-arg-boot case asserts an empty
 * `/api/plugins` payload — that only holds if this plugin contributes
 * nothing to it.
 */
export default definePlugin({
  id: "notifications",
  version: "1.0.0",
  basePaths: ["/api/notifications"],
  routes: [
    route({
      method: "GET",
      path: "/api/notifications",
      handler: async (ctx) => {
        const playerId = ctx.player?.id;
        if (playerId === undefined) throw new PluginError("unauthorized", 401);

        return ctx.transaction(async (tx) => {
          const rows = await tx.db
            .select()
            .from(notifications)
            .where(eq(notifications.playerId, playerId))
            .orderBy(desc(notifications.createdAt));

          return {
            status: 200,
            body: {
              notifications: rows.map((n) => ({
                id: n.id,
                body: n.body,
                readAt: n.readAt?.toISOString() ?? null,
                createdAt: n.createdAt.toISOString(),
              })),
            },
          };
        });
      },
    }),
    route({
      method: "POST",
      path: "/api/notifications/:notificationId/read",
      params: NotificationParamsSchema,
      handler: async (ctx, { params }) => {
        const playerId = ctx.player?.id;
        if (playerId === undefined) throw new PluginError("unauthorized", 401);

        return ctx.transaction(async (tx) => {
          const [updated] = await tx.db
            .update(notifications)
            .set({ readAt: new Date() })
            .where(and(eq(notifications.id, params.notificationId), eq(notifications.playerId, playerId)))
            .returning({ id: notifications.id });

          if (!updated) throw new PluginError("notification_not_found", 404);
          return { status: 204 };
        });
      },
    }),
  ],
});
