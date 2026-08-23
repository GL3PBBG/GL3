import {
  definePlugin, filterPoint, InsufficientFundsError, newId, on, PluginError, route,
  type PageSchema, type PlayerSnapshot, type PluginCtx, type RouteResult,
} from "@gl3/plugin-sdk";
import { benefits as membershipBenefits, isMember } from "@gl3/plugin-membership";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, playerStats } from "./schema.js";

/**
 * Ported from `apps/server/src/game/travel/routes.ts` and `service.ts`. Paths,
 * status codes, error strings, response bodies and the `player.travelled`
 * event are unchanged. The lock order is NOT: see §4 below and design
 * the offline port design.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `IdSchema` is restated.
 */
const IdSchema = z.string().uuid();

// --- Admin schemas ---

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");
const TownBodySchema = z.object({
  name: z.string().min(1).max(80),
  travelCost: AdminMoney,
  travelCooldownSeconds: z.coerce.number().int().nonnegative(),
  // Validated in the handler, not by z.enum: the loader answers every zod
  // failure with a generic `invalid_request`, and the spec pins this one to
  // its own code. Optional rather than defaulted: the admin form's untouched
  // <select> has no auto-selected option, so PageRenderer submits
  // `combatMode: ""` for a field the operator never touched. A `.default`
  // only fires on an ABSENT key, so that empty string would reach
  // parseCombatMode and 400 the pre-existing add/update-town flows. "" and
  // absent are treated identically by parseCombatMode below.
  combatMode: z.string().optional(),
}).strict();
const TownUpdateSchema = TownBodySchema.extend({ id: z.string().uuid() }).strict();
const TravelParamsSchema = z.object({ locationId: IdSchema });

/**
 * `undefined` covers both an absent key and the admin form's untouched-select
 * `""` (see TownBodySchema above) — both mean "caller expressed no opinion",
 * so both come back `undefined` rather than defaulting here. That lets
 * adminUpdateRoute tell "no opinion" apart from "explicitly open" and leave
 * the stored mode untouched.
 */
function parseCombatMode(raw: string | undefined): "open" | "underground" | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw !== "open" && raw !== "underground") throw new PluginError("invalid_combat_mode", 400);
  return raw;
}

/** Max attempts before a caller who keeps moving gets a clean 409. */
const MAX_ATTEMPTS = 3;

/** V2 travel.hooks.php: ceil(L_cost * 0.25) while the membership timer runs — ceiling division in bigint. */
function memberFare(cost: bigint, member: boolean): bigint {
  return member ? (cost + 3n) / 4n : cost;
}

const declareBenefit = on(membershipBenefits, (_ctx, list) => [
  ...list,
  { title: "Frequent Flyer Discount", description: "All travel costs are reduced by 75%" },
]);

/**
 * Internal, never reaches the loader: the unlocked pre-read that chose which
 * `locations` rows to lock turned out to be stale, so the transaction is
 * abandoned and retried against the row the player is actually on.
 */
class LocationMovedRetry extends Error {
  constructor() {
    super("player location changed between the pre-read and the lock");
    this.name = "LocationMovedRetry";
  }
}

/**
 * A `locations` row as the travel board is about to show it, before per-caller
 * decoration (`current`, `cooldownRemaining`, art) is stamped on.
 */
export interface LocationListing {
  readonly id: string;
  readonly name: string;
  readonly travelCost: bigint;
  readonly travelCooldownSeconds: number;
  readonly bulletCost: bigint;
  readonly bulletStock: number;
  readonly combatMode: "open" | "underground";
}

/**
 * Runs over the listing `GET /api/locations` is about to return. Travel prices
 * its own board from the raw `locations` row, but other plugins own parts of
 * that economy — bullets subscribes here to replace `bulletCost` with the
 * price its shop actually charges (franchise lever, `max_cost` clamp) so the
 * board never quotes a number the shop would not honour.
 */
export const locationsListed = filterPoint<LocationListing[]>("travel.locationsListed", "propagate");

const listRoute = route({
  method: "GET",
  path: "/api/locations",
  // No jail gate: core's route had none. Listing is not an action.
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const cooldownRemaining = await ctx.cooldown.peek("travel", player.id);

    const { rows, currentLocationId, member } = await ctx.transaction(async (tx) => {
      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      return {
        rows: await tx.db.select().from(locations),
        currentLocationId: stats?.locationId ?? null,
        member: await isMember(tx, player.id),
      };
    });

    // Filters run outside any transaction (spec: Filters) — a subscriber that
    // needs the database opens its own read, as bullets' price quote does.
    const listed = await ctx.filters.apply(
      locationsListed,
      rows.map((l) => ({
        id: l.id,
        name: l.name,
        travelCost: l.travelCost,
        travelCooldownSeconds: l.travelCooldownSeconds,
        bulletCost: l.bulletCost,
        bulletStock: l.bulletStock,
        combatMode: l.combatMode === "underground" ? "underground" as const : "open" as const,
      })),
    );

    // `locations` is a CORE table, so its art lives under the `core` scope
    // even though travel is what renders it. One lookup for every town on the
    // page, not one per row.
    const art = await ctx.assets.resolve("core", listed.map((l) => l.id), "location");

    return {
      status: 200,
      body: {
        locations: listed.map((l) => ({
          id: l.id,
          name: l.name,
          travelCost: memberFare(l.travelCost, member).toString(),
          travelCooldownSeconds: l.travelCooldownSeconds,
          bulletCost: l.bulletCost.toString(),
          bulletStock: l.bulletStock,
          combatMode: l.combatMode,
          current: l.id === currentLocationId,
          cooldownRemaining,
          ...(art.has(l.id) ? { imageUrl: art.get(l.id) as string } : {}),
        })),
      },
    };
  },
});

const travelRoute = route({
  method: "POST",
  path: "/api/travel/:locationId",
  // Travelling is an action, so it gates on jail. The loader runs
  // releaseIfExpired and answers 423 + retry-after, exactly as core's route did.
  accessInJail: false,
  params: TravelParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const toLocationId = params.locationId;

    // (1) Look the destination up BEFORE claiming the cooldown, so a typo
    // costs the player nothing (core's ordering).
    const destination = await ctx.transaction(async (tx) => {
      const [row] = await tx.db
        .select({ travelCooldownSeconds: locations.travelCooldownSeconds })
        .from(locations)
        .where(eq(locations.id, toLocationId));
      return row ?? null;
    });
    if (destination === null) throw new PluginError("location_not_found", 404);

    // (2) One cooldown claim for the whole call. Retries below do not
    // re-acquire it, and only a failure that ENDS the call releases it.
    const won = await ctx.cooldown.acquire("travel", player.id, destination.travelCooldownSeconds);
    if (!won) {
      const retryAfter = await ctx.cooldown.peek("travel", player.id);
      throw new PluginError(
        "on_cooldown",
        429,
        { retryAfter },
        { "retry-after": String(Math.max(retryAfter, 1)) },
      );
    }

    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await attemptTravel(ctx, player, toLocationId);
        } catch (error) {
          if (!(error instanceof LocationMovedRetry)) throw error;
          // Reachable only by one player racing themselves — two concurrent
          // travels past the Redis cooldown. Bounded, then a clean 409.
          if (attempt >= MAX_ATTEMPTS) throw new PluginError("location_changed", 409);
        }
      }
    } catch (error) {
      try {
        // Don't strand the player behind a cooldown they never used.
        await ctx.cooldown.release("travel", player.id);
      } catch (releaseError) {
        ctx.log.error("failed to release travel cooldown after failure", {
          err: String(releaseError), playerId: player.id, locationId: toLocationId,
        });
      }
      throw error;
    }
  },
});

/**
 * §4 — the lock protocol, and the reason this port exists.
 *
 * Every path in this game that touches a `locations` row and a `player_stats`
 * row takes LOCATIONS BEFORE PLAYERS. `bullets` does
 * (`locks.location` then `applyBalanceChange`); core's `performTravel` did the
 * opposite, taking `player_stats` FOR UPDATE first and reaching `locations`
 * afterwards through the implicit FOR KEY SHARE on the `location_id` FK. That
 * inversion closed an ABBA cycle with a bullets purchase — `40P01`, surfacing
 * as a 500 on a well-formed request.
 *
 * Locking only the DESTINATION would close the deadlock but leave the other
 * half open: a travel OUT of L never touches `locations[L]`, so it can still
 * commit inside a buy's window and the buy charges at a location the player
 * has left. Both rows are locked here for that reason.
 *
 * The source id has to be read before it can be locked, which is why the
 * unlocked pre-read below exists. It is a HINT used to choose which rows to
 * lock, never a value the commit depends on: the re-read under the lock is
 * what the transaction trusts for the fare, the destination write and the
 * published event, and a mismatch there abandons the attempt (`LocationMovedRetry`).
 *
 * `already_there` is the one exception, and it is decided BEFORE any lock is
 * taken, straight off the unlocked pre-read — there is no locked backstop for
 * it. That is safe only because the check is rejection-only: it throws before
 * a transaction opens, so nothing commits and no money moves, and the
 * cooldown is released on the way out so a client that lost the race to a
 * concurrent move of its own can simply retry. The one way to observe a wrong
 * answer here is a player racing themselves past the cooldown between the
 * pre-read and this check; if that race instead lands the player back on
 * `toLocationId` under the lock, step 6's mismatch check (`actualFrom !==
 * expectedFrom`) catches it and retries, whose fresh pre-read then throws
 * `already_there` correctly.
 */
async function attemptTravel(
  ctx: PluginCtx,
  player: PlayerSnapshot,
  toLocationId: string,
): Promise<RouteResult> {
  // (3) Unlocked pre-read — see the note above.
  const expectedFrom = await ctx.transaction(async (tx) => {
    const [stats] = await tx.db
      .select({ locationId: playerStats.locationId })
      .from(playerStats)
      .where(eq(playerStats.playerId, player.id));
    return stats?.locationId ?? null;
  });
  // Rejected outright rather than silently no-oped: the fare would be a bug,
  // and succeeding would hide a stale client re-submitting the current location.
  if (expectedFrom === toLocationId) throw new PluginError("already_there", 409);

  return await ctx.transaction(async (tx) => {
    // (4) LOCATIONS FIRST, both of them, ascending id inside the helper.
    await tx.locks.locations([expectedFrom, toLocationId]);
    // (5) Then the player. Explicit, because a zero-fare travel never calls
    // applyBalanceChange and would otherwise hold no player lock at all.
    // Defence in depth: the lost-update race it prevents isn't reachable
    // through travelRoute today, since ctx.cooldown.acquire's SET NX admits
    // only one in-flight travel per player — a Redis-level accident of the
    // current caller, not a database guarantee. Evict that key, or call
    // attemptTravel from anywhere else, and this lock is what stops a
    // committed player.travelled naming a fromLocationId the player had left.
    await tx.locks.player([player.id]);

    // (6) The value the transaction actually trusts.
    const [current] = await tx.db
      .select({ locationId: playerStats.locationId })
      .from(playerStats)
      .where(eq(playerStats.playerId, player.id));
    const actualFrom = current?.locationId ?? null;
    if (actualFrom !== expectedFrom) throw new LocationMovedRetry();

    // (7) Fare read under the lock. Absent = deleted since step 1.
    const [destination] = await tx.db
      .select({ id: locations.id, travelCost: locations.travelCost })
      .from(locations)
      .where(eq(locations.id, toLocationId));
    if (!destination) throw new PluginError("location_not_found", 404);

    const member = await isMember(tx, player.id);
    const fare = memberFare(destination.travelCost, member);

    if (fare > 0n) {
      try {
        await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: -fare,
          kind: "cash",
          reason: "travel.cost",
          refId: destination.id,
        });
      } catch (error) {
        // The loader maps no status for this by design (errors.ts) — bank,
        // travel and bullets answer 409 while gangs answers 400.
        if (error instanceof InsufficientFundsError) {
          throw new PluginError("insufficient_funds", 409);
        }
        throw error;
      }
    }

    // (8) The implicit FOR KEY SHARE this takes on the destination lands on a
    // row this transaction already holds FOR UPDATE — a no-op against
    // ourselves, not a lock-order hazard. `.returning()` replaces core's
    // post-commit re-read (the bullets precedent).
    const [fresh] = await tx.db
      .update(playerStats)
      .set({ locationId: destination.id })
      .where(eq(playerStats.playerId, player.id))
      .returning({ cash: playerStats.cash });
    if (!fresh) throw new PluginError("location_not_found", 404);

    // (9) Buffered here, published after commit, discarded on rollback.
    // Audience is PRIVATE, as core's was.
    await tx.events.publishCore({
      type: "player.travelled",
      actorId: player.id,
      actorName: player.username,
      audience: { kind: "player", playerId: player.id },
      fromLocationId: actualFrom,
      toLocationId: destination.id,
      cost: fare.toString(),
    });

    return { status: 200, body: { locationId: destination.id, cash: fresh.cash.toString() } };
  });
}

// --- Admin routes ---

const adminListRoute = route({
  method: "GET", path: "/api/admin/travel/locations", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(locations));
    return {
      status: 200,
      body: {
        rows: rows.map((l) => ({
          id: l.id, name: l.name,
          travelCost: l.travelCost.toString(),
          travelCooldownSeconds: String(l.travelCooldownSeconds),
          combatMode: l.combatMode,
        })),
      },
    };
  },
});

const adminCreateRoute = route({
  method: "POST", path: "/api/admin/travel/locations", auth: "admin",
  body: TownBodySchema,
  handler: async (ctx, { body }) => {
    const combatMode = parseCombatMode(body.combatMode) ?? "open";
    const id = newId();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(locations).values({
        id, name: body.name,
        travelCost: BigInt(body.travelCost),
        travelCooldownSeconds: body.travelCooldownSeconds,
        bulletStock: 0, bulletCost: 0n,
        combatMode,
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminUpdateRoute = route({
  method: "POST", path: "/api/admin/travel/locations/update", auth: "admin",
  body: TownUpdateSchema,
  handler: async (ctx, { body }) => {
    // Computed before the transaction, same as create — but here `undefined`
    // ("no opinion") is a real outcome, not defaulted, so the mode below is
    // included in the update only when the caller actually asked for one.
    const mode = parseCombatMode(body.combatMode);
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db.update(locations)
        .set({
          name: body.name,
          travelCost: BigInt(body.travelCost),
          travelCooldownSeconds: body.travelCooldownSeconds,
          ...(mode !== undefined ? { combatMode: mode } : {}),
        })
        .where(eq(locations.id, body.id))
        .returning({ id: locations.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("location_not_found", 404);
    return { status: 204 };
  },
});

/**
 * drizzle re-throws the driver's `PostgresError` either directly or wrapped as
 * an `Error` whose `cause` is it (gangs' helper, restated — `@gl3/shared` and
 * `postgres` are both off-limits to a plugin package). Guards, not casts.
 */
function pgErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("code" in value)) return null;
  const { code } = value;
  return typeof code === "string" ? code : null;
}

const isForeignKeyViolation = (error: unknown): boolean =>
  pgErrorCode(error) === "23503" ||
  (error instanceof Error && pgErrorCode(error.cause) === "23503");

const adminDeleteRoute = route({
  method: "DELETE", path: "/api/admin/travel/locations/:id", auth: "admin",
  params: z.object({ id: IdSchema }),
  handler: async (ctx, { params }) => {
    let deleted: boolean;
    try {
      deleted = await ctx.transaction(async (tx) => {
        // `player_stats.location_id` is ON DELETE SET NULL, so the database
        // would strand every player standing here on a null location without
        // a word. Refused instead, same reasoning as core's `role_in_use`:
        // moving them out first makes the displacement deliberate.
        const [occupant] = await tx.db.select({ playerId: playerStats.playerId })
          .from(playerStats).where(eq(playerStats.locationId, params.id)).limit(1);
        if (occupant !== undefined) throw new PluginError("location_in_use", 409);
        // Two plugin tables reference locations with ON DELETE CASCADE, so
        // the FK catch below never fires for them — the rows would just
        // vanish. Only the rows that are someone's ASSET block the delete: an
        // owned property deed was paid for, and an open casino hand holds an
        // escrowed wager (an unowned property is config and a settled hand is
        // history — both may cascade). Checked by table name through
        // to_regclass rather than by import, so travel gains no dependency
        // edge and a deployment without those plugins skips the check.
        // Read-only peeking only — cleanup stays with the owning plugin.
        const cascadeAssets: { table: string; predicate: string }[] = [
          { table: "p_properties_properties", predicate: "owner_player_id is not null" },
          { table: "p_casino_sessions", predicate: "status = 'open'" },
        ];
        for (const { table, predicate } of cascadeAssets) {
          // postgres.js returns an Array subclass of row objects; guards,
          // not casts (packages/*).
          const guarded: unknown = await tx.db.execute(
            sql`select to_regclass(${table}) is not null as present`,
          );
          const first: unknown = Array.isArray(guarded) ? guarded[0] : undefined;
          const present = typeof first === "object" && first !== null
            && "present" in first && (first as { present: unknown }).present === true;
          if (!present) continue;
          const hit: unknown = await tx.db.execute(sql`
            select 1 from ${sql.raw(table)}
            where location_id = ${params.id} and ${sql.raw(predicate)} limit 1
          `);
          if (Array.isArray(hit) && hit.length > 0) throw new PluginError("location_in_use", 409);
        }
        const result = await tx.db.delete(locations)
          .where(eq(locations.id, params.id)).returning({ id: locations.id });
        return result.length > 0;
      });
    } catch (error) {
      // A plugin table's FK (a property deed, a garaged car) still points
      // here — same answer as an occupant, found by the database instead.
      if (isForeignKeyViolation(error)) throw new PluginError("location_in_use", 409);
      throw error;
    }
    if (!deleted) throw new PluginError("location_not_found", 404);
    return { status: 204 };
  },
});

const adminModesRoute = route({
  method: "GET", path: "/api/admin/travel/combat-modes", auth: "admin",
  handler: async () => ({
    status: 200,
    body: { rows: [
      { id: "open", name: "Open" },
      { id: "underground", name: "Underground" },
    ] },
  }),
});

const adminPage: PageSchema = {
  id: "travel-admin",
  path: "/admin/travel",
  view: {
    kind: "panel", title: "Towns",
    children: [
      { kind: "table", source: "GET /api/admin/travel/locations", rowActions: [
        { label: "Delete", action: "DELETE /api/admin/travel/locations/:id", confirm: "Delete this town? Refused while anyone is standing in it." },
      ], columns: [
        { key: "name", label: "Name" },
        { key: "travelCost", label: "Travel cost" },
        { key: "travelCooldownSeconds", label: "Cooldown (s)" },
        { key: "combatMode", label: "Combat" },
      ] },
      { kind: "form", action: "POST /api/admin/travel/locations", submitLabel: "Add town", fields: [
        { name: "name", label: "Name", type: "text" },
        { name: "travelCost", label: "Travel cost", type: "money" },
        { name: "travelCooldownSeconds", label: "Cooldown seconds", type: "number" },
        { name: "combatMode", label: "Combat mode", type: "select", optionsSource: "GET /api/admin/travel/combat-modes", valueKey: "id", labelKey: "name" },
      ] },
      { kind: "form", action: "POST /api/admin/travel/locations/update", submitLabel: "Update town", fields: [
        { name: "id", label: "Town", type: "select", optionsSource: "GET /api/admin/travel/locations", valueKey: "id", labelKey: "name" },
        { name: "name", label: "Name", type: "text" },
        { name: "travelCost", label: "Travel cost", type: "money" },
        { name: "travelCooldownSeconds", label: "Cooldown seconds", type: "number" },
        { name: "combatMode", label: "Combat mode", type: "select", optionsSource: "GET /api/admin/travel/combat-modes", valueKey: "id", labelKey: "name" },
      ] },
    ],
  },
};

export default definePlugin({
  id: "travel",
  version: "1.0.0",
  // First port claiming two base paths; plugins/validate.ts checks each route
  // path is contained in one of them and that no other plugin claims either.
  basePaths: ["/api/locations", "/api/travel", "/api/admin/travel"],
  // Real import dependencies (see this package's package.json) —
  // enforced against the final boot set by plugins/validate.ts.
  requires: ["membership"],
  pages: [{
    id: "travel.index",
    path: "/travel",
    menu: { label: "Travel", order: 36, category: "town" },
    // Stub view: the client renders a hand-written override (apps/web
    // PAGE_OVERRIDES) for this id; the schema view exists because a
    // page declaration requires one.
    view: { kind: "list", items: [] },
  }],
  routes: [listRoute, travelRoute, adminListRoute, adminCreateRoute, adminUpdateRoute, adminDeleteRoute, adminModesRoute],
  adminPages: [adminPage],
  filters: [declareBenefit],
  // No `menu`, `pages` or `events`: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. No `jobs`: buildApp throws at boot if
  // a core plugin declares any.
});
