import { eq } from "drizzle-orm";
import { z } from "zod";
import { PluginError, type PluginTx } from "@gl3/plugin-sdk";
import { ownerAt, payOwner, propertiesTable, takeOverFrom } from "@gl3/plugin-properties";
import type { GameDef } from "./games.js";
import { casinoSessions, playerStats } from "./schema.js";

/** A bigint-safe amount on the wire: digits only, never a JSON number
 *  (money is decimal-string, rule: zod every external boundary). Shared by
 *  `play`'s body and the table's `bet` body. */
export const NonNegativeIntegerString = z.string().regex(/^\d+$/, "nonnegative integer string");

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
 * The house a hand in progress settles against: the property row `play`
 * stamped on the session, looked up BY ID.
 *
 * Spec §4.1 freezes `property_id` for the hand and §4.3 says why — "a house
 * sold mid-hand must not move the payout to a new owner who never took the
 * wager". `act` re-resolving through `resolveHouse` broke that: a town
 * unowned at `play` sank the wager, and a table bought while the hand was
 * live saw its brand-new owner debited the payout.
 *
 * WHAT THE FREEZE DOES NOT GUARD (spec §4.3 says this too, now): properties'
 * `transfer` moves `owner_player_id` on the SAME row, so a frozen id still
 * pays whoever owns that row at settle. The freeze pins the ROW, which closes
 * drop-and-rebuy and unowned-then-bought; a transfer of the same table hands
 * the position, wager and all, to the new owner.
 *
 * A row that is gone or unowned answers as no house at all — the unowned-town
 * sink/faucet the spec already defines — rather than as a property id
 * `payOwner` would re-read only to skip.
 *
 * Unlocked, like `resolveHouse`: the caller holds `tx.locks.location` for the
 * session's town, which excludes every properties mutator (all are
 * locations-first), and `payOwner` re-reads FOR UPDATE itself.
 */
export async function frozenHouse(
  tx: PluginTx, propertyId: string | null, fallbackMaxBet: bigint,
): Promise<House> {
  const noHouse: House = { propertyId: null, ownerId: null, maxBet: fallbackMaxBet };
  if (propertyId === null) return noHouse;
  const [row] = await tx.db
    .select({ ownerPlayerId: propertiesTable.ownerPlayerId, cost: propertiesTable.cost })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId));
  if (row === undefined || row.ownerPlayerId === null) return noHouse;
  return {
    propertyId,
    ownerId: row.ownerPlayerId,
    // `ownerAt`'s reading of the lever: 0n means the owner has set none.
    maxBet: row.cost > 0n ? row.cost : fallbackMaxBet,
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

/** The house owner's cash, or `null` in an unowned town — the figure
 *  `assertHouseCanCover` (and the table path's `totalExposure` comparison)
 *  measures exposure against. Read under the player lock the caller has
 *  already taken. */
export async function readOwnerCash(tx: PluginTx, ownerId: string | null): Promise<bigint | null> {
  if (ownerId === null) return null;
  const [ownerStats] = await tx.db
    .select({ cash: playerStats.cash })
    .from(playerStats)
    .where(eq(playerStats.playerId, ownerId));
  return ownerStats?.cash ?? 0n;
}

/**
 * A game's OWN action schema over the `z.unknown()` envelope `act` accepts.
 *
 * The act body schemas can only validate the envelope — the hub cannot know a
 * game's action shape up front (spec §4.2) — so this is the second half of
 * the boundary, and a `ZodError` escaping it is a 500 where the repo's rule
 * says a bad body is a clean 400. Takes the SCHEMA rather than the game so the
 * solo `GameDef` and the table `TableGameDef` share one 400 contract.
 */
export function parseAction(schema: z.ZodType<unknown>, raw: unknown): unknown {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new PluginError("invalid_action", 400);
  return parsed.data;
}

/** What the winner is told when the table changes hands. Exported so the page
 *  and the tests quote the one string rather than three copies of it. */
export const HOUSE_SEIZED_MESSAGE =
  "The owner did not have enough cash to pay the bet, you took ownership of the casino.";

/**
 * Both sides of a bankruptcy takeover, told by NOTIFICATION rather than by a
 * plugin event: casino publishes no event per hand (one per blackjack hand
 * floods the feed) and a takeover is still a hand. `tx.notify` also reaches
 * the OLD owner, who is not the actor and would never see a player-audience
 * event.
 *
 * Called after a settle reported a seizure, inside the same transaction, so
 * a rollback takes the notification with the handover.
 */
export async function notifyTakeover(
  tx: PluginTx, house: House, winner: { id: string; username: string }, gameName: string,
): Promise<void> {
  await tx.notify(winner.id, HOUSE_SEIZED_MESSAGE);
  if (house.ownerId === null) return;
  await tx.notify(
    house.ownerId,
    `${winner.username} took over your ${gameName} table — you could not cover their winnings.`,
  );
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
    // Truncated because a third-party game controls both the content and the
    // LENGTH of this string, and it rides a response to the player. 200 is far
    // more than any real message needs and far less than a useful payload. The
    // page renders the code rather than `detail` today, so this is a bound on
    // a surface that is inert — the rule to keep is that `detail` is a game's
    // own text and must never be rendered raw.
    const raw = error instanceof Error ? error.message : String(error);
    const detail = raw.slice(0, 200);
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
): Promise<boolean> {
  let seized = false;
  if (payout > 0n) {
    if (house.propertyId !== null) {
      // The return value is READ now, unlike `escrow`'s: it is the only place
      // a short-pay is visible. `payOwner` clamps a debit to the owner's cash,
      // so `moved` is `-payout` when the house covered the hand and something
      // smaller (0n included) when it did not.
      const moved = await payOwner(tx, house.propertyId, -payout, `casino.${gameId}.payout`);
      const shortfall = payout + moved; // `moved` is <= 0n
      if (shortfall > 0n && house.ownerId !== null) {
        // THE BANKRUPTCY TAKEOVER. The house could not pay what the hand won,
        // so the winner takes the table. `takeOverFrom` refuses if the row is
        // gone or unowned (an unowned house is a faucet — it cannot go
        // bankrupt, and 0n from `payOwner` means exactly that when a
        // `seizeOnKill` landed mid-hand), if somebody else owns it now, or if
        // the winner is the owner. In every one of those cases the payout
        // below still happens: the player is paid either way.
        seized = await takeOverFrom(tx, house.propertyId, house.ownerId, playerId);
      }
    }
    await tx.economy.applyBalanceChange({
      playerId, amount: payout, kind: "cash", reason: `casino.${gameId}.payout`,
    });
  }
  await tx.db.update(casinoSessions)
    .set({ status: "settled", settledAt: new Date() })
    .where(eq(casinoSessions.id, sessionId));
  return seized;
}
