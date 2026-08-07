import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { players, playerStats } from "../../db/schema/index.js";
import { applyBalanceChange } from "../../economy/ledger.js";

export type BankDirection = "deposit" | "withdraw";
export interface BankTransactionResult { cash: bigint; bank: bigint }

/**
 * Two ledger legs (a cash debit/credit and a matching bank credit/debit) in
 * ONE transaction — the same "one balance, one ledger row" rule from Task 8
 * applied twice. No cooldown, no queue: bank has no V2 cooldown (spec §1.2)
 * and no randomness to protect from a retry (M2 plan Decision 1); the row
 * lock `applyBalanceChange` already takes on `player_stats` is what makes
 * two concurrent requests against the same player safe.
 */
export async function performBankTransaction(
  db: Db, redis: Redis, playerId: string, direction: BankDirection, amount: bigint,
): Promise<BankTransactionResult> {
  const result = await db.transaction(async (tx) => {
    if (direction === "deposit") {
      await applyBalanceChange(tx, { playerId, amount: -amount, kind: "cash", reason: "bank.deposit" });
      await applyBalanceChange(tx, { playerId, amount, kind: "bank", reason: "bank.deposit" });
    } else {
      await applyBalanceChange(tx, { playerId, amount: -amount, kind: "bank", reason: "bank.withdraw" });
      await applyBalanceChange(tx, { playerId, amount, kind: "cash", reason: "bank.withdraw" });
    }
    const [row] = await tx.select({ cash: playerStats.cash, bank: playerStats.bank })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    if (!row) throw new Error(`player_stats missing for ${playerId}`);
    return row;
  });

  const [actor] = await db.select({ username: players.username }).from(players).where(eq(players.id, playerId));
  const event: GameEvent = {
    id: uuidv7(), type: "bank.transacted", at: new Date().toISOString(),
    actorId: playerId, actorName: actor?.username ?? "unknown",
    audience: { kind: "player", playerId },
    direction, amount: amount.toString(), cash: result.cash.toString(), bank: result.bank.toString(),
  };
  await publishEvent(redis, event);

  return result;
}
