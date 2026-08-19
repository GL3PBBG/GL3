import type { GameEvent } from "@gl3/shared";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FilterPoint } from "./filters.js";
import type { AssetSlot, PropertyTypeDecl } from "./manifest.js";

/**
 * The transaction handle a plugin sees. `query` is omitted, so
 * `tx.db.query.players` does not exist — a plugin can only name tables it
 * imported itself, which is how "nothing in core may reach into a plugin's
 * tables, and the converse" (spec) becomes a compiler rule. `select`,
 * `insert`, `update`, `delete` and `execute` all survive the omission.
 *
 * The two generics are the loosest pair that a real `PgTransaction` is
 * assignable to under `exactOptionalPropertyTypes`, checked against drizzle
 * 0.45.2: `TFullSchema` must admit core's schema module (the bare
 * `PgDatabase<PgQueryResultHKT>` default of `Record<string, never>` rejects
 * it on `_.fullSchema`), and `TSchema` must be the base
 * `TablesRelationalConfig` rather than the default
 * `ExtractTablesWithRelations<TFullSchema>` (which rejects it on
 * `_.schema`). Widening `TFullSchema` is precisely what would have turned
 * `query` back into a usable index signature over every table name — hence
 * the `Omit`, which carries the isolation the generics no longer can.
 */
export type PluginDbTx = Omit<
  PgDatabase<PgQueryResultHKT, Record<string, unknown>, TablesRelationalConfig>,
  "query"
>;

// Compile-time guard for the paragraph above: `query` is the one member whose
// absence is load-bearing, and it would come back silently if `PluginDbTx`
// were ever simplified back to a bare `PgDatabase<...>`. Verified to fail by
// dropping the `Omit`. Types only — nothing is emitted.
type _Assert<T extends true> = T;
type _NoRelationalQuery = _Assert<"query" extends keyof PluginDbTx ? false : true>;

export interface PlayerSnapshot {
  id: string;
  username: string;
  cash: bigint;
  bank: bigint;
  level: number;
  jailed: boolean;
  gangId: string | null;
}

/** No `jobId`: a plugin never writes an idempotency key (spec, rule 1). */
export interface PluginBalanceChange {
  playerId: string;
  amount: bigint;
  kind: "cash" | "bank" | "points";
  reason: string;
  refId?: string;
}

/**
 * Mirrors core's `GangBalanceChange` field for field. `kind` is required and
 * has no default — it selects the `gangs.cash` vs `gangs.bank` column — and
 * there is deliberately no actor field, because core records a gang balance
 * movement with `playerId: null` and never reads one.
 */
export interface PluginGangBalanceChange {
  gangId: string;
  amount: bigint;
  kind: "cash" | "bank";
  reason: string;
  refId?: string;
}

/**
 * Mirrors core's `appendGangLog(tx, gangId, playerId, message)` field for
 * field — the positional parameters gathered into an object, with nothing
 * added. The SDK type is the plugin-facing contract and must not describe a
 * gang log entry core cannot write.
 */
export interface GangLogEntry {
  gangId: string;
  playerId: string | null;
  message: string;
}

/** What a plugin supplies; the loader wraps it in the `plugin.event` envelope. */
export interface PluginEventInput {
  name: string;
  actorId: string;
  actorName: string;
  audience: GameEvent["audience"];
  payload: Record<string, unknown>;
}

/**
 * `Omit` does not distribute over a union — `Omit<A | B, "id">` collapses to
 * the shared keys and destroys the discriminant. This conditional type is a
 * naked type parameter, so it distributes and each variant keeps its own
 * fields.
 */
type OmitFromUnion<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What a plugin supplies to `tx.events.publishCore`: every core event variant
 * minus the two fields core fills in — `id` (uuidv7) and `at` (ISO string).
 * `plugin.event` is excluded; that envelope has its own input type,
 * `PluginEventInput`.
 *
 * Derived from `GameEvent` rather than restated, so a new core variant reaches
 * plugins automatically and cannot drift. The cost is that adding a core
 * variant is an SDK surface change — `apps/server/test/plugin-ctx-core-events.test.ts`
 * is the guard that makes that coupling visible.
 */
export type CoreEventInput = OmitFromUnion<
  Exclude<GameEvent, { type: "plugin.event" }>,
  "id" | "at"
>;

/**
 * Mirrors core's `RankUpResult` (`economy/ranks.ts`) field for field — the
 * promotion details `applyExpAndRankUp` returns on a fresh rank-up, or
 * `null` when nothing changed (no exp gained, or already at the qualifying
 * rank).
 */
export interface RankUpResult {
  rankId: string;
  rankName: string;
  cashReward: bigint;
  bulletReward: number;
  maxHealth: number;
}

export interface PluginTx {
  readonly db: PluginDbTx;
  readonly economy: {
    applyBalanceChange(change: PluginBalanceChange): Promise<bigint>;
    applyGangBalanceChange(change: PluginGangBalanceChange): Promise<bigint>;
    addExp(playerId: string, amount: bigint): Promise<void>;
    applyExpAndRankUp(playerId: string, expGain: bigint): Promise<RankUpResult | null>;
  };
  /**
   * `sendToJail` takes a player lock internally (ascending id order, same as
   * `economy.applyBalanceChange`), so a transaction that also moves money is
   * already safe — the two touch player rows in the same fixed order no
   * matter which one a plugin calls first.
   */
  readonly jail: { sendToJail(playerId: string, seconds: number): Promise<Date> };
  /**
   * `sendToHospital` takes a player lock internally (ascending id order, same
   * as `economy.applyBalanceChange` and `jail.sendToJail`), so a transaction
   * that also moves money is already safe whichever order a plugin calls them
   * in. Sets `health = 0` alongside the deadline.
   */
  readonly hospital: { sendToHospital(playerId: string, seconds: number): Promise<Date> };
  /**
   * The lock-ordering contract every multi-row transaction in this game must
   * follow, to rule out deadlocks (`40P01`) against core and other plugins
   * touching the same rows in a different order:
   * - Several players: `player`, never manual `SELECT ... FOR UPDATE` — it
   *   sorts the given ids before locking them.
   * - A gang and a player together: `gangAndPlayer`, never `player` and a
   *   gang lock taken separately — it fixes the one order every gang↔player
   *   path (including core's bank and membership routes) agrees on.
   * - A location alongside a player: `location` first, then the player.
   * - SEVERAL locations alongside a player: `locations` first (it sorts them),
   *   then the player — never repeated `location` calls, whose relative order
   *   is exactly what a deadlock needs. `travel` is the caller.
   * - Jailing a player needs no separate call here: `jail.sendToJail` takes
   *   the player lock itself, in the same order as `economy.applyBalanceChange`.
   */
  readonly locks: {
    player(playerIds: string[]): Promise<void>;
    gangAndPlayer(gangId: string, playerId: string): Promise<void>;
    location(locationId: string): Promise<void>;
    locations(locationIds: readonly (string | null)[]): Promise<void>;
  };
  /**
   * Per-player key→expiry timers over core's `player_timers` — the table V2's
   * open-ended `userTimers` migrated into, so a plugin can read keys a V2
   * custom module wrote. `set` is an upsert on the (player, key) primary key.
   * `clear` reports whether a row was actually deleted, which is what lets a
   * caller use the DELETE as an atomic once-only claim (membership's lazy
   * expiry notification) instead of a check-then-act.
   *
   * Rule-6 note: the upsert's FK takes FOR KEY SHARE on the players row.
   * Every write path must already hold that player FOR UPDATE (via
   * `economy.applyBalanceChange` or `locks.player`) before calling `set`.
   */
  readonly timers: {
    get(playerId: string, key: string): Promise<Date | null>;
    set(playerId: string, key: string, expiresAt: Date): Promise<void>;
    clear(playerId: string, key: string): Promise<boolean>;
  };
  /**
   * Reads core's three-layer gang permission mask
   * (`game/gangs/permissions.ts`): boss/underboss bypass, then a
   * `gang_permissions` row that must join a live `gang_members` row.
   *
   * `permission` is `string`, not core's `GangPermission` union — that type
   * lives in `apps/server` and the SDK may not import it. A value outside the
   * known set answers `false`, which is what the underlying query would have
   * answered anyway; a plugin validates the enum on its own route param.
   *
   * Always reads through the LIVE TRANSACTION, never a fresh connection. That
   * is what lets a caller do the lock-then-recheck TOCTOU defence
   * (NOTES.md rule 2): call it once before `locks.gangAndPlayer` for the
   * unlocked pre-check, and again after for a read that observes post-lock,
   * post-commit state. The gang bank's withdraw route
   * (`packages/plugins/gangs/src/index.ts`'s `withdrawRoute`, guarding
   * `bank.withdraw`) depends on exactly this.
   */
  readonly gangs: {
    hasPermission(gangId: string, playerId: string, permission: string): Promise<boolean>;
  };
  gangLog(entry: GangLogEntry): Promise<void>;
  notify(playerId: string, body: string): Promise<void>;
  /**
   * Both methods buffer into ONE array, so a handler's relative call order
   * survives to the wire — `game/crimes/worker.ts` publishes `crime.resolved`
   * before `player.jailed` deliberately, and a port must be able to keep that.
   * The loader publishes after commit and discards on rollback, which makes
   * NOTES.md rule 5 unrepresentable rather than merely documented.
   */
  readonly events: {
    publish(event: PluginEventInput): Promise<void>;
    /** Publishes a core `GameEventSchema` variant verbatim — no envelope. */
    publishCore(event: CoreEventInput): Promise<void>;
  };
}

export interface JobContext { readonly id: string; readonly seed: string; readonly rng: PluginRng }
export interface PluginRng { int(minInclusive: number, maxExclusive: number): number; bigint(min: bigint, max: bigint): bigint }

export interface PluginCtx {
  readonly pluginId: string;
  /** Null on a `auth: "public"` route and inside a job. */
  readonly player: PlayerSnapshot | null;
  transaction<T>(fn: (tx: PluginTx) => Promise<T>): Promise<T>;
  readonly cooldown: {
    acquire(action: string, playerId: string, ttlSeconds: number): Promise<boolean>;
    peek(action: string, playerId: string): Promise<number>;
    release(action: string, playerId: string): Promise<void>;
  };
  readonly jobs: { enqueue(name: string, data: Record<string, unknown>): Promise<string> };
  readonly job: JobContext | null;
  readonly filters: { apply<T>(point: FilterPoint<T>, value: T): Promise<T> };
  readonly settings: { get(key: string): string | null };
  /**
   * Every property type declared by any installed plugin, from the loader's
   * registry. Read-only manifest data — the same information `GET /api/plugins`
   * already serves — so every plugin sees it, not only `properties`.
   */
  readonly propertyTypes: {
    get(id: string): PropertyTypeDecl | null;
    list(): readonly PropertyTypeDecl[];
  };
  /**
   * Every installed plugin's id, from the loader's manifest list — the same
   * shape as `propertyTypes` above, added for the same reason: cross-plugin,
   * loader-only data a route handler cannot otherwise see. `casino`'s
   * `buildRegistry` is the first consumer — it validates a `GameDef.id`
   * declared through a filter subscription against real installed ids, which
   * `definePlugin` cannot check for `providesProperties` (spec §3, the
   * validation-gap risk).
   */
  readonly installedPluginIds: ReadonlySet<string>;
  /**
   * Every image slot declared by any installed plugin, plus core's own, from
   * the loader's registry. `scope` is the declaring plugin's id (or `"core"`)
   * and is derived, never author-supplied. Same read-only manifest-data shape
   * as `propertyTypes`.
   */
  readonly assetSlots: {
    get(scope: string, slot: string): AssetSlot | null;
    list(): readonly AssetSlot[];
  };
  /**
   * Image URLs for entities, keyed by entity id.
   *
   * Batched by construction: `resolve` takes an ARRAY and returns a Map, and
   * there is deliberately no single-id accessor anywhere in this surface. A
   * list page is the common case for art, and a per-row lookup inside a
   * `.map()` is an N+1 that stays invisible until a town has forty items in it.
   *
   * An entity with no art bound is absent from the Map — not an error, just
   * the normal state of a row nobody has uploaded art for yet. The renderer
   * falls back to its placeholder.
   *
   * Reads only, and cross-scope reads are allowed on purpose: `combat` renders
   * a weapon whose `items` rows are core-scope. Writes go through the admin
   * bind route, which checks `hasPermission(scope)` — so reading another
   * plugin's art is free and changing it is not.
   */
  readonly assets: {
    resolve(scope: string, entityIds: readonly string[], slot: string): Promise<Map<string, string>>;
    /** `resolve` with `scope` fixed to the calling plugin's own id. */
    mine(entityIds: readonly string[], slot: string): Promise<Map<string, string>>;
    /**
     * The one image bound to a `singleton: true` slot, or null when none is.
     *
     * Single-valued rather than batched, and that is not a contradiction of the
     * batching rule above: a singleton is one row by definition, so there is no
     * list to N+1 over.
     */
    singleton(scope: string, slot: string): Promise<string | null>;
  };
  readonly log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
}
