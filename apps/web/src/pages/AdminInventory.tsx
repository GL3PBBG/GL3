import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, keys } from "@gl3/client";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import {
  adminItemListSchema, adminItemSchema, adminLocationsSchema, adminShopSchema,
  itemDraft, itemFields, itemPayload, itemSummary, itemTypes, rowType,
  type AdminItem, type AdminStock, type ItemDraft, type ItemFormType,
} from "../lib/adminInventory.js";
import common from "./pages.module.css";
import styles from "./AdminInventory.module.css";

const inventoryKey = ["admin", "inventory"] as const;
const base = "/api/admin/inventory";

function DeleteAction({ path, name, description, onSaved }: {
  path: string; name: string; description: string; onSaved: (message: string) => Promise<void>;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    onSuccess: async () => { await onSaved(`Removed ${name}.`); setConfirming(false); },
  });
  return <div className={styles.confirm}>
    {confirming ? <>
      <span>{description}</span>
      <div className={styles.actions}>
        <button type="button" className={styles.danger} disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? "Removing…" : "Confirm removal"}
        </button>
        <button type="button" className={styles.secondary} disabled={remove.isPending} onClick={() => { setConfirming(false); remove.reset(); }}>Cancel</button>
      </div>
    </> : <button type="button" className={styles.secondary} aria-label={`Remove ${name}`} onClick={() => setConfirming(true)}>Remove</button>}
    <ErrorText error={remove.error} />
  </div>;
}

function ItemForm({ item, onCancel, onSaved }: {
  item?: AdminItem; onCancel: () => void; onSaved: (message: string) => Promise<void>;
}): JSX.Element {
  const initial = item === undefined ? { name: "", itemType: "weapon" as const } : itemDraft(item);
  const [draft, setDraft] = useState<ItemDraft>(initial ?? { name: item?.name ?? "", itemType: "misc" });
  const [validation, setValidation] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api(`${base}/items${item ? "/update" : ""}`, {
      method: "POST", body: JSON.stringify({ ...itemPayload(draft), ...(item ? { id: item.id } : {}) }),
    }),
    onSuccess: async () => { await onSaved(`${draft.name.trim()} ${item ? "saved" : "created"}.`); onCancel(); },
  });
  if (initial === null) return <Panel title={`Edit ${item?.name}`}>
    <p>This item type is managed by another plugin and has no editor here.</p>
    <button type="button" onClick={onCancel}>Back to items</button>
  </Panel>;

  return <Panel title={item ? `Edit ${item.name}` : "Create item"}>
    <form className={styles.form} onSubmit={(event) => {
      event.preventDefault();
      if (!draft.name.trim()) { setValidation("Enter an item name."); return; }
      if (draft.itemType === "weapon" && Number(draft["damageMax"]) < Number(draft["damageMin"])) {
        setValidation("Maximum damage must be at least minimum damage."); return;
      }
      if (draft.itemType === "weapon" && draft["dps"] && Number(draft["dps"]) <= 0) {
        setValidation("Damage per second must be positive, or left blank."); return;
      }
      setValidation(null);
      save.mutate();
    }}>
      <fieldset disabled={save.isPending}>
        <div className={styles.fields}>
          <label className={styles.field}>Name
            <input autoFocus required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className={styles.field}>Item type
            <select aria-label="Item type" value={draft.itemType} onChange={(event) => {
              setDraft({ name: draft.name, itemType: event.target.value as ItemFormType });
              setValidation(null); save.reset();
            }}>
              {Object.entries(itemTypes).filter(([type]) => item === undefined
                || (item.itemType === "weapon" ? type === "weapon" || type === "melee" : type === item.itemType))
                .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {item?.itemType === "weapon" && <small>Changing between firearm and melee replaces the weapon’s stats.</small>}
          </label>
        </div>
      </fieldset>
      {itemFields[draft.itemType].length > 0 && <fieldset disabled={save.isPending}>
        <legend>{itemTypes[draft.itemType]} stats</legend>
        <div className={styles.fields}>
          {itemFields[draft.itemType].map((field) => <label className={styles.field} key={field.name}>
            {field.label}
            <input aria-label={field.label} aria-describedby={field.hint ? `item-hint-${field.name}` : undefined} type={field.type ?? "number"} required={field.required} min={field.min} max={field.max}
              step={field.type === "text" ? undefined : field.step ?? "1"}
              value={draft[field.name] ?? ""} onChange={(event) => setDraft({ ...draft, [field.name]: event.target.value })} />
            {field.hint && <small id={`item-hint-${field.name}`}>{field.hint}</small>}
          </label>)}
        </div>
      </fieldset>}
      {validation && <p role="alert">{validation}</p>}
      <ErrorText error={save.error} />
      <div className={styles.actions}>
        <button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : item ? "Save changes" : "Create item"}</button>
        <button type="button" className={styles.secondary} disabled={save.isPending} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  </Panel>;
}

function ItemEditor({ id, onCancel, onSaved }: {
  id: string; onCancel: () => void; onSaved: (message: string) => Promise<void>;
}): JSX.Element {
  const detail = useQuery({
    queryKey: [...inventoryKey, "item", id],
    queryFn: async () => adminItemSchema.parse(await api(`${base}/items/${encodeURIComponent(id)}`)),
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // Wait for fresh data even if this item was edited earlier in the session.
  if (detail.isFetching) return <Panel title="Edit item"><Loading what="item details" /><button type="button" onClick={onCancel}>Cancel</button></Panel>;
  if (detail.isError || !detail.data) return <Panel title="Edit item">
    <ErrorText error={detail.error} />
    <div className={styles.actions}><button type="button" onClick={() => { void detail.refetch(); }}>Retry</button><button type="button" onClick={onCancel}>Cancel</button></div>
  </Panel>;
  return <ItemForm item={detail.data} onCancel={onCancel} onSaved={onSaved} />;
}

function StockForm({ stock, rows, items, locations, onCancel, onSaved }: {
  stock?: AdminStock; rows: AdminStock[];
  items: { id: string; name: string }[]; locations: { id: string; name: string }[];
  onCancel: () => void; onSaved: (message: string) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState(stock ?? { locationId: "", itemId: "", price: "", stock: "" });
  const existing = rows.find((row) => row.locationId === draft.locationId && row.itemId === draft.itemId);
  const save = useMutation({
    mutationFn: () => api(`${base}/shop`, { method: "POST", body: JSON.stringify({
      locationId: draft.locationId, itemId: draft.itemId, price: draft.price, stock: draft.stock,
    }) }),
    onSuccess: async () => { await onSaved("Shop listing saved."); onCancel(); },
  });
  const select = (field: "locationId" | "itemId", value: string) => {
    const next = { ...draft, [field]: value };
    const match = rows.find((row) => row.locationId === next.locationId && row.itemId === next.itemId);
    setDraft({ ...next, price: match?.price ?? "", stock: match?.stock ?? "" });
  };
  return <Panel title={stock ? `Edit ${stock.itemName} at ${stock.locationName}` : "Add shop listing"}>
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <fieldset disabled={save.isPending}>
        <div className={styles.fields}>
          <label className={styles.field}>Location<select required disabled={!!stock} value={draft.locationId} onChange={(e) => select("locationId", e.target.value)}>
            <option value="">Choose a location</option>
            {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </select></label>
          <label className={styles.field}>Item<select required disabled={!!stock} value={draft.itemId} onChange={(e) => select("itemId", e.target.value)}>
            <option value="">Choose an item</option>
            {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <label className={styles.field}>Price<input aria-label="Price" aria-describedby="stock-price-hint" required inputMode="numeric" pattern="[0-9]+" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
            <small id="stock-price-hint">Whole currency units. Zero makes the item free.</small>
          </label>
          <label className={styles.field}>Stock quantity<input aria-label="Stock quantity" aria-describedby="stock-quantity-hint" required type="number" min="0" step="1" value={draft.stock} onChange={(e) => setDraft({ ...draft, stock: e.target.value })} />
            <small id="stock-quantity-hint">Sets the total available quantity; it does not add to current stock.</small>
          </label>
        </div>
      </fieldset>
      {!stock && existing && <p className={styles.notice}>This listing already exists. Its current price and stock are loaded for editing.</p>}
      <ErrorText error={save.error} />
      <div className={styles.actions}>
        <button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save listing"}</button>
        <button type="button" className={styles.secondary} disabled={save.isPending} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  </Panel>;
}

export function AdminInventory(): JSX.Element {
  const client = useQueryClient();
  const [tab, setTab] = useState<"items" | "shop">("items");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [location, setLocation] = useState("");
  const [editItem, setEditItem] = useState<string | null>(null);
  const [editStock, setEditStock] = useState<AdminStock | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const items = useQuery({ queryKey: [...inventoryKey, "items"], queryFn: async () => adminItemListSchema.parse(await api(`${base}/items`)) });
  const shop = useQuery({ queryKey: [...inventoryKey, "shop"], queryFn: async () => adminShopSchema.parse(await api(`${base}/shop`)), enabled: tab === "shop" });
  const locations = useQuery({ queryKey: [...inventoryKey, "locations"], queryFn: async () => adminLocationsSchema.parse(await api(`${base}/locations`)), enabled: tab === "shop" });
  const saved = async (message: string) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: inventoryKey }),
      client.invalidateQueries({ queryKey: keys.inventory() }),
      client.invalidateQueries({ queryKey: keys.shop() }),
    ]);
    setNotice(message);
  };
  const sortedItems = [...(items.data?.rows ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const sortedLocations = [...(locations.data?.rows ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const matchingItems = sortedItems.filter((item) => (!type || rowType(item) === type) && item.name.toLowerCase().includes(search.toLowerCase()));
  const matchingStock = [...(shop.data?.rows ?? [])].filter((row) => (!location || row.locationId === location)
    && `${row.itemName} ${row.locationName}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.locationName.localeCompare(b.locationName) || a.itemName.localeCompare(b.itemName));
  const editing = editItem !== null || editStock !== null;
  const loadError = items.error ?? (tab === "shop" ? shop.error ?? locations.error : null);

  return <div className={common.stack}>
    <div className={common.tabs}>
      {(["items", "shop"] as const).map((value) => <button type="button" key={value} disabled={editing} aria-pressed={tab === value}
        className={tab === value ? common.tabActive : common.tabIdle} onClick={() => { setTab(value); setSearch(""); setNotice(""); }}>
        {value === "items" ? "Item catalogue" : "Shop stock"}
      </button>)}
    </div>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {editItem !== null ? editItem === "new"
      ? <ItemForm onCancel={() => setEditItem(null)} onSaved={saved} />
      : <ItemEditor key={editItem} id={editItem} onCancel={() => setEditItem(null)} onSaved={saved} />
      : editStock !== null ? <StockForm {...(editStock === "new" ? {} : { stock: editStock })} rows={shop.data?.rows ?? []}
        items={sortedItems} locations={sortedLocations} onCancel={() => setEditStock(null)} onSaved={saved} />
      : <Panel title={tab === "items" ? "Item catalogue" : "Shop stock"}>
        <p className={common.muted}>{tab === "items" ? "Create items or select Edit to change their current stats." : "Manage prices and available quantities in each location."}</p>
        <div className={styles.toolbar}>
          <label className={styles.field}>Search<input type="search" placeholder={tab === "items" ? "Find an item…" : "Find an item or location…"} value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          {tab === "items" ? <label className={styles.field}>Type<select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>{Object.entries(itemTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label> : <label className={styles.field}>Location<select value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">All locations</option>{sortedLocations.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select></label>}
          <button type="button" disabled={tab === "shop" && (!shop.data || !locations.data || !items.data || sortedLocations.length === 0 || sortedItems.length === 0)}
            onClick={() => { setNotice(""); if (tab === "items") setEditItem("new"); else setEditStock("new"); }}>
            {tab === "items" ? "Create item" : "Add listing"}
          </button>
        </div>
        <ErrorText error={loadError} />
        {loadError && <button type="button" className={styles.secondary} onClick={() => {
          void items.refetch();
          if (tab === "shop") { void shop.refetch(); void locations.refetch(); }
        }}>Retry loading</button>}
        {(items.isLoading || (tab === "shop" && (shop.isLoading || locations.isLoading))) ? <Loading /> : <>
          <p className={common.muted}>{tab === "items" ? `${matchingItems.length} of ${sortedItems.length} items` : `${matchingStock.length} listings`}</p>
          <div className={styles.tableWrap}><table className={common.table}>
            <thead><tr>{(tab === "items" ? ["Item", "Type", "Stats", "Actions"] : ["Item", "Location", "Price", "Stock", "Actions"]).map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
            <tbody>{tab === "items" ? matchingItems.map((item) => <tr key={item.id}>
              <td>{item.name}</td><td className={styles.type}>{itemTypes[rowType(item) as ItemFormType] ?? item.itemType}</td><td className={styles.summary}>{itemSummary(item)}</td>
              <td><div className={styles.actions}>
                <button type="button" className={styles.secondary} aria-label={`Edit ${item.name}`} onClick={() => { setNotice(""); setEditItem(item.id); }}>Edit</button>
                <DeleteAction path={`${base}/items/${item.id}`} name={item.name} description={`Remove ${item.name} and its shop listings? Items owned or equipped by players cannot be removed.`} onSaved={saved} />
              </div></td>
            </tr>) : matchingStock.map((row) => <tr key={`${row.locationId}:${row.itemId}`}>
              <td>{row.itemName}</td><td>{row.locationName}</td><td><Money value={row.price} /></td><td>{row.stock}</td>
              <td><div className={styles.actions}>
                <button type="button" className={styles.secondary} aria-label={`Edit ${row.itemName} at ${row.locationName}`} onClick={() => { setNotice(""); setEditStock(row); }}>Edit</button>
                <DeleteAction path={`${base}/shop/${row.locationId}/${row.itemId}`} name={`${row.itemName} at ${row.locationName}`} description={`Remove ${row.itemName} from the shop in ${row.locationName}?`} onSaved={saved} />
              </div></td>
            </tr>)}</tbody>
          </table></div>
          {(tab === "items" ? matchingItems.length : matchingStock.length) === 0 && <p className={common.muted}>{search || type || location ? "No matching entries." : tab === "items" ? "No items yet. Create an item to get started." : "No shop listings yet. Add an item to a location to start selling it."}</p>}
        </>}
      </Panel>}
  </div>;
}
