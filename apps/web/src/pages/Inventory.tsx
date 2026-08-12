import type { InventoryItem } from "@gl3/shared";
import { useInventory, useEquip, useMe, useUseItem } from "../api/queries.js";
import { describeError } from "../lib/errors.js";
import { numericEffect } from "../lib/effects.js";

/**
 * The three item types this page renders specially. Anything else is listed
 * under "Other" with no actions: `item_type` is unconstrained text and the
 * server passes an unrecognised type's effects through untouched, so the page
 * must not assume it knows every type either.
 */
const WEAPON = "weapon";
const ARMOR = "armor";
const CONSUMABLE = "consumable";

function ItemStats({ item }: { item: InventoryItem }) {
  if (item.itemType === WEAPON) {
    const min = numericEffect(item.effects, "damageMin");
    const max = numericEffect(item.effects, "damageMax");
    if (min === null || max === null) return <span className="muted">unusable</span>;
    return <span className="muted">{min}–{max} damage</span>;
  }
  if (item.itemType === ARMOR) {
    const armor = numericEffect(item.effects, "armor");
    if (armor === null) return <span className="muted">unusable</span>;
    return <span className="muted">{armor} armor</span>;
  }
  if (item.itemType === CONSUMABLE) {
    const heal = numericEffect(item.effects, "heal");
    if (heal === null) return <span className="muted">unusable</span>;
    return <span className="muted">heals {heal}</span>;
  }
  return null;
}

export function Inventory(): JSX.Element {
  const inventory = useInventory();
  const me = useMe();
  const equip = useEquip();
  const useItem = useUseItem();

  if (inventory.isLoading) return <p>Loading…</p>;
  if (inventory.error) return <p className="error">{describeError(inventory.error)}</p>;
  if (!inventory.data) return <></>;

  const { items, equipped } = inventory.data;

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
    <section>
      <h1>Inventory</h1>
      {actionError ? <p className="error">{describeError(actionError)}</p> : null}

      <h2>Equipped</h2>
      <ul>
        <li>
          Weapon: {equipped.weaponItemId
            ? items.find((i) => i.itemId === equipped.weaponItemId)?.name ?? "unknown"
            : "none"}
          {equipped.weaponItemId ? (
            <button
              type="button"
              disabled={equip.isPending}
              // Explicit null unequips. Omitting the key would leave the slot
              // alone — that distinction is the whole reason the request
              // schema is `.nullable().optional()`.
              onClick={() => equip.mutate({ weaponItemId: null })}
            >
              Unequip
            </button>
          ) : null}
        </li>
        <li>
          Armor: {equipped.armorItemId
            ? items.find((i) => i.itemId === equipped.armorItemId)?.name ?? "unknown"
            : "none"}
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

      {items.length === 0 ? (
        <p>You own nothing. Buy something at the shop.</p>
      ) : null}

      {weapons.length > 0 ? (
        <>
          <h2>Weapons</h2>
          <ul>
            {weapons.map((item) => (
              <li key={item.itemId}>
                {item.name} ×{item.qty} <ItemStats item={item} />
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
        </>
      ) : null}

      {armors.length > 0 ? (
        <>
          <h2>Armor</h2>
          <ul>
            {armors.map((item) => (
              <li key={item.itemId}>
                {item.name} ×{item.qty} <ItemStats item={item} />
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
        </>
      ) : null}

      {consumables.length > 0 ? (
        <>
          <h2>Consumables</h2>
          <ul>
            {consumables.map((item) => (
              <li key={item.itemId}>
                {item.name} ×{item.qty} <ItemStats item={item} />
                <button
                  type="button"
                  disabled={useItem.isPending}
                  onClick={() => useItem.mutate(item.itemId)}
                >
                  Use
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {others.length > 0 ? (
        <>
          <h2>Other</h2>
          <ul>
            {others.map((item) => (
              <li key={item.itemId}>{item.name} ×{item.qty}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
