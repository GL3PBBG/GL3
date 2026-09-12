import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CasinoMachine, ReelDisplay } from "@gl3/shared";
import { renderNode, type CasinoMachineVerb } from "@gl3/client";
import { Money } from "../components/ui.js";
import { PageRenderer } from "../plugins/PageRenderer.js";
import css from "./ReelCabinet.module.css";

function WinAmount({ amount, animate }: { amount: string; animate: boolean }): JSX.Element {
  const [shown, setShown] = useState(animate ? "0" : amount);
  useEffect(() => {
    if (!animate) { setShown(amount); return; }
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / 1100);
      const scale = BigInt(Math.round((1 - (1 - progress) ** 3) * 1000));
      setShown((BigInt(amount) * scale / 1000n).toString());
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [amount, animate]);
  return <Money value={shown} />;
}

export function ReelCabinet({ machine, display, busy, animating, jailed, reducedMotion, wager, onWager, send, cashout }: {
  machine: CasinoMachine; display: ReelDisplay; busy: boolean; animating: boolean;
  jailed: boolean; reducedMotion: boolean; wager: string; onWager: (value: string) => void;
  send: (verb: CasinoMachineVerb, fields?: Record<string, unknown>) => void; cashout: ReactNode;
}): JSX.Element {
  const seenRevision = useRef(machine.revision);
  const [celebration, setCelebration] = useState<number | null>(null);
  const payout = BigInt(machine.payout ?? "0");
  const profit = payout - BigInt(machine.wager);
  const bigWin = profit > 0n && payout >= BigInt(machine.wager) * 10n;
  useEffect(() => {
    if (animating || seenRevision.current === machine.revision) return;
    seenRevision.current = machine.revision;
    if (!machine.inRound && payout > 0n) setCelebration(machine.revision);
  }, [animating, machine.revision, machine.inRound, payout]);
  useEffect(() => {
    if (celebration === null) return;
    const timer = window.setTimeout(() => setCelebration(null), bigWin ? 3600 : 2600);
    return () => window.clearTimeout(timer);
  }, [celebration, bigWin]);
  const celebrating = !busy && celebration === machine.revision;
  const holdIndices = new Set(display.reels.flatMap(reel => reel.holdMove === null ? [] : [reel.holdMove]));
  const moves = machine.moves.filter((_, i) => !holdIndices.has(i));
  const canSpin = /^[1-9]\d{0,17}$/.test(wager) && BigInt(wager) <= BigInt(machine.credits);
  const status = animating ? "Reels spinning…" : machine.inRound
    ? "Hold your favourites. Respin once for free, or collect."
    : machine.payout === undefined ? "Choose your bet. Make it spin."
    : profit > 0n ? `${bigWin ? "Big win!" : "You win!"} $${payout.toLocaleString("en-US")} returned to your credits.`
    : payout > 0n ? "Your stake is back. Go for another spin."
    : "No win this time. Ready for another spin?";
  return <>
    <section className={`${css.cabinet} ${celebrating ? css.winning : ""}`} data-reel-cabinet data-big-win={bigWin && celebrating ? "true" : undefined}>
      <header className={css.marquee}>
        <span className={css.eyebrow}>The Lucky Strip</span>
        <h2>{machine.gameName}</h2>
        <div className={css.lights} aria-hidden="true">{Array.from({ length: 13 }, (_, i) => <i key={i} />)}</div>
      </header>
      <div className={css.meters}>
        <div><span>Credits</span><strong>{animating ? "•••" : <Money value={machine.credits} />}</strong></div>
        <div><span>{machine.inRound ? "To collect" : "Last return"}</span><strong>{animating ? "•••" : <Money value={machine.inRound ? display.collectable : machine.payout ?? "0"} />}</strong></div>
      </div>
      <div className={css.reelDeck} aria-busy={animating}>
        <div className={css.reels}>
          {display.reels.map((reel, i) => {
            const move = reel.holdMove === null ? undefined : machine.moves[reel.holdMove];
            const rolling = animating && reel.spin;
            return <div key={i} className={css.reelColumn}>
              <div className={`${css.reelWindow} ${reel.held ? css.heldWindow : ""}`} role="img" aria-label={rolling ? `Reel ${i + 1} spinning` : `Reel ${i + 1}: ${reel.label}${reel.held ? ", held" : ""}`}>
                <div key={`${machine.revision}-${rolling}`} className={rolling ? css.rolling : css.still} style={{ "--stop": `${1000 + i * 300}ms`, "--distance": `-${display.symbols.length * 100}%` } as CSSProperties} aria-hidden="true">
                  {[reel.image, ...(rolling ? display.symbols : [])].map((image, j) => <img key={j} src={image} alt="" draggable={false} />)}
                </div>
              </div>
              <button type="button" className={css.hold} aria-label={move?.label ?? `Hold reel ${i + 1}`} aria-pressed={reel.held}
                disabled={busy || jailed || !machine.available || !move || move.needsAmount} onClick={() => { if (move) send("act", { action: move.action }); }}>
                <span className={css.holdLamp} aria-hidden="true" />{reel.held ? "Held" : "Hold"}
              </button>
            </div>;
          })}
        </div>
        {celebrating ? <div key={celebration} className={`${css.celebration} ${bigWin ? css.bigWin : ""}`} aria-hidden="true" data-win-effect>
          {!reducedMotion ? <div className={css.coins}>{Array.from({ length: bigWin ? 30 : 16 }, (_, i) => <i key={i} style={{ "--x": `${(i * 37 + 7) % 100}%`, "--delay": `${(i % 7) * 80}ms`, "--drift": `${(i % 2 ? 1 : -1) * (15 + i * 3)}px` } as CSSProperties}>✦</i>)}</div> : null}
          <div className={css.winPlaque}><span>{bigWin ? "Big win!" : "Winner!"}</span><strong><WinAmount amount={machine.payout!} animate={!reducedMotion} /></strong><small>Added to your credits</small></div>
        </div> : null}
      </div>
      <p className={css.status} role="status">{status}</p>
      <div className={css.console}>
        <label className={css.bet}><span>Bet per spin</span><input aria-label="Bet per spin" inputMode="numeric" value={wager} disabled={busy || machine.inRound} onChange={e => onWager(e.target.value)} /></label>
        <div className={css.playButtons}>
          {machine.inRound ? moves.map((move, i) => <button key={i} type="button" className={i === 0 && moves.length > 1 ? css.primary : css.collect} disabled={busy || jailed || !machine.available || move.needsAmount} onClick={() => send("act", { action: move.action })}>{move.label}</button>)
            : <button type="button" className={css.primary} disabled={busy || jailed || !machine.available || !canSpin} onClick={() => send("spin", { wager })}><span aria-hidden="true">↻</span> Spin</button>}
        </div>
      </div>
      <footer className={css.footer}><span>Credits stay here until you cash out.</span>{cashout}</footer>
    </section>
    <div className={css.rules}><PageRenderer instructions={renderNode(display.rules, {})} /></div>
  </>;
}
