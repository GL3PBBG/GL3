/**
 * MCCodes' generic item effect engine → GL3 consumable effects.
 *
 * `itemuse.php` applies up to three `{stat, dir, inc_amount, inc_type}`
 * records per item. `inc_type = percent` is a share of the stat's MAX for the
 * four capped stats (energy/will/brave/hp; of the CURRENT value for the
 * rest), `dir` signs it, and the result is clamped to `[0, max]`.
 *
 * GL3 has a def for exactly two of those shapes: energy/will/brave through
 * the built-in `pools` def and a positive hp through `heal`, both of which
 * take a flat integer OR the percent-of-max figure `"N%"` and resolve it at
 * use time — so a percent is carried as authored, never resolved here
 * against a max this migrator does not know.
 *
 * Everything else — a stat with no def (iq, strength, money, …), a negative
 * hp, a heal mixed with pool deltas (no def reads both), the same pool named
 * twice (GL3 carries one delta per pool), or a record that does not parse —
 * is PARKED verbatim under `{ kind: "mccodes", mccodes: [...] }` and
 * reported. That fails a use cleanly as `unknown_effect` (a registered kind
 * a future def can claim) rather than the `wrong_slot` a raw record used to
 * draw from the heal def, and loses nothing.
 *
 * Divergences, both deliberate: GL3 refuses an unaffordable pool cost (409,
 * item kept) where MCCodes clamped the stat to 0 and consumed the item, and
 * GL3 floors a percent's magnitude at 1 where MCCodes' round() could reach 0.
 */

export const MCCODES_EFFECT_KIND = "mccodes";

const POOL_STATS = new Set(["energy", "will", "brave"]);

export type McEffectRecord = Record<string, string | number>;

interface Parsed { stat: string; sign: 1 | -1; figure: number | string }

function parse(record: McEffectRecord): Parsed | null {
  const { stat, dir, inc_amount: amount, inc_type: type } = record;
  if (typeof stat !== "string") return null;
  if (dir !== "pos" && dir !== "neg") return null;
  if (type !== "percent" && type !== "figure") return null;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) return null;
  const sign = dir === "pos" ? 1 : -1;
  return { stat, sign, figure: type === "percent" ? `${sign < 0 ? "-" : ""}${amount}%` : sign * amount };
}

export interface MappedEffects {
  effects: Record<string, unknown>;
  /** One line per reason the item was parked; empty when it mapped. */
  notes: string[];
}

export function mapMcItemEffects(records: McEffectRecord[]): MappedEffects {
  const parked = (note: string): MappedEffects => ({
    effects: { kind: MCCODES_EFFECT_KIND, mccodes: records }, notes: [note],
  });

  const pools: Record<string, number | string> = {};
  let heal: number | string | undefined;
  for (const record of records) {
    const p = parse(record);
    if (p === null) return parked(`effect does not parse: ${JSON.stringify(record)}`);
    if (POOL_STATS.has(p.stat)) {
      if (p.stat in pools) return parked(`pool "${p.stat}" named twice; GL3 carries one delta per pool`);
      pools[p.stat] = p.figure;
    } else if (p.stat === "hp" && p.sign > 0) {
      if (heal !== undefined) return parked("hp named twice; GL3 carries one heal figure");
      heal = p.figure;
    } else {
      return parked(`stat "${p.stat}" (${p.sign > 0 ? "pos" : "neg"}) has no GL3 item effect def`);
    }
  }
  const hasPools = Object.keys(pools).length > 0;
  if (heal !== undefined && hasPools) return parked("heal mixed with pool deltas; no GL3 def reads both");
  if (heal !== undefined) return { effects: { heal }, notes: [] };
  if (hasPools) return { effects: { kind: "pools", pools }, notes: [] };
  return parked("no effect records");
}
