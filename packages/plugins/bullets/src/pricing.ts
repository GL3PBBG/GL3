/**
 * The price a purchase actually costs: the franchise owner's lever when a
 * factory is owned and the owner has set one, the location's admin price
 * otherwise, and never above the `max_cost` cap. V2's admin caps the owner
 * (`adminModule::method_options`); this is the read-side half of that, and the
 * lever route's filter subscriber (`lever-cap.ts`) is the set-side half.
 *
 * Its own module rather than a private in `index.ts` because the travel-board
 * quote (`travel-quote.ts`) needs it too, and `index.ts` imports that file —
 * exporting from `index.ts` would make the two mutually importing.
 */
export function effectiveCost(lever: bigint | null, locationCost: bigint, maxCost: bigint | null): bigint {
  const base = lever ?? locationCost;
  return maxCost !== null && base > maxCost ? maxCost : base;
}
