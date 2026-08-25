import type { Pool } from "@gl3/shared";

export type { Pool, TrainedAttr, ActionCost } from "@gl3/shared";

/**
 * How one pool refills. Declared by exactly one plugin, through
 * `providesAttributes`; the loader rejects a second declarer at boot.
 */
export interface AttributePoolDecl {
  readonly pool: Pool;
  readonly defaultMax: number;
  readonly regenAmount: number;
  readonly regenIntervalSeconds: number;
}

export interface PoolSettlement {
  readonly value: number;
  readonly max: number;
  readonly stamp: Date | null;
}

/** The full settled row `tx.attributes.read` hands back. */
export interface PlayerAttributes {
  readonly energy: number; readonly energyMax: number;
  readonly will: number; readonly willMax: number;
  readonly brave: number; readonly braveMax: number;
  readonly nerve: number; readonly nerveMax: number;
  readonly level: number;
  readonly strength: bigint; readonly agility: bigint;
  readonly guard: bigint; readonly labour: bigint;
}

/**
 * Lazy regen, pure. There is no cron anywhere in GL3 — this is applied under
 * the player-row lock a caller already holds (`ensureCurrentRound` and the
 * bullet restock have the same settle-at-read shape).
 *
 * The stamp advances by whole intervals to the deadline it just cleared,
 * NEVER to `now`, so the sub-interval remainder survives. `advanceTable` in
 * the casino carries the identical rule for the same reason.
 *
 * `decl === null` — nobody declared this pool — is a total no-op. That single
 * branch is what makes the whole feature opt-in: an install with no attribute
 * plugin runs no clock and writes no row.
 */
export function settlePool(
  current: number,
  max: number,
  stampedAt: Date | null,
  now: Date,
  decl: AttributePoolDecl | null,
): PoolSettlement {
  if (decl === null) return { value: current, max, stamp: stampedAt };

  // `0` is the uninitialised sentinel: seed from the declaration on first
  // touch, which is what lets a player migrated months before the plugin was
  // installed come live correctly the moment it is.
  const seeded = max === 0 ? decl.defaultMax : max;

  if (stampedAt === null) return { value: current, max: seeded, stamp: now };
  if (current >= seeded) return { value: current, max: seeded, stamp: now };
  if (decl.regenIntervalSeconds <= 0 || decl.regenAmount <= 0) {
    return { value: current, max: seeded, stamp: stampedAt };
  }

  const elapsedSeconds = (now.getTime() - stampedAt.getTime()) / 1000;
  const intervals = Math.floor(elapsedSeconds / decl.regenIntervalSeconds);
  // Covers both "not yet due" and a stamp in the future from clock skew.
  if (intervals <= 0) return { value: current, max: seeded, stamp: stampedAt };

  return {
    value: Math.min(seeded, current + intervals * decl.regenAmount),
    max: seeded,
    stamp: new Date(stampedAt.getTime() + intervals * decl.regenIntervalSeconds * 1000),
  };
}
