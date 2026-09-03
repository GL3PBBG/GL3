import { useState } from "react";
import { Link } from "react-router-dom";
import { useBulletShop, useBuyBullets, useJail, useMe } from "../api/queries.js";
import { canAfford, multiplyMoney } from "@gl3/client";
import { Amount, ErrorText, Loading, Money, Panel } from "../components/ui.js";
import { PropertyPanel } from "../components/PropertyPanel.js";
import styles from "./pages.module.css";

export function Bullets(): JSX.Element {
  const me = useMe();
  const jail = useJail();
  // Not useLocations(): the shop route carries the price the buy route will
  // actually charge (an owned factory's lever, capped by the admin's
  // max_cost), and reading it is what runs the hourly restock. The locations
  // list knows neither.
  const shop = useBulletShop();
  const buy = useBuyBullets();
  const [quantity, setQuantity] = useState("10");

  if (shop.isLoading || !me.data) return <Loading what="the shop" />;

  const here = shop.data;

  // A brand-new player has locationId null, so the shop route answers 409
  // no_location. Say so instead of rendering a form that can only fail.
  if (here === undefined) {
    return (
      <Panel title="Bullets">
        <p style={{ margin: 0 }}>You aren't anywhere yet — bullets are bought from a city.</p>
        <p className={styles.meta}>
          <Link to="/plugins/travel.index">Travel somewhere</Link> first.
        </p>
      </Panel>
    );
  }

  const count = /^\d+$/.test(quantity) ? Number(quantity) : 0;
  const total = count > 0 ? multiplyMoney(here.unitCost, count) : "0";
  const overCap = here.maxBuy !== null && count > here.maxBuy;
  const valid = count > 0 && count <= here.bulletStock && !overCap && canAfford(me.data.cash, total);
  const jailed = jail.data?.jailed === true;

  return (
    <Panel title={`Bullets — ${here.locationName}`}>
      <p className={styles.meta}>
        <Money value={here.unitCost} /> each · {here.bulletStock} in stock · you hold{" "}
        <Amount value={here.bullets} />
        {here.maxBuy !== null ? <> · {here.maxBuy} max per purchase</> : null}
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

      {/* The town's bullet factory — owner shown, buyable when nobody's.
          Half of every sale here goes to whoever holds it. */}
      <PropertyPanel pluginId="bullets" />

      {jailed ? <p className={styles.bad}>No shopping from jail.</p> : null}
      {count > here.bulletStock ? (
        <p role="alert" className={styles.bad}>Only {here.bulletStock} left here.</p>
      ) : null}
      {overCap ? (
        <p role="alert" className={styles.bad}>At most {here.maxBuy} per purchase.</p>
      ) : null}
      <ErrorText error={buy.error} />
    </Panel>
  );
}
