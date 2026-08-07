import { asc, eq, inArray, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../db/client.js";
import { gangs, locations, playerStats, transactions } from "../db/schema/index.js";

export type BalanceKind = "cash" | "bank" | "points";

export interface BalanceChange {
  playerId: string;
  /** Signed: positive credits, negative debits. Always bigint — never a number. */
  amount: bigint;
  kind: BalanceKind;
  reason: string;
  refId?: string;
  jobId?: string;
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
    jobId: change.jobId ?? null,
  });

  return next;
}

/**
 * Same rationale as lockPlayersForUpdate, for the one shared non-player row
 * this schema locks: a bullets purchase decrements `locations.bullet_stock`,
 * a value every buyer at that location contends over. Global Constraints:
 * always lock the location row before the player's row (called first in
 * performBulletsPurchase) — a single fixed direction is what rules out a
 * deadlock against any future code path that might lock a player row first.
 */
export async function lockLocationForUpdate(tx: Tx, locationId: string): Promise<void> {
  await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, locationId)).for("update");
}

/** Credit exp — not money, but bigint and same overflow concern (spec §1.1). */
export async function addExp(tx: Tx, playerId: string, amount: bigint): Promise<void> {
  if (amount === 0n) return;
  await tx.update(playerStats)
    .set({ exp: sql`${playerStats.exp} + ${amount}` })
    .where(eq(playerStats.playerId, playerId));
}

export type GangBalanceKind = "cash" | "bank";

export interface GangBalanceChange {
  gangId: string;
  amount: bigint;
  kind: GangBalanceKind;
  reason: string;
  refId?: string;
}

export class InsufficientGangFundsError extends Error {
  constructor(readonly gangId: string, readonly kind: GangBalanceKind) {
    super(`insufficient gang ${kind} for gang ${gangId}`);
    this.name = "InsufficientGangFundsError";
  }
}

const gangColumn = { cash: gangs.cash, bank: gangs.bank } as const;

/** Same ascending-id-order guarantee as lockPlayersForUpdate, applied to gangs. */
export async function lockGangsForUpdate(tx: Tx, gangIds: string[]): Promise<void> {
  const unique = [...new Set(gangIds)].sort();
  if (unique.length === 0) return;
  await tx.select({ id: gangs.id })
    .from(gangs)
    .where(inArray(gangs.id, unique))
    .orderBy(asc(gangs.id))
    .for("update");
}

/** The gang-side sibling of applyBalanceChange. Same contract: call inside an existing transaction, returns the new balance. */
export async function applyGangBalanceChange(tx: Tx, change: GangBalanceChange): Promise<bigint> {
  await lockGangsForUpdate(tx, [change.gangId]);

  const target = gangColumn[change.kind];
  const [current] = await tx.select({ value: target })
    .from(gangs)
    .where(eq(gangs.id, change.gangId));

  if (!current) throw new Error(`gang missing for ${change.gangId}`);

  const next = current.value + change.amount;
  if (next < 0n) throw new InsufficientGangFundsError(change.gangId, change.kind);

  await tx.update(gangs)
    .set({ [change.kind]: next })
    .where(eq(gangs.id, change.gangId));

  await tx.insert(transactions).values({
    id: uuidv7(),
    gangId: change.gangId,
    playerId: null,
    amount: change.amount,
    balanceKind: change.kind,
    reason: change.reason,
    refId: change.refId ?? null,
  });

  return next;
}

/**
 * Locks a gang row and a player_stats row in a single global order — the two
 * live in different tables, so applyBalanceChange's and applyGangBalanceChange's
 * own single-row locks can't establish cross-table ordering on their own.
 * String-comparing the two UUIDs gives a total order that is the same
 * regardless of which side (deposit vs withdraw) is conceptually "first",
 * which is what actually prevents the deadlock — see gang-ledger.test.ts.
 */
export async function lockGangAndPlayerForUpdate(tx: Tx, gangId: string, playerId: string): Promise<void> {
  if (gangId < playerId) {
    await lockGangsForUpdate(tx, [gangId]);
    await lockPlayersForUpdate(tx, [playerId]);
  } else {
    await lockPlayersForUpdate(tx, [playerId]);
    await lockGangsForUpdate(tx, [gangId]);
  }
}
