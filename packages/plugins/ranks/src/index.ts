import { definePlugin, PluginError, route, type PageSchema } from "@gl3/plugin-sdk";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
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
// --- Admin schemas ---

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");
const RankUpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  expRequired: AdminMoney,
  cashReward: AdminMoney,
  bulletReward: z.coerce.number().int().nonnegative(),
  maxHealth: z.coerce.number().int().nonnegative(),
}).strict();

// --- Admin routes ---

const adminRanksListRoute = route({
  method: "GET", path: "/api/admin/ranks/list", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select().from(ranks).orderBy(asc(ranks.expRequired)),
    );
    return {
      status: 200,
      body: {
        rows: rows.map((r) => ({
          id: r.id, name: r.name,
          expRequired: r.expRequired.toString(),
          cashReward: r.cashReward.toString(),
          bulletReward: String(r.bulletReward),
          maxHealth: String(r.maxHealth),
        })),
      },
    };
  },
});

const adminRanksUpdateRoute = route({
  method: "POST", path: "/api/admin/ranks/update", auth: "admin",
  body: RankUpdateSchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db.update(ranks)
        .set({
          name: body.name,
          expRequired: BigInt(body.expRequired),
          cashReward: BigInt(body.cashReward),
          bulletReward: body.bulletReward,
          maxHealth: body.maxHealth,
        })
        .where(eq(ranks.id, body.id))
        .returning({ id: ranks.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("rank_not_found", 404);
    return { status: 204 };
  },
});

const adminRanksPage: PageSchema = {
  id: "ranks-admin",
  path: "/admin/ranks",
  view: {
    kind: "panel", title: "Ranks",
    children: [
      { kind: "table", source: "GET /api/admin/ranks/list", columns: [
        { key: "id", label: "Id" }, { key: "name", label: "Name" },
        { key: "expRequired", label: "Exp required" },
        { key: "cashReward", label: "Cash reward" },
        { key: "bulletReward", label: "Bullets" },
        { key: "maxHealth", label: "Max health" },
      ] },
      { kind: "form", action: "POST /api/admin/ranks/update", submitLabel: "Update rank", fields: [
        { name: "id", label: "Rank", type: "select", optionsSource: "GET /api/admin/ranks/list", valueKey: "id", labelKey: "name" },
        { name: "name", label: "Name", type: "text" },
        { name: "expRequired", label: "Exp required", type: "money" },
        { name: "cashReward", label: "Cash reward", type: "money" },
        { name: "bulletReward", label: "Bullet reward", type: "number" },
        { name: "maxHealth", label: "Max health", type: "number" },
      ] },
    ],
  },
};

export default definePlugin({
  id: "ranks",
  version: "1.0.0",
  basePaths: ["/api/ranks", "/api/admin/ranks"],
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
    adminRanksListRoute,
    adminRanksUpdateRoute,
  ],
  adminPages: [adminRanksPage],
});
