import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { asc, eq } from "drizzle-orm";
import { playerStats, ranks } from "./schema.js";

/**
 * `GET /api/ranks` — the rank ladder, with the caller's current rank
 * flagged. Ported verbatim from `apps/server/src/game/ranks/routes.ts`:
 * response body, status codes and error strings are byte-identical. The
 * only shape change is plumbing — `db` becomes `tx.db` via `ctx.transaction`,
 * `request.playerId` becomes `ctx.player?.id`.
 *
 * No `menu`, no `pages`, no `events` (spec Ruling 1): the test boot now
 * default-loads every `CORE_PLUGINS` manifest, and
 * `plugin-manifest-endpoint.test.ts`'s no-arg-boot case asserts an empty
 * `/api/plugins` payload — that only holds if this plugin contributes
 * nothing to it.
 */
export default definePlugin({
  id: "ranks",
  version: "1.0.0",
  basePaths: ["/api/ranks"],
  routes: [
    route({
      method: "GET",
      path: "/api/ranks",
      handler: async (ctx) => {
        const playerId = ctx.player?.id;
        if (playerId === undefined) throw new PluginError("unauthorized", 401);

        return ctx.transaction(async (tx) => {
          const [player] = await tx.db
            .select({ rankId: playerStats.rankId })
            .from(playerStats)
            .where(eq(playerStats.playerId, playerId));
          const rows = await tx.db.select().from(ranks).orderBy(asc(ranks.expRequired));

          return {
            status: 200,
            body: {
              ranks: rows.map((r) => ({
                id: r.id,
                name: r.name,
                expRequired: r.expRequired.toString(),
                cashReward: r.cashReward.toString(),
                bulletReward: r.bulletReward,
                maxHealth: r.maxHealth,
                current: r.id === player?.rankId,
              })),
            },
          };
        });
      },
    }),
  ],
});
