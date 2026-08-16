import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { propertiesTable, locations, players, playerStats } from "./schema.js";
import { PROPERTIES_MIGRATIONS } from "./migrations.js";
import { adminPage } from "./pages.js";

// ---------------------------------------------------------------------------
// Params schema — id in the path, validated by the loader via `params`.
// ---------------------------------------------------------------------------

const PropertyParamsSchema = z.object({ id: z.string().uuid() });

// ---------------------------------------------------------------------------
// List route (read-only, no locks)
// ---------------------------------------------------------------------------

const listRoute = route({
  method: "GET",
  path: "/api/properties",
  accessInJail: true,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const rows = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          pluginId: propertiesTable.pluginId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
          profit: propertiesTable.profit,
          locationName: locations.name,
          ownerName: players.username,
        })
        .from(propertiesTable)
        .leftJoin(locations, eq(locations.id, propertiesTable.locationId))
        .leftJoin(players, eq(players.id, propertiesTable.ownerPlayerId));

      return {
        status: 200,
        body: {
          rows: rows.map((row) => {
            const decl = ctx.propertyTypes.get(row.pluginId);
            const isOwner = row.ownerPlayerId === player.id;
            return {
              id: row.id,
              locationId: row.locationId,
              locationName: row.locationName ?? "",
              pluginId: row.pluginId,
              typeName: decl?.name ?? row.pluginId,
              // "" when the type is not installed: there is no declared price,
              // so the row is not buyable and the page renders no Buy button.
              price: decl === null ? "" : decl.price.toString(),
              leverLabel: decl?.leverLabel ?? "",
              ownerName: row.ownerPlayerId ? (row.ownerName ?? "") : "—",
              // The lever and the P&L are the owner's business only.
              lever: isOwner ? row.cost.toString() : "",
              profit: isOwner ? row.profit.toString() : "",
            };
          }),
        },
      };
    });
  },
});

// ---------------------------------------------------------------------------
// Buy route
// ---------------------------------------------------------------------------

const buyRoute = route({
  method: "POST",
  path: "/api/properties/:id/buy",
  accessInJail: false,
  accessInHospital: true,
  params: PropertyParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // Unlocked read, only to learn WHICH row (and location) we act on.
      const [before] = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
        })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, params.id));
      if (before === undefined) throw new PluginError("property_not_found", 404);

      // RULE 6: location first, then player — the established order for the
      // location↔player pair (travel/bullets deadlock).
      await tx.locks.location(before.locationId);
      await tx.locks.player([player.id]);

      // Lock-then-recheck (TOCTOU).
      const [row] = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
        })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, params.id))
        .for("update");
      if (row === undefined) throw new PluginError("property_not_found", 404);
      if (row.ownerPlayerId !== null) throw new PluginError("already_owned", 409);

      const [stats] = await tx.db
        .select({ cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (stats === undefined || stats.cash < row.cost) {
        throw new PluginError("insufficient_funds", 409);
      }

      await tx.economy.applyBalanceChange({
        playerId: player.id,
        amount: -row.cost,
        kind: "cash",
        reason: "properties.buy",
      });
      await tx.db
        .update(propertiesTable)
        .set({ ownerPlayerId: player.id })
        .where(eq(propertiesTable.id, row.id));

      // Fetch the location name for the event payload under the same tx.
      const [loc] = await tx.db
        .select({ name: locations.name })
        .from(locations)
        .where(eq(locations.id, row.locationId));

      await tx.events.publish({
        name: "bought",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { propertyName: loc?.name ?? "", cost: row.cost.toString() },
      });

      return { status: 200, body: { propertyId: row.id } };
    });
  },
});

// ---------------------------------------------------------------------------
// Event declarations
// ---------------------------------------------------------------------------

// Re-exported so test/plugin-manifest-endpoint.test.ts can assert against
// the same page object rather than a hand-copied duplicate of its view tree,
// which would silently drift if pages.ts changed.
export { adminPage } from "./pages.js";

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");

/**
 * The page renderer posts every field in a form, sending "" for the ones the
 * admin left blank (`PageRenderer.tsx`'s form `onSubmit`). Blank is
 * normalised to `undefined` here so an update that only changes one column
 * leaves every other column untouched — the theft convention, reused.
 */
function blankable<T extends z.ZodTypeAny>(inner: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((v) => (v === "" ? undefined : v), inner.optional()) as never;
}

/**
 * Extracts a Postgres error code (`err.code` directly, or `err.cause.code`
 * for a driver that wraps it), or null if `err` carries none. Generalised
 * from the old `isUniqueViolation` so the create route can also translate
 * `23503` (foreign-key violation, an unknown `locationId`) instead of
 * letting it fall through to an unhandled 500.
 */
function pgErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  if (
    err instanceof Error &&
    err.cause !== null &&
    typeof err.cause === "object" &&
    err.cause !== undefined &&
    "code" in err.cause &&
    typeof (err.cause as { code: unknown }).code === "string"
  ) {
    return (err.cause as { code: string }).code;
  }
  return null;
}

const PropertyCreateSchema = z
  .object({
    locationId: z.string().uuid(),
    pluginId: z.string().min(1).max(80),
    cost: AdminMoney,
  })
  .strict();

const PropertyUpdateSchema = z
  .object({
    id: z.string().uuid(),
    pluginId: blankable(z.string().min(1).max(80)),
    cost: AdminMoney,
  })
  .strict();

/**
 * Every location as a TableRowsResponse — the create form's select
 * `optionsSource`. It no longer filters out locations that already have a
 * property: since `0004_location_plugin_unique` the key is
 * (location_id, plugin_id), so a town with one type can still take another.
 * The 409 `location_type_taken` guard on the create route is what rejects a
 * genuine duplicate.
 */
const adminLocationsRoute = route({
  method: "GET",
  path: "/api/admin/properties/locations",
  auth: "admin",
  handler: async (ctx) => {
    return ctx.transaction(async (tx) => {
      const rows = (await tx.db.select({ id: locations.id, name: locations.name }).from(locations))
        .map((loc) => ({ locationId: loc.id, locationName: loc.name }));
      return { status: 200, body: { rows } };
    });
  },
});

/**
 * Every property type any installed plugin declares, as a TableRowsResponse —
 * the create form's select `optionsSource`. `pluginId` is the select's
 * `valueKey`; the human `name` is what an admin sees, so nobody types a plugin
 * id by hand any more.
 */
const adminTypesRoute = route({
  method: "GET",
  path: "/api/admin/properties/types",
  auth: "admin",
  handler: async (ctx) => {
    const rows = ctx.propertyTypes.list().map((decl) => ({
      pluginId: decl.id,
      name: decl.name,
      price: decl.price.toString(),
      leverLabel: decl.leverLabel,
    }));
    return { status: 200, body: { rows } };
  },
});

/**
 * Existing properties only, as a TableRowsResponse. `id` is the update
 * form's select `valueKey` — it must resolve to a real property, or an
 * admin picking a location-with-no-property row would submit `id: ""` and
 * get a bare 400 from `PropertyUpdateSchema` with no indication why. A
 * location that has no property simply does not appear here; use
 * `/api/admin/properties/locations` to find those. Not rendered as a
 * table column.
 */
const adminListRoute = route({
  method: "GET",
  path: "/api/admin/properties",
  auth: "admin",
  handler: async (ctx) => {
    return ctx.transaction(async (tx) => {
      const props = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          pluginId: propertiesTable.pluginId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
          profit: propertiesTable.profit,
          locationName: locations.name,
          ownerName: players.username,
        })
        .from(propertiesTable)
        .leftJoin(locations, eq(locations.id, propertiesTable.locationId))
        .leftJoin(players, eq(players.id, propertiesTable.ownerPlayerId));

      const rows = props.map((p) => ({
        id: p.id,
        locationId: p.locationId,
        locationName: p.locationName ?? "",
        plugin: p.pluginId,
        ownerName: p.ownerPlayerId ? (p.ownerName ?? "") : "",
        cost: p.cost.toString(),
        profit: p.profit.toString(),
      }));

      return { status: 200, body: { rows } };
    });
  },
});

const adminCreateRoute = route({
  method: "POST",
  path: "/api/admin/properties",
  auth: "admin",
  body: PropertyCreateSchema,
  // The INSERT takes FOR KEY SHARE on locations[L] via the location_id FK
  // and acquires nothing afterwards (rule 6) — it cannot be half of a
  // deadlock cycle with the buy/sell/claim routes' locations-then-player
  // order, the same reasoning as adminUpdateRoute below.
  handler: async (ctx, { body }) => {
    if (ctx.propertyTypes.get(body.pluginId) === null) {
      throw new PluginError("unknown_property_type", 404);
    }
    const id = uuidv7();
    try {
      await ctx.transaction(async (tx) => {
        await tx.db.insert(propertiesTable).values({
          id,
          locationId: body.locationId,
          pluginId: body.pluginId,
          cost: BigInt(body.cost),
        });
      });
    } catch (err: unknown) {
      const code = pgErrorCode(err);
      // unique(location_id, plugin_id) violation → this town already has a
      // property of this type.
      if (code === "23505") throw new PluginError("location_type_taken", 409);
      // location_id FK violation (unknown locationId) → 404
      if (code === "23503") throw new PluginError("location_not_found", 404);
      throw err;
    }
    return { status: 201, body: { id } };
  },
});

const adminUpdateRoute = route({
  method: "POST",
  path: "/api/admin/properties/update",
  auth: "admin",
  body: PropertyUpdateSchema,
  handler: async (ctx, { body }) => {
    if (body.pluginId !== undefined && ctx.propertyTypes.get(body.pluginId) === null) {
      throw new PluginError("unknown_property_type", 404);
    }
    // The property editor selects FOR UPDATE on exactly one
    // p_properties_properties row and locks nothing else. A transaction
    // holding exactly one lock cannot be half of a deadlock cycle, which is
    // why this route introduces no new deadlock edge — do not grow a second
    // lock in this route.
    const updated = await ctx.transaction(async (tx) => {
      const [existing] = await tx.db
        .select()
        .from(propertiesTable)
        .where(eq(propertiesTable.id, body.id))
        .for("update");
      if (existing === undefined) return false;
      await tx.db
        .update(propertiesTable)
        .set({
          cost: BigInt(body.cost),
          ...(body.pluginId !== undefined && { pluginId: body.pluginId }),
        })
        .where(eq(propertiesTable.id, body.id));
      return true;
    });
    if (!updated) throw new PluginError("property_not_found", 404);
    return { status: 204 };
  },
});

// ---------------------------------------------------------------------------
// Event declarations (cont.)
// ---------------------------------------------------------------------------

const boughtEvent = {
  name: "bought",
  payload: z.object({ propertyName: z.string(), cost: z.string() }),
  describe: "{actorName} bought {propertyName} for {cost}",
  invalidates: ["properties", "me"],
};

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export default definePlugin({
  id: "properties",
  version: "1.0.0",
  basePaths: ["/api/properties", "/api/admin/properties"],
  tables: {
    properties: "p_properties_properties",
  },
  migrations: PROPERTIES_MIGRATIONS,
  routes: [listRoute, buyRoute, adminListRoute, adminLocationsRoute, adminTypesRoute, adminCreateRoute, adminUpdateRoute],
  events: [boughtEvent],
  pages: [],
  adminPages: [adminPage],
});
