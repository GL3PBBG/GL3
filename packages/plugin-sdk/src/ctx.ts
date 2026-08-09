import type { GameEvent } from "@gl3/shared";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FilterPoint } from "./filters.js";

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
   * The lock-ordering contract every multi-row transaction in this game must
   * follow, to rule out deadlocks (`40P01`) against core and other plugins
   * touching the same rows in a different order:
   * - Several players: `player`, never manual `SELECT ... FOR UPDATE` — it
   *   sorts the given ids before locking them.
   * - A gang and a player together: `gangAndPlayer`, never `player` and a
   *   gang lock taken separately — it fixes the one order every gang↔player
   *   path (including core's bank and membership routes) agrees on.
   * - A location alongside a player: `location` first, then the player —
   *   the direction core's bullets purchase locks in.
   * - Jailing a player needs no separate call here: `jail.sendToJail` takes
   *   the player lock itself, in the same order as `economy.applyBalanceChange`.
   */
  readonly locks: {
    player(playerIds: string[]): Promise<void>;
    gangAndPlayer(gangId: string, playerId: string): Promise<void>;
    location(locationId: string): Promise<void>;
  };
  gangLog(entry: GangLogEntry): Promise<void>;
  notify(playerId: string, body: string): Promise<void>;
  /**
   * Buffers the event. The loader publishes after commit and discards on
   * rollback, which makes NOTES.md rule 5 unrepresentable rather than merely
   * documented.
   */
  readonly events: { publish(event: PluginEventInput): Promise<void> };
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
  readonly log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
}
