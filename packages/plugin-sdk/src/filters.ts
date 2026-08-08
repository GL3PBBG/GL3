import type { PluginCtx } from "./ctx.js";

/**
 * A typed token identifying a hook point. The plugin that owns the point
 * exports the token; subscribers import it from that package, which is what
 * makes cross-plugin filters type-safe without a global registry (spec:
 * Filters). The phantom `_type` field exists only to make `FilterPoint<Crime>`
 * and `FilterPoint<Gang>` structurally distinct to the compiler.
 *
 * The parameter is `never`, not `T`, to make the phantom *covariant*. Under
 * `strictFunctionTypes` a property-position `(value: T) => T` is checked
 * contravariantly in its parameter, which would make `FilterPoint<Crime>`
 * unassignable to `FilterPoint<unknown>` — the type `PluginManifest.provides`
 * holds — so no plugin could declare a point it owns. `never` is the bottom
 * type and so satisfies contravariance from anything, while the return position
 * still keeps two distinct `T`s mutually unassignable.
 *
 * With `never` in the parameter, all of the variance is carried by the return
 * position — the parameter deliberately contributes nothing. That is the point:
 * it makes the phantom's behaviour independent of `strictFunctionTypes` and of
 * property-vs-method declaration quirks.
 */
export interface FilterPoint<T> { readonly name: string; readonly _type?: (value: never) => T }

// Compile-time guards for the phantom's variance (see `_type` above). These
// are types only — nothing is emitted. Both are verified to fail, each on a
// different regression: revert `never` to `T` and _Concrete fails; delete the
// `_type` field and _Distinct fails.
//
// Note that rewriting `_type` as a method (`_type?(value: T): T`) fails
// neither, and that is correct rather than a gap — distinctness comes from the
// return position, which a method shorthand keeps, and bivariance only relaxes
// the parameter, which is already inert. The method form is not a wrong answer
// here; `never` is preferred only because it states that intent outright.
type _Assert<T extends true> = T;
type _Concrete = _Assert<FilterPoint<{ a: 1 }> extends FilterPoint<unknown> ? true : false>;
type _Distinct = _Assert<FilterPoint<{ a: 1 }> extends FilterPoint<{ b: 2 }> ? false : true>;

export type FilterFn<T> = (ctx: PluginCtx, value: T) => T | Promise<T>;

export interface FilterSubscription {
  readonly pointName: string;
  readonly order: number;
  run(ctx: PluginCtx, value: unknown): Promise<unknown>;
}

const declared = new Set<string>();

export function filterPoint<T>(name: string): FilterPoint<T> {
  if (declared.has(name)) throw new Error(`filter point "${name}" already declared`);
  declared.add(name);
  return { name };
}

/** `order` defaults to 100 so a subscriber can sort before or after the norm. */
export function on<T>(point: FilterPoint<T>, fn: FilterFn<T>, order = 100): FilterSubscription {
  return {
    pointName: point.name,
    order,
    async run(ctx: PluginCtx, value: unknown): Promise<unknown> {
      // `value` re-enters as T: runFilterChain only ever routes a point's own
      // value here, and the chain's public signature is what enforces that.
      return await fn(ctx, value as T);
    },
  };
}

/**
 * Filters run outside any transaction (spec: Filters) — a filter cannot
 * participate in the caller's write, so a slow subscriber cannot hold a row
 * lock open.
 */
export async function runFilterChain<T>(
  subscriptions: readonly FilterSubscription[],
  point: FilterPoint<T>,
  ctx: PluginCtx,
  value: T,
): Promise<T> {
  const chain = subscriptions
    .filter((s) => s.pointName === point.name)
    .sort((a, b) => a.order - b.order);
  let current: unknown = value;
  for (const subscription of chain) current = await subscription.run(ctx, current);
  return current as T;
}
