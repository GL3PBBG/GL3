import { eq } from "drizzle-orm";
import { PluginError, type PluginTx } from "@gl3/plugin-sdk";
import { ownerAt, payOwner } from "@gl3/plugin-properties";
import type { GameDef } from "./games.js";
import { casinoSessions } from "./schema.js";

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
 * THE MOST A HAND CAN EVER RETURN: `wager × maxPayoutMultiplier`, in bigint.
 *
 * Two callers, and they are the two halves of one idea — `assertHouseCanCover`
 * asks whether the house could pay it, `resolvePayout` refuses to pay more
 * than it. Splitting the arithmetic out is what keeps those two answers the
 * same figure.
 *
 * `multiplier` is a `GameDef` field, so it is a number a third party chose. A
 * non-finite or negative one used to reach `BigInt(Math.round(...))` and throw
 * a RangeError, which `routes.ts` re-throws as an unhandled 500 with a stack
 * trace; it is refused here instead. 500 rather than 4xx because nothing the
 * caller sent is at fault — the installed game is misdeclared.
 */
export function exposureOf(wager: bigint, multiplier: number): bigint {
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new PluginError("invalid_game_multiplier", 500);
  }
  // Scale by 10 and divide to stay in bigint — never convert to float, money
  // is bigint end to end.
  return (wager * BigInt(Math.round(multiplier * 10))) / 10n;
}

/**
 * `payOwner` CLAMPS a debit to the owner's cash. Without this check a player
 * who wins more than the house holds is silently short-paid, with no error
 * anywhere and a ledger that still balances. Re-run whenever the wager grows
 * (Task 7's `wagerDelta`), which is why this is a standalone function rather
 * than inlined into `play`.
 *
 * The exposure is computed BEFORE the unowned-house early return, so a
 * misdeclared multiplier is refused in a town nobody owns too — an unowned
 * house is a faucet, which is exactly where an unbounded figure costs most.
 */
export function assertHouseCanCover(wager: bigint, multiplier: number, ownerCash: bigint | null): void {
  const exposure = exposureOf(wager, multiplier);
  if (ownerCash === null) return; // unowned house is a faucet — nothing to exhaust
  if (exposure > ownerCash) throw new PluginError("house_cannot_cover", 409);
}

/**
 * Runs one of a game's four pure handlers and turns anything it throws into a
 * clean refusal.
 *
 * `start`/`act`/`settle`/`view` are third-party code called inside a route
 * handler, and `routes.ts:88-95` re-throws whatever is not a `PluginError` —
 * so blackjack's own `throw new Error("can only double on the first two
 * cards")` answered 500 with a stack trace where the repo's rule is that an
 * unvalidated boundary must return a clean 4xx. 400 because the common case is
 * a move the game does not allow; the game's own message rides along as
 * `detail` so a page can show something better than a code.
 */
export function guardGame<T>(gameId: string, step: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    // A game that speaks the hub's own error type keeps its status and code.
    if (error instanceof PluginError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new PluginError("game_error", 400, { game: gameId, step, detail });
  }
}

/**
 * What the hand pays, BOUNDED. The single place `game.settle` is ever called.
 *
 * Spec §3 claims a game "cannot get money wrong, because it never touches
 * money". That holds only if the hub bounds the figure it is handed: the
 * player's leg is credited in full through `applyBalanceChange` while the
 * house's leg goes through `payOwner`, which clamps to the owner's cash — so
 * a `settle` returning more than it declared MINTS the difference, and in an
 * unowned town it is a pure faucet with no counterparty at all. A negative
 * figure is worse: it would debit the winner a second time.
 *
 * Clamping rather than refusing an over-large payout is deliberate — the
 * player has already staked the wager, and a hand that cannot pay out at all
 * because the game misbehaved would take their money and give nothing. The
 * cap is the figure the house was checked against at `play`, so the clamp can
 * never exceed what `assertHouseCanCover` already proved payable.
 */
export function resolvePayout(game: GameDef, state: unknown, wager: bigint): bigint {
  const payout = guardGame(game.id, "settle", () => game.settle(state, wager));
  if (payout < 0n) throw new PluginError("invalid_payout", 500);
  const cap = exposureOf(wager, game.maxPayoutMultiplier);
  return payout > cap ? cap : payout;
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
    // The return value is DISCARDED, and that is a decision, not an oversight.
    // `payOwner` answers 0n when the property's owner changed between its own
    // unlocked pre-read and its locked re-read. Every properties acquisition
    // and disposal route is locations-first, so `tx.locks.location` (held by
    // the caller) excludes all of them — except `seizeOnKill`, which takes no
    // location lock and no player lock and still disowns a victim's rows on
    // every kill. Seized here, the wager is debited from the player and
    // credited to nobody: the hand degrades to the unowned-town sink the
    // spec already defines, the money is conserved (every movement is still a
    // ledger row), and `play`'s up-front `assertHouseCanCover` has already
    // ruled out short-paying a winner. Pinned by
    // `apps/server/test/casino-lock-order.test.ts`.
    await payOwner(tx, house.propertyId, amount, `casino.${gameId}.wager`);
  }
}

/**
 * Pays the player and debits the house, then closes the session. The wager was
 * escrowed at `play` (V2 blackjack.inc.php:297) so the net across a hand is
 * correct without a second bookkeeping concept: a push returns the wager, a
 * loss returns nothing and the house keeps it. V2 :406 is the debit. Caller
 * (`act`, and Task 8's lazy forfeit) is responsible for persisting `state`
 * and any `wager` raise beforehand — this only writes `status`/`settledAt`.
 */
export async function settleSession(
  tx: PluginTx, sessionId: string, playerId: string, gameId: string,
  house: House, payout: bigint,
): Promise<void> {
  if (payout > 0n) {
    if (house.propertyId !== null) {
      // Return value DISCARDED for the same reason as `escrow`'s above: a
      // house seized by `seizeOnKill` between `ownerAt` and this call answers
      // 0n, and the payout becomes a faucet rather than a debit to a player
      // whose row this transaction never locked. The player is paid either
      // way — a seizure mid-hand must not cost the winner their money.
      await payOwner(tx, house.propertyId, -payout, `casino.${gameId}.payout`);
    }
    await tx.economy.applyBalanceChange({
      playerId, amount: payout, kind: "cash", reason: `casino.${gameId}.payout`,
    });
  }
  await tx.db.update(casinoSessions)
    .set({ status: "settled", settledAt: new Date() })
    .where(eq(casinoSessions.id, sessionId));
}
