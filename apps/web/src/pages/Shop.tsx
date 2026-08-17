import { useState } from "react";
import type { ShopItem } from "@gl3/shared";
import { useBuyItem, useMe, useShop } from "../api/queries.js";
import { describeError } from "../lib/errors.js";
import { numericEffect, weaponStatLine } from "../lib/effects.js";
import { canAfford, multiplyMoney } from "../lib/money.js";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import styles from "./pages.module.css";

function Stats({ item }: { item: ShopItem }) {
  if (item.itemType === "weapon") {
    const line = weaponStatLine(item.effects);
    return line === null ? null : <span className={styles.muted}>{line}</span>;
  }
  if (item.itemType === "armor") {
    const armor = numericEffect(item.effects, "armor");
    return armor === null ? null : <span className={styles.muted}>{armor} armor</span>;
  }
  if (item.itemType === "consumable") {
    const heal = numericEffect(item.effects, "heal");
    return heal === null ? null : <span className={styles.muted}>heals {heal}</span>;
  }
  return null;
}

function Row({ item, cash }: { item: ShopItem; cash: string }) {
  const [quantity, setQuantity] = useState(1);
  const buy = useBuyItem();

  const total = multiplyMoney(item.price, quantity);
  const affordable = canAfford(cash, total);
  const inStock = quantity > 0 && quantity <= item.stock;

  return (
    <li className={styles.row}>
      <span>
        <strong>{item.name}</strong> <Stats item={item} />
        <span className={styles.meta}> <Money value={item.price} /> each · {item.stock} in stock</span>
      </span>
      <div className={styles.actions}>
        <input
          type="number"
          min={1}
          max={item.stock}
          value={quantity}
          onChange={(event) => setQuantity(Number(event.target.value))}
        />
        <span className={styles.meta}>= <Money value={total} /></span>
        <button
          type="button"
          disabled={buy.isPending || !affordable || !inStock}
          onClick={() => buy.mutate({ itemId: item.itemId, quantity })}
        >
          Buy
        </button>
        {!affordable ? <span className={styles.muted}> can't afford</span> : null}
      </div>
      {buy.error ? <p className={styles.bad}>{describeError(buy.error)}</p> : null}
    </li>
  );
}

export function Shop(): JSX.Element {
  const shop = useShop();
  const me = useMe();

  if (shop.isLoading) return <Loading what="the shop" />;
  if (shop.error) return <ErrorText error={shop.error} />;
  if (!shop.data) return <Loading what="the shop" />;

  const cash = me.data?.cash ?? "0";
  const forSale = shop.data.items.filter((item) => item.stock > 0);

  return (
    <Panel title="Shop">
      <p className={styles.meta}>Cash <Money value={cash} /></p>
      {forSale.length === 0 ? (
        <p className={styles.meta}>Nothing for sale here. Try another city.</p>
      ) : (
        <ul className={styles.rows}>
          {forSale.map((item) => <Row key={item.itemId} item={item} cash={cash} />)}
        </ul>
      )}
    </Panel>
  );
}
