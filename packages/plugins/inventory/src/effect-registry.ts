import { filterPoint, isPluginError, PluginError, type PluginCtx, type Pool } from "@gl3/plugin-sdk";

/**
 * What using an item does, stated as FIGURES. A def never touches the database,
 * the clock or the ledger: it is handed a snapshot and returns deltas, and the
 * use route bounds every one of them and writes every row. That is the split
 * casino's `GameDef`/`resolvePayout` established, for the same reason — it makes
 * installing a plugin that adds an item effect a smaller act of trust than
 * installing an arbitrary plugin.
 *
 * Every field is optional: an effect that only prints a line is legal.
 */
export interface ItemEffectOutcome {
  /** Signed. Bounded so health lands within [MIN_HEALTH_AFTER_USE, maxHealth]. */
  healthDelta?: number;
  /** Bounded to [0, MAX_EXP_PER_USE] — an item may grant exp, never take it. */
  expDelta?: number;
  /** A decimal string, never a JSON number (the money rule). May be negative. */
  cashDelta?: string;
  /**
   * Signed, per pool. Positive is a grant — clamped at the pool's max by
   * `tx.attributes.grant`; negative is a cost — refused with a 409
   * `insufficient_<pool>` by `tx.attributes.spend`, which rolls the whole
   * transaction back, qty decrement included, so an unaffordable item is
   * never consumed. Unlike health/exp/cash, the BOUNDS live in
   * `tx.attributes` (the one authority for pool writes, player-attributes
   * cluster); `boundOutcome` only sanitises shape.
   */
  poolDeltas?: Partial<Record<Pool, number>>;
  /** Shown to the player after the use. Truncated — a def controls its length. */
  message?: string;
}

/** Fixed iteration order for pool deltas — the route applies in this order too. */
export const POOL_ORDER = ["energy", "will", "brave"] as const satisfies readonly Pool[];

export interface PoolSnapshot { value: number; max: number }

export interface ItemEffectSnapshot {
  health: number;
  maxHealth: number;
  /**
   * `player_stats.exp` is a bigint column, narrowed to a number here so a def
   * stays arithmetic-simple. Lossy above 2^53, which no reachable exp total
   * comes near; the write back is bigint, so nothing rounds on the way in.
   */
  exp: number;
  /** Decimal string, per the money rule. Always a non-negative integer. */
  cash: string;
  /**
   * The three regen pools, settled under the player lock before the def runs
   * (`tx.attributes.read`), so regen counts. `max === 0` means the pool is
   * inactive on this install — no plugin declared it, and the settle never
   * seeds an undeclared max. A def that needs the pool should refuse rather
   * than no-op (the built-in `pools` def answers `pool_not_active`).
   */
  pools: Record<Pool, PoolSnapshot>;
}

export interface ItemEffectDef {
  /** Unique across the registry. An item names its def with `effects.kind`. */
  kind: string;
  /** Human-readable, for the inventory listing and the admin items table. */
  label: string;
  /**
   * PURE: no IO, no ctx, no clock, no randomness.
   *
   * `config` is the item's `effects` jsonb (minus `kind`) laid over its `meta`
   * jsonb, with `effects` winning on a shared key — `meta` is where V2's
   * `itemMeta` EAV landed and is not editable here, `effects` is what an admin
   * sets, so the editable half must be the one that wins.
   *
   * Throwing is allowed and is the way to refuse: the route turns anything a
   * def throws into a clean 400 rather than a 500 (`guardEffect`).
   */
  apply(config: Record<string, unknown>, snapshot: ItemEffectSnapshot): ItemEffectOutcome;
}

/**
 * `"collect"`, like `inventory.itemActions` and unlike `casino.games`: one
 * plugin's throwing subscriber must not take the inventory listing down with
 * it. A def it never contributed is simply absent, and an item naming that
 * kind refuses with `unknown_effect` at use time.
 */
export const itemEffects = filterPoint<ItemEffectDef[]>("inventory.itemEffects", "collect");

/** The kind an item with no `effects.kind` selects — every item that exists today. */
export const HEAL_EFFECT_KIND = "heal";

/**
 * The most exp one use may grant. Unlike a casino payout, which has the wager
 * to scale against, an item effect has no natural bound — so this is an
 * outright ceiling. Without one, any installed plugin's def is an unbounded
 * exp faucet.
 */
export const MAX_EXP_PER_USE = 10_000;

/** The same argument, for cash. */
export const MAX_CASH_PER_USE = 1_000_000n;

/**
 * An item may hurt but must never kill. Death is combat's path — it admits to
 * hospital, seizes properties and publishes the kill; a consumable that drove
 * health to 0 outside it would strand a player at zero health with none of
 * that having happened.
 */
export const MIN_HEALTH_AFTER_USE = 1;

/** How much of a def's `message` reaches the player. See `guardEffect`. */
const MAX_MESSAGE_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The built-in, and the base of every registry: `{ heal: n }` raises health by
 * n. It does NOT arrive through the filter chain, which is what makes every
 * item that exists today — including every V2-migrated one, none of which
 * carries a `kind` — behave exactly as it did before the registry existed.
 *
 * It refuses an item with no usable heal figure with the same `wrong_slot` 400
 * the route answered before, so a consumable whose jsonb says nothing sensible
 * still cannot be spent.
 */
export const HEAL_EFFECT: ItemEffectDef = {
  kind: HEAL_EFFECT_KIND,
  label: "Heal",
  apply(config) {
    const heal = config["heal"];
    if (typeof heal !== "number" || !Number.isInteger(heal) || heal <= 0) {
      throw new PluginError("wrong_slot", 400);
    }
    return { healthDelta: heal };
  },
};

export const POOLS_EFFECT_KIND = "pools";

/**
 * The second built-in: `{ kind: "pools", pools: { brave: 3, energy: -4 } }`
 * moves the named pools by the named amounts. Refusals are PluginErrors so
 * `guardEffect` passes them through untouched:
 * - `wrong_slot`: config the def cannot read — same code the route gives any
 *   unusable consumable.
 * - `pool_not_active`: a named pool has `max === 0` (nobody declared it on
 *   this install) — refusing beats silently burning the item as a no-op.
 * - `already_full`: positive deltas exist and EVERY one targets a full pool —
 *   using "refill brave, cost energy" at full brave would waste both the item
 *   and the energy. Mirrors the route's heal-at-full-health 409.
 */
export const POOLS_EFFECT: ItemEffectDef = {
  kind: POOLS_EFFECT_KIND,
  label: "Pools",
  apply(config, snapshot) {
    const raw = config["pools"];
    if (!isRecord(raw)) throw new PluginError("wrong_slot", 400);
    const deltas: Partial<Record<Pool, number>> = {};
    for (const pool of POOL_ORDER) {
      const value = raw[pool];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value === 0) {
        throw new PluginError("wrong_slot", 400);
      }
      deltas[pool] = value;
    }
    const named = POOL_ORDER.filter((pool) => deltas[pool] !== undefined);
    if (named.length === 0) throw new PluginError("wrong_slot", 400);
    for (const pool of named) {
      if (snapshot.pools[pool].max === 0) {
        throw new PluginError("pool_not_active", 400, { pool });
      }
    }
    const positives = named.filter((pool) => (deltas[pool] ?? 0) > 0);
    if (
      positives.length > 0
      && positives.every((pool) => snapshot.pools[pool].value >= snapshot.pools[pool].max)
    ) {
      throw new PluginError("already_full", 409);
    }
    return { poolDeltas: deltas };
  },
};

/**
 * Built on first use, request-time rather than boot-time for the reason
 * `casino.buildRegistry` records: a def arrives inside a filter subscription
 * and `definePlugin` cannot see it.
 *
 * A duplicate kind REFUSES, mirroring `buildRegistry` exactly. Silently
 * letting the first win would make which def runs depend on subscriber order,
 * and a kind colliding with `heal` would quietly rewrite every legacy item.
 * This is an install-time misconfiguration and it is loud on purpose.
 */
export async function buildEffectRegistry(
  ctx: Pick<PluginCtx, "filters">,
): Promise<Map<string, ItemEffectDef>> {
  const declared = await ctx.filters.apply(itemEffects, []);
  const registry = new Map<string, ItemEffectDef>([
    [HEAL_EFFECT.kind, HEAL_EFFECT],
    [POOLS_EFFECT.kind, POOLS_EFFECT],
  ]);
  for (const def of declared) {
    if (registry.has(def.kind)) throw new Error(`duplicate item effect kind "${def.kind}"`);
    registry.set(def.kind, def);
  }
  return registry;
}

/**
 * Runs a def's `apply` and turns anything it throws into a clean refusal —
 * casino's `guardGame`, for the same reason: a def is third-party code called
 * inside a route handler, and `routes.ts` re-throws whatever is not a
 * `PluginError` as a 500 with a stack trace.
 *
 * `isPluginError` rather than `instanceof`: a `PLUGIN_PACKAGES`-loaded plugin
 * brings its own `@gl3/plugin-sdk` copy, so the class identities differ.
 * `detail` is truncated because a def controls both its content and its
 * length, and it rides a response to the player.
 */
export function guardEffect<T>(kind: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (isPluginError(error)) throw error;
    const raw = error instanceof Error ? error.message : String(error);
    throw new PluginError("effect_failed", 400, { kind, detail: raw.slice(0, MAX_MESSAGE_LENGTH) });
  }
}

/** What the route actually writes, after every figure a def stated is bounded. */
export interface BoundedOutcome {
  /** The absolute health to store — not a delta. */
  health: number;
  /** `health - snapshot.health`, so a caller need not subtract it again. */
  healed: number;
  expDelta: bigint;
  cashDelta: bigint;
  poolDeltas: Partial<Record<Pool, number>>;
  message: string | null;
}

/** A decimal integer, optionally negative. Anything else is not a figure. */
const CASH_DELTA_PATTERN = /^-?\d+$/;

function intOrZero(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

/**
 * Every bound the hub places on a def's figures, in one pure function.
 *
 * Clamping rather than refusing is deliberate, and it is `resolvePayout`'s own
 * reasoning: the item is already spent by the time `apply` runs, so a use that
 * did nothing at all because the def misbehaved would take the item and give
 * nothing back. A figure that cannot be read as a figure — a NaN delta, a
 * `cashDelta` that is not a decimal string — is treated as zero for the same
 * reason.
 *
 * The one thing NOT clamped is a def that throws; that refuses outright
 * (`guardEffect`), before the item is spent.
 */
export function boundOutcome(
  outcome: ItemEffectOutcome,
  snapshot: ItemEffectSnapshot,
): BoundedOutcome {
  const healthDelta = intOrZero(outcome.healthDelta);
  // A zero delta must leave health exactly alone. Clamping unconditionally
  // would trim a player whose maxHealth had just dropped (a rank change) as a
  // side effect of using an item that never claimed to touch health.
  const health = healthDelta === 0
    ? snapshot.health
    : Math.min(snapshot.maxHealth, Math.max(MIN_HEALTH_AFTER_USE, snapshot.health + healthDelta));

  const expDelta = BigInt(Math.min(MAX_EXP_PER_USE, Math.max(0, intOrZero(outcome.expDelta))));

  let cashDelta = 0n;
  const rawCash = outcome.cashDelta;
  if (typeof rawCash === "string" && CASH_DELTA_PATTERN.test(rawCash)) {
    cashDelta = BigInt(rawCash);
    if (cashDelta > MAX_CASH_PER_USE) cashDelta = MAX_CASH_PER_USE;
    // A def can charge for its effect, but never more than the player holds:
    // `applyBalanceChange` refuses an overdraft, and a def must not be able to
    // turn using an item into a 409 the player cannot act on.
    const floor = -BigInt(snapshot.cash);
    if (cashDelta < floor) cashDelta = floor;
  }

  const message = typeof outcome.message === "string" && outcome.message.length > 0
    ? outcome.message.slice(0, MAX_MESSAGE_LENGTH)
    : null;

  const poolDeltas: Partial<Record<Pool, number>> = {};
  const rawPools = outcome.poolDeltas;
  if (rawPools !== undefined) {
    for (const pool of POOL_ORDER) {
      const delta = intOrZero(rawPools[pool]);
      if (delta !== 0) poolDeltas[pool] = delta;
    }
  }

  return { health, healed: health - snapshot.health, expDelta, cashDelta, poolDeltas, message };
}

/**
 * Which def an item selects. `null` means the item's jsonb is malformed — a
 * non-object `effects`, or a `kind` that is present but not a string — which
 * the route answers with the same `wrong_slot` 400 it has always given a
 * consumable it cannot read.
 *
 * Absent, null and empty-string all mean `heal`: that is the state of every
 * item in every existing database.
 */
export function consumableKind(effects: unknown): string | null {
  if (!isRecord(effects)) return null;
  const raw = effects["kind"];
  if (raw === undefined || raw === null || raw === "") return HEAL_EFFECT_KIND;
  return typeof raw === "string" ? raw : null;
}

export interface ConsumableUse {
  kind: string;
  config: Record<string, unknown>;
}

/** The kind and the config a def is handed. See `ItemEffectDef.apply`. */
export function readConsumableUse(effects: unknown, meta: unknown): ConsumableUse | null {
  const kind = consumableKind(effects);
  if (kind === null || !isRecord(effects)) return null;
  const { kind: _kind, ...rest } = effects;
  return { kind, config: { ...(isRecord(meta) ? meta : {}), ...rest } };
}
