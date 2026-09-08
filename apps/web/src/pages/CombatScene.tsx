import type { AttackResponse, CombatTarget } from "@gl3/shared";
import css from "./CombatScene.module.css";

function Fighter({ gun = false, melee = false }: { gun?: boolean; melee?: boolean }): JSX.Element {
  return <svg viewBox="0 0 160 240" aria-hidden="true">
    <ellipse cx="78" cy="229" rx="58" ry="8" fill="#000" opacity=".35" />
    <path d="M57 143 47 221 70 221 83 165 94 221 117 221 103 139" fill="#121b28" stroke="#65717c" strokeWidth="2" />
    <path d="M51 77 91 73 111 147 48 150Z" fill="#263746" stroke="#82909a" strokeWidth="2" />
    <path d="m67 78 10 44 12-45-12 10Z" fill="#d7cbb3" /><path d="m77 87-4 25 6 12 5-15Z" fill="#ac6151" />
    <path d="m55 84-14 47 19 9 11-17M92 85l21 25 28-7" fill="none" stroke="#526575" strokeWidth="18" strokeLinecap="round" />
    <circle cx="77" cy="52" r="22" fill="#b69b7b" /><path d="M53 47h51l-13-9-4-18H64l-4 19Z" fill="#17232f" stroke="#82909a" strokeWidth="2" />
    <path d="m80 57 12-2M78 67h10" stroke="#554536" strokeWidth="3" />
    <circle cx="142" cy="104" r="9" fill="#b69b7b" />
    {gun ? <path d="M132 91h27v9h-15v16h-9Z" fill="#a5acac" stroke="#17232f" strokeWidth="3" /> : null}
    {melee ? <path d="m142 105-12-61q1-9 8-5l12 64" fill="#ba9670" stroke="#574634" strokeWidth="3" /> : null}
  </svg>;
}

export function CombatScene({ target, result, pending, failed, sequence }: {
  target: CombatTarget | null; result: AttackResponse | undefined; pending: boolean; failed: boolean; sequence: number;
}): JSX.Element {
  const outcome = result?.backfire ? "backfire" : result?.targetKilled ? "fatal" : result?.hit ? "hit" : "miss";
  const health = result?.targetHealth ?? target?.health ?? 0;
  const percent = target ? Math.max(0, Math.min(100, health / Math.max(1, target.maxHealth) * 100)) : 100;
  const before = target ? Math.max(0, Math.min(100, target.health / Math.max(1, target.maxHealth) * 100)) : 100;
  return <section className={css.scene} aria-label="Combat encounter">
    <div className={css.heading}><span>STREET ENCOUNTER</span><span>{pending ? "Taking action…" : failed ? "Attack unsuccessful" : result ? "Attack resolved" : "Ready when you are"}</span></div>
    <div className={css.identity}><strong>You</strong><span>VS</span><strong>{target?.username ?? "Choose a target below"}</strong></div>
    <div className={css.stage} key={sequence} data-outcome={result ? outcome : "idle"} data-weapon={result?.weapon}>
      <div className={css.skyline} />
      <div className={css.sign}>NO WAY BACK</div>
      <div className={css.road} />
      <div className={css.attacker}><Fighter gun={result?.weapon === "firearm"} melee={result?.weapon === "melee"} /></div>
      <div className={css.defender}><Fighter /></div>
      {result ? <div key="effects" className={css.effects}>
        {result.weapon === "firearm" && !result.backfire ? <div className={css.flash}>✦</div> : null}
        {result.hit && !result.backfire ? <div className={css.impact}>✴</div> : null}
        <div className={css.damage}>
          <strong>{result.backfire ? `−${result.selfDamage}` : result.hit ? `−${result.damage}` : "MISS"}</strong>
          <span>{result.backfire ? "BACKFIRE" : result.targetKilled ? "KILLED" : result.crit ? "CRITICAL HIT" : result.hit ? "HIT" : ""}</span>
          {result.armorAbsorbed > 0 ? <small>Armor absorbed {result.armorAbsorbed}</small> : null}
        </div>
      </div> : null}
    </div>
    <div className={css.footer}>
      <div className={css.healthLabel}><span>{target ? `${target.username} · health` : "Target health"}</span><strong>{target ? `${health} / ${target.maxHealth}` : "—"}</strong></div>
      <div className={css.health} role={target ? "meter" : undefined} aria-label="Target health" aria-valuemin={0} aria-valuemax={target?.maxHealth} aria-valuenow={target ? health : undefined}>
        <div key={`${sequence}-${result ? "after" : "before"}`} className={result ? css.healthChange : undefined} style={{ width: `${percent}%`, ...{ "--before": `${before}%`, "--after": `${percent}%` } }} />
      </div>
      <p>{pending ? "Lining up the attack…" : failed ? "No impact to show. Check the error below." : result?.targetKilled ? "Target defeated." : result?.backfire ? "Your weapon backfired. You took the impact." : result?.hit ? "Hit landed. The target is still standing." : result ? "The attack missed. No damage dealt." : "Choose Shoot, Strike or Punch below to attack."}</p>
    </div>
  </section>;
}
