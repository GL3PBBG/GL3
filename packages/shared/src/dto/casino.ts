import { z } from "zod";
import { IdSchema, MoneySchema, TimestampSchema } from "../primitives.js";
import { BoundedViewNodeDtoSchema } from "./plugins.js";

/**
 * One installed game as the lobby reports it for the town the player is in.
 *
 * `ownerName` is `null`, not `""`, for a table nobody has bought — the page
 * decides how to draw an unowned house. `maxBet` is meaningful either way: it
 * is the owner's lever when there is an owner, and the `max_bet` setting when
 * there is not.
 */
export const CasinoGameSchema = z.object({
  /** The GameDef id, which is also the declaring plugin's id. */
  gameId: z.string(),
  name: z.string(),
  ownerName: z.string().nullable(),
  maxBet: MoneySchema,
});
export type CasinoGame = z.infer<typeof CasinoGameSchema>;

/**
 * The caller's own open hand, as the lobby reports it.
 *
 * Only an UNEXPIRED hand ever appears here — the route reports an expired one
 * as no hand at all, because it is not resumable (the next `play` forfeits it).
 *
 * `view` is `null` when the game is no longer installed, or is installed but
 * declares no `view` renderer: the hand is still resumable through `act`, it
 * just cannot be drawn. `gameName` falls back to the raw `gameId` in the same
 * case.
 */
export const CasinoSessionViewSchema = z.object({
  sessionId: IdSchema,
  gameId: z.string(),
  gameName: z.string(),
  wager: MoneySchema,
  view: BoundedViewNodeDtoSchema.nullable(),
  expiresAt: TimestampSchema,
});
export type CasinoSessionView = z.infer<typeof CasinoSessionViewSchema>;

/** `GET /api/casino`. */
export const CasinoLobbyResponseSchema = z.object({
  locationId: IdSchema,
  locationName: z.string(),
  minBet: MoneySchema,
  games: z.array(CasinoGameSchema),
  session: CasinoSessionViewSchema.nullable(),
});
export type CasinoLobbyResponse = z.infer<typeof CasinoLobbyResponseSchema>;

/**
 * What `POST /api/casino/play` and `POST /api/casino/act` both answer.
 *
 * `view` is never null here — a `GameStep` always carries one, unlike the
 * lobby's resume view. `payout` is present only when `done` is true; a hand
 * that is still in play has no figure yet.
 *
 * `wager` is the hand's stake AFTER this step, which is why it is not
 * optional: blackjack's double raises it through `GameStep.wagerDelta`, and
 * this response is the only place the caller can ever learn the new figure —
 * the session row is gone once the hand settles, and a raise that settles in
 * the same call never reaches the lobby. Both routes send it on both
 * branches, so an optional field would only buy the page a fallback branch
 * that can never run and can never be tested.
 */
export const CasinoStepResponseSchema = z.object({
  sessionId: IdSchema,
  view: BoundedViewNodeDtoSchema,
  done: z.boolean(),
  wager: MoneySchema,
  payout: MoneySchema.optional(),
});
export type CasinoStepResponse = z.infer<typeof CasinoStepResponseSchema>;
