import { z } from "zod";
import { definePlugin, on, type ViewNode } from "@gl3/plugin-sdk";
import { games, type GameDef, type GameStep } from "@gl3/plugin-casino";
import { handValue, isNatural, playDealer, shuffle, type BlackjackState } from "./rules.js";
import { renderState } from "./view.js";

export { handValue, shuffle, type BlackjackState } from "./rules.js";
export {
  dealTable, actSeat, settleTable,
  type BjTableState, type BjSeatHand, type SeatPhase,
} from "./multi.js";

const ActionSchema = z.enum(["hit", "stand", "double"]);

export const BLACKJACK: GameDef<BlackjackState> = {
  id: "blackjack",
  name: "Blackjack",
  /** A natural pays 3:2. A doubled hand has twice the wager and is still 2.5
   *  of it — which is why the hub re-checks exposure on `wagerDelta`. */
  maxPayoutMultiplier: 2.5,
  action: ActionSchema,

  start({ wager, seed }): GameStep<BlackjackState> {
    const shoe = shuffle(seed);
    const state: BlackjackState = {
      shoe, cursor: 4,
      player: [shoe[0]!, shoe[2]!],
      dealer: [shoe[1]!, shoe[3]!],
      wager, phase: "player",
    };
    if (isNatural(state.player) || isNatural(state.dealer)) {
      const done = { ...state, phase: "done" as const };
      return { state: done, view: renderState(done), done: true };
    }
    return { state, view: renderState(state), done: false };
  },

  act(state, action): GameStep<BlackjackState> {
    const parsed = ActionSchema.parse(action);
    if (state.phase === "done") throw new Error("hand is already finished");

    if (parsed === "hit") {
      const player = [...state.player, state.shoe[state.cursor]!];
      const next: BlackjackState = { ...state, player, cursor: state.cursor + 1 };
      if (handValue(player) > 21) {
        const done = { ...next, phase: "done" as const };
        return { state: done, view: renderState(done), done: true };
      }
      return { state: next, view: renderState(next), done: false };
    }

    if (parsed === "double") {
      if (state.player.length !== 2) throw new Error("can only double on the first two cards");
      const player = [...state.player, state.shoe[state.cursor]!];
      const drawn: BlackjackState = { ...state, player, cursor: state.cursor + 1, wager: state.wager * 2n };
      const done = handValue(player) > 21 ? { ...drawn, phase: "done" as const } : playDealer(drawn);
      // The hub debits the player, credits the house and re-runs the exposure
      // check. This function moves no money and knows nothing about balances.
      return { state: done, view: renderState(done), done: true, wagerDelta: state.wager };
    }

    const done = playDealer(state);
    return { state: done, view: renderState(done), done: true };
  },

  /** The lobby's resume view — the same `renderState` `start` and `act`
   *  return, applied to a hand loaded back out of the session row. */
  view(state): ViewNode {
    return renderState(state);
  },

  settle(state, wager): bigint {
    const player = handValue(state.player);
    const dealer = handValue(state.dealer);
    if (player > 21) return 0n;
    if (isNatural(state.player) && !isNatural(state.dealer)) return (wager * 5n) / 2n;  // 3:2
    if (dealer > 21) return wager * 2n;
    if (player > dealer) return wager * 2n;
    if (player === dealer) return wager;                                                // push
    return 0n;
  },
};

export default definePlugin({
  id: "blackjack",
  version: "1.0.0",
  basePaths: ["/api/blackjack"],
  // The game's own art. It owns no tables and serves no routes — its state is
  // opaque jsonb in the casino hub's session row — so a singleton is the only
  // shape that fits, and the lobby is what renders it.
  providesAssets: [
    { slot: "table", label: "Blackjack table", singleton: true },
    // The building on the properties board. A singleton because art belongs to
    // the property TYPE, not to each town's copy of it — every casino in the
    // game is the same franchise.
    { slot: "property", label: "Casino building", singleton: true },
  ],
  providesProperties: [{
    id: "blackjack",
    name: "Blackjack Table",
    price: 1_000_000n,       // $1,000,000 — V2's hardcoded figure; money bigints are whole dollars
    leverLabel: "Maximum bet",
  }],
  filters: [on(games, (_ctx, list) => [...list, BLACKJACK as GameDef])],
});
