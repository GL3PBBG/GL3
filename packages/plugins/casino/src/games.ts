import { filterPoint, type PluginCtx, type ViewNode } from "@gl3/plugin-sdk";
import type { z } from "zod";

export interface GameStep<S> {
  state: S;
  /** What the player sees now. Rendered by PageRenderer; may contain `cards`. */
  view: ViewNode;
  done: boolean;
  /**
   * Raise the wager mid-hand (blackjack's double down; a poker raise). The hub
   * debits the player, credits the house, updates the session and RE-RUNS the
   * exposure check. A game never moves money itself.
   */
  wagerDelta?: bigint;
}

export interface TableSeatInput {
  seat: number;
  wager: bigint;
}

export interface TableStep<S> {
  state: S;
  done: boolean;
  /** The seat whose turn it now is; null when the hand is done. */
  turn: number | null;
  /** A raise (double). `seat` must be the seat that just acted; `amount` > 0. */
  wagerDelta?: { seat: number; amount: bigint };
}

/**
 * The whole contract a casino game implements. `start`, `act` and `settle` are
 * PURE — no database, no ctx, no clock, no randomness, no io. That is what
 * makes installing a third-party game a smaller act of trust than installing
 * an arbitrary plugin: it returns a payout figure and the hub decides whether
 * the house can pay it and writes every ledger row.
 */
export interface GameDef<S = unknown> {
  /** Must equal the declaring plugin's id — checked in `buildRegistry`. */
  id: string;
  name: string;
  /**
   * The most a player can be returned per unit of the CURRENT wager. Blackjack
   * is 2.5 (a natural pays 3:2). A doubled hand has twice the wager and is
   * still 2.5 of it, which is why the exposure check re-runs on `wagerDelta`
   * rather than predicting a maximum up front.
   */
  maxPayoutMultiplier: number;
  /** Validates the act body's `action`. Rule: zod every external boundary. */
  action: z.ZodType<unknown>;
  start(input: { wager: bigint; seed: string }): GameStep<S>;
  act(state: S, action: unknown): GameStep<S>;
  /** Total returned to the player. 0 = loss, wager = push, 2×wager = win. */
  settle(state: S, wager: bigint): bigint;
  /**
   * Re-render an in-progress hand from its stored state, without advancing it.
   * Pure, like the other three.
   *
   * The lobby (`GET /api/casino`) needs this and nothing else can supply it: a
   * `ViewNode` is otherwise produced only as part of a `GameStep`, `state` is
   * opaque game-owned jsonb the hub cannot interpret, and `act` cannot be used
   * to peek because every action mutates. Without it a player who reloads the
   * page mid-hand cannot be shown their own cards.
   *
   * OPTIONAL, so a game that does not implement it still compiles and simply
   * resumes viewless rather than failing to install.
   */
  view?(state: S): ViewNode;
}

export interface TableGameDef<S = unknown> {
  /** Must equal the declaring plugin's id — checked in `buildTableRegistry`. */
  id: string;
  name: string;
  /**
   * The most a player can be returned per unit of the CURRENT wager. Blackjack
   * is 2.5 (a natural pays 3:2). A doubled hand has twice the wager and is
   * still 2.5 of it, which is why the exposure check re-runs on `wagerDelta`
   * rather than predicting a maximum up front.
   */
  maxPayoutMultiplier: number;
  /** Validates the act body's `action`. Rule: zod every external boundary. */
  action: z.ZodType<unknown>;
  deal(input: { seats: TableSeatInput[]; seed: string }): TableStep<S>;
  act(state: S, seat: number, action: unknown): TableStep<S>;
  /** What happens to a seat whose turn timer lapsed. Pure, like the rest. */
  autoAct(state: S, seat: number): TableStep<S>;
  /** Per-seat render. `viewer` null = a seated spectator not in this hand. */
  view(state: S, viewer: number | null): ViewNode;
  /** TOTAL returned per seat. A seat absent from the array is paid 0. */
  settle(state: S): { seat: number; payout: bigint }[];
}

export const games = filterPoint<GameDef[]>("casino.games");
export const tableGames = filterPoint<TableGameDef[]>("casino.tableGames");

/**
 * Built on first use and memoised by the caller. Request-time rather than
 * boot-time, because a GameDef arrives inside a filter subscription and
 * `definePlugin` cannot see it — the tradeoff spec §3 records.
 */
export async function buildRegistry(
  ctx: Pick<PluginCtx, "filters">,
  installedPluginIds: ReadonlySet<string>,
): Promise<Map<string, GameDef>> {
  const declared = await ctx.filters.apply(games, []);
  const registry = new Map<string, GameDef>();
  for (const game of declared) {
    if (!installedPluginIds.has(game.id)) {
      throw new Error(`casino game "${game.id}" is not an installed plugin id`);
    }
    if (registry.has(game.id)) throw new Error(`duplicate casino game id "${game.id}"`);
    registry.set(game.id, game);
  }
  return registry;
}

/**
 * Built on first use and memoised by the caller. Request-time rather than
 * boot-time, because a TableGameDef arrives inside a filter subscription and
 * `definePlugin` cannot see it — the tradeoff spec §3 records.
 */
export async function buildTableRegistry(
  ctx: Pick<PluginCtx, "filters">,
  installedPluginIds: ReadonlySet<string>,
): Promise<Map<string, TableGameDef>> {
  const declared = await ctx.filters.apply(tableGames, []);
  const registry = new Map<string, TableGameDef>();
  for (const game of declared) {
    if (!installedPluginIds.has(game.id)) {
      throw new Error(`casino table game "${game.id}" is not an installed plugin id`);
    }
    if (registry.has(game.id)) throw new Error(`duplicate casino table game id "${game.id}"`);
    registry.set(game.id, game);
  }
  return registry;
}
