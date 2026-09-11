import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, keys, renderNode } from "@gl3/client";
import { CasinoMachineResponseSchema, type CasinoMachine, type CasinoGame } from "@gl3/shared";
import { ErrorText, Money, Panel } from "../components/ui.js";
import { PageRenderer } from "../plugins/PageRenderer.js";
import { ReelCabinet } from "./ReelCabinet.js";
import styles from "./pages.module.css";

const QUERY_KEY = ["casino-machine"];
export function useCasinoMachine() {
  return useQuery({ queryKey: QUERY_KEY, queryFn: async () => CasinoMachineResponseSchema.parse(await api("/api/casino/machine")) });
}
function useMachineAction() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async ({ verb, body }: { verb: string; body: Record<string, unknown> }) =>
      CasinoMachineResponseSchema.parse(await api(`/api/casino/machine/${verb}`, { method: "POST", body: JSON.stringify(body) })),
    onSuccess: response => { queries.setQueryData(QUERY_KEY, response); },
    onError: () => { void queries.invalidateQueries({ queryKey: QUERY_KEY }); },
    onSettled: () => { void queries.invalidateQueries({ queryKey: keys.me() }); },
  });
}

export function MachineEntry({ game, minBet, cash, jailed }: { game: CasinoGame; minBet: string; cash: string; jailed: boolean }): JSX.Element {
  const [credits, setCredits] = useState("");
  const action = useMachineAction();
  const valid = /^[1-9]\d{0,17}$/.test(credits) && BigInt(credits) >= BigInt(minBet) && BigInt(credits) <= BigInt(cash);
  return <Panel title={game.name}>
    <p className={styles.meta}>Sit down with credits, choose your bet, and keep playing until you cash out.</p>
    <p className={styles.meta}>Bet limits <Money value={minBet} />–<Money value={game.maxBet} /> · {game.ownerName ?? "House machine"}</p>
    <form className={styles.form} onSubmit={e => { e.preventDefault(); if (valid) action.mutate({ verb: "open", body: { gameId: game.gameId, credits, wager: minBet } }); }}>
      <label>Credits to put in <input aria-label={`Credits for ${game.name}`} inputMode="numeric" value={credits} onChange={e => setCredits(e.target.value)} /></label>
      <button type="submit" disabled={!valid || jailed || action.isPending}>Sit at {game.name}</button>
    </form>
    <ErrorText error={action.error} />
  </Panel>;
}

/** The animation is presentation only; server revisions protect every money action. */
export function MachineScreen({ machine, jailed }: { machine: CasinoMachine; jailed: boolean }): JSX.Element {
  const action = useMachineAction();
  const [wager, setWager] = useState(machine.wager);
  const [revealed, setRevealed] = useState<number | null>(null);
  const [confirmCashout, setConfirmCashout] = useState(false);
  const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animating = !reducedMotion && machine.animation !== undefined && machine.animation.durationMs > 0 && revealed !== machine.revision;
  useEffect(() => {
    if (!animating) return;
    const timer = window.setTimeout(() => setRevealed(machine.revision), machine.animation!.durationMs);
    return () => window.clearTimeout(timer);
  }, [machine.revision, machine.animation, animating]);
  const busy = action.isPending || animating;
  const send = (verb: string, fields: Record<string, unknown> = {}) => {
    setConfirmCashout(false);
    action.mutate({ verb, body: { id: machine.id, revision: machine.revision, ...fields } });
  };
  const betValid = /^[1-9]\d{0,17}$/.test(wager) && BigInt(wager) <= BigInt(machine.credits);
  if (machine.reelDisplay) return <div>
    <ReelCabinet machine={machine} display={machine.reelDisplay} busy={busy} animating={animating} jailed={jailed} reducedMotion={reducedMotion} wager={wager} onWager={setWager} send={send}
      cashout={<div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => {
          if (machine.inRound && !confirmCashout) setConfirmCashout(true);
          else send("cashout");
        }}>{confirmCashout ? "Forfeit this bet and cash out credits" : "Cash out & leave"}</button>
        {confirmCashout ? <button type="button" onClick={() => setConfirmCashout(false)}>Keep playing</button> : null}
      </div>} />
    {!machine.available ? <p role="alert">This game is unavailable. You can still cash out.</p> : null}
    {jailed ? <p role="alert">You can cash out, but cannot play from a cell.</p> : null}
    <ErrorText error={action.error} />
  </div>;
  return <Panel title={machine.gameName}>
    <div className={styles.controls}>
      <p className={styles.big} aria-live="polite">{animating ? "Reels spinning…" : <>Machine credits <Money value={machine.credits} /></>}</p>
      <p className={styles.meta}>Your credits stay on this machine between rounds and after a reload. Cash out to return them to your cash.</p>

      {!machine.available ? <p className={styles.bad}>This game is unavailable. Your unused credits can still be cashed out.</p> : null}
      {!machine.inRound ? <div className={styles.form}>
        <label>Bet per spin <input aria-label="Bet per spin" inputMode="numeric" value={wager} disabled={busy} onChange={e => setWager(e.target.value)} /></label>
        <button type="button" disabled={busy || jailed || !machine.available || !betValid} onClick={() => send("spin", { wager })}>Spin</button>
        {machine.credits === "0" ? <p>No credits left. Cash out to leave the machine.</p> : null}
      </div> : <div className={styles.actions}>
        {machine.moves.map((move, i) => <button key={i} type="button" disabled={busy || jailed || move.needsAmount} onClick={() => send("act", { action: move.action })}>{move.label}</button>)}
      </div>}
      <div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => {
          if (machine.inRound && !confirmCashout) setConfirmCashout(true);
          else send("cashout");
        }}>{confirmCashout ? "Forfeit this bet and cash out credits" : "Cash out & leave"}</button>
        {confirmCashout ? <button type="button" onClick={() => setConfirmCashout(false)}>Keep playing</button> : null}
      </div>
      {jailed ? <p className={styles.bad}>You can cash out, but cannot play from a cell.</p> : null}
      <ErrorText error={action.error} />
      <div style={{ width: "100%", minWidth: 0 }} aria-busy={animating}>
        {animating && machine.animation
          ? <PageRenderer key={`animation-${machine.revision}`} instructions={renderNode(machine.animation.view, {})} />
          : machine.view !== null ? <PageRenderer key={`result-${machine.revision}`} instructions={renderNode(machine.view, {})} />
          : <p>Choose a bet and press Spin.</p>}
      </div>
    </div>
  </Panel>;
}
