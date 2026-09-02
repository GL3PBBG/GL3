import { definePlugin, newId, PluginError, route, type PageSchema } from "@gl3/plugin-sdk";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { moneyRanks, playerStats, ranks } from "./schema.js";

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
/** The columns an admin edits, shared by create and update. */
const RankFieldsSchema = z.object({
  name: z.string().min(1).max(80),
  expRequired: AdminMoney,
  cashReward: AdminMoney,
  bulletReward: z.coerce.number().int().nonnegative(),
  maxHealth: z.coerce.number().int().nonnegative(),
});
const RankUpdateSchema = RankFieldsSchema.extend({ id: z.string().uuid() }).strict();
const RankCreateSchema = RankFieldsSchema.strict();

const MoneyRankFieldsSchema = z.object({
  label: z.string().min(1).max(80),
  threshold: AdminMoney,
});
const MoneyRankCreateSchema = MoneyRankFieldsSchema.strict();
const MoneyRankUpdateSchema = MoneyRankFieldsSchema.extend({ id: z.string().uuid() }).strict();

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

const adminRanksCreateRoute = route({
  method: "POST", path: "/api/admin/ranks", auth: "admin",
  body: RankCreateSchema,
  handler: async (ctx, { body }) => {
    const id = newId();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(ranks).values({
        id, name: body.name,
        expRequired: BigInt(body.expRequired),
        cashReward: BigInt(body.cashReward),
        bulletReward: body.bulletReward,
        maxHealth: body.maxHealth,
      });
    });
    return { status: 201, body: { id } };
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

const adminRanksDeleteRoute = route({
  method: "DELETE", path: "/api/admin/ranks/:id", auth: "admin",
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const deleted = await ctx.transaction(async (tx) => {
      // `player_stats.rank_id` is ON DELETE SET NULL and self-healing: rank
      // is recomputed from exp on the next exp change and every reader
      // left-joins it — so unlike a town or an item, a held rank is safe to
      // delete and no in-use refusal is warranted.
      const result = await tx.db.delete(ranks)
        .where(eq(ranks.id, params.id)).returning({ id: ranks.id });
      return result.length > 0;
    });
    if (!deleted) throw new PluginError("rank_not_found", 404);
    return { status: 204 };
  },
});

const adminMoneyRanksListRoute = route({
  method: "GET", path: "/api/admin/ranks/money/list", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select().from(moneyRanks).orderBy(asc(moneyRanks.threshold)),
    );
    return {
      status: 200,
      body: {
        rows: rows.map((r) => ({
          id: r.id, label: r.label, threshold: r.threshold.toString(),
        })),
      },
    };
  },
});

const adminMoneyRanksCreateRoute = route({
  method: "POST", path: "/api/admin/ranks/money", auth: "admin",
  body: MoneyRankCreateSchema,
  handler: async (ctx, { body }) => {
    const id = newId();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(moneyRanks).values({
        id, label: body.label, threshold: BigInt(body.threshold),
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminMoneyRanksUpdateRoute = route({
  method: "POST", path: "/api/admin/ranks/money/update", auth: "admin",
  body: MoneyRankUpdateSchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db.update(moneyRanks)
        .set({ label: body.label, threshold: BigInt(body.threshold) })
        .where(eq(moneyRanks.id, body.id))
        .returning({ id: moneyRanks.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("money_rank_not_found", 404);
    return { status: 204 };
  },
});

const adminMoneyRanksDeleteRoute = route({
  method: "DELETE", path: "/api/admin/ranks/money/:id", auth: "admin",
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const deleted = await ctx.transaction(async (tx) => {
      // Money ranks are pure display brackets over cash+bank; nothing
      // references them, so this is the simplest delete on the page.
      const result = await tx.db.delete(moneyRanks)
        .where(eq(moneyRanks.id, params.id)).returning({ id: moneyRanks.id });
      return result.length > 0;
    });
    if (!deleted) throw new PluginError("money_rank_not_found", 404);
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
        { key: "name", label: "Name" },
        { key: "expRequired", label: "Exp required" },
        { key: "cashReward", label: "Cash reward" },
        { key: "bulletReward", label: "Bullets" },
        { key: "maxHealth", label: "Max health" },
      ], rowActions: [
        { label: "Delete", action: "DELETE /api/admin/ranks/:id", confirm: "Delete this rank? Holders re-rank on their next exp change." },
      ] },
      { kind: "form", action: "POST /api/admin/ranks", submitLabel: "Add rank", fields: [
        { name: "name", label: "Name", type: "text" },
        { name: "expRequired", label: "Exp required", type: "money" },
        { name: "cashReward", label: "Cash reward", type: "money" },
        { name: "bulletReward", label: "Bullet reward", type: "number" },
        { name: "maxHealth", label: "Max health", type: "number" },
      ] },
      { kind: "form", action: "POST /api/admin/ranks/update", submitLabel: "Update rank", fields: [
        { name: "id", label: "Rank", type: "select", optionsSource: "GET /api/admin/ranks/list", valueKey: "id", labelKey: "name" },
        { name: "name", label: "Name", type: "text" },
        { name: "expRequired", label: "Exp required", type: "money" },
        { name: "cashReward", label: "Cash reward", type: "money" },
        { name: "bulletReward", label: "Bullet reward", type: "number" },
        { name: "maxHealth", label: "Max health", type: "number" },
      ] },
      { kind: "table", source: "GET /api/admin/ranks/money/list", columns: [
        { key: "label", label: "Money rank" },
        { key: "threshold", label: "Threshold" },
      ], rowActions: [
        { label: "Delete", action: "DELETE /api/admin/ranks/money/:id", confirm: "Delete this money rank?" },
      ] },
      { kind: "form", action: "POST /api/admin/ranks/money", submitLabel: "Add money rank", fields: [
        { name: "label", label: "Label", type: "text" },
        { name: "threshold", label: "Threshold", type: "money" },
      ] },
      { kind: "form", action: "POST /api/admin/ranks/money/update", submitLabel: "Update money rank", fields: [
        // `id` travels as the select's valueKey and is never a table column:
        // no admin table shows a UUID (`test/admin-ids-hidden.test.ts`).
        { name: "id", label: "Money rank", type: "select",
          optionsSource: "GET /api/admin/ranks/money/list", valueKey: "id", labelKey: "label" },
        { name: "label", label: "Label", type: "text" },
        { name: "threshold", label: "Threshold", type: "money" },
      ] },
    ],
  },
};

export default definePlugin({
  id: "ranks",
  version: "1.0.0",
  apiVersion: 1,
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
          const money = await tx.db.select().from(moneyRanks).orderBy(asc(moneyRanks.threshold));
          // `ranks` is a CORE table — same cross-scope read as travel's towns
          // and inventory's items.
          const art = await ctx.assets.resolve("core", rows.map((r) => r.id), "rank");

          return {
            status: 200,
            body: {
              ranks: rows.map((r, i) => ({
                id: r.id,
                name: r.name,
                expRequired: r.expRequired.toString(),
                cashReward: r.cashReward.toString(),
                bulletReward: r.bulletReward,
                maxHealth: r.maxHealth,
                current: r.id === player?.rankId,
                // Ordinal position in the ladder (1-based), ordered by
                // expRequired ascending — the same ordering `syncRankToLevel`
                // promotes into on a routed boot. Display only; the plugin
                // cannot see whether this install is routed.
                levelRequired: i + 1,
                ...(art.has(r.id) ? { imageUrl: art.get(r.id) as string } : {}),
              })),
              moneyRanks: money.map((m) => ({
                id: m.id, label: m.label, threshold: m.threshold.toString(),
              })),
            },
          };
        });
      },
    }),
    adminRanksListRoute,
    adminRanksCreateRoute,
    adminRanksUpdateRoute,
    adminRanksDeleteRoute,
    adminMoneyRanksListRoute,
    adminMoneyRanksCreateRoute,
    adminMoneyRanksUpdateRoute,
    adminMoneyRanksDeleteRoute,
  ],
  adminPages: [adminRanksPage],
});
