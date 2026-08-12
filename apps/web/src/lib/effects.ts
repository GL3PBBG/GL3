/**
 * Pull one numeric field out of an item's `effects`.
 *
 * The DTO types `effects` as `unknown` because the server passes an
 * unrecognised `item_type`'s jsonb through untouched (see dto/inventory.ts).
 * Rather than casting at every call site, pages read individual fields through
 * here: a missing, non-numeric or NaN value is `null`, which a page renders as
 * a dash instead of "undefined" or "NaN".
 */
export function numericEffect(effects: unknown, field: string): number | null {
  if (typeof effects !== "object" || effects === null) return null;
  const value = (effects as Record<string, unknown>)[field];
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return value;
}
