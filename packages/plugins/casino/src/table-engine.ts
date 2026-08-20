import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { isInsufficientFundsError, PluginError, type PluginCtx, type PluginTx } from "@gl3/plugin-sdk";
import { payOwner, takeOverFrom } from "@gl3/plugin-properties";
import {
  escrow, exposureOf, frozenHouse, guardGame, notifyTakeover, readOwnerCash, type House,
} from "./engine.js";
import type { TableGameDef, TableStep } from "./games.js";
import { casinoSeats, casinoTables, players } from "./schema.js";
import { fromStorableState, toStorableState } from "./state.js";
import {
  MAX_TABLE_SEATS, readMaxBet, readTableIdleKickHands, readTableTurnSeconds,
} from "./settings.js";

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

/**
 * `lockTable`'s READ-ONLY twin: the same `LockedTable` shape, assembled from
 * plain SELECTs with not one lock taken.
 *
 * For RENDERING ONLY, and the name is deliberately not `lockTable`-ish so a
 * future caller cannot mistake it for one: nothing read here is authoritative
 * for a write, because any of it can change under a concurrent transaction.
 * GET's fast path is its only caller — a table whose clock has not lapsed owes
 * nobody anything, so making every poll (2.5s per seated player, spec §8) take
 * the location lock, three player locks and the table row `FOR UPDATE` would
 * serialize a read against every acting player at the table.
 */
export async function readTableUnlocked(
  tx: PluginTx, ctx: PluginCtx, tableId: string,
): Promise<LockedTable | null> {
  const [table] = await tx.db.select().from(casinoTables).where(eq(casinoTables.id, tableId));
  if (table === undefined) return null;
  const seats = await tx.db.select().from(casinoSeats)
    .where(eq(casinoSeats.tableId, tableId)).orderBy(asc(casinoSeats.seatNo));
  // Unlocked by its own contract (`engine.ts`), so it fits here unchanged.
  const house = await frozenHouse(tx, table.propertyId, readMaxBet(ctx.settings));
  return { table, seats, house };
}

/**
 * Σ per-seat `exposureOf` over every in-hand wager, `extra` included.
 *
 * The solo `assertHouseCanCover` comparison, SUMMED (spec §6): the house's
 * liability at a table is every live seat at once, not the seat that happens
 * to be acting, so a bet or a double is measured against the whole table's
 * exposure. `extra` is the wager being added by the request in flight — the
 * incoming bet at `bet`, the raise at `applyStep` — because it is not on the
 * seat row yet at the moment the check runs.
 */
export function totalExposure(
  seats: readonly SeatRow[], multiplier: number, extra?: { seat: number; amount: bigint },
): bigint {
  let sum = 0n;
  for (const seat of seats) {
    let wager = seat.wager;
    if (extra !== undefined && seat.seatNo === extra.seat) wager += extra.amount;
    if (wager > 0n) sum += exposureOf(wager, multiplier);
  }
  return sum;
}

/**
 * Refuses the request when the house could not pay what the table is exposed
 * to. `readOwnerCash` is read LIVE under the player lock the caller already
 * holds, so wagers escrowed earlier in this hand count toward covering the
 * next one (spec §6, amended) — there is no incoming-wager addend.
 */
export async function assertTableCanCover(
  tx: PluginTx, house: House, seats: readonly SeatRow[], multiplier: number,
  extra?: { seat: number; amount: bigint },
): Promise<void> {
  const exposure = totalExposure(seats, multiplier, extra);
  const ownerCash = await readOwnerCash(tx, house.ownerId);
  if (ownerCash === null) return; // unowned house is a faucet — nothing to exhaust
  if (exposure > ownerCash) throw new PluginError("house_cannot_cover", 409);
}

/**
 * What the hand pays PER SEAT, bounded — `resolvePayout`'s multi-seat twin,
 * and the single place `TableGameDef.settle` is ever called.
 *
 * The bounds are the solo ones per seat (a figure over `exposureOf` is
 * clamped, a negative one is a misdeclared game and 500s) plus two a table
 * adds: a seat the game names that is NOT in the hand, and the same seat named
 * twice. Either would let a game direct another seat's money — or the same
 * seat's twice — through a payout the hub thought it had bounded.
 *
 * Seats absent from the array pay 0, which is `TableGameDef.settle`'s declared
 * contract, so a game that forgets a losing seat is not a defect.
 */
export function resolveTablePayouts(
  game: TableGameDef, state: unknown, seats: readonly SeatRow[],
): Map<string, bigint> {
  const figures = guardGame(game.id, "settle", () => game.settle(state));
  const bySeat = new Map<number, SeatRow>();
  for (const seat of seats) if (seat.wager > 0n) bySeat.set(seat.seatNo, seat);
  const payouts = new Map<string, bigint>();
  const seen = new Set<number>();
  for (const figure of figures) {
    const seat = bySeat.get(figure.seat);
    if (seat === undefined || seen.has(figure.seat)) throw new PluginError("invalid_payout", 500);
    seen.add(figure.seat);
    if (figure.payout < 0n) throw new PluginError("invalid_payout", 500);
    const cap = exposureOf(seat.wager, game.maxPayoutMultiplier);
    payouts.set(seat.id, figure.payout > cap ? cap : figure.payout);
  }
  for (const seat of bySeat.values()) if (!payouts.has(seat.id)) payouts.set(seat.id, 0n);
  return payouts;
}

/**
 * Ends the hand: pays every in-hand seat, hands the table over if the house
 * came up short, then resets the row for the next one.
 *
 * `settleSession`'s shape, seat by seat in ASCENDING seat order, with one
 * table-only rule: the takeover fires for the FIRST SHORT-PAID winner, not
 * the first winner. A house with enough cash for seat 0 and not for seat 1
 * failed seat 1, and seat 1 is who takes it; `seized` is a latch, so every
 * seat after it is paid from the sink and none of them can take a table that
 * has already changed hands. Every winner is credited in full throughout —
 * the takeover is on top of the money, never instead of it.
 */
export async function settleHand(
  tx: PluginTx, ctx: PluginCtx, locked: LockedTable, game: TableGameDef,
): Promise<void> {
  const { table, seats, house } = locked;
  const payouts = resolveTablePayouts(game, fromStorableState(table.state), seats);
  const ordered = [...seats].sort((a, b) => a.seatNo - b.seatNo);

  let seized = false;
  for (const seat of ordered) {
    if (seat.wager <= 0n) continue;
    const payout = payouts.get(seat.id) ?? 0n;
    if (payout <= 0n) continue;
    // `!seized` is load-bearing, not an optimisation. `takeOverFrom` moved
    // `owner_player_id` to the winner who was short-paid, so a later
    // `payOwner` on this same property would debit THEM — the seizing winner
    // would fund the rest of the table out of the winnings they just took the
    // house for. Once the latch is set, the remaining payouts come from the
    // sink instead, which is not a shortcut: the debit that tripped the latch
    // was clamped to the old owner's cash, so that owner provably holds 0 and
    // freezing the debit target on them would move nothing anyway.
    if (house.propertyId !== null && !seized) {
      // The return value is READ, as `settleSession` reads it: `payOwner`
      // clamps a debit to the owner's cash, so a smaller `moved` is the only
      // signal that this winner was short-paid.
      const moved = await payOwner(tx, house.propertyId, -payout, `casino.${table.gameId}.payout`);
      const shortfall = payout + moved; // `moved` is <= 0n
      if (shortfall > 0n && house.ownerId !== null) {
        seized = await takeOverFrom(tx, house.propertyId, house.ownerId, seat.playerId);
        if (seized) {
          const [winner] = await tx.db.select({ username: players.username })
            .from(players).where(eq(players.id, seat.playerId));
          await notifyTakeover(
            tx, house, { id: seat.playerId, username: winner?.username ?? "" }, game.name,
          );
        }
      }
    }
    await tx.economy.applyBalanceChange({
      playerId: seat.playerId, amount: payout, kind: "cash", reason: `casino.${table.gameId}.payout`,
    });
  }

  // Everyone who played is back to a clean slate: no stake, and an idle count
  // that only ever measures CONSECUTIVE deals sat out (spec §3's `idle_hands`).
  await tx.db.update(casinoSeats).set({ wager: 0n, idleHands: 0 })
    .where(and(eq(casinoSeats.tableId, table.id), gt(casinoSeats.wager, 0n)));
  // The `leaving` flag is a deferred leave: the seat stayed for the hand its
  // stake was in (spec §5, "no money is ever dropped by leaving") and is freed
  // now that the stake has settled.
  await tx.db.delete(casinoSeats)
    .where(and(eq(casinoSeats.tableId, table.id), eq(casinoSeats.leaving, true)));

  const remaining = await tx.db.select({ id: casinoSeats.id }).from(casinoSeats)
    .where(eq(casinoSeats.tableId, table.id));
  if (remaining.length === 0) {
    await tx.db.delete(casinoTables).where(eq(casinoTables.id, table.id));
    return;
  }
  await tx.db.update(casinoTables)
    .set({ phase: "betting", state: null, turnSeat: null, deadlineAt: null })
    .where(eq(casinoTables.id, table.id));
}

/**
 * Persists one `TableStep` — the single choke point every deal, act and
 * autoAct passes through, which is why all three of its guards live here
 * rather than in the routes.
 *
 * `actingSeat` is the seat whose action produced this step, or `null` for a
 * step nobody asked for (the deal, and the clock's autoAct). A `wagerDelta` is
 * only ever legitimate from the seat that just acted, so a null `actingSeat`
 * refuses every one of them: that is what makes a clock-driven raise
 * impossible.
 *
 * `clockFrom` is when this step HAPPENED, which is the same as now for every
 * step a player asked for and is NOT for one the clock owed: a turn that
 * lapsed at 12:00 and is auto-stood by a read at 12:05 hands the next seat a
 * turn that started at 12:00, so its deadline is 12:00:30 and not 12:05:30.
 * See `advanceTable` for why that equivalence is the whole design.
 */
export async function applyStep(
  tx: PluginTx, ctx: PluginCtx, locked: LockedTable, game: TableGameDef,
  step: TableStep<unknown>, actingSeat: number | null, clockFrom: Date = new Date(),
): Promise<void> {
  const { table, seats, house } = locked;

  const delta = step.wagerDelta;
  if (delta !== undefined) {
    // 500 rather than 4xx on all three: nothing the caller sent is at fault —
    // the installed game raised a stake it was not entitled to raise. A
    // non-positive amount would turn `escrow` into a credit to the player.
    if (delta.amount <= 0n || actingSeat === null || delta.seat !== actingSeat) {
      throw new PluginError("invalid_wager_delta", 500);
    }
    const seat = seats.find((s) => s.seatNo === delta.seat);
    if (seat === undefined || seat.wager <= 0n) throw new PluginError("invalid_wager_delta", 500);

    // BEFORE taking the extra money: a raised wager raises the whole table's
    // exposure, and `payOwner`'s clamp would otherwise short-pay a winner in
    // silence. Throwing here rolls the transaction back — the hand is
    // untouched and the seat keeps the stake it had.
    await assertTableCanCover(tx, house, seats, game.maxPayoutMultiplier, delta);
    try {
      await escrow(tx, house, seat.playerId, delta.amount, table.gameId);
    } catch (error) {
      // The GUARD, never `instanceof`: a dynamically loaded plugin brings its
      // own copy of the SDK, so the error class here need not be the class the
      // throw site used (CLAUDE.md, the plugin/core boundary).
      if (isInsufficientFundsError(error)) throw new PluginError("insufficient_funds", 409);
      throw error;
    }
    seat.wager += delta.amount;
    await tx.db.update(casinoSeats).set({ wager: seat.wager }).where(eq(casinoSeats.id, seat.id));
  }

  // THE TURN GUARD. `turn_seat` is what answers 409 `not_your_turn`, so a step
  // that leaves the hand live must name a seat that is actually in it —
  // post-delta wagers, since the raise above just changed one. A game pointing
  // the turn at an empty or settled seat would strand the table: nobody could
  // act, and only the clock could ever move it again.
  if (!step.done) {
    const turn = step.turn;
    if (turn === null || !Number.isInteger(turn)
      || !seats.some((s) => s.wager > 0n && s.seatNo === turn)) {
      throw new PluginError("invalid_turn", 500);
    }
  }

  const state = toStorableState(step.state);
  const deadlineAt = step.done
    ? null
    : new Date(clockFrom.getTime() + readTableTurnSeconds(ctx.settings) * 1000);
  await tx.db.update(casinoTables)
    .set({ state, turnSeat: step.done ? null : step.turn, deadlineAt })
    .where(eq(casinoTables.id, table.id));
  // The in-memory view moves with the row: `settleHand` reads `table.state`
  // for the payout figures, and a caller may render from `locked` afterwards.
  table.state = state;
  table.turnSeat = step.done ? null : step.turn;
  table.deadlineAt = deadlineAt;

  // The resets `settleHand` writes overwrite the three columns above — one
  // extra UPDATE in the same transaction, in exchange for one place that
  // persists a step.
  if (step.done) await settleHand(tx, ctx, locked, game);
}

/**
 * Deals the next hand when the table is ready for one, and does nothing when
 * it is not.
 *
 * Ready means every NON-leaving seat has bet — `force` is the lapsed betting
 * deadline (`advanceTable`), which deals to whoever did. The hand itself
 * includes every seat with a stake, `leaving` ones INCLUDED: an escrowed wager
 * is always dealt in and settles normally (spec §5, "no money is ever dropped
 * by leaving"), so `leaving` matters only to the readiness test above and to
 * the idle sweep below.
 *
 * `clockFrom` is when the deal happened — now for a bet that completed the
 * table, the lapsed betting deadline for a forced one. `applyStep` dates the
 * first turn from it.
 */
export async function dealIfReady(
  tx: PluginTx, ctx: PluginCtx, locked: LockedTable, game: TableGameDef, force: boolean,
  clockFrom: Date = new Date(),
): Promise<void> {
  const { table, seats } = locked;
  if (!force && seats.some((s) => !s.leaving && s.wager === 0n)) return;

  const bettors = seats.filter((s) => s.wager > 0n);
  if (bettors.length === 0) {
    // A lapse with nobody betting just stops the clock — the idle sweep runs
    // only at a real deal (spec §5, amended), so a wholly idle table sits.
    if (table.deadlineAt !== null) {
      await tx.db.update(casinoTables).set({ deadlineAt: null })
        .where(eq(casinoTables.id, table.id));
      table.deadlineAt = null;
    }
    return;
  }

  // THE IDLE SWEEP, at deal time. A seat that sat this deal out gains a hand;
  // at `table_idle_kick_hands` it is freed. Kicking here is safe precisely
  // because these seats hold no money — every wager belongs to a bettor.
  const kickAt = readTableIdleKickHands(ctx.settings);
  const kicked: string[] = [];
  for (const seat of seats) {
    if (seat.leaving || seat.wager > 0n) continue;
    const idleHands = seat.idleHands + 1;
    if (idleHands >= kickAt) {
      kicked.push(seat.id);
      continue;
    }
    await tx.db.update(casinoSeats).set({ idleHands }).where(eq(casinoSeats.id, seat.id));
    seat.idleHands = idleHands;
  }
  if (kicked.length > 0) {
    await tx.db.delete(casinoSeats).where(inArray(casinoSeats.id, kicked));
    locked.seats = seats.filter((s) => !kicked.includes(s.id));
  }

  // The row's CURRENT seed feeds this hand, and a fresh one is rotated on for
  // the next: spec §3's "rotated at every deal" holds either way, and this
  // order is what lets a test write a known seed onto the row and get the deal
  // it computed.
  const step = guardGame(table.gameId, "start", () => game.deal({
    seats: bettors.map((s) => ({ seat: s.seatNo, wager: s.wager })),
    seed: table.seed,
  }));
  const seed = randomBytes(16).toString("hex");
  const handNo = table.handNo + 1;
  await tx.db.update(casinoTables).set({ seed, handNo, phase: "acting" })
    .where(eq(casinoTables.id, table.id));
  table.seed = seed;
  table.handNo = handNo;
  table.phase = "acting";

  // `actingSeat: null` — the deal is nobody's action, so a `wagerDelta` on it
  // is refused (`applyStep`).
  await applyStep(tx, ctx, locked, game, step, null, clockFrom);
}

/**
 * THE LAZY CLOCK. Owes the table every deadline that has already lapsed, then
 * hands back the table as it now stands — or `null` when settling it emptied
 * the table and deleted the row.
 *
 * There is no cron and no job (`ensureCurrentRound` and bullets' restock are
 * the precedents): a table advances because somebody READ it. Every mutating
 * table route calls this immediately after `lockTable`, and GET calls it on
 * the slow path, so the seated players' 2.5s poll is the heartbeat.
 *
 * EAGER EQUIVALENCE is the property to preserve. A lazy clock must leave the
 * table exactly where a cron firing on the deadline would have left it, so
 * every deadline this loop settles is passed on as `clockFrom`: an abandoned
 * hand's seats lapse 30 seconds apart in the PAST and one read plays the hand
 * out, rather than each auto-stand handing the next seat a fresh 30 seconds
 * and the table needing one poll per seat to clear. Spec §5 says it directly —
 * "repeat until the clock is in the future or the hand settles".
 *
 * The `null` return is never a stale snapshot: a settle that emptied the table
 * deleted it, and rendering the pre-settle `LockedTable` would show a table
 * that no longer exists. Callers answer `{ table: null }` / `not_seated`.
 */
export async function advanceTable(
  tx: PluginTx, ctx: PluginCtx, locked: LockedTable, game: TableGameDef,
): Promise<LockedTable | null> {
  let current = locked;
  // Bounded. Every iteration either deals (once — the next deal needs a bet,
  // and a bet is not something a clock can make), stands ONE seat, or settles
  // the hand and clears the deadline, so a well-behaved game costs at most
  // 1 + MAX_TABLE_SEATS passes. The margin is belt-and-braces against a rogue
  // game whose `autoAct` never advances the turn.
  for (let i = 0; i < 3 * MAX_TABLE_SEATS; i += 1) {
    const { table } = current;
    const lapsed = table.deadlineAt;
    if (lapsed === null || lapsed.getTime() > Date.now()) return current;

    if (table.phase === "betting") {
      await dealIfReady(tx, ctx, current, game, true, lapsed);
    } else if (table.turnSeat !== null && table.state !== null) {
      const seat = table.turnSeat;
      const state = fromStorableState(table.state);
      // The game's own code, so the same guard `act` uses — a throw becomes a
      // clean 400 rather than a 500 out of a route nobody asked to act on.
      const step = guardGame(table.gameId, "act", () => game.autoAct(state, seat));
      // `actingSeat: null`: the seat did NOT act, it ran out of time, so a
      // `wagerDelta` here is refused (`applyStep`) — the clock can never raise
      // an absent player's stake.
      await applyStep(tx, ctx, current, game, step, null, lapsed);
    } else {
      // An acting table with no turn or no state is a hub defect, not a bad
      // request: `applyStep` writes phase, turn and state together and
      // `settleHand` clears them together.
      throw new PluginError("invalid_turn", 500);
    }

    const reread = await lockTable(tx, ctx, table.id);
    if (reread === null) return null;
    current = reread;
  }
  throw new PluginError("invalid_turn", 500);
}
