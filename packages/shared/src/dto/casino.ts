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

/**
 * One live table at a registered table game, as the lobby lists it —
 * `seatsFilled`/`maxSeats`/`phase` are enough to render an occupancy badge
 * without a second round trip to `GET /api/casino/table`.
 */
export const CasinoTableSummarySchema = z.object({
  tableId: IdSchema,
  seatsFilled: z.number().int(),
  maxSeats: z.number().int(),
  phase: z.enum(["betting", "acting"]),
});
export type CasinoTableSummary = z.infer<typeof CasinoTableSummarySchema>;

/**
 * One installed TABLE game, as the lobby reports it — `CasinoGameSchema` plus
 * `maxSeats` (a table game has no session-style solo cap) and every live
 * table at it in the caller's town. A game with no live table still appears,
 * with `tables: []`: `sit` opens a fresh one.
 */
export const CasinoTableGameSchema = CasinoGameSchema.extend({
  maxSeats: z.number().int(),
  tables: z.array(CasinoTableSummarySchema),
});
export type CasinoTableGame = z.infer<typeof CasinoTableGameSchema>;

/**
 * A town OTHER than the caller's with at least one seated player at a
 * registered table game — counts only, never a username, matching the
 * anonymity an underground town already gets everywhere else.
 */
export const CasinoRemoteTablesSchema = z.object({
  locationId: IdSchema,
  locationName: z.string(),
  gameId: z.string(),
  gameName: z.string(),
  seated: z.number().int(),
});
export type CasinoRemoteTables = z.infer<typeof CasinoRemoteTablesSchema>;

/** `GET /api/casino`. */
export const CasinoLobbyResponseSchema = z.object({
  locationId: IdSchema,
  locationName: z.string(),
  minBet: MoneySchema,
  games: z.array(CasinoGameSchema),
  tableGames: z.array(CasinoTableGameSchema),
  remote: z.array(CasinoRemoteTablesSchema),
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
  /**
   * True when this hand's payout bankrupted the house and the table changed
   * hands to the caller. Optional, not required: only a settling step (`done`)
   * ever carries it, and an in-play step has no answer to give yet.
   */
  houseSeized: z.boolean().optional(),
});
export type CasinoStepResponse = z.infer<typeof CasinoStepResponseSchema>;

/** One occupied seat at a table, as `GET /api/casino/table` reports it. */
export const CasinoTableSeatSchema = z.object({
  seat: z.number().int().min(0).max(4),
  username: z.string(),
  wager: MoneySchema,
  leaving: z.boolean(),
  idleHands: z.number().int(),
});
export type CasinoTableSeat = z.infer<typeof CasinoTableSeatSchema>;

/**
 * What `GET /api/casino/table`, `POST /api/casino/table/bet` and
 * `POST /api/casino/table/act` all answer with — one envelope for all three,
 * since a settle inside `bet`/`act` can leave the table in exactly the state
 * a plain `GET` would have found it in (`renderAfter`'s reasoning).
 *
 * `deadlineAt` is `null` before the first bet starts the clock. `turnSeat` is
 * `null` outside the acting phase. `mySeat` is `null` for a spectator read —
 * unreachable via `bet`/`act` (both require a seat), but `GET` allows it, so
 * the field is nullable rather than always populated. `view` is `null` only
 * when the table has no state yet (before the first deal of a hand).
 */
export const CasinoTableViewSchema = z.object({
  tableId: IdSchema,
  gameId: z.string(),
  gameName: z.string(),
  locationId: IdSchema,
  locationName: z.string(),
  phase: z.enum(["betting", "acting"]),
  handNo: z.number().int(),
  deadlineAt: TimestampSchema.nullable(),
  turnSeat: z.number().int().nullable(),
  mySeat: z.number().int().nullable(),
  minBet: MoneySchema,
  maxBet: MoneySchema,
  seats: z.array(CasinoTableSeatSchema),
  view: BoundedViewNodeDtoSchema.nullable(),
});
export type CasinoTableView = z.infer<typeof CasinoTableViewSchema>;

/**
 * The shared envelope itself — `table` is `null` when the caller holds no
 * seat, or when a settle inside `bet`/`act` emptied and deleted the table the
 * caller was just acting on.
 */
export const CasinoTableResponseSchema = z.object({ table: CasinoTableViewSchema.nullable() });
export type CasinoTableResponse = z.infer<typeof CasinoTableResponseSchema>;

/** `POST /api/casino/table/sit`. */
export const CasinoSitResponseSchema = z.object({ tableId: IdSchema, seat: z.number().int() });
export type CasinoSitResponse = z.infer<typeof CasinoSitResponseSchema>;

/**
 * `POST /api/casino/table/leave`. `deferred` is true when the caller was
 * still in an open hand — the seat is marked `leaving` rather than freed, and
 * frees itself once the hand settles.
 */
export const CasinoLeaveResponseSchema = z.object({ left: z.literal(true), deferred: z.boolean() });
export type CasinoLeaveResponse = z.infer<typeof CasinoLeaveResponseSchema>;
