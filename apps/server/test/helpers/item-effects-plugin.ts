import { definePlugin, on, type PluginManifest } from "@gl3/plugin-sdk";
import { itemEffects, type ItemEffectDef } from "@gl3/plugin-inventory";

/**
 * Deterministic item effect defs for the registry's own tests, installed the
 * way FARO installs a casino game: one test-only plugin whose only job is to
 * subscribe to the point (`test/helpers/faro.ts` is the precedent).
 *
 * There is no built-in def beyond `heal`, so without these there is nothing to
 * prove the open half of the registry with — the caps, the refusals and the
 * ledger movement all need a def that reaches for more than it may have.
 */

/** The ordinary case: reads its config, moves several things at once. */
export const TONIC: ItemEffectDef = {
  kind: "tonic",
  label: "Bootleg Tonic",
  apply: (config) => ({
    healthDelta: typeof config["kick"] === "number" ? config["kick"] : 0,
    expDelta: typeof config["street"] === "number" ? config["street"] : 0,
    message: "The tonic burns going down.",
  }),
};

/** Claims far more exp and cash than the caps allow. Proves both clamps. */
export const JACKPOT: ItemEffectDef = {
  kind: "jackpot",
  label: "Jackpot Powder",
  apply: () => ({
    expDelta: 1_000_000_000,
    cashDelta: "999999999999",
    message: "Everything, all at once.",
  }),
};

/** Charges more than any player holds. Proves the debit floors at their cash. */
export const SHAKEDOWN: ItemEffectDef = {
  kind: "shakedown",
  label: "Shakedown",
  apply: () => ({ cashDelta: "-999999999999" }),
};

/** Charges a modest, affordable fee — the ledger-row case. */
export const TOLL: ItemEffectDef = {
  kind: "toll",
  label: "Toll",
  apply: () => ({ cashDelta: "-250", message: "Paid the man." }),
};

/** Would kill outright. Proves MIN_HEALTH_AFTER_USE. */
export const POISON: ItemEffectDef = {
  kind: "poison",
  label: "Bad Batch",
  apply: () => ({ healthDelta: -10_000 }),
};

/** Throws, the way a third-party def with a bug does. Must be a clean 400. */
export const CURSED: ItemEffectDef = {
  kind: "cursed",
  label: "Cursed",
  apply: () => {
    throw new Error("the vial was empty");
  },
};

export const EFFECT_DEFS = [TONIC, JACKPOT, SHAKEDOWN, TOLL, POISON, CURSED];

/** Installed alongside CORE_PLUGINS via bootTestServer({ plugins: [...] }). */
export const itemEffectsPlugin: PluginManifest = definePlugin({
  id: "tonic",
  version: "1.0.0",
  basePaths: ["/api/tonic"],
  filters: [on(itemEffects, (_ctx, list) => [...list, ...EFFECT_DEFS])],
});
