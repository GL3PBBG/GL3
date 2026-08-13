import {
  definePlugin, InsufficientFundsError, PluginError, route,
  type PageSchema,
} from "@gl3/plugin-sdk";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, playerStats } from "./schema.js";

/**
 * Ported from `apps/server/src/game/bullets/routes.ts` and `service.ts`:
 * paths, status codes, error strings, response bodies and the
 * `bullets.purchased` event are byte-identical. `apps/server/test/bullets.test.ts`'s
 * `app.inject` block is the proof.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `BuyBulletsRequestSchema`
 * is restated rather than imported.
 */
const BuyBulletsSchema = z.object({ quantity: z.number().int().positive() });

// --- Admin schemas ---

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");
const StockBodySchema = z.object({
  locationId: z.string().uuid(),
  bulletStock: z.coerce.number().int().nonnegative(),
  bulletCost: AdminMoney,
}).strict();

// --- Admin routes ---

const adminListRoute = route({
  method: "GET", path: "/api/admin/bullets/stock", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(locations));
    return {
      status: 200,
      body: {
        rows: rows.map((l) => ({
          id: l.id, name: l.name,
          bulletStock: String(l.bulletStock),
          bulletCost: l.bulletCost.toString(),
        })),
      },
    };
  },
});

const adminStockRoute = route({
  method: "POST", path: "/api/admin/bullets/stock", auth: "admin",
  body: StockBodySchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db.update(locations)
        .set({
          bulletStock: body.bulletStock,
          bulletCost: BigInt(body.bulletCost),
        })
        .where(eq(locations.id, body.locationId))
        .returning({ id: locations.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("location_not_found", 404);
    return { status: 204 };
  },
});

const adminPage: PageSchema = {
  id: "bullets-admin",
  path: "/admin/bullets",
  view: {
    kind: "panel", title: "Bullet stock",
    children: [
      { kind: "table", source: "GET /api/admin/bullets/stock", columns: [
        { key: "id", label: "Id" }, { key: "name", label: "Name" },
        { key: "bulletStock", label: "Stock" },
        { key: "bulletCost", label: "Cost" },
      ] },
      { kind: "form", action: "POST /api/admin/bullets/stock", submitLabel: "Set stock", fields: [
        { name: "locationId", label: "Location", type: "select", optionsSource: "GET /api/admin/bullets/stock", valueKey: "id", labelKey: "name" },
        { name: "bulletStock", label: "Bullet stock", type: "number" },
        { name: "bulletCost", label: "Bullet cost", type: "money" },
      ] },
    ],
  },
};

const buyRoute = route({
  method: "POST",
  path: "/api/bullets/buy",
  // Buying is an action, so it gates on jail — unlike bank, news, ranks and
  // notifications, which all take the `true` default. The loader runs
  // releaseIfExpired and answers 423 + retry-after, exactly as core's route did.
  accessInJail: false,
  body: BuyBulletsSchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { quantity } = body;

    return ctx.transaction(async (tx) => {
      // (1) Unlocked read, preserved verbatim from core (`service.ts:32`). A
      // concurrent travel committing in this window means buying at a location
      // already left. Closing it here would either invert the lock order or
      // smuggle a behaviour change into a port whose proof depends on there
      // being none — see design §6.
      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const locationId = stats?.locationId;
      if (!locationId) throw new PluginError("no_location", 409);

      // (3) LOCATION LOCK FIRST. `tx.economy.applyBalanceChange` below takes
      // the player lock internally, so this line is what this handler must
      // keep first — moving any player-row access above it would invert the
      // location→player order and no explicit player lock appears below to
      // hint at it. Travel used to lock the other way round and closed an
      // ABBA cycle with this handler; it no longer does —
      // `@gl3/plugin-travel` takes both of its location rows before the
      // player row
      // (`apps/server/test/travel-lock-order.test.ts` is the regression).
      // The unlocked read at (1) above is likewise no longer a staleness
      // window: a travel off this location must hold this row to commit.
      await tx.locks.location(locationId);

      const [location] = await tx.db.select().from(locations).where(eq(locations.id, locationId));
      // (4) The location was deleted out from under a stale reference.
      if (!location) throw new PluginError("no_location", 409);
      // (5) Read under the lock, so two concurrent buyers cannot both pass.
      if (location.bulletStock < quantity) {
        throw new PluginError("insufficient_stock", 409, { available: location.bulletStock });
      }

      // (6) bigint throughout — quantity is an integer, cost is money.
      const cost = location.bulletCost * BigInt(quantity);

      // (7) Takes the player lock. (8) Core's InsufficientFundsError is
      // translated to the SDK's by the ctx; the loader maps only PluginError,
      // so without this catch an overdraft would be a 500.
      let cash: bigint;
      try {
        cash = await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: -cost,
          kind: "cash",
          reason: "bullets.purchase",
          refId: location.id,
        });
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          throw new PluginError("insufficient_funds", 409);
        }
        throw error;
      }

      // (9) The stock value read under the lock at step 4, minus the purchase.
      const bulletStock = location.bulletStock - quantity;
      await tx.db.update(locations).set({ bulletStock }).where(eq(locations.id, location.id));

      // (10) `.returning()` replaces core's post-commit re-read: cash came
      // back from step 7, bullets comes back from here.
      const [fresh] = await tx.db
        .update(playerStats)
        .set({ bullets: sql`${playerStats.bullets} + ${quantity}` })
        .where(eq(playerStats.playerId, player.id))
        .returning({ bullets: playerStats.bullets });
      if (!fresh) throw new PluginError("no_location", 409);

      // (11) Buffered here, published after commit and discarded on rollback.
      // Audience is PRIVATE: a purchase is not broadcast.
      await tx.events.publishCore({
        type: "bullets.purchased",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        locationId,
        quantity,
        cost: cost.toString(),
        cash: cash.toString(),
        bullets: fresh.bullets.toString(),
      });

      // (12) Money crosses the wire as a decimal string, never a JSON number.
      return {
        status: 200,
        body: { cash: cash.toString(), bullets: fresh.bullets.toString(), bulletStock },
      };
    });
  },
});

export default definePlugin({
  id: "bullets",
  version: "1.0.0",
  basePaths: ["/api/bullets", "/api/admin/bullets"],
  routes: [buyRoute, adminListRoute, adminStockRoute],
  adminPages: [adminPage],
  // No `menu`, `pages` or `events`: plugin-manifest-endpoint.test.ts:87
  // asserts a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. No `jobs`: buildApp throws at boot
  // if a core plugin declares any (that path has no queue-name prefix).
});
