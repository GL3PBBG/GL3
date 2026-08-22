import { z } from "zod";
import { MoneySchema } from "../primitives.js";

/**
 * `GET /api/admin/economy/overview` — the admin MIMO dashboard, one round
 * trip. Consumed by the bespoke `AdminEconomy` page (the one core admin page
 * that outgrew the static view vocabulary), which is why this is a real DTO
 * rather than the TableRowsResponse shape the generic renderer eats.
 *
 * Conventions, all mirroring stats.ts: money is a decimal string straight off
 * a Postgres bigint (never a JSON number), days are `YYYY-MM-DD` in UTC, and
 * `daily` is one entry per day INCLUDING empty ones — the client charts it,
 * and a chart with holes renders a lie. `generatedAt` is when the payload was
 * computed, not served: the endpoint caches for five minutes.
 */
export const AdminEconomySupplySchema = z.object({
  playerCash: MoneySchema,
  playerBank: MoneySchema,
  gangCash: MoneySchema,
  gangBank: MoneySchema,
  /** Player cash + bank + gang cash + bank. Points are not money. */
  moneySupply: MoneySchema,
  points: MoneySchema,
});
export type AdminEconomySupply = z.infer<typeof AdminEconomySupplySchema>;

/** Signed totals for a window — a faucet-heavy economy nets positive here. */
export const AdminEconomyWindowSchema = z.object({
  net: MoneySchema,
  inflow: MoneySchema,
  outflow: MoneySchema,
});
export type AdminEconomyWindow = z.infer<typeof AdminEconomyWindowSchema>;

export const AdminEconomyFlowSchema = z.object({
  reason: z.string(),
  /** Signed, no explicit `+` — plain `MoneySchema`, so the client can format it. */
  net: MoneySchema,
  inflow: MoneySchema,
  outflow: MoneySchema,
  count: z.number().int().nonnegative(),
});
export type AdminEconomyFlow = z.infer<typeof AdminEconomyFlowSchema>;

export const AdminEconomyDaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  net: MoneySchema,
  inflow: MoneySchema,
  outflow: MoneySchema,
});
export type AdminEconomyDay = z.infer<typeof AdminEconomyDaySchema>;

export const AdminEconomyOverviewSchema = z.object({
  /** When the payload was computed, NOT when it was served — it is cached. */
  generatedAt: z.string().datetime(),
  supply: AdminEconomySupplySchema,
  windows: z.object({
    d7: AdminEconomyWindowSchema,
    d30: AdminEconomyWindowSchema,
  }),
  /** Net flow by ledger reason over the last 7 days, biggest movers first. */
  flows: z.array(AdminEconomyFlowSchema),
  /** Thirty UTC days, ASCENDING and gap-filled — chart-ready. */
  daily: z.array(AdminEconomyDaySchema),
});
export type AdminEconomyOverview = z.infer<typeof AdminEconomyOverviewSchema>;
