import { asc, eq, inArray, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../db/client.js";
import { playerStats, transactions } from "../db/schema/index.js";

export type BalanceKind = "cash" | "bank" | "points";

export interface BalanceChange {
  playerId: string;
  /** Signed: positive credits, negative debits. Always bigint — never a number. */
  amount: bigint;
  kind: BalanceKind;
  reason: string;
  refId?: string;
}

export class InsufficientFundsError extends Error {
  constructor(readonly playerId: string, readonly kind: BalanceKind) {
    super(`insufficient ${kind} for player ${playerId}`);
    this.name = "InsufficientFundsError";
  }
}

/** Drizzle's transaction callback type. Every mutation takes this, never the root Db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const column = { cash: playerStats.cash, bank: playerStats.bank, points: playerStats.points } as const;

/**
 * Lock several players' stat rows in ascending id order.
 * Consistent ordering is what prevents deadlocks when two jobs touch the same
 * pair of players in opposite order (spec §2.3).
 */
export async function lockPlayersForUpdate(tx: Tx, playerIds: string[]): Promise<void> {
  const unique = [...new Set(playerIds)].sort();
  if (unique.length === 0) return;
  await tx.select({ playerId: playerStats.playerId })
    .from(playerStats)
    .where(inArray(playerStats.playerId, unique))
    .orderBy(asc(playerStats.playerId))
    .for("update");
}

/**
 * The ONLY sanctioned way to move money. Writes the ledger row and the balance
 * in the caller's transaction — never call this outside `db.transaction(...)`.
 * Returns the new balance.
 */
export async function applyBalanceChange(tx: Tx, change: BalanceChange): Promise<bigint> {
  await lockPlayersForUpdate(tx, [change.playerId]);

  const target = column[change.kind];
  const [current] = await tx.select({ value: target })
    .from(playerStats)
    .where(eq(playerStats.playerId, change.playerId));

  if (!current) throw new Error(`player_stats missing for ${change.playerId}`);

  const next = current.value + change.amount;
  if (next < 0n) throw new InsufficientFundsError(change.playerId, change.kind);

  await tx.update(playerStats)
    .set({ [change.kind]: next })
    .where(eq(playerStats.playerId, change.playerId));

  await tx.insert(transactions).values({
    id: uuidv7(),
    playerId: change.playerId,
    amount: change.amount,
    balanceKind: change.kind,
    reason: change.reason,
    refId: change.refId ?? null,
  });

  return next;
}

/** Credit exp — not money, but bigint and same overflow concern (spec §1.1). */
export async function addExp(tx: Tx, playerId: string, amount: bigint): Promise<void> {
  if (amount === 0n) return;
  await tx.update(playerStats)
    .set({ exp: sql`${playerStats.exp} + ${amount}` })
    .where(eq(playerStats.playerId, playerId));
}
