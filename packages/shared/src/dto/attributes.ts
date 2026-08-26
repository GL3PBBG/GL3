import { z } from "zod";

/** The three spent-and-regenerated pools. MCCodes' crime currency is `brave`;
 * there is no nerve column in any engine of this family — "nerve" was Torn's
 * name for brave's slot (spec 2026-08-26-mccodes-mechanics-audit §7 item 1). */
export const PoolSchema = z.enum(["energy", "will", "brave"]);
export type Pool = z.infer<typeof PoolSchema>;

/** Trained attributes. bigint in Postgres, decimal string on the wire. IQ is
 * MCCodes' fifth stat — bought and studied, never gym-trained. */
export const TrainedAttrSchema = z.enum(["strength", "agility", "guard", "labour", "iq"]);
export type TrainedAttr = z.infer<typeof TrainedAttrSchema>;

/**
 * The value carried by the `core.actionCost` filter point. `action` is the
 * acting plugin's own dotted identifier (`"crimes.commit"`,
 * `"combat.attack"`); subscribers add to `costs`. An empty `costs` means the
 * action is free, which is the state of every install with no attribute
 * plugin loaded.
 */
export interface ActionCost {
  readonly action: string;
  costs: Partial<Record<Pool, number>>;
}

/**
 * The caller's own attributes, on `/api/auth/me`. OPTIONAL: absent entirely
 * when no plugin declares a pool, so an install with no attribute plugin
 * serves a byte-identical payload to the one it served before this feature
 * existed, and an old client sees nothing new.
 *
 * Trained stats are decimal strings — they are `bigint` in Postgres and a
 * JSON number would reintroduce floating point.
 */
export const PlayerAttributesDtoSchema = z.object({
  energy: z.number().int(), energyMax: z.number().int(),
  will: z.number().int(), willMax: z.number().int(),
  brave: z.number().int(), braveMax: z.number().int(),
  level: z.number().int(),
  strength: z.string(), agility: z.string(), guard: z.string(), labour: z.string(), iq: z.string(),
  energyRegenAt: z.string().datetime().nullable(),
  willRegenAt: z.string().datetime().nullable(),
  braveRegenAt: z.string().datetime().nullable(),
});
export type PlayerAttributesDto = z.infer<typeof PlayerAttributesDtoSchema>;
