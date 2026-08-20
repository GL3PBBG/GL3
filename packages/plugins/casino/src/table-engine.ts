import { asc, eq } from "drizzle-orm";
import type { PluginCtx, PluginTx } from "@gl3/plugin-sdk";
import { frozenHouse, type House } from "./engine.js";
import { casinoSeats, casinoTables } from "./schema.js";
import { readMaxBet } from "./settings.js";

export type TableRow = typeof casinoTables.$inferSelect;
export type SeatRow = typeof casinoSeats.$inferSelect;

export interface LockedTable { table: TableRow; seats: SeatRow[]; house: House }

/**
 * RULE 6, the table edge. The caller holds tx.locks.location(the table's
 * town) BEFORE calling — that lock serializes every sit/leave/bet/act/advance
 * at the table, which is what makes the seat read below authoritative. Then:
 * ONE sorted tx.locks.player over every seated player, the frozen-house
 * owner, and any extra ids (sit's caller, who has no seat yet) — splitting
 * this call is the ABBA cycle casino-table-lock-order.test.ts pins — then
 * the table row FOR UPDATE.
 */
export async function lockTable(
  tx: PluginTx, ctx: PluginCtx, tableId: string, extraPlayerIds: string[] = [],
): Promise<LockedTable | null> {
  const seatRows = await tx.db.select().from(casinoSeats)
    .where(eq(casinoSeats.tableId, tableId)).orderBy(asc(casinoSeats.seatNo));
  const [pre] = await tx.db.select().from(casinoTables).where(eq(casinoTables.id, tableId));
  if (pre === undefined) return null;
  const house = await frozenHouse(tx, pre.propertyId, readMaxBet(ctx.settings));
  const ids = new Set<string>(extraPlayerIds);
  for (const seat of seatRows) ids.add(seat.playerId);
  if (house.ownerId !== null) ids.add(house.ownerId);
  await tx.locks.player([...ids]);
  const [table] = await tx.db.select().from(casinoTables)
    .where(eq(casinoTables.id, tableId)).for("update");
  if (table === undefined) return null;
  const seats = await tx.db.select().from(casinoSeats)
    .where(eq(casinoSeats.tableId, tableId)).orderBy(asc(casinoSeats.seatNo));
  return { table, seats, house };
}
