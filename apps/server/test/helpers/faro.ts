import { z } from "zod";
import { definePlugin, on, type PluginManifest } from "@gl3/plugin-sdk";
import { games, type GameDef, type GameStep } from "@gl3/plugin-casino";

/**
 * A deterministic solo game for the hub's own tests, now that blackjack is a
 * table game. The ACTION decides the outcome, so a test chooses its branch:
 *   win → settles at 2×, lose → 0, push → 1×, double → wagerDelta then 2×,
 *   wait → stays open, no wagerDelta, no settle.
 * `start` never settles — the "natural at deal" nondeterminism the blackjack
 * fixtures had to net-from-the-body around does not exist here. `wait` is the
 * one action that doesn't settle either, standing in for blackjack's `hit`:
 * the hub's non-settling `act` branch (state/wager persisted, `done: false`,
 * no money moved) otherwise has no coverage once blackjack leaves the solo
 * registry.
 */
export interface FaroState { wager: bigint; outcome: "open" | "win" | "lose" | "push" }

export const FARO: GameDef<FaroState> = {
  id: "faro",
  name: "Faro",
  maxPayoutMultiplier: 2.5,
  action: z.enum(["win", "lose", "push", "double", "wait"]),
  start: ({ wager }) => ({
    state: { wager, outcome: "open" },
    view: { kind: "text", value: "faro: place your call" },
    done: false,
  }),
  act: (state, action): GameStep<FaroState> => {
    if (action === "wait") {
      return {
        state, done: false,
        view: { kind: "text", value: "faro: waiting" },
      };
    }
    if (action === "double") {
      const next: FaroState = { ...state, wager: state.wager * 2n, outcome: "win" };
      return {
        state: next, done: true, wagerDelta: state.wager,
        view: { kind: "text", value: "faro: doubled and won" },
      };
    }
    const outcome = action as "win" | "lose" | "push";
    return {
      state: { ...state, outcome }, done: true,
      view: { kind: "text", value: `faro: ${outcome}` },
    };
  },
  settle: (state, wager) => {
    if (state.outcome === "win") return wager * 2n;
    if (state.outcome === "push") return wager;
    return 0n;
  },
  view: (state) => ({ kind: "text", value: `faro: ${state.outcome}` }),
};

/** Installed alongside CORE_PLUGINS via bootTestServer({ plugins: [faroPlugin] }). */
export const faroPlugin: PluginManifest = definePlugin({
  id: "faro",
  version: "1.0.0",
  basePaths: ["/api/faro"],
  filters: [on(games, (_ctx, list) => [...list, FARO as GameDef])],
});
