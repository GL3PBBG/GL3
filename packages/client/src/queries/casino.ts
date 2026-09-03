import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CasinoLeaveResponseSchema,
  CasinoLobbyResponseSchema,
  CasinoSitResponseSchema,
  CasinoStepResponseSchema,
  CasinoTableResponseSchema,
  type CasinoLeaveResponse,
  type CasinoLobbyResponse,
  type CasinoSitResponse,
  type CasinoStepResponse,
  type CasinoTableResponse,
} from "@gl3/shared";
import { api } from "../api/client.js";
import { keys } from "../api/keys.js";

// ---------------------------------------------------------------------------
// Casino
// ---------------------------------------------------------------------------

/** The tables in the town the player is standing in, plus their own open hand. */
export function useCasino() {
  return useQuery<CasinoLobbyResponse>({
    queryKey: keys.casino(),
    queryFn: async () => CasinoLobbyResponseSchema.parse(await api("/api/casino")),
  });
}

/**
 * Opens a hand. `wager` is a decimal string all the way down — it is a bigint
 * server-side, and passing it through Number here is exactly the floating-point
 * reintroduction the money rule forbids.
 *
 * A one-shot game (or blackjack dealing a natural) comes back `done: true` with
 * a payout and no session ever opens, so the caller must read `done` rather
 * than assume a hand is now in play.
 */
export function usePlayCasino() {
  const queryClient = useQueryClient();
  return useMutation<CasinoStepResponse, Error, { gameId: string; wager: string }>({
    mutationFn: async (input) =>
      CasinoStepResponseSchema.parse(
        await api("/api/casino/play", { method: "POST", body: JSON.stringify(input) }),
      ),
    onSettled: () => {
      // The wager left the player's cash whether the hand won, lost or 409'd
      // partway — refresh both even on failure.
      void queryClient.invalidateQueries({ queryKey: keys.casino() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

/**
 * Advances the caller's open hand. The action is whatever the game's own
 * `action` schema accepts — a bare string for blackjack ("hit" | "stand" |
 * "double"), or an arbitrary object for a game that speaks the generic-moves
 * protocol (`GameMoveDto.action`, possibly shallow-merged with a typed
 * amount). The hub validates only the envelope, so this stays `unknown` here.
 */
export function useCasinoAct() {
  const queryClient = useQueryClient();
  return useMutation<CasinoStepResponse, Error, unknown>({
    mutationFn: async (action) =>
      CasinoStepResponseSchema.parse(
        await api("/api/casino/act", { method: "POST", body: JSON.stringify({ action }) }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.casino() });
      // A double raises the wager and a settle pays out, so cash moves here too.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

/**
 * How often a seated player re-reads their table, in milliseconds.
 *
 * WS invalidation is the fast path: the hub publishes a SILENT `table` event
 * to every seat at the end of each mutating table transaction, and
 * `invalidates: ["casino"]` refreshes this query the moment anything at the
 * table moves. Silent because a blackjack hand is ~10 transitions across up
 * to five seats, which is the right amount of cache invalidation and far too
 * many feed lines — the flag is what made this possible at all.
 *
 * The poll stays as the LAZY CLOCK'S BACKSTOP, and that is now its only job:
 * the table advances because somebody read it (`advanceTable`), so a table
 * nobody is acting at produces no request for the server to publish from.
 * This interval is the worst case for a lapsed turn to be auto-stood there.
 * It was 2500 when it was also the realtime channel.
 */
export const TABLE_POLL_MS = 15_000;

/**
 * The caller's seat, wherever it is. `{ table: null }` when they hold none.
 *
 * `seated` gates the POLL, never the query: nothing else on the client knows
 * whether this player holds a seat — the lobby reports the town's tables, not
 * the caller's place at one — so the first read is what answers the question,
 * and the caller feeds the answer back in. Polling unconditionally instead
 * would hit the server forever to be told `null`, which is exactly the bug
 * the hospital query shipped (see `hospitalRefetchInterval`).
 */
export function useCasinoTable(seated: boolean) {
  return useQuery<CasinoTableResponse>({
    queryKey: keys.casinoTable(),
    queryFn: async () => CasinoTableResponseSchema.parse(await api("/api/casino/table")),
    refetchInterval: seated ? TABLE_POLL_MS : false,
  });
}

/** Takes a seat at a table of `gameId` in the caller's town, opening one if needed. */
export function useSitCasino() {
  const queryClient = useQueryClient();
  return useMutation<CasinoSitResponse, Error, string>({
    mutationFn: async (gameId) =>
      CasinoSitResponseSchema.parse(
        await api("/api/casino/table/sit", { method: "POST", body: JSON.stringify({ gameId }) }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.casinoTable() });
      // The lobby's seat counts moved too — and on a 409 the caller is seated
      // somewhere they did not expect, which only a refetch can show them.
      void queryClient.invalidateQueries({ queryKey: keys.casino() });
    },
  });
}

/**
 * Gives the seat up. `deferred` is true when a stake was still in play: the
 * seat is marked leaving and frees itself when the hand settles, so the table
 * query keeps answering until then.
 */
export function useLeaveCasino() {
  const queryClient = useQueryClient();
  return useMutation<CasinoLeaveResponse, Error, void>({
    mutationFn: async () =>
      CasinoLeaveResponseSchema.parse(
        // No body at all — the route declares no schema, and `api` omits the
        // JSON content-type when there is nothing to send (FST_ERR_CTP_EMPTY_JSON_BODY).
        await api("/api/casino/table/leave", { method: "POST" }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.casinoTable() });
      void queryClient.invalidateQueries({ queryKey: keys.casino() });
      // Leaving can SETTLE the hand on the way out (the clock runs inside
      // `leave`), which pays out — so cash can move on this route.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}

/**
 * Puts this hand's stake up. Answers the whole table, which is why the
 * response is written straight into the table query rather than only
 * invalidating it: the bet may have completed the table and DEALT, and without
 * the write the player watches the pre-deal table for up to a whole poll.
 */
export function useTableBet() {
  const queryClient = useQueryClient();
  return useMutation<CasinoTableResponse, Error, string>({
    mutationFn: async (wager) =>
      CasinoTableResponseSchema.parse(
        await api("/api/casino/table/bet", { method: "POST", body: JSON.stringify({ wager }) }),
      ),
    onSuccess: (table) => { queryClient.setQueryData(keys.casinoTable(), table); },
    // The escrow left the player's cash. `onSettled` rather than `onSuccess`
    // for the same reason `usePlayCasino` uses it: a refused bet moves nothing
    // (the route throws inside the transaction, which rolls the escrow back),
    // but a refetch on a failure costs one request and removes a whole class
    // of "did that take my money?" from ever being possible.
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: keys.me() }); },
  });
}

/**
 * Plays the caller's turn. The action is whatever the game's own `action`
 * schema accepts; the hub validates only the envelope, so it stays `unknown`
 * here — `useCasinoAct`'s reasoning.
 */
export function useTableAct() {
  const queryClient = useQueryClient();
  return useMutation<CasinoTableResponse, Error, unknown>({
    mutationFn: async (action) =>
      CasinoTableResponseSchema.parse(
        await api("/api/casino/table/act", { method: "POST", body: JSON.stringify({ action }) }),
      ),
    onSuccess: (table) => { queryClient.setQueryData(keys.casinoTable(), table); },
    // A double raises the stake and a settle pays out, so cash moves here.
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: keys.me() }); },
  });
}
