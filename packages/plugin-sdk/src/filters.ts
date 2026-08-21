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
export type FilterPolicy = "propagate" | "collect";

export interface FilterPoint<T> {
  readonly name: string;
  readonly policy: FilterPolicy;
  readonly _type?: (value: never) => T;
}

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

export function filterPoint<T>(name: string, policy: FilterPolicy): FilterPoint<T> {
  if (declared.has(name)) throw new Error(`filter point "${name}" already declared`);
  declared.add(name);
  return { name, policy };
}

/** `order` defaults to 100 so a subscriber can sort before or after the norm. */
export function on<T>(point: FilterPoint<T>, fn: FilterFn<T>, order = 100): FilterSubscription {
  return {
    pointName: point.name,
    order,
    async run(ctx: PluginCtx, value: unknown): Promise<unknown> {
      // `value` re-enters as T. What backs that cast is constructor discipline,
      // not the signature: `runFilterChain` routes by the name *string*, and
      // `filterPoint()` is the only sanctioned way to mint a point, so within one
      // `@gl3/plugin-sdk` module instance its duplicate-name `Set` makes a name
      // map to exactly one `T`.
      //
      // Both halves of that are escapable, and neither is checked. `_type` is
      // optional, so a bare `{ name: "crimes.beforeResolve" }` literal inhabits
      // `FilterPoint<Gang>` without ever calling `filterPoint()` — it never meets
      // the `Set`, type-checks clean, and routes a `Gang` into a `Crime`
      // subscriber, which this cast then launders. Two copies of the package in
      // one process would break it the same way, each with its own `Set`.
      return await fn(ctx, value as T);
    },
  };
}

/**
 * A subscription paired with the plugin id that owns it, so
 * `runFilterChain` can hand each subscriber its own plugin's ctx rather
 * than the ctx of whichever plugin applied the filter.
 */
export interface BoundFilterSubscription {
  readonly ownerId: string;
  readonly subscription: FilterSubscription;
}

/**
 * Filters run outside any transaction (spec: Filters) — a filter cannot
 * participate in the caller's write, so a slow subscriber cannot hold a row
 * lock open.
 *
 * `ctxFor` is called once per subscriber, keyed by the subscriber's owning
 * plugin id — never the applier's — which is what makes a subscriber's
 * `ctx.pluginId`, permission checks and event publishes attribute to the
 * plugin that declared the subscription rather than the plugin that
 * triggered the chain.
 *
 * `point.policy` governs error handling: `"propagate"` rethrows a
 * subscriber's error, aborting the chain (the default shape prior points
 * had); `"collect"` logs and drops a throwing subscriber's contribution,
 * carrying the previous value forward to the next subscriber instead.
 *
 * `"collect"` isolates a subscriber's *throw*, not its *mutation*: a
 * subscriber that mutates the threaded value in place (pushes onto an array
 * it was handed, rewrites another plugin's entry) instead of returning a
 * copy is unguarded — the mutation lands regardless of what the subscriber
 * returns or whether a later subscriber throws. Treat the incoming value as
 * read-only and return a copy, as every shipped subscriber does.
 */
export async function runFilterChain<T>(
  bound: readonly BoundFilterSubscription[],
  point: FilterPoint<T>,
  ctxFor: (ownerId: string) => PluginCtx,
  value: T,
): Promise<T> {
  const chain = bound
    .filter((b) => b.subscription.pointName === point.name)
    .sort((a, b) => a.subscription.order - b.subscription.order);
  let current: unknown = value;
  for (const { ownerId, subscription } of chain) {
    const ctx = ctxFor(ownerId);
    if (point.policy === "collect") {
      try {
        current = await subscription.run(ctx, current);
      } catch (error) {
        ctx.log.error(`filter subscriber for "${point.name}" dropped`, { ownerId, error });
      }
    } else {
      current = await subscription.run(ctx, current);
    }
  }
  // Same cast, same backing as `on`'s above: a subscriber for this point is
  // typed to return `T`, so the threaded value is still `T` — given the
  // constructor discipline described there, and no stronger than it.
  return current as T;
}
