import { Link } from "react-router-dom";
import type { AttackResponse, TargetReason, WeaponConditionDto } from "@gl3/shared";
import {
  useAttack, useCombatLog, useCombatTargets, useHospital, useJail, useMe,
  useRepairWeapon, useWeaponCondition,
} from "../api/queries.js";
import { formatMoney } from "../lib/money.js";
import { Amount, ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";

/**
 * The list is advisory. `attack` re-checks every rule under the lock, and it
 * claims its Redis cooldown BEFORE the transaction and deliberately does not
 * release it on a 4xx — so firing at an illegal target costs a full cooldown.
 * Greying those rows out is the point of the endpoint, not decoration.
 */
const REASONS: Record<TargetReason, string> = {
  hospitalised: "In hospital",
  jailed: "In jail",
  gang_mate: "Your gang",
  newbie_protected: "Under newbie protection",
  newbie_self: "You're still under newbie protection",
};

function AttackResult({ data }: { data: AttackResponse }): JSX.Element {
  if (data.backfire) {
    return <span className={styles.bad}>Your weapon backfired for {data.selfDamage} damage!</span>;
  }
  if (!data.hit) return <span>Missed.</span>;
  return (
    <span>
      {data.crit ? <span className={styles.bad}>Critical!</span> : null}
      {" "}{data.damage} damage
      {data.armorAbsorbed > 0 ? <span className={styles.muted}> ({data.armorAbsorbed} absorbed)</span> : null}
      {data.targetKilled ? (
        <span className={styles.ok}> — killed, took <Money value={String(data.payout)} /></span>
      ) : (
        <span className={styles.muted}> — they're on {data.targetHealth}</span>
      )}
    </span>
  );
}

/** Weapon name, condition bar, backfire odds, and a repair action. */
function WeaponPanel({ weapon }: { weapon: WeaponConditionDto }): JSX.Element {
  const repair = useRepairWeapon();
  const itemId = weapon.itemId;

  return (
    <div>
      <h3 className={styles.meta}>Weapon</h3>
      <p className={styles.meta}>{weapon.name ?? "Unarmed"}</p>
      {itemId !== null ? (
        <>
          <div className={styles.bar}>
            <div className={styles.barFill} style={{ width: `${weapon.condition}%` }} />
          </div>
          <p className={styles.meta}>
            Condition {weapon.condition}% · Backfire chance {weapon.backfireChance}%
          </p>
          <ErrorText error={repair.error} />
          {weapon.condition < 100 ? (
            <button
              type="button"
              disabled={repair.isPending}
              onClick={() => { repair.mutate(itemId); }}
            >
              {repair.isPending ? "Repairing…" : `Repair (${formatMoney(weapon.repairCost)})`}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function Combat(): JSX.Element {
  const targets = useCombatTargets();
  const log = useCombatLog();
  const me = useMe();
  const jail = useJail();
  const hospital = useHospital();
  const attack = useAttack();
  const weapon = useWeaponCondition();

  if (targets.isLoading) return <Loading what="targets" />;
  if (targets.error) return <ErrorText error={targets.error} />;

  const rows = targets.data?.targets ?? [];
  const mode = targets.data?.mode ?? "open";
  const entries = log.data?.entries ?? [];
  const myId = me.data?.playerId;
  // The server rejects these anyway, but the cooldown is claimed before the
  // check — so an enabled button here would cost the player a wasted shot.
  const jailed = jail.data?.jailed === true;
  const hospitalised = hospital.data?.hospitalised === true;
  const blocked = jailed || hospitalised;

  return (
    <Panel title="Combat">
      <ErrorText error={attack.error} />

      {jailed ? <p className={styles.bad}>You can't shoot anyone from jail.</p> : null}
      {!jailed && hospitalised ? <p className={styles.bad}>You can't shoot anyone from a hospital bed.</p> : null}

      {weapon.data ? <WeaponPanel weapon={weapon.data} /> : null}

      {/* Always mounted so it is a live region BEFORE a result lands in it —
          a region inserted together with its content is often not announced. */}
      <p className={styles.meta} role="status">
        {attack.data ? <AttackResult data={attack.data} /> : null}
      </p>

      <div className={styles.stack}>
        <div>
          <h3 className={styles.meta}>Here now</h3>
          {rows.length === 0 ? (
            mode === "underground" ? (
              <p className={styles.meta}>
                Nobody shows their face in this town. <Link to="/detectives">Hire a detective.</Link>
              </p>
            ) : (
              <p className={styles.meta}>Nobody else is in this city.</p>
            )
          ) : (
            <ul className={styles.rows}>
              {rows.map((target) => (
                <li key={target.playerId} className={styles.row}>
                  <span>
                    {target.username}
                    {target.rank ? <span className={styles.muted}> · {target.rank}</span> : null}
                    {" · "}
                    <Amount value={String(target.health)} />
                    /
                    <Amount value={String(target.maxHealth)} />
                  </span>
                  {target.attackable ? (
                    <button
                      type="button"
                      disabled={blocked || attack.isPending}
                      onClick={() => attack.mutate(target.playerId)}
                    >
                      Shoot
                    </button>
                  ) : (
                    <span className={styles.muted}>
                      {" — "}{target.reason ? REASONS[target.reason] : "Can't be shot"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className={styles.meta}>Recent fights</h3>
          {entries.length === 0 ? (
            <p className={styles.meta}>Nothing yet.</p>
          ) : (
            <ul className={styles.rows}>
              {entries.map((entry) => (
                <li key={entry.id} className={styles.row}>
                  <span>
                    {entry.attackerId === myId
                      ? "You shot someone"
                      : "Someone shot you"}
                    {entry.hit
                      ? <span className={styles.muted}> for <Amount value={String(entry.damage)} /></span>
                      : " and it missed"}
                    {entry.fatal ? <span className={styles.bad}> — fatal</span> : null}
                    {entry.payout !== "0"
                      ? <span className={styles.muted}> · <Money value={entry.payout} /></span>
                      : null}
                  </span>
                  <span className={styles.meta}><When iso={entry.createdAt} /></span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
