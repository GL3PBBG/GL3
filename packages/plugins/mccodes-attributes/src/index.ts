import { definePlugin } from "@gl3/plugin-sdk";

/**
 * The MCCodes profile anchor (C spec 2026-08-26-mccodes-plugin-family-design
 * §3): declares all three pools with MCCodes' own numbers so that exactly
 * one plugin owns the vocabulary, and every other family plugin can
 * `requires: ["mccodes-attributes"]`.
 *
 * Energy is MCCodes' `maxenergy/12.5` per 5-minute tick expressed as 8% of
 * max, with the donator `/6` rate as the membership ×2 — a documented
 * divergence from the exact ×2.0833 (audit §7 item 2). Brave is `10% of max
 * + 0.5`. Will is flat +10. Registration seeds each declared pool full
 * (12/12, 5/5, 100/100 — MCCodes' register.php), because the auth path
 * consults this registry at signup.
 *
 * Deliberately no routes: this manifest is a declaration and nothing else.
 * Loaded only through PLUGIN_IDS — never imported into core-plugins.ts, or
 * every default GL3 game would start seeding pools.
 */
export default definePlugin({
  id: "mccodes-attributes",
  version: "1.0.0",
  apiVersion: 1,
  basePaths: ["/api/mccodes-attributes"],
  requires: [],
  providesAttributes: [
    {
      pool: "energy", defaultMax: 12,
      regenPercent: 8, regenAmount: 0, regenIntervalSeconds: 300,
      memberMultiplier: 2,
    },
    {
      pool: "brave", defaultMax: 5,
      regenPercent: 10, regenAmount: 0.5, regenIntervalSeconds: 300,
    },
    {
      pool: "will", defaultMax: 100,
      regenAmount: 10, regenIntervalSeconds: 300,
    },
  ],
});
