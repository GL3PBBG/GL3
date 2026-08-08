import { useState } from "react";
import { Link } from "react-router-dom";
import { useBuyBullets, useJail, useLocations, useMe } from "../api/queries.js";
import { canAfford, multiplyMoney } from "../lib/money.js";
import { Amount, ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

export function Bullets(): JSX.Element {
  const me = useMe();
  const jail = useJail();
  const locations = useLocations();
  const buy = useBuyBullets();
  const [quantity, setQuantity] = useState("10");

  if (locations.isLoading || !me.data) return <Loading what="the shop" />;

  const here = locations.data?.locations.find((location) => location.current);

  // A brand-new player has locationId null, so every location reports
  // current:false and POST /api/bullets/buy answers 409 no_location. Say so
  // instead of rendering a form that can only fail.
  if (here === undefined) {
    return (
      <Panel title="Bullets">
        <p style={{ margin: 0 }}>You aren't anywhere yet — bullets are bought from a city.</p>
        <p className={styles.meta}>
          <Link to="/travel">Travel somewhere</Link> first.
        </p>
      </Panel>
    );
  }

  const count = /^\d+$/.test(quantity) ? Number(quantity) : 0;
  const total = count > 0 ? multiplyMoney(here.bulletCost, count) : "0";
  const valid = count > 0 && count <= here.bulletStock && canAfford(me.data.cash, total);
  const jailed = jail.data?.jailed === true;

  return (
    <Panel title={`Bullets — ${here.name}`}>
      <p className={styles.meta}>
        <Money value={here.bulletCost} /> each · {here.bulletStock} in stock · you hold{" "}
        <Amount value={me.data.bullets} />
      </p>

      <div className={styles.form}>
        <label>
          <span className={styles.meta}>Quantity </span>
          <input
            inputMode="numeric"
            value={quantity}
            onChange={(event) => { setQuantity(event.target.value.trim()); }}
          />
        </label>
        <span>
          = <Money value={total} />
        </span>
        <button
          type="button"
          disabled={!valid || jailed || buy.isPending}
          onClick={() => { buy.mutate(count); }}
        >
          Buy
        </button>
      </div>

      {jailed ? <p className={styles.bad}>No shopping from jail.</p> : null}
      {count > here.bulletStock ? (
        <p role="alert" className={styles.bad}>Only {here.bulletStock} left here.</p>
      ) : null}
      <ErrorText error={buy.error} />
    </Panel>
  );
}
