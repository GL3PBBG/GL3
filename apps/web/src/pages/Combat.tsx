import { Link } from "react-router-dom";
import type { AttackResponse, TargetReason, WeaponChoice, WeaponConditionDto } from "@gl3/shared";
import { formatMoney, useAttack, useCombatLog, useCombatTargets, useHospital, useJail, useMe, useRepairWeapon, useWeaponCondition } from "@gl3/client";
import { PlayerLink } from "../components/PlayerLink.js";
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

/** "Shot with Glock" / "Struck with Bat" / "Punched" — which model resolved, by name. */
function weaponVerb(data: AttackResponse): string {
  if (data.weapon === "fists") return "Punched";
  const verb = data.weapon === "melee" ? "Struck" : "Shot";
  return data.weaponName === null ? verb : `${verb} with ${data.weaponName}`;
}

function AttackResult({ data }: { data: AttackResponse }): JSX.Element {
  if (data.backfire) {
    return <span className={styles.bad}>Your weapon backfired for {data.selfDamage} damage!</span>;
  }
  if (!data.hit) return <span>{weaponVerb(data)} — missed.</span>;
  // The raw figure the weapon rolled is damage + what armor ate; showing both
  // is what makes a weapon comparable across targets rather than a yes/no.
  const raw = data.damage + data.armorAbsorbed;
  return (
    <span>
      {weaponVerb(data)} for{" "}
      {data.crit ? <span className={styles.bad}>a critical </span> : null}
      {data.damage} damage
      {data.armorAbsorbed > 0
        ? <span className={styles.muted}> ({raw} rolled, armor ate {data.armorAbsorbed})</span>
        : null}
      {data.bulletsSpent > 0
        ? <span className={styles.muted}> · {data.bulletsSpent} {data.bulletsSpent === 1 ? "bullet" : "bullets"}</span>
        : null}
      {data.targetKilled ? (
        <span className={styles.ok}> — killed, took <Money value={String(data.payout)} /></span>
      ) : (
        <span className={styles.muted}> — they're on {data.targetHealth}</span>
      )}
    </span>
  );
}

/**
 * Both slots. Slot 1 keeps its condition bar, backfire odds and repair; the
 * melee slot shows its power, the strength it multiplies and the estimate
 * the server labels a ceiling (real damage divides by the target's guard).
 */
function WeaponPanel({ weapon }: { weapon: WeaponConditionDto }): JSX.Element {
  const repair = useRepairWeapon();
  const itemId = weapon.itemId;
  const gun = weapon.firearm;
  const melee = weapon.melee;

  return (
    <div>
      <h3 className={styles.meta}>Weapons</h3>
      <p className={styles.meta}>
        Firearm: {weapon.name ?? "none"}
        {gun !== null ? (
          <span className={styles.muted}>
            {" · "}{gun.damageMin}–{gun.damageMax} damage
            {gun.bulletsPerShot > 1 ? ` · ${gun.bulletsPerShot} bullets/shot` : ""}
          </span>
        ) : null}
      </p>
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
      <p className={styles.meta}>
        Melee: {melee === null ? "none" : melee.name}
        {melee !== null ? (
          <span className={styles.muted}>
            {" · "}power {melee.power} × strength <Amount value={melee.strength} />
            {" → up to "}<Amount value={melee.estimate} /> vs an unguarded target
          </span>
        ) : null}
      </p>
      {itemId === null && melee === null ? <p className={styles.meta}>Unarmed — you fight with your fists.</p> : null}
    </div>
  );
}

/**
 * One button per armed slot when both are armed, so a player who trained
 * for the bat is never forced through a lousy gun. A single armed slot needs
 * no choice — the server's precedence fires it — and fists need none either.
 */
function AttackButtons({ weapon, targetId, disabled, fire }: {
  weapon: WeaponConditionDto | undefined;
  targetId: string;
  disabled: boolean;
  fire: (input: { targetId: string; weapon?: WeaponChoice }) => void;
}): JSX.Element {
  const slot1Armed = weapon?.itemId != null;
  const hasMelee = weapon?.melee != null;
  // A melee item still in slot 1 (equipped before the slot gate) has no
  // firearm block; "Attack" rather than "Shoot" keeps the label honest.
  const slot1Label = weapon?.firearm != null ? "Shoot" : "Attack";
  if (slot1Armed && hasMelee) {
    return (
      <>
        <button type="button" disabled={disabled} onClick={() => fire({ targetId, weapon: "firearm" })}>
          {slot1Label}
        </button>
        <button type="button" disabled={disabled} onClick={() => fire({ targetId, weapon: "melee" })}>
          Strike
        </button>
      </>
    );
  }
  const label = slot1Armed ? slot1Label : hasMelee ? "Strike" : "Punch";
  return (
    <button type="button" disabled={disabled} onClick={() => fire({ targetId })}>
      {label}
    </button>
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
                Nobody shows their face in this town. <Link to="/plugins/detectives.index">Hire a detective.</Link>
              </p>
            ) : (
              <p className={styles.meta}>Nobody else is in this city.</p>
            )
          ) : (
            <ul className={styles.rows}>
              {rows.map((target) => (
                <li key={target.playerId} className={styles.row}>
                  <span>
                    <PlayerLink playerId={target.playerId} username={target.username} />
                    {target.rank ? <span className={styles.muted}> · {target.rank}</span> : null}
                    {" · "}
                    <Amount value={String(target.health)} />
                    /
                    <Amount value={String(target.maxHealth)} />
                  </span>
                  {target.attackable ? (
                    <AttackButtons
                      weapon={weapon.data}
                      targetId={target.playerId}
                      disabled={blocked || attack.isPending}
                      fire={(input) => attack.mutate(input)}
                    />
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
