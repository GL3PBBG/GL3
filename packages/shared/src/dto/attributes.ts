import { z } from "zod";

/** The four spent-and-regenerated pools. */
export const PoolSchema = z.enum(["energy", "will", "brave", "nerve"]);
export type Pool = z.infer<typeof PoolSchema>;

/** The four gym-trained attributes. bigint in Postgres, decimal string on the wire. */
export const TrainedAttrSchema = z.enum(["strength", "agility", "guard", "labour"]);
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
  nerve: z.number().int(), nerveMax: z.number().int(),
  level: z.number().int(),
  strength: z.string(), agility: z.string(), guard: z.string(), labour: z.string(),
  energyRegenAt: z.string().datetime().nullable(),
  willRegenAt: z.string().datetime().nullable(),
  braveRegenAt: z.string().datetime().nullable(),
  nerveRegenAt: z.string().datetime().nullable(),
});
export type PlayerAttributesDto = z.infer<typeof PlayerAttributesDtoSchema>;
