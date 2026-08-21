import type { InventoryItem } from "@gl3/shared";
import { Link } from "react-router-dom";
import { useInventory, useEquip, useHospital, useUseItem } from "../api/queries.js";
import { Amount, ErrorText, Loading, Panel } from "../components/ui.js";
import { numericEffect, weaponStatLine } from "../lib/effects.js";
import styles from "./pages.module.css";
import { GameImage } from "../components/GameImage.js";

/**
 * The three item types this page renders specially. Anything else is listed
 * under "Other" with no actions: `item_type` is unconstrained text and the
 * server passes an unrecognised type's effects through untouched, so the page
 * must not assume it knows every type either.
 */
const WEAPON = "weapon";
const ARMOR = "armor";
const CONSUMABLE = "consumable";

/** Plugin-contributed links from `inventory.itemActions` (e.g. combat's gunsmith repair). */
function ItemActions({ item }: { item: InventoryItem }): JSX.Element | null {
  const actions = item.actions ?? [];
  if (actions.length === 0) return null;
  return (
    <span className={styles.actions}>
      {actions.map((action) => (
        <Link key={`${action.pluginId}:${action.label}`} to={action.to}>{action.label}</Link>
      ))}
    </span>
  );
}

function ItemStats({ item }: { item: InventoryItem }): JSX.Element | null {
  if (item.itemType === WEAPON) {
    const line = weaponStatLine(item.effects);
    if (line === null) return <span className={styles.muted}>unusable</span>;
    return <span className={styles.muted}>{line}</span>;
  }
  if (item.itemType === ARMOR) {
    const armor = numericEffect(item.effects, "armor");
    if (armor === null) return <span className={styles.muted}>unusable</span>;
    return <span className={styles.muted}>{armor} armor</span>;
  }
  if (item.itemType === CONSUMABLE) {
    const heal = numericEffect(item.effects, "heal");
    if (heal === null) return <span className={styles.muted}>unusable</span>;
    return <span className={styles.muted}>heals {heal}</span>;
  }
  return null;
}

export function Inventory(): JSX.Element {
  const inventory = useInventory();
  const hospital = useHospital();
  const equip = useEquip();
  const useItem = useUseItem();

  if (inventory.isLoading || hospital.isLoading) return <Loading what="inventory" />;
  if (inventory.error) return <ErrorText error={inventory.error} />;
  if (!inventory.data) return <Loading what="inventory" />;

  const { items, equipped } = inventory.data;
  const health = hospital.data?.health;
  const maxHealth = hospital.data?.maxHealth;
  const full = health !== undefined && maxHealth !== undefined && health >= maxHealth;

  const weapons = items.filter((i) => i.itemType === WEAPON);
  const armors = items.filter((i) => i.itemType === ARMOR);
  const consumables = items.filter((i) => i.itemType === CONSUMABLE);
  const others = items.filter(
    (i) => i.itemType !== WEAPON && i.itemType !== ARMOR && i.itemType !== CONSUMABLE,
  );

  // The mutation whose error is worth showing is whichever ran last; both
  // report through describeError so `rank_too_low`, `wrong_slot`, `not_owned`
  // and `already_full` read as sentences rather than codes.
  const actionError = equip.error ?? useItem.error;

  return (
    <Panel title="Inventory">
      {health !== undefined && maxHealth !== undefined ? (
        <p className={styles.meta}>
          Health <Amount value={String(health)} /> / <Amount value={String(maxHealth)} />
        </p>
      ) : null}
      <ErrorText error={actionError} />

      <div className={styles.stack}>
        <div>
          <h3 className={styles.meta}>Equipped</h3>
          <ul className={styles.rows}>
            <li className={styles.row}>
              <span>Weapon: {equipped.weaponItemId
                ? items.find((i) => i.itemId === equipped.weaponItemId)?.name ?? "unknown"
                : "none"}</span>
              {equipped.weaponItemId ? (
                <button
                  type="button"
                  disabled={equip.isPending}
                  onClick={() => equip.mutate({ weaponItemId: null })}
                >
                  Unequip
                </button>
              ) : null}
            </li>
            <li className={styles.row}>
              <span>Armor: {equipped.armorItemId
                ? items.find((i) => i.itemId === equipped.armorItemId)?.name ?? "unknown"
                : "none"}</span>
              {equipped.armorItemId ? (
                <button
                  type="button"
                  disabled={equip.isPending}
                  onClick={() => equip.mutate({ armorItemId: null })}
                >
                  Unequip
                </button>
              ) : null}
            </li>
          </ul>
        </div>

        {items.length === 0 ? (
          <p className={styles.meta}>You own nothing. Buy something at the shop.</p>
        ) : null}

        {weapons.length > 0 ? (
          <div>
            <h3 className={styles.meta}>Weapons</h3>
            <ul className={styles.rows}>
              {weapons.map((item) => (
                <li key={item.itemId} className={styles.row}>
                  <span>
                    <GameImage url={item.imageUrl} alt={item.name} size="sm" />{" "}
                    {item.name} ×<Amount value={String(item.qty)} /> <ItemStats item={item} />
                  </span>
                  <ItemActions item={item} />
                  <button
                    type="button"
                    disabled={equip.isPending || item.itemId === equipped.weaponItemId}
                    onClick={() => equip.mutate({ weaponItemId: item.itemId })}
                  >
                    {item.itemId === equipped.weaponItemId ? "Equipped" : "Equip"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {armors.length > 0 ? (
          <div>
            <h3 className={styles.meta}>Armor</h3>
            <ul className={styles.rows}>
              {armors.map((item) => (
                <li key={item.itemId} className={styles.row}>
                  <span>
                    <GameImage url={item.imageUrl} alt={item.name} size="sm" />{" "}
                    {item.name} ×<Amount value={String(item.qty)} /> <ItemStats item={item} />
                  </span>
                  <ItemActions item={item} />
                  <button
                    type="button"
                    disabled={equip.isPending || item.itemId === equipped.armorItemId}
                    onClick={() => equip.mutate({ armorItemId: item.itemId })}
                  >
                    {item.itemId === equipped.armorItemId ? "Equipped" : "Equip"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {consumables.length > 0 ? (
          <div>
            <h3 className={styles.meta}>Consumables</h3>
            {full ? <p className={styles.bad}>You're at full health — nothing to heal.</p> : null}
            <ul className={styles.rows}>
              {consumables.map((item) => (
                <li key={item.itemId} className={styles.row}>
                  <span>
                    <GameImage url={item.imageUrl} alt={item.name} size="sm" />{" "}
                    {item.name} ×<Amount value={String(item.qty)} /> <ItemStats item={item} />
                  </span>
                  <ItemActions item={item} />
                  <button
                    type="button"
                    disabled={useItem.isPending || full}
                    onClick={() => useItem.mutate(item.itemId)}
                  >
                    Use
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {others.length > 0 ? (
          <div>
            <h3 className={styles.meta}>Other</h3>
            <ul className={styles.rows}>
              {others.map((item) => (
                <li key={item.itemId} className={styles.row}>
                  <span>
                    <GameImage url={item.imageUrl} alt={item.name} size="sm" />{" "}
                    {item.name} ×<Amount value={String(item.qty)} />
                  </span>
                  <ItemActions item={item} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
