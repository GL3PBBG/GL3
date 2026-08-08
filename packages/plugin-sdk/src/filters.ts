import type { PluginCtx } from "./ctx.js";

/**
 * A typed token identifying a hook point. The plugin that owns the point
 * exports the token; subscribers import it from that package, which is what
 * makes cross-plugin filters type-safe without a global registry (spec:
 * Filters). The phantom `_type` field exists only to make `FilterPoint<Crime>`
 * and `FilterPoint<Gang>` structurally distinct to the compiler.
 */
export interface FilterPoint<T> { readonly name: string; readonly _type?: (value: T) => T }

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
