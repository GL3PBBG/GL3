export interface CatalogueCar {
  id: string;
  name: string;
  value: bigint;
  theftWeight: number;
}

export interface TheftTier {
  id: string;
  name: string;
  successChance: number;
  maxDamage: number;
  minCarValue: bigint;
  maxCarValue: bigint;
}

/**
 * Every roll the outcome depends on, drawn by the caller with `randomInt`
 * from `node:crypto` and handed in. Keeping randomness out of here is what
 * makes the whole outcome table testable without a database — the shape
 * `packages/plugins/combat/src/resolve.ts` established.
 *
 * `successRoll` and `escapeRoll` are drawn over [0, 100). `carRoll` is drawn
 * over [0, bracketWeight(...)), which is why `bracketWeight` is exported:
 * the caller needs the bound before it can draw, and duplicating the filter
 * to compute it would be two definitions of the bracket.
 */
export interface TheftRolls {
  successRoll: number;
  carRoll: number;
  damageRoll: number;
  escapeRoll: number;
}

export type TheftOutcome =
  | { kind: "stolen"; car: CatalogueCar; damage: number }
  | { kind: "escaped" }
  | { kind: "caught" }
  | { kind: "empty" };

/** A negative weight is clamped, not subtracted: `theft_weight` is admin-edited. */
const weightOf = (car: CatalogueCar): number => Math.max(0, Math.floor(car.theftWeight));

function inBracket(tier: TheftTier, candidates: readonly CatalogueCar[]): CatalogueCar[] {
  return candidates.filter((c) => c.value >= tier.minCarValue && c.value <= tier.maxCarValue);
}

export function bracketWeight(tier: TheftTier, candidates: readonly CatalogueCar[]): number {
  return inBracket(tier, candidates).reduce((sum, c) => sum + weightOf(c), 0);
}

/** V2 theft.hooks.php: floor(T_chance * 1.1), capped at 100, while the membership timer runs. */
export function boostedChance(chance: number, member: boolean): number {
  return member ? Math.min(100, Math.floor(chance * 1.1)) : chance;
}

/**
 * Two-stage: roll for success, then (on success) draw a car and damage; on
 * failure, roll the chase. The chase branch is evaluated first because it is
 * the only one that does not care what was parked on the street — an empty
 * bracket must not block a failed theft from resolving to escaped/caught.
 */
export function resolveTheft(
  rolls: TheftRolls,
  tier: TheftTier,
  candidates: readonly CatalogueCar[],
  escapeChance: number,
): TheftOutcome {
  if (rolls.successRoll >= tier.successChance) {
    return rolls.escapeRoll < escapeChance ? { kind: "escaped" } : { kind: "caught" };
  }

  const pool = inBracket(tier, candidates);
  const total = pool.reduce((sum, c) => sum + weightOf(c), 0);
  if (pool.length === 0 || total <= 0) return { kind: "empty" };

  const damage = Math.min(Math.max(0, Math.floor(rolls.damageRoll)), tier.maxDamage);

  let acc = 0;
  for (const car of pool) {
    acc += weightOf(car);
    if (rolls.carRoll < acc) return { kind: "stolen", car, damage };
  }

  // Unreachable for a roll drawn over [0, total). Kept so the function is
  // total: a caller that drew against a stale weight gets a car, not
  // undefined threaded into an insert.
  const last = pool[pool.length - 1];
  if (last === undefined) return { kind: "empty" };
  return { kind: "stolen", car: last, damage };
}
