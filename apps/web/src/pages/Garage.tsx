import { useState } from "react";
import { Link } from "react-router-dom";
import { canAfford, useGarage, useGarageAction, useJail, useMe, usePlugins, type GarageCar } from "@gl3/client";
import { Amount, ErrorText, Loading, Money, Panel } from "../components/ui.js";
import { CollectionArt } from "../components/CollectionArt.js";
import { SlotImage } from "../components/GameImage.js";
import { HudIcon } from "../components/HudIcon.js";
import collection from "../components/Collection.module.css";
import styles from "./Garage.module.css";

type Feedback = { carId: string; carName: string } & (
  { action: "sell"; payout: string } | { action: "repair"; cost: string | null }
);

function ActionFeedback({ feedback }: { feedback: Feedback }): JSX.Element {
  return <p className={styles.feedback} role="status">
    {feedback.action === "sell" ? <>Sold {feedback.carName} for <Money value={feedback.payout} />.</>
      : feedback.cost === null ? <>{feedback.carName} is already pristine. No repair charge.</>
      : <>{feedback.carName} repaired for <Money value={feedback.cost} />.</>}
  </p>;
}

export function Garage(): JSX.Element {
  const garage = useGarage();
  const me = useMe();
  const jail = useJail();
  const plugins = usePlugins();
  const action = useGarageAction();
  const [confirmSale, setConfirmSale] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [failure, setFailure] = useState<{ carId: string; error: Error } | null>(null);
  const [localOnly, setLocalOnly] = useState(false);

  if (garage.isLoading || me.isLoading) return <Loading what="your garage" />;
  if (!garage.data || !me.data) return <Panel title="Garage"><ErrorText error={garage.error ?? me.error} /></Panel>;

  const cash = me.data.cash;
  const cars = garage.data.rows;
  const local = cars.filter((car) => car.here);
  const visible = localOnly ? local : cars;
  const saleValue = cars.reduce((total, car) => total + BigInt(car.saleValue), 0n).toString();
  const canTravel = plugins.data?.installed.includes("travel") === true;
  const blocked = jail.data?.jailed ? "You can't sell or repair cars while in jail."
    : jail.isError ? "Your jail status is unavailable. Try again shortly."
    : !jail.data ? "Checking your status…" : null;

  function run(car: GarageCar, kind: "sell" | "repair"): void {
    setConfirmSale(null);
    setFeedback(null);
    setFailure(null);
    action.mutate({ action: kind, garageId: car.id }, {
      onSuccess: (result) => setFeedback({ carId: car.id, carName: car.carName, ...result }),
      onError: (error) => setFailure({ carId: car.id, error }),
    });
  }

  return <Panel title="Garage">
    <SlotImage scope="theft" slot="page-garage" alt="Garage" size="lg" />
    <div className={styles.intro}>
      <div><span className={collection.eyebrow}>Your collection</span><h3>Keys to the city</h3><p className={collection.meta}>Cars stay in the city you stole them in. Sell or repair them there.</p></div>
      <div className={styles.summary}><div><strong><Amount value={String(cars.length)} /></strong><span>Cars owned</span></div><div><strong><Money value={saleValue} /></strong><span>Current sale value</span></div></div>
    </div>
    <ErrorText error={garage.error} />
    {blocked ? <p className={styles.notice}>{blocked}</p> : null}
    {feedback && (feedback.action === "sell" || !visible.some((car) => car.id === feedback.carId)) ? <ActionFeedback feedback={feedback} /> : null}
    {failure && !visible.some((car) => car.id === failure.carId) ? <ErrorText error={failure.error} /> : null}
    {cars.length > 0 ? <div className={styles.filters} aria-label="Filter cars by location">
      <button type="button" aria-pressed={!localOnly} onClick={() => { setLocalOnly(false); setConfirmSale(null); }}>All cars ({cars.length})</button>
      <button type="button" aria-pressed={localOnly} onClick={() => { setLocalOnly(true); setConfirmSale(null); }}>In this city ({local.length})</button>
    </div> : null}
    {visible.length === 0 ? <div className={styles.empty}>
      <CollectionArt name="Empty garage" kind="car" />
      <h3>{cars.length === 0 ? "Your first set of keys awaits" : "No cars parked here"}</h3>
      <p className={collection.meta}>{cars.length === 0 ? "Steal a car to start your collection." : "Your collection is parked in other cities."}</p>
      {cars.length === 0 ? <Link to="/plugins/theft.index">Try car theft →</Link> : <button type="button" onClick={() => setLocalOnly(false)}>Show all cars</button>}
    </div> : <ul className={collection.grid}>
      {visible.map((car) => {
        const condition = 100 - car.damage;
        const affordable = canAfford(cash, car.repairCost);
        const disabled = action.isPending || blocked !== null || !car.here;
        return <li key={car.id} className={collection.card}>
          <CollectionArt url={car.image} name={car.carName} kind="car" />
          <div className={collection.body}>
            <div className={styles.location}><HudIcon id="location" /><span>{car.locationName}</span><span className={collection.badge}>{car.here ? "In this city" : "Parked elsewhere"}</span></div>
            <h3 className={collection.title}>{car.carName}</h3>
            <div className={styles.conditionLabel}><span>Condition</span><strong>{condition}%</strong></div>
            <div className={styles.condition} role="meter" aria-label={`${car.carName} condition`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={condition} data-worn={condition < 40}>
              <div style={{ width: `${condition}%` }} />
            </div>
            <p className={collection.meta}>{car.damage === 0 ? "Pristine · no repairs needed" : `${car.damage}% damage`}</p>
            <dl className={styles.prices}><dt>Sells for</dt><dd><Money value={car.saleValue} /></dd><dt>Full repair</dt><dd><Money value={car.repairCost} /></dd></dl>
            {!car.here ? <p className={styles.notice}>{canTravel ? <Link to="/plugins/travel.index">Travel to {car.locationName}</Link> : <>Visit {car.locationName}</>} to sell or repair this car.</p> : null}
            {car.here && car.damage > 0 && !affordable ? <p className={styles.notice}>Not enough cash for a full repair.</p> : null}
            <div className={collection.actions}>
              <button type="button" disabled={disabled || car.damage === 0 || !affordable} onClick={() => run(car, "repair")}>{action.isPending && action.variables?.garageId === car.id && action.variables.action === "repair" ? "Repairing…" : "Repair"}</button>
              <button type="button" disabled={disabled} onClick={() => setConfirmSale(car.id)}>{action.isPending && action.variables?.garageId === car.id && action.variables.action === "sell" ? "Selling…" : "Sell"}</button>
            </div>
            {confirmSale === car.id ? <div className={styles.confirm}>
              <p>Sell {car.carName} for <Money value={car.saleValue} />? This removes it from your garage.</p>
              <div className={collection.actions}><button type="button" disabled={disabled} onClick={() => run(car, "sell")}>Confirm sale</button><button type="button" onClick={() => setConfirmSale(null)}>Keep car</button></div>
            </div> : null}
            {failure?.carId === car.id ? <ErrorText error={failure.error} /> : null}
            {feedback?.carId === car.id && feedback.action === "repair" ? <ActionFeedback feedback={feedback} /> : null}
          </div>
        </li>;
      })}
    </ul>}
  </Panel>;
}
