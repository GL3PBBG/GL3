import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client.js";
import { useCasino, useCasinoAct, useJail, useMe, usePlayCasino } from "../api/queries.js";
import { canAfford } from "../lib/money.js";
import { ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import { PageRenderer } from "../plugins/PageRenderer.js";
import { renderNode } from "../plugins/render.js";
import styles from "./pages.module.css";
import type { CasinoGame, CasinoSessionView } from "@gl3/shared";

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
 * Hit and Stand are always available on an open hand. Double is not: it raises
 * the wager, and blackjack accepts it only on the opening two cards — after
 * which `GameDef.act` throws a plain `Error`, which is a 500 rather than a
 * clean refusal. The hub's `view` is game-agnostic (it is an opaque `ViewNode`
 * the page walks but does not interpret), so the page cannot read a card count
 * out of it to decide.
 *
 * So Double is offered on exactly the state where the opening two cards are
 * certain: a hand THIS page dealt and has not yet acted on. A hand resumed from
 * the lobby after a reload offers Hit and Stand only — conservative, because
 * the alternative is a button that can 500.
 */
export function handActions(source: "dealt" | "resumed", actsTaken: number): readonly HandAction[] {
  return source === "dealt" && actsTaken === 0 ? ["hit", "stand", "double"] : ["hit", "stand"];
}

const ACTION_LABELS: Readonly<Record<HandAction, string>> = {
  hit: "Hit",
  stand: "Stand",
  double: "Double",
};

/**
 * The hand on screen, from whichever source is freshest.
 *
 * `stake` is what was staked to OPEN the hand. A `double` raises it, and
 * `POST /api/casino/act` does not return the new figure — so the stake is not
 * re-rendered mid-hand. The payout below it is the server's own number and the
 * cash in the shell HUD is refreshed from `/api/auth/me`, so nothing the player
 * acts on is derived from this field.
 */
interface LiveHand {
  readonly sessionId: string;
  readonly gameName: string;
  readonly stake: string;
  readonly view: unknown;
  readonly done: boolean;
  readonly payout: string | null;
  readonly expiresAt: string | null;
  readonly source: "dealt" | "resumed";
  readonly actsTaken: number;
}

function resumedHand(session: CasinoSessionView): LiveHand {
  return {
    sessionId: session.sessionId,
    gameName: session.gameName,
    stake: session.wager,
    view: session.view,
    done: false,
    payout: null,
    expiresAt: session.expiresAt,
    source: "resumed",
    actsTaken: 0,
  };
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

export function Casino(): JSX.Element {
  const lobby = useCasino();
  const me = useMe();
  const jail = useJail();
  const play = usePlayCasino();
  const act = useCasinoAct();

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

  if (lobby.isLoading) return <Loading what="the casino" />;

  if (lobby.error) {
    const nowhere = lobby.error instanceof ApiError && lobby.error.code === "no_location";
    return (
      <Panel title="Casino">
        <ErrorText error={lobby.error} />
        {nowhere ? (
          <p className={styles.meta}><Link to="/travel">Travel somewhere</Link> first.</p>
        ) : null}
      </Panel>
    );
  }
  if (!lobby.data || !me.data) return <Loading what="the casino" />;

  const { locationName, minBet, games, session } = lobby.data;
  const resumable = session === null || session.sessionId === dismissed
    ? null
    : resumedHand(session);
  const active = hand ?? resumable;
  const jailed = jail.data?.jailed === true;
  const cash = me.data.cash;

  function onPlay(game: CasinoGame): void {
    play.mutate({ gameId: game.gameId, wager }, {
      onSuccess: (step) => {
        setHand({
          sessionId: step.sessionId,
          gameName: game.name,
          stake: wager,
          view: step.view,
          done: step.done,
          payout: step.payout ?? null,
          // `play` reports no expiry; only the lobby computes one.
          expiresAt: null,
          source: "dealt",
          actsTaken: 0,
        });
      },
    });
  }

  // `current` comes from the render closure rather than a `setHand` updater:
  // a hand resumed from the lobby has never been in `hand`, so an updater
  // would be handed `null` and drop the whole table.
  function onAct(current: LiveHand, action: HandAction): void {
    act.mutate(action, {
      onSuccess: (step) => {
        setHand({
          ...current,
          view: step.view,
          done: step.done,
          payout: step.payout ?? null,
          actsTaken: current.actsTaken + 1,
        });
      },
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

        {active.done ? (
          <>
            <p className={styles.big}>
              {active.payout === null || active.payout === "0"
                ? "The house takes it."
                : <>Paid out <Money value={active.payout} /></>}
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                onClick={() => { setDismissed(active.sessionId); setHand(null); }}
              >
                Back to the tables
              </button>
            </div>
          </>
        ) : (
          <div className={styles.actions}>
            {handActions(active.source, active.actsTaken).map((action) => (
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
        )}

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

      {games.length === 0 ? (
        <p className={styles.muted}>No games are installed.</p>
      ) : (
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

      {jailed ? <p className={styles.bad}>No playing from a cell.</p> : null}
      <ErrorText error={play.error} />
    </Panel>
  );
}
