import {
  definePlugin, InsufficientFundsError, PluginError, route,
  type PageSchema,
} from "@gl3/plugin-sdk";
import { ownerAt, payOwner } from "@gl3/plugin-properties";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, playerStats, settings } from "./schema.js";
import { readBulletSettings } from "./settings.js";
import { restockIfDue } from "./restock.js";
import { capLever } from "./lever-cap.js";

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

export { readBulletSettings, type BulletSettings } from "./settings.js";
import type { BulletSettings } from "./settings.js";
export { restockIfDue, type RestockResult } from "./restock.js";

/**
 * The price a purchase actually costs: the franchise owner's lever when a
 * factory is owned and the owner has set one, the location's admin price
 * otherwise, and never above the `max_cost` cap. V2's admin caps the owner
 * (`adminModule::method_options`); this is the read-side half of that, and the
 * lever route's filter subscriber below is the set-side half.
 */
function effectiveCost(lever: bigint | null, locationCost: bigint, maxCost: bigint | null): bigint {
  const base = lever ?? locationCost;
  return maxCost !== null && base > maxCost ? maxCost : base;
}

// --- Admin schemas ---

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");
const StockBodySchema = z.object({
  locationId: z.string().uuid(),
  bulletStock: z.coerce.number().int().nonnegative(),
  bulletCost: AdminMoney,
}).strict();

/** Blank is how the admin form says "unlimited" — see `readBulletSettings`. */
const Unlimitable = z.union([z.literal(""), z.string().regex(/^\d+$/, "digits or blank")]);
const OptionsBodySchema = z.object({
  stockMinPerHour: z.coerce.number().int().nonnegative(),
  stockMaxPerHour: z.coerce.number().int().nonnegative(),
  maxStock: z.coerce.number().int().nonnegative(),
  maxCost: Unlimitable,
  maxBuy: Unlimitable,
}).strict();

/** The five keys V2's `method_options` edits, in the order the panel lists them. */
const OPTION_LABELS: readonly (readonly [keyof BulletSettings, string, string])[] = [
  ["stockMinPerHour", "stock_min_per_hour", "Stock min per hour"],
  ["stockMaxPerHour", "stock_max_per_hour", "Stock max per hour"],
  ["maxStock", "max_stock", "Max stock"],
  ["maxCost", "max_cost", "Max bullet cost"],
  ["maxBuy", "max_buy", "Max bullets per purchase"],
];

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

/**
 * V2's `adminModule::method_options`. Reads and writes the `settings` TABLE,
 * not `ctx.settings` — the snapshot is boot-time, so this panel must show what
 * the next boot will read rather than what this process happens to hold. That
 * is also why an edit here changes nothing until the server restarts, which
 * the panel says out loud.
 */
const adminOptionsListRoute = route({
  method: "GET", path: "/api/admin/bullets/options", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(settings));
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const config = readBulletSettings((key) => stored.get(`bullets.${key}`) ?? null);

    return {
      status: 200,
      body: {
        rows: OPTION_LABELS.map(([field, key, label]) => {
          const value = config[field];
          return { key, label, value: value === null ? "unlimited" : value.toString() };
        }),
      },
    };
  },
});

const adminOptionsRoute = route({
  method: "POST", path: "/api/admin/bullets/options", auth: "admin",
  body: OptionsBodySchema,
  handler: async (ctx, { body }) => {
    // `readBulletSettings` would silently raise the max to meet the min, which
    // is the right thing for a value already in the database and the wrong
    // thing for a form submission — an admin who inverts them has made a
    // mistake and should be told.
    if (body.stockMinPerHour > body.stockMaxPerHour) {
      throw new PluginError("min_above_max", 400);
    }

    const values = [
      { key: "bullets.stock_min_per_hour", value: String(body.stockMinPerHour) },
      { key: "bullets.stock_max_per_hour", value: String(body.stockMaxPerHour) },
      { key: "bullets.max_stock", value: String(body.maxStock) },
      // Stored blank rather than deleted so the row round-trips; blank, absent
      // and unparseable all read as unlimited.
      { key: "bullets.max_cost", value: body.maxCost },
      { key: "bullets.max_buy", value: body.maxBuy },
    ];
    await ctx.transaction(async (tx) => {
      for (const row of values) {
        await tx.db.insert(settings).values(row)
          .onConflictDoUpdate({ target: settings.key, set: { value: row.value } });
      }
    });
    return { status: 204 };
  },
});

const adminStockRoute = route({
  method: "POST", path: "/api/admin/bullets/stock", auth: "admin",
  body: StockBodySchema,
  handler: async (ctx, { body }) => {
    // The ops override is still bound by the same ceilings the restock and the
    // buy route obey, so admin and gameplay cannot disagree about the limits.
    const config = readBulletSettings((key) => ctx.settings.get(key));
    if (body.bulletStock > config.maxStock) {
      throw new PluginError("stock_above_max", 400, { maxStock: config.maxStock });
    }
    if (config.maxCost !== null && BigInt(body.bulletCost) > config.maxCost) {
      throw new PluginError("cost_above_max", 400, { maxCost: config.maxCost.toString() });
    }

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
    kind: "panel", title: "Bullets",
    children: [
      {
        kind: "panel", title: "Bullet stock",
        children: [
          { kind: "table", source: "GET /api/admin/bullets/stock", columns: [
            { key: "name", label: "Name" },
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
      {
        kind: "panel", title: "Options",
        children: [
          { kind: "text", value: "Restock runs lazily on the bullet shop, catching up at most 12 hours. These take effect on the next server restart." },
          { kind: "table", source: "GET /api/admin/bullets/options", columns: [
            { key: "label", label: "Option" },
            { key: "value", label: "Value" },
          ] },
          { kind: "form", action: "POST /api/admin/bullets/options", submitLabel: "Update options", fields: [
            { name: "stockMinPerHour", label: "Stock min per hour", type: "number" },
            { name: "stockMaxPerHour", label: "Stock max per hour", type: "number" },
            { name: "maxStock", label: "Max stock", type: "number" },
            // `text`, not `money`/`number`: blank is a meaningful value here
            // (unlimited) and a typed field cannot express it.
            { name: "maxCost", label: "Max bullet cost (blank = unlimited)", type: "text" },
            { name: "maxBuy", label: "Max bullets per purchase (blank = unlimited)", type: "text" },
          ] },
        ],
      },
    ],
  },
};

/**
 * The restock trigger, and the page's read. It exists because V2 called
 * `restock()` on the bullets module load and GL3 has nowhere else to put it:
 * a core plugin cannot declare jobs, and hanging the restock off the purchase
 * would deadlock — the web page disables the buy button at zero stock, so the
 * buy that would refill the town can never be made.
 *
 * It also answers the price the buy route will actually charge. The page used
 * to read `locations.bullet_cost` from `GET /api/locations` while the buy
 * route charged the owner's lever, so an owned town displayed a price it would
 * not honour.
 */
const shopRoute = route({
  method: "GET",
  path: "/api/bullets/shop",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readBulletSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      // First, and before any location row is read: it locks every location
      // ascending, and a read taken before it would be stale by the time it
      // returned.
      await restockIfDue(tx.db, config);

      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId, bullets: playerStats.bullets })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const locationId = stats?.locationId;
      if (!locationId) throw new PluginError("no_location", 409);

      const [location] = await tx.db.select().from(locations).where(eq(locations.id, locationId));
      if (!location) throw new PluginError("no_location", 409);

      const franchise = await ownerAt(tx, "bullets", locationId);
      const unitCost = effectiveCost(franchise?.lever ?? null, location.bulletCost, config.maxCost);

      return {
        status: 200,
        body: {
          locationId,
          locationName: location.name,
          bulletStock: location.bulletStock,
          // Money crosses the wire as a decimal string; stock and the cap are
          // counts and stay JSON numbers, as `bulletStock` already does in the
          // buy response.
          unitCost: unitCost.toString(),
          maxBuy: config.maxBuy,
          bullets: (stats?.bullets ?? 0n).toString(),
        },
      };
    });
  },
});

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
    const config = readBulletSettings((key) => ctx.settings.get(key));

    // V2's `maxBulletBuy`. Checked before the transaction opens: it reads no
    // row, so there is nothing to lock and nothing to be stale.
    if (config.maxBuy !== null && quantity > config.maxBuy) {
      throw new PluginError("quantity_above_max", 400, { maxBuy: config.maxBuy });
    }

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

      // V2: the factory's owner sets the bullet price and takes half the sale
      // (bullets.inc.php:86 and :225). A null lever means the owner set none,
      // so the location's admin-editable price stands — V2's
      // `if (!!$owner["cost"])`.
      const franchise = await ownerAt(tx, "bullets", locationId);
      // `max_cost` clamps here as well as rejecting at lever-set time: the cap
      // can be lowered after an owner has already set a higher lever, and the
      // figure charged has to follow the cap, not the stale lever.
      const unitCost = effectiveCost(franchise?.lever ?? null, location.bulletCost, config.maxCost);
      const cost = unitCost * BigInt(quantity);

      // RULE 6, player↔player half: buyer and owner go through ONE sorted
      // tx.locks.player call BEFORE either balance moves. payOwner takes the
      // owner's lock itself, but taking it second — after the buyer's —
      // would be an ABBA cycle against a simultaneous buy in the other
      // direction. Regression:
      // apps/server/test/properties-consumer-lock-order.test.ts.
      await tx.locks.player(
        franchise === null || franchise.ownerId === player.id
          ? [player.id]
          : [player.id, franchise.ownerId],
      );

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

      if (franchise !== null) {
        await payOwner(tx, franchise.propertyId, cost / 2n, "properties.bullets");
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
  routes: [shopRoute, buyRoute, adminListRoute, adminStockRoute, adminOptionsListRoute, adminOptionsRoute],
  adminPages: [adminPage],
  // V2's maxBulletCost, enforced where the owner sets their price. The read
  // side clamps too (`effectiveCost`), because the cap can be lowered after a
  // lever was already accepted.
  filters: [capLever],
  providesProperties: [{
    id: "bullets",
    name: "Bullet Factory",
    price: 100_000_000n,          // $1,000,000 in cents — V2's hardcoded figure
    leverLabel: "Price per bullet",
  }],
  // No `menu`, `pages` or `events`: plugin-manifest-endpoint.test.ts:87
  // asserts a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. No `jobs`: buildApp throws at boot
  // if a core plugin declares any (that path has no queue-name prefix).
});
