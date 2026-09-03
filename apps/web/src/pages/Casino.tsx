import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { canAfford, secondsLeft, describeError, renderNode, ApiError, useCasino, useCasinoAct, useCasinoTable, useJail, useLeaveCasino, useMe, usePlayCasino, useSitCasino, useTableAct, useTableBet } from "@gl3/client";
import { ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import { PageRenderer } from "../plugins/PageRenderer.js";
import { PropertyPanel } from "../components/PropertyPanel.js";
import styles from "./pages.module.css";
import type {
  CasinoGame, CasinoRemoteTables, CasinoSessionView, CasinoStepResponse,
  CasinoTableGame, CasinoTableSeat, CasinoTableView, GameMoveDto,
} from "@gl3/shared";
import { SlotImage } from "../components/GameImage.js";
import { PlayerLink } from "../components/PlayerLink.js";

/**
 * Why the wager the player typed cannot be staked, in the server's own order.
 *
 * The three refusals mirror `POST /api/casino/play` exactly — `wager_below_min`,
 * `wager_above_max`, then `insufficient_funds` from `escrow` — so the button is
 * disabled with a reason rather than firing a POST that can only 4xx. The
 * digits-only test is the client half of the route's `NonNegativeIntegerString`.
 *
 * `maxBet` is per game, not per lobby: it is the house owner's lever where the
 * table is owned and the `max_bet` setting where it is not.
 */
export type WagerCheck =
  | { kind: "ok" }
  | { kind: "notAnAmount" }
  | { kind: "belowMin" }
  | { kind: "aboveMax" }
  | { kind: "tooPoor" };

export function checkWager(
  raw: string, minBet: string, maxBet: string, cash: string,
): WagerCheck {
  if (!/^\d+$/.test(raw)) return { kind: "notAnAmount" };
  const wager = BigInt(raw);
  if (wager < BigInt(minBet)) return { kind: "belowMin" };
  if (wager > BigInt(maxBet)) return { kind: "aboveMax" };
  if (!canAfford(cash, raw)) return { kind: "tooPoor" };
  return { kind: "ok" };
}

export type HandAction = "hit" | "stand" | "double";

/**
 * Which controls a hand offers.
 *
 * Hit and Stand are always available on an open hand. Double raises the wager,
 * and blackjack accepts it only on the opening two cards — so the page
 * withdraws it once it has seen an act on this hand.
 *
 * It does NOT withdraw it on a hand resumed after a reload, though the page
 * cannot know how many cards that hand holds: the hub's `view` is an opaque
 * `ViewNode` it walks but does not interpret. This page used to treat every
 * resumed hand as already in progress, because an illegal double reached
 * `GameDef.act`'s plain `throw` and came back a 500. It now comes back a clean
 * 400 the page shows like any other refusal, so the conservative branch cost a
 * legal Double on every resumed hand and bought nothing.
 */
export function handActions(actsTaken: number): readonly HandAction[] {
  return actsTaken === 0 ? ["hit", "stand", "double"] : ["hit", "stand"];
}

/**
 * Whether a payload's `moves` field means "this game doesn't speak the
 * generic-moves protocol" — the client's cue to fall back to its own
 * hardcoded UI (blackjack's Hit/Stand/Double, here; the solo hand's same
 * three). `undefined` is an old server that predates the field entirely;
 * `null` is a current one reporting a game with no `moves` method. Either
 * way there is no move list to draw from, so both fall back the same way.
 *
 * A bounded ARRAY, even an empty one, is a real answer from a game that DOES
 * implement `moves` — "no legal move for you right now" — and is drawn with
 * the generic bar (which then simply has nothing to show).
 */
export function usesLegacyMoves(
  moves: readonly GameMoveDto[] | null | undefined,
): moves is null | undefined {
  return moves == null;
}

/**
 * The body to POST for one move: the game's own `action` verbatim, or —
 * when the move needs an amount — a shallow copy of it with the player's
 * typed digits merged in. Never mutates `move.action` itself, since the same
 * `GameMoveDto` rides the query cache and a poll can hand it out again.
 */
export function mergeMovePayload(move: GameMoveDto, amount: string): unknown {
  if (move.needsAmount !== true) return move.action;
  // Assumes `move.action` is a plain JSON object when `needsAmount` is true —
  // the spec's client-merge contract. A game that ships anything else here
  // (an array, a primitive) only garbles its own payload, and the hub's act
  // schema refuses the malformed result; it cannot corrupt another game's.
  return { ...(move.action as Record<string, unknown>), amount };
}

/**
 * Which controls a SEAT at a shared table offers, and — when none — why.
 *
 * This is about the seat's standing in the hand, never about the amount the
 * player typed: `checkWager` still runs on that separately, because it changes
 * on every keystroke and this does not. The one thing `myCash` decides here is
 * whether the seat can bet AT ALL: a player who cannot cover `minBet` has no
 * legal bet to type, so offering the field is offering a refusal.
 *
 * `canDouble` equals `canAct` on purpose. A double is legal only on a hand's
 * opening two cards, and the page cannot count them — the table's `view` is an
 * opaque `ViewNode` it walks but does not interpret. The server answers an
 * illegal double with a clean 400 the page shows like any other refusal, which
 * is exactly the reasoning `handActions` records for the solo resumed hand.
 * The field stays separate so a game whose double IS knowable can diverge.
 */
export interface TableActions {
  readonly canBet: boolean;
  readonly canAct: boolean;
  readonly canDouble: boolean;
  /** One sentence for why nothing is on offer, or null when something is. */
  readonly reason: string | null;
}

export function tableActions(view: CasinoTableView, myCash: string): TableActions {
  const none = { canBet: false, canAct: false, canDouble: false } as const;
  const mine = view.mySeat === null
    ? undefined
    : view.seats.find((seat) => seat.seat === view.mySeat);
  // A spectator read. `GET /api/casino/table` allows one; `bet` and `act` do
  // not, so every control is withheld rather than left to 404.
  if (mine === undefined) return { ...none, reason: "You're watching this table, not playing it." };

  if (view.phase === "betting") {
    if (BigInt(mine.wager) > 0n) {
      return { ...none, reason: "Your stake is in — waiting on the other seats." };
    }
    // Against the MINIMUM, not against anything typed: this asks whether a
    // legal bet exists for this player, and the cheapest one is the test.
    if (checkWager(view.minBet, view.minBet, view.maxBet, myCash).kind !== "ok") {
      return { ...none, reason: "You can't cover the minimum bet at this table." };
    }
    return { canBet: true, canAct: false, canDouble: false, reason: null };
  }

  if (BigInt(mine.wager) === 0n) return { ...none, reason: "You sat this hand out." };
  if (view.turnSeat !== view.mySeat) {
    return {
      ...none,
      reason: view.turnSeat === null
        ? "The hand is being dealt."
        : `Waiting on seat ${String(view.turnSeat + 1)}.`,
    };
  }
  return { canBet: false, canAct: true, canDouble: true, reason: null };
}

/**
 * Shown when `houseSeized` comes back true. The casino plugin has its own copy
 * of this sentence (`HOUSE_SEIZED_MESSAGE`) for the NOTIFICATION it writes;
 * the two are separate channels on purpose — apps/web depends on `@gl3/shared`
 * and not on any plugin package, so there is no import that could share one
 * constant without giving the web bundle a plugin dependency.
 */
const HOUSE_SEIZED_MESSAGE =
  "The owner did not have enough cash to pay the bet, you took ownership of the casino.";

const ACTION_LABELS: Readonly<Record<HandAction, string>> = {
  hit: "Hit",
  stand: "Stand",
  double: "Double",
};

/**
 * The hand on screen, from whichever source is freshest.
 *
 * `stake` always comes from the server, never from the string the player
 * typed: blackjack's double raises the wager mid-hand, and the step response
 * is the only place that new figure exists — the session row is gone once the
 * hand settles, and a raise that settles in the same call never reaches the
 * lobby at all.
 */
export interface LiveHand {
  readonly sessionId: string;
  readonly gameName: string;
  readonly stake: string;
  readonly view: unknown;
  readonly done: boolean;
  readonly payout: string | null;
  /** True when this hand's payout bankrupted the house and the table is now
   *  the player's. Only a settled step can set it. */
  readonly houseSeized: boolean;
  readonly expiresAt: string | null;
  readonly actsTaken: number;
  /** The generic-moves protocol's list for this hand, straight off the
   *  session/step it was built from — see `usesLegacyMoves`. */
  readonly moves: readonly GameMoveDto[] | null | undefined;
}

function resumedHand(session: CasinoSessionView): LiveHand {
  return {
    sessionId: session.sessionId,
    gameName: session.gameName,
    stake: session.wager,
    view: session.view,
    done: false,
    payout: null,
    houseSeized: false,
    expiresAt: session.expiresAt,
    actsTaken: 0,
    moves: session.moves,
  };
}

/** A hand this page has just dealt. `play` reports no expiry — only the lobby
 *  computes one — so the countdown appears on a resumed hand and not here. */
export function dealtHand(step: CasinoStepResponse, gameName: string): LiveHand {
  return {
    sessionId: step.sessionId,
    gameName,
    stake: step.wager,
    view: step.view,
    done: step.done,
    payout: step.payout ?? null,
    houseSeized: step.houseSeized ?? false,
    expiresAt: null,
    actsTaken: 0,
    moves: step.moves,
  };
}

/**
 * The hand after a step. `stake` follows `step.wager`, which is what makes a
 * doubled hand show the doubled figure rather than the one it opened with —
 * the number a blackjack player watches hardest.
 *
 * `expiresAt` is carried over: when the hand times out is a fact about the
 * hand, not about the step.
 */
export function advanceHand(current: LiveHand, step: CasinoStepResponse): LiveHand {
  return {
    ...current,
    stake: step.wager,
    view: step.view,
    done: step.done,
    payout: step.payout ?? null,
    houseSeized: step.houseSeized ?? false,
    actsTaken: current.actsTaken + 1,
    moves: step.moves,
  };
}

/**
 * The generic action bar the generic-moves protocol draws in place of a
 * game's hardcoded buttons: one button per move, and — when at least one
 * move needs one — a single amount field shared by all of them (a game
 * offering both Bet and Raise types the figure once, not twice). A
 * needsAmount button stays disabled until that field holds at least one
 * digit; every button honours `busy` the same way the legacy buttons do.
 */
export function MoveBar({ moves, busy, onMove }: {
  moves: readonly GameMoveDto[];
  busy: boolean;
  onMove: (payload: unknown) => void;
}): JSX.Element {
  const [amount, setAmount] = useState("");
  const showAmount = moves.some((move) => move.needsAmount === true);
  return (
    <div className={styles.actions}>
      {showAmount ? (
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          value={amount}
          aria-label="Amount"
          placeholder="Amount"
          onChange={(event) => { setAmount(event.target.value.replace(/\D/g, "")); }}
        />
      ) : null}
      {moves.map((move, index) => (
        // Index key: the bounded, server-ordered list carries no id of its own.
        <button
          key={index}
          type="button"
          disabled={busy || (move.needsAmount === true && amount === "")}
          title={move.needsAmount === true && amount === "" ? "Enter an amount first" : undefined}
          onClick={() => { onMove(mergeMovePayload(move, amount)); }}
        >
          {move.label}
        </button>
      ))}
    </div>
  );
}

function GameRow({ game, wager, cash, minBet, disabled, onPlay }: {
  game: CasinoGame;
  wager: string;
  cash: string;
  minBet: string;
  disabled: boolean;
  onPlay: (game: CasinoGame) => void;
}): JSX.Element {
  const check = checkWager(wager, minBet, game.maxBet, cash);
  return (
    <li className={styles.row}>
      {/* `scope` is the GAME's plugin id, so each game plugin ships its own
          table art under the same `table` slot name. */}
      <SlotImage scope={game.gameId} slot="table" alt={game.name} size="md" />
      <span className={styles.rowStack}>
        <span>{game.name}</span>
        <span className={styles.meta}>
          {/* null, not "", for a table nobody owns — the town takes the bets. */}
          {game.ownerName === null ? "House: the town" : `House: ${game.ownerName}`}
          {" · max "}<Money value={game.maxBet} />
        </span>
      </span>
      <span className={styles.actions}>
        <button
          type="button"
          disabled={disabled || check.kind !== "ok"}
          onClick={() => { onPlay(game); }}
        >
          Deal
        </button>
      </span>
      {check.kind === "aboveMax" ? (
        <span className={styles.bad}>Over this table&apos;s limit.</span>
      ) : null}
    </li>
  );
}

/**
 * Re-renders once a second while `active`, and returns the current wall clock.
 *
 * Deliberately NOT a per-second decrement: `lib/countdown.ts` records why
 * (throttled background tabs and a suspended laptop drop ticks, and a counter
 * that subtracts one per tick never recovers). The deadline is absolute and the
 * seconds are re-derived from `Date.now()` on every render, so a missed tick
 * costs display latency and never correctness.
 */
function useSecondTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [active]);
  return now;
}

/**
 * The clock on the table, in the one place the player looks for it.
 *
 * Crossing zero fires no fetch: the 2.5s table poll is what actually advances
 * the table (`advanceTable` runs lazily, on a read), so the deadline reaching
 * zero and the table moving are the same event arriving a beat apart. A
 * "settling…" line rather than a frozen 0s says so.
 */
function TableClock({ deadlineAt, phase }: {
  deadlineAt: string; phase: "betting" | "acting";
}): JSX.Element {
  const now = useSecondTicker(true);
  const left = secondsLeft(new Date(deadlineAt).getTime(), now);
  if (left === 0) return <span className={styles.meta}>settling…</span>;
  return (
    <span className={styles.meta}>
      {phase === "betting" ? "betting closes in " : "turn ends in "}{left}s
    </span>
  );
}

/** One occupied seat, with everything a player watching the table wants. */
function SeatRow({ seat, view }: {
  seat: CasinoTableSeat; view: CasinoTableView;
}): JSX.Element {
  const isMine = seat.seat === view.mySeat;
  const isTurn = seat.seat === view.turnSeat;
  const staked = BigInt(seat.wager) > 0n;
  return (
    <li className={isTurn ? `${styles.row} ${styles.rowCurrent}` : styles.row}>
      <span className={styles.rowStack}>
        <span className={isMine ? styles.self : undefined}>
          Seat {seat.seat + 1} — <PlayerLink playerId={seat.playerId} username={seat.username} />{isMine ? " (you)" : ""}
        </span>
        <span className={styles.meta}>
          {staked ? <>stake <Money value={seat.wager} /></> : "no stake"}
          {/* Both badges are facts the player needs to read the table: a
              leaving seat is gone after this hand, and an idle count is how
              close a seat is to being swept out of it. */}
          {seat.leaving ? " · leaving" : null}
          {seat.idleHands > 0 ? ` · idle ${seat.idleHands}` : null}
        </span>
      </span>
      {isTurn ? <span className={styles.ok}>to act</span> : null}
    </li>
  );
}

/**
 * The seated screen: one table, everyone at it, and whatever this seat may do.
 *
 * There is no event feed behind any of this — casino publishes none, so
 * `useCasinoTable`'s 2.5s poll is both the realtime channel and the lazy
 * clock's heartbeat. Every mutation here answers the whole table, and the
 * hooks write that answer straight into the query, so an action's own result
 * never waits for the next tick.
 */
function TableScreen({ view, cash, jailed }: {
  view: CasinoTableView; cash: string; jailed: boolean;
}): JSX.Element {
  const bet = useTableBet();
  const act = useTableAct();
  const leave = useLeaveCasino();
  const [wager, setWager] = useState("");
  // Leaving mid-hand does not drop the stake — the seat is marked and frees
  // itself at settle — but it does forfeit every remaining choice in the hand
  // to the auto-stand, so the first click asks. Two-step in place, never
  // `window.confirm`: the property board's idiom, and nothing else in this app
  // opens a native dialog.
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  // Swapping Leave for Confirm/Cancel unmounts the focused button, which dumps
  // keyboard focus to <body>. Follow the swap both ways (PropertyPanel's).
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const leaveRef = useRef<HTMLButtonElement | null>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirmingLeave) confirmRef.current?.focus();
    else if (wasConfirming.current) leaveRef.current?.focus();
    wasConfirming.current = confirmingLeave;
  }, [confirmingLeave]);

  const actions = tableActions(view, cash);
  const mine = view.mySeat === null
    ? undefined
    : view.seats.find((seat) => seat.seat === view.mySeat);
  const inHand = mine !== undefined && BigInt(mine.wager) > 0n;
  const check = checkWager(wager, view.minBet, view.maxBet, cash);
  const busy = jailed || bet.isPending || act.isPending || leave.isPending;
  // `handActions`' shape, decided per seat rather than per hand: the table
  // records no act count, so `canDouble` is the only gate there is. Only
  // reached when `usesLegacyMoves(view.moves)` — a game that speaks the
  // generic-moves protocol draws `MoveBar` instead, below.
  const legacyMoves: readonly HandAction[] = actions.canDouble
    ? ["hit", "stand", "double"]
    : ["hit", "stand"];

  return (
    <Panel title={`${view.gameName} — ${view.locationName}`}>
      <p className={styles.meta}>
        {view.handNo === 0 ? "No hand dealt yet" : `Hand #${String(view.handNo)}`}
        {" · "}{view.phase === "betting" ? "taking bets" : "in play"}
        {" · min "}<Money value={view.minBet} />
        {" · max "}<Money value={view.maxBet} />
        {" · you hold "}<Money value={cash} />
        {view.deadlineAt !== null ? (
          <> · <TableClock deadlineAt={view.deadlineAt} phase={view.phase} /></>
        ) : null}
      </p>

      <ul className={styles.rows}>
        {view.seats.map((seat) => <SeatRow key={seat.seat} seat={seat} view={view} />)}
      </ul>

      {/* The game draws itself. Between hands this is the hand that just
          finished — `settleHand` keeps the final state on the row, so the
          dealer's hole card is face up here until the next deal. */}
      {view.view === null ? (
        <p className={styles.muted}>No hand on the table yet.</p>
      ) : (
        <PageRenderer instructions={renderNode(view.view, {})} />
      )}

      {/* One stack for every control on the table, so the bet row, the hand
          actions and Leave are spaced from each other and from the cards
          above — `Panel` puts no gap between its own children. */}
      <div className={styles.controls}>
        {actions.canBet ? (
          <>
            <div className={styles.form}>
              <label>
                <span className={styles.meta}>Wager </span>
                <input
                  inputMode="numeric"
                  value={wager}
                  aria-label="Wager"
                  onChange={(event) => { setWager(event.target.value.trim()); }}
                />
              </label>
              <button
                type="button"
                disabled={busy || check.kind !== "ok"}
                onClick={() => { bet.mutate(wager, { onSuccess: () => { setWager(""); } }); }}
              >
                Bet
              </button>
            </div>
            {check.kind === "notAnAmount" && wager !== "" ? (
              <p role="alert" className={styles.bad}>Whole numbers only.</p>
            ) : null}
            {check.kind === "belowMin" ? (
              <p role="alert" className={styles.bad}>
                The minimum bet is <Money value={view.minBet} />.
              </p>
            ) : null}
            {check.kind === "aboveMax" ? (
              <p role="alert" className={styles.bad}>
                This table takes at most <Money value={view.maxBet} />.
              </p>
            ) : null}
            {check.kind === "tooPoor" ? (
              <p role="alert" className={styles.bad}>You don&apos;t have that much on you.</p>
            ) : null}
          </>
        ) : null}
  
        {actions.canAct ? (
          usesLegacyMoves(view.moves) ? (
            <div className={styles.actions}>
              {legacyMoves.map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={busy}
                  onClick={() => { act.mutate(action); }}
                >
                  {ACTION_LABELS[action]}
                </button>
              ))}
            </div>
          ) : view.moves.length > 0 ? (
            <MoveBar moves={view.moves} busy={busy} onMove={(payload) => { act.mutate(payload); }} />
          ) : null
        ) : null}
  
        {actions.reason !== null ? <p className={styles.meta}>{actions.reason}</p> : null}
  
        <div className={styles.actions}>
          {confirmingLeave ? (
            <>
              <span className={styles.meta} role="alert">
                Leave mid-hand? Your stake stays in and settles normally, but the
                rest of your turns are stood automatically.
              </span>
              <button
                ref={confirmRef}
                type="button"
                disabled={leave.isPending}
                onClick={() => {
                  leave.mutate(undefined, { onSettled: () => { setConfirmingLeave(false); } });
                }}
              >
                Confirm leave
              </button>
              <button type="button" onClick={() => { setConfirmingLeave(false); }}>Cancel</button>
            </>
          ) : (
            <button
              ref={leaveRef}
              type="button"
              disabled={leave.isPending}
              onClick={() => {
                // Only an in-hand leave costs anything, so only that one asks.
                if (inHand) setConfirmingLeave(true);
                else leave.mutate();
              }}
            >
              Leave table
            </button>
          )}
        </div>
      </div>

      {jailed ? <p className={styles.bad}>No playing from a cell.</p> : null}
      <TableError error={bet.error ?? act.error ?? leave.error} />
    </Panel>
  );
}

/**
 * `ErrorText` with the two codes whose shared copy is written for a different
 * page. `wrong_location` is combat's ("They're not in this town") and here it
 * is about the CALLER, who travelled away from their own table; `no_such_game`
 * reads as a lobby refusal and here means the game plugin went away underneath
 * a live seat. Everything else comes from `lib/errors.ts`, which is where a
 * server code's sentence belongs.
 */
function TableError({ error }: { error: unknown }): JSX.Element | null {
  if (error === null || error === undefined) return null;
  if (error instanceof ApiError && error.code === "wrong_location") {
    return (
      <p role="alert" className={styles.bad}>
        Your table is in another town. <Link to="/plugins/travel.index">Travel back</Link>, or leave your seat.
      </p>
    );
  }
  if (error instanceof ApiError && error.code === "no_such_game") {
    return <p role="alert" className={styles.bad}>This game is no longer installed — leave the table.</p>;
  }
  return <p role="alert" className={styles.bad}>{describeError(error)}</p>;
}

/** One registered TABLE game in the lobby: its house, its tables, and a Sit. */
function TableGameRow({ game, disabled, onSit }: {
  game: CasinoTableGame; disabled: boolean; onSit: (gameId: string) => void;
}): JSX.Element {
  return (
    <li className={styles.row}>
      <SlotImage scope={game.gameId} slot="table" alt={game.name} size="md" />
      <span className={styles.rowStack}>
        <span>{game.name}</span>
        <span className={styles.meta}>
          {game.ownerName === null ? "House: the town" : `House: ${game.ownerName}`}
          {" · max "}<Money value={game.maxBet} />
          {" · "}{game.maxSeats} seats
        </span>
        {game.tables.length === 0 ? (
          <span className={styles.meta}>No table open — sitting opens one.</span>
        ) : (
          game.tables.map((table, index) => (
            <span key={table.tableId} className={styles.meta}>
              Table {index + 1}: {table.seatsFilled}/{table.maxSeats}
              {" · "}{table.phase === "betting" ? "taking bets" : "in play"}
            </span>
          ))
        )}
      </span>
      <span className={styles.actions}>
        {/* ONE Sit per GAME, not per table: `POST /api/casino/table/sit` takes
            a gameId and picks the oldest table with a free seat itself, so a
            per-table button would seat you somewhere other than the one you
            clicked. The list above is occupancy, not a chooser. */}
        <button type="button" disabled={disabled} onClick={() => { onSit(game.gameId); }}>
          Sit
        </button>
      </span>
    </li>
  );
}

/** Where the tables are busy, for a player standing somewhere else. */
function RemoteTables({ remote }: { remote: readonly CasinoRemoteTables[] }): JSX.Element {
  return (
    <>
      <h3 className={styles.meta}>Elsewhere</h3>
      {/* Counts, never usernames — the lobby route reports it that way so an
          underground town's residents stay unidentifiable from here. No
          buttons either: you have to go there. */}
      <ul className={`${styles.rows} ${styles.remote}`}>
        {remote.map((row) => (
          <li key={`${row.locationId}:${row.gameId}`} className={styles.row}>
            <span className={styles.meta}>
              {row.locationName}: {row.seated} at the {row.gameName} tables
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.meta}><Link to="/plugins/travel.index">Travel</Link> to join them.</p>
    </>
  );
}

export function Casino(): JSX.Element {
  const lobby = useCasino();
  const me = useMe();
  const jail = useJail();
  const play = usePlayCasino();
  const act = useCasinoAct();
  const sit = useSitCasino();

  // The table query bootstraps its own poll. Nothing else on the client knows
  // whether this player holds a seat — the lobby reports the town's tables,
  // not the caller's place at one — so the first read answers the question and
  // only then does the 2.5s interval start. Leaving turns it off again.
  const [seated, setSeated] = useState(false);
  const tableQuery = useCasinoTable(seated);
  useEffect(() => {
    if (tableQuery.data !== undefined) setSeated(tableQuery.data.table !== null);
  }, [tableQuery.data]);

  // Page-local UI state only — the server data all lives in react-query.
  const [wager, setWager] = useState("");
  // Non-null once this page has dealt or advanced a hand. It outranks the
  // lobby's `session` because it is newer, and it is the ONLY place a finished
  // hand survives: `session` goes null the moment the hand settles, and the
  // final view (the dealer's hole card, the payout) is what a player most
  // wants to see.
  const [hand, setHand] = useState<LiveHand | null>(null);
  // The hand the player has finished reading and walked away from. Without it,
  // clicking away from a settled hand while the lobby's refetch is still in
  // flight resurrects it from the stale `session` — with Hit and Stand buttons
  // that can only answer `session_closed`.
  const [dismissed, setDismissed] = useState<string | null>(null);

  const jailed = jail.data?.jailed === true;

  // THE SEAT OUTRANKS THE LOBBY, and is checked before it. A seated player's
  // table is in the town the table is in, which need not be the town they are
  // standing in — the lobby can be erroring with `no_location` while the seat
  // is perfectly real, and the way out of that is the Leave button on the
  // table screen. Waiting for BOTH queries is what stops the lobby flashing up
  // for a beat before the table replaces it.
  if (tableQuery.isLoading || me.isLoading) return <Loading what="the casino" />;
  // A failed table read is not a failed page: the lobby is still worth
  // drawing, and the poll retries. Treated as "no seat".
  const table = tableQuery.data?.table ?? null;
  if (table !== null && me.data !== undefined) {
    return <TableScreen view={table} cash={me.data.cash} jailed={jailed} />;
  }

  if (lobby.isLoading) return <Loading what="the casino" />;

  if (lobby.error) {
    const nowhere = lobby.error instanceof ApiError && lobby.error.code === "no_location";
    return (
      <Panel title="Casino">
        <ErrorText error={lobby.error} />
        {nowhere ? (
          <p className={styles.meta}><Link to="/plugins/travel.index">Travel somewhere</Link> first.</p>
        ) : null}
      </Panel>
    );
  }
  if (!lobby.data || !me.data) return <Loading what="the casino" />;

  const { locationName, minBet, games, tableGames, remote, session } = lobby.data;
  const resumable = session === null || session.sessionId === dismissed
    ? null
    : resumedHand(session);
  const active = hand ?? resumable;
  const cash = me.data.cash;

  function onPlay(game: CasinoGame): void {
    play.mutate({ gameId: game.gameId, wager }, {
      onSuccess: (step) => { setHand(dealtHand(step, game.name)); },
    });
  }

  // `current` comes from the render closure rather than a `setHand` updater:
  // a hand resumed from the lobby has never been in `hand`, so an updater
  // would be handed `null` and drop the whole table. `payload` is a bare
  // `HandAction` on the legacy path and a merged move payload on the
  // generic-moves one — the hub validates only the envelope either way.
  function onAct(current: LiveHand, payload: unknown): void {
    act.mutate(payload, {
      onSuccess: (step) => { setHand(advanceHand(current, step)); },
    });
  }

  if (active !== null) {
    return (
      <Panel title={`${active.gameName} — ${locationName}`}>
        <p className={styles.meta}>
          Stake <Money value={active.stake} />
          {active.expiresAt !== null ? (
            <> · hand expires <When iso={active.expiresAt} /></>
          ) : null}
        </p>

        {active.view === null ? (
          <p className={styles.muted}>
            This game can&apos;t draw itself — play it out blind, or stand.
          </p>
        ) : (
          <PageRenderer instructions={renderNode(active.view, {})} />
        )}

        {/* The solo hand's controls get the same stack as the table's, for the
            same reason: they sat flush against the cards above them. */}
        <div className={styles.controls}>
          {active.done ? (
            <>
              <p className={styles.big}>
                {active.payout === null || active.payout === "0"
                  ? "The house takes it."
                  : <>Paid out <Money value={active.payout} /></>}
              </p>
              {active.houseSeized ? (
                <p className={styles.big}>{HOUSE_SEIZED_MESSAGE}</p>
              ) : null}
              <div className={styles.actions}>
                <button
                  type="button"
                  onClick={() => { setDismissed(active.sessionId); setHand(null); }}
                >
                  Back to the tables
                </button>
              </div>
            </>
          ) : usesLegacyMoves(active.moves) ? (
            <div className={styles.actions}>
              {handActions(active.actsTaken).map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={jailed || act.isPending}
                  onClick={() => { onAct(active, action); }}
                >
                  {ACTION_LABELS[action]}
                </button>
              ))}
            </div>
          ) : active.moves.length > 0 ? (
            <MoveBar
              moves={active.moves}
              busy={jailed || act.isPending}
              onMove={(payload) => { onAct(active, payload); }}
            />
          ) : null}
        </div>

        {jailed ? <p className={styles.bad}>No playing from a cell.</p> : null}
        <ErrorText error={act.error} />
      </Panel>
    );
  }

  // The most generous table in town. Run through the SAME check as a row, so
  // `aboveMax` here means no table at all will take the bet — the per-row
  // message covers the tables that individually won't.
  const bestMax = games.reduce(
    (max, game) => (BigInt(game.maxBet) > BigInt(max) ? game.maxBet : max), "0",
  );
  const lobbyCheck = checkWager(wager, minBet, bestMax, cash);

  return (
    <Panel title={`Casino — ${locationName}`}>
      <p className={styles.meta}>
        Minimum bet <Money value={minBet} /> · you hold <Money value={cash} />
      </p>

      {games.length === 0 && tableGames.length === 0 ? (
        <p className={styles.muted}>No games are installed.</p>
      ) : null}

      {/* THE TABLES, first: a table game is the shared, multiplayer kind, and
          `sit` is the only way in. The wager is not asked for here — it is
          asked for at the table, once per hand, against that table's own
          bounds. */}
      {tableGames.length > 0 ? (
        <>
          <h3 className={styles.meta}>Tables</h3>
          <ul className={styles.rows}>
            {tableGames.map((game) => (
              <TableGameRow
                key={game.gameId}
                game={game}
                disabled={jailed || sit.isPending}
                onSit={(gameId) => { sit.mutate(gameId); }}
              />
            ))}
          </ul>
          <ErrorText error={sit.error} />
        </>
      ) : null}

      {remote.length > 0 ? <RemoteTables remote={remote} /> : null}

      {games.length === 0 ? null : (
        <>
          <h3 className={styles.meta}>Solo games</h3>
          <div className={styles.form}>
            <label>
              <span className={styles.meta}>Wager </span>
              <input
                inputMode="numeric"
                value={wager}
                aria-label="Wager"
                onChange={(event) => { setWager(event.target.value.trim()); }}
              />
            </label>
          </div>

          {lobbyCheck.kind === "notAnAmount" && wager !== "" ? (
            <p role="alert" className={styles.bad}>Whole numbers only.</p>
          ) : null}
          {lobbyCheck.kind === "belowMin" ? (
            <p role="alert" className={styles.bad}>
              The minimum bet is <Money value={minBet} />.
            </p>
          ) : null}
          {/* No lobby-wide `aboveMax` line: the limit is per table, so the row
              that refuses the bet says so itself. Running the lobby check
              against the MOST generous table is what keeps `tooPoor` visible
              for a wager some tables would refuse and the player can't cover
              anyway. */}
          {lobbyCheck.kind === "tooPoor" ? (
            <p role="alert" className={styles.bad}>You don&apos;t have that much on you.</p>
          ) : null}

          <ul className={styles.rows}>
            {games.map((game) => (
              <GameRow
                key={game.gameId}
                game={game}
                wager={wager}
                cash={cash}
                minBet={minBet}
                disabled={jailed || play.isPending}
                onPlay={onPlay}
              />
            ))}
          </ul>

        </>
      )}

      {/* The houses themselves — each game's property row for this town,
          buyable when the town still holds it, with the owner tools when it's
          yours. This replaced the /properties tab. Table games declare a
          property type too (that is what `providesProperties` on the game
          plugin is for), so both lists contribute; deduped because a plugin
          could in principle register in both registries. */}
      {[...new Set([...tableGames, ...games].map((game) => game.gameId))].map((gameId) => (
        <PropertyPanel key={gameId} pluginId={gameId} />
      ))}

      {jailed ? <p className={styles.bad}>No playing from a cell.</p> : null}
      <ErrorText error={play.error} />
    </Panel>
  );
}
