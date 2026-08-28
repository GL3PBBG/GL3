import { asc, eq } from "drizzle-orm";
import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { HOUSES_MIGRATIONS } from "./migrations.js";
import { definePlugin, isInsufficientFundsError, PluginError, route, type PluginTx } from "@gl3/plugin-sdk";
import { adminPage, housesPage } from "./pages.js";
// Re-exported so `apps/server/test/houses-page.test.ts` can assert against the
// same page object rather than a hand-copied duplicate of its view tree,
// which would silently drift if `pages.ts` changed — the theft precedent.
export { adminPage, housesPage } from "./pages.js";

/** This plugin's own catalog table (migrations.ts creates it). */
const houses = pgTable("p_houses", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  price: bigint("price", { mode: "bigint" }).notNull(),
  will: integer("will").notNull(),
});

const HouseIdSchema = z.object({ houseId: z.string().uuid() }).strict();

/**
 * The player's current house is derived, never stored: maxwill IS the house
 * (MCCodes `estate.php:12-17` matches `hWILL = maxwill`). No ownership row,
 * no ambiguity — one row per will value is the admin's content constraint.
 */
async function currentHouse(tx: PluginTx, willMax: number) {
  const [row] = await tx.db.select().from(houses).where(eq(houses.will, willMax)).limit(1);
  return row ?? null;
}

const listRoute = route({
  method: "GET",
  path: "/api/houses",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const attrs = await ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      return tx.attributes.read(player.id);
    });
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select().from(houses).orderBy(asc(houses.will)));
    return {
      status: 200,
      body: {
        currentWillMax: attrs.willMax,
        houses: rows.map((h) => ({
          id: h.id, name: h.name, price: h.price.toString(), will: h.will,
        })),
      },
    };
  },
});

/**
 * The catalog plus the caller's current house, composed from the same reads
 * `/api/houses` and `currentHouse` already do, shaped as a `TableRowsResponse`
 * so one GET serves both the catalog `table` and the `keyValueSource` (the
 * sourced contract Task 1 established). `houseName`/`houseWill` are present
 * only above the Default House — `willMax <= 100` means no upgrade owned, the
 * same threshold `sellRoute` already uses.
 */
const boardRoute = route({
  method: "GET",
  path: "/api/houses/board",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      const attrs = await tx.attributes.read(player.id);
      const rows = await tx.db.select().from(houses).orderBy(asc(houses.will));
      const owned = attrs.willMax > 100 ? await currentHouse(tx, attrs.willMax) : null;

      const values: Record<string, string> = { willMax: String(attrs.willMax) };
      if (owned !== null) {
        values.houseName = owned.name;
        values.houseWill = String(owned.will);
      }

      return {
        status: 200,
        body: {
          rows: rows.map((h) => ({ id: h.id, name: h.name, price: h.price.toString(), will: String(h.will) })),
          values,
        },
      };
    });
  },
});

const buyRoute = route({
  method: "POST",
  path: "/api/houses/buy",
  body: HouseIdSchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      const [house] = await tx.db.select().from(houses).where(eq(houses.id, body.houseId));
      if (!house) throw new PluginError("house_not_found", 404);

      const attrs = await tx.attributes.read(player.id);
      // Upgrades only (estate.php:37-39): "You cannot go backwards in
      // houses!" — an equal-will buy is also refused; there is nothing to
      // gain and the will reset would be pure loss.
      if (house.will <= attrs.willMax) throw new PluginError("downgrade_refused", 409);

      try {
        await tx.economy.applyBalanceChange(
          { playerId: player.id, amount: -house.price, kind: "cash", reason: "houses.buy", refId: house.id },
        );
      } catch (error) {
        if (isInsufficientFundsError(error)) throw new PluginError("insufficient_funds", 409);
        throw error;
      }

      // Moving house resets will to zero (estate.php:47-51) — the new
      // maxwell's higher multiplier is earned back through regen.
      if (attrs.will > 0) await tx.attributes.spend(player.id, "will", attrs.will);
      await tx.attributes.setMax(player.id, "will", house.will);

      return { status: 200, body: { houseId: house.id, name: house.name, willMax: house.will } };
    });
  },
});

const sellRoute = route({
  method: "POST",
  path: "/api/houses/sell",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      const attrs = await tx.attributes.read(player.id);
      if (attrs.willMax <= 100) throw new PluginError("no_house_to_sell", 409);
      const house = await currentHouse(tx, attrs.willMax);
      if (house === null) throw new PluginError("no_house_to_sell", 409);

      // 100% refund (estate.php:56-69) — storage, not income; the player
      // re-earns nothing by cycling buy/sell.
      await tx.economy.applyBalanceChange(
        { playerId: player.id, amount: house.price, kind: "cash", reason: "houses.sell", refId: house.id },
      );
      if (attrs.will > 0) await tx.attributes.spend(player.id, "will", attrs.will);
      await tx.attributes.setMax(player.id, "will", 100);

      return { status: 200, body: { soldHouseId: house.id, refund: house.price.toString(), willMax: 100 } };
    });
  },
});

// ---------------------------------------------------------------------------
// Admin routes — the catalog editor. Theft's four-route shape
// (`packages/plugins/theft/src/index.ts`'s admin section): list/create/
// update/delete, `auth: "admin"`, an update that blanks a rename. No FK
// references `p_houses`, so unlike theft's cars there is no "in use" row to
// refuse against — a delete is unconditional, the membership packages shape.
// ---------------------------------------------------------------------------

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");

/**
 * The page renderer posts every field in a form, sending "" for the ones the
 * admin left blank (`PageRenderer.tsx`'s form `onSubmit`). Blank is
 * normalised to `undefined` here so an update that only reprices a house
 * leaves its name untouched — the theft/membership admin convention, reused
 * rather than reinvented (there is no shared export for it).
 */
function blankable<T extends z.ZodTypeAny>(inner: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((v) => (v === "" ? undefined : v), inner.optional()) as never;
}

const HouseCreateSchema = z
  .object({
    name: z.string().min(1).max(80),
    price: AdminMoney,
    will: z.coerce.number().int().positive(),
  })
  .strict();

const HouseUpdateSchema = z
  .object({
    id: z.string().uuid(),
    name: blankable(z.string().min(1).max(80)),
    price: AdminMoney,
    will: z.coerce.number().int().positive(),
  })
  .strict();

/** The catalog as a `TableRowsResponse`. `id` is the update form's select `valueKey` and is never rendered as a column. */
const adminListRoute = route({
  method: "GET",
  path: "/api/admin/houses/list",
  auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(houses).orderBy(asc(houses.will)));
    return {
      status: 200,
      body: {
        rows: rows.map((h) => ({ id: h.id, name: h.name, price: h.price.toString(), will: String(h.will) })),
      },
    };
  },
});

const adminCreateRoute = route({
  method: "POST",
  path: "/api/admin/houses",
  auth: "admin",
  body: HouseCreateSchema,
  handler: async (ctx, { body }) => {
    const id = uuidv7();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(houses).values({ id, name: body.name, price: BigInt(body.price), will: body.will });
    });
    return { status: 201, body: { id } };
  },
});

const adminUpdateRoute = route({
  method: "POST",
  path: "/api/admin/houses/update",
  auth: "admin",
  body: HouseUpdateSchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db
        .update(houses)
        .set({
          price: BigInt(body.price),
          will: body.will,
          ...(body.name !== undefined && { name: body.name }),
        })
        .where(eq(houses.id, body.id))
        .returning({ id: houses.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("house_not_found", 404);
    return { status: 204 };
  },
});

const adminDeleteRoute = route({
  method: "DELETE",
  path: "/api/admin/houses/:id",
  auth: "admin",
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const deleted = await ctx.transaction(async (tx) => {
      const result = await tx.db.delete(houses).where(eq(houses.id, params.id)).returning({ id: houses.id });
      return result.length > 0;
    });
    if (!deleted) throw new PluginError("house_not_found", 404);
    return { status: 204 };
  },
});

/**
 * Houses (C spec §4.2): maxwill IS the house. Buying upgrades the ceiling
 * and resets current will; selling refunds in full and returns to the
 * Default House's 100. Requires the anchor for the will pool.
 */
export default definePlugin({
  id: "houses",
  version: "1.0.0",
  apiVersion: 1,
  basePaths: ["/api/houses", "/api/admin/houses"],
  requires: ["mccodes-attributes"],
  migrations: HOUSES_MIGRATIONS,
  routes: [
    listRoute, boardRoute, buyRoute, sellRoute,
    adminListRoute, adminCreateRoute, adminUpdateRoute, adminDeleteRoute,
  ],
  // The page renders at /plugins/<pageId>, out of reach of the Shell's
  // route→slot banner map, so the banner is this plugin's own singleton drawn
  // by a `slotImage` node in the page view (the theft precedent).
  providesAssets: [
    // Per-row art with its own picker, bound from core's central art section
    // (the theft cars precedent).
    { slot: "house", label: "Houses", entitySource: "GET /api/admin/houses/list", entityLabelKey: "name" },
    { slot: "page-houses", label: "Houses page banner", singleton: true },
  ],
  pages: [housesPage],
  adminPages: [adminPage],
});
