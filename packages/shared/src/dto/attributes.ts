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
