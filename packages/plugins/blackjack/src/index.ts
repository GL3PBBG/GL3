import { z } from "zod";
import { definePlugin, on } from "@gl3/plugin-sdk";
import { tableGames, type TableGameDef, type TableStep } from "@gl3/plugin-casino";
import { actSeat, dealTable, settleTable, type BjTableState } from "./multi.js";
import { renderTable } from "./table-view.js";

export { handValue, isNatural, shuffle, type Card } from "./rules.js";
export { actSeat, dealTable, settleTable, type BjSeatHand, type BjTableState, type SeatPhase } from "./multi.js";
export { renderTable } from "./table-view.js";

const ActionSchema = z.enum(["hit", "stand", "double"]);

function toStep(result: { state: BjTableState; wagerDelta?: { seat: number; amount: bigint } }): TableStep<BjTableState> {
  return {
    state: result.state,
    done: result.state.done,
    turn: result.state.turn,
    ...(result.wagerDelta !== undefined ? { wagerDelta: result.wagerDelta } : {}),
  };
}

export const BLACKJACK_TABLE: TableGameDef<BjTableState> = {
  id: "blackjack",
  name: "Blackjack",
  maxPayoutMultiplier: 2.5,
  action: ActionSchema,
  deal: ({ seats, seed }) => toStep({ state: dealTable(seats, seed) }),
  act: (state, seat, action) => toStep(actSeat(state, seat, ActionSchema.parse(action))),
  autoAct: (state, seat) => toStep(actSeat(state, seat, "stand")),
  view: renderTable,
  settle: settleTable,
};

export default definePlugin({
  id: "blackjack",
  version: "1.0.0",
  basePaths: ["/api/blackjack"],
  providesAssets: [
    { slot: "table", label: "Blackjack table", singleton: true },
    { slot: "property", label: "Casino building", singleton: true },
  ],
  providesProperties: [{
    id: "blackjack",
    name: "Blackjack Table",
    price: 1_000_000n,
    leverLabel: "Maximum bet",
  }],
  filters: [on(tableGames, (_ctx, list) => [...list, BLACKJACK_TABLE as TableGameDef])],
});
