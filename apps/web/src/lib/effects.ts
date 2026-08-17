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

/**
 * The weapon stat line `/inventory` and `/shop` both render, or `null` when the
 * damage range is unusable. Shared so the two pages cannot drift; pure so it can
 * be tested at all, since neither project has a DOM to render a component in.
 *
 * `dps` is what paces the attack cooldown — combat waits the average damage
 * divided by it, so 10 damage at 0.5 dps is a 20-second wait. The clause is
 * omitted rather than zeroed when a weapon declares none: absent means the flat
 * `combat.cooldown_seconds`, a server setting this page cannot see, so saying
 * nothing beats inventing a number. The dps is shown rather than the derived
 * wait for the same reason — the server also clamps it against
 * `combat.cooldown_max_seconds`, and a page that recomputed the seconds would
 * be confidently wrong at the edges.
 *
 * The caller keeps its own copy for the null case: "unusable" on /inventory,
 * nothing at all on /shop.
 */
export function weaponStatLine(effects: unknown): string | null {
  const min = numericEffect(effects, "damageMin");
  const max = numericEffect(effects, "damageMax");
  if (min === null || max === null) return null;
  const dps = numericEffect(effects, "dps");
  const damage = `${min}–${max} damage`;
  return dps === null || dps <= 0 ? damage : `${damage} · ${dps} dps`;
}
