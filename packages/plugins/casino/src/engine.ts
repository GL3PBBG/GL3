import { PluginError, type PluginTx } from "@gl3/plugin-sdk";
import { ownerAt, payOwner } from "@gl3/plugin-properties";

export interface House {
  /** Null in a town nobody owns: escrow is a sink and payout a faucet. */
  propertyId: string | null;
  ownerId: string | null;
  /** The owner's lever read as the maximum bet — V2 blackjack.inc.php:276. */
  maxBet: bigint;
}

/**
 * Who the house is for `gameId` in `locationId`, and its maximum bet. Reads
 * without `FOR UPDATE` — `payOwner` re-reads the row under lock itself, so a
 * transfer racing this call cannot pay the wrong player (spec §4.3).
 */
export async function resolveHouse(
  tx: PluginTx, gameId: string, locationId: string, fallbackMaxBet: bigint,
): Promise<House> {
  const owner = await ownerAt(tx, gameId, locationId);
  if (owner === null) return { propertyId: null, ownerId: null, maxBet: fallbackMaxBet };
  return {
    propertyId: owner.propertyId,
    ownerId: owner.ownerId,
    // `null` lever means the owner has set none — use our own default, which
    // is bullets' fallback shape.
    maxBet: owner.lever ?? fallbackMaxBet,
  };
}

/**
 * `payOwner` CLAMPS a debit to the owner's cash. Without this check a player
 * who wins more than the house holds is silently short-paid, with no error
 * anywhere and a ledger that still balances. Re-run whenever the wager grows
 * (Task 7's `wagerDelta`), which is why this is a standalone function rather
 * than inlined into `play`.
 */
export function assertHouseCanCover(wager: bigint, multiplier: number, ownerCash: bigint | null): void {
  if (ownerCash === null) return; // unowned house is a faucet — nothing to exhaust
  // multiplier is a float (2.5); scale by 10 and divide to stay in bigint —
  // never convert to float, money is bigint end to end.
  const exposure = (wager * BigInt(Math.round(multiplier * 10))) / 10n;
  if (exposure > ownerCash) throw new PluginError("house_cannot_cover", 409);
}

/**
 * Debits the player and credits the house the same amount, or sinks it in an
 * unowned town. V2 blackjack.inc.php:297. Every movement goes through
 * `applyBalanceChange` (rule 3); `payOwner` does the same internally for the
 * house leg.
 */
export async function escrow(
  tx: PluginTx, house: House, playerId: string, amount: bigint, gameId: string,
): Promise<void> {
  await tx.economy.applyBalanceChange({
    playerId, amount: -amount, kind: "cash", reason: `casino.${gameId}.wager`,
  });
  if (house.propertyId !== null) {
    await payOwner(tx, house.propertyId, amount, `casino.${gameId}.wager`);
  }
}
