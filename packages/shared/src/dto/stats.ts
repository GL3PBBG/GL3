import { z } from "zod";
import { MoneySchema } from "../primitives.js";

/** A UTC calendar day, `YYYY-MM-DD`. Trend arrays are index-aligned with these. */
export const StatsDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a UTC date");

export const GameStatsTotalsSchema = z.object({
  playersTotal: z.number().int().nonnegative(),
  /** Presence ZSET members inside the same 5-minute window `/api/online` uses. */
  onlineNow: z.number().int().nonnegative(),
  jailedNow: z.number().int().nonnegative(),
  hospitalisedNow: z.number().int().nonnegative(),
  gangsTotal: z.number().int().nonnegative(),
  /** cash + bank across every player, summed as bigint and sent as a decimal string. */
  moneySupply: MoneySchema,
});
export type GameStatsTotals = z.infer<typeof GameStatsTotalsSchema>;

export const GameStatsTrendsSchema = z.object({
  days: z.array(StatsDaySchema),
  newPlayers: z.array(z.number().int().nonnegative()),
  crimes: z.array(z.number().int().nonnegative()),
  /** Sum of |amount| over the ledger for that day — a decimal string per point. */
  moneyMoved: z.array(MoneySchema),
});
export type GameStatsTrends = z.infer<typeof GameStatsTrendsSchema>;

export const GameStatsResponseSchema = z.object({
  /** When the payload was computed, NOT when it was served — it is cached. */
  generatedAt: z.string().datetime(),
  totals: GameStatsTotalsSchema,
  trends: GameStatsTrendsSchema,
});
export type GameStatsResponse = z.infer<typeof GameStatsResponseSchema>;
