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
 * `numericEffect`'s twin for the one string field in the vocabulary: a
 * consumable's `effects.kind`, which names its def in the server's item effect
 * registry. Absent and empty both read as `null` — the server treats both as
 * the built-in heal, so a page must not show either as a kind of its own.
 */
export function stringEffect(effects: unknown, field: string): string | null {
  if (typeof effects !== "object" || effects === null) return null;
  const value = (effects as Record<string, unknown>)[field];
  if (typeof value !== "string" || value === "") return null;
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
  // `power` IS the melee marker, the same test combat's loadWeapon applies:
  // such an item has no damage range, spends no bullets and never wears, so
  // none of the firearm clauses below apply to it.
  const power = numericEffect(effects, "power");
  if (power !== null) return `power ${power} · melee`;
  const min = numericEffect(effects, "damageMin");
  const max = numericEffect(effects, "damageMax");
  if (min === null || max === null) return null;
  const dps = numericEffect(effects, "dps");
  const parts = [`${min}–${max} damage`];
  if (dps !== null && dps > 0) parts.push(`${dps} dps`);
  const kill = shotsToKill(effects);
  if (kill !== null) {
    const bullets = kill.bullets > kill.shots ? ` (${kill.bullets} bullets)` : "";
    parts.push(`~${kill.shots} shots to kill${bullets}`);
  }
  return parts.join(" · ");
}

/**
 * Estimated shots (and bullets — a shot may spend several) to drop a
 * 100-health unarmored target; 100 mirrors `ranks.max_health`'s default. Crit
 * folds into the expectation because both crit fields always arrive in the
 * parsed DTO; accuracy deliberately does NOT — a migrated V2 weapon carries
 * none and the server-side default is invisible here, so including it only
 * when present would make two rows non-comparable. Hence the "~" in the line
 * above.
 */
export function shotsToKill(effects: unknown): { shots: number; bullets: number } | null {
  const min = numericEffect(effects, "damageMin");
  const max = numericEffect(effects, "damageMax");
  if (min === null || max === null) return null;
  const critChance = numericEffect(effects, "critChance") ?? 0;
  const critMultiplier = numericEffect(effects, "critMultiplier") ?? 1;
  const expected = ((min + max) / 2) * (1 + (critChance / 100) * (critMultiplier - 1));
  if (expected <= 0) return null;
  const shots = Math.ceil(100 / expected);
  const perShot = numericEffect(effects, "bulletsPerShot");
  const bullets = perShot !== null && perShot > 0 ? shots * perShot : shots;
  return { shots, bullets };
}
