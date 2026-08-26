import type mysql from "mysql2/promise";
import { items } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordAbsentTargetTable, recordOrphan, type MigrationReport } from "../report.js";
import { shopStock, targetHas } from "../pg/plugin-tables.js";
import type { Executor } from "../pg/types.js";

/**
 * MCCodes `items`/`itemtypes`/`shops`/`shopitems` -> GL3 `items` +
 * `p_inventory_shop_stock` (B3 Task 10, spec §4 phase 2).
 *
 * Every MCCodes weapon is melee-model: flat `weapon` attack power, no
 * accuracy data — imported as the melee marker `{power}` (C6/B0 §2.1).
 * `armor` imports as `{armor}`. The generic effect engine's PHP-serialized
 * `{inc_type, stat, dir, inc_amount}` imports verbatim into the jsonb for a
 * future inventory effect def to consume (ConsumableEffectsSchema is
 * passthrough, so the row parses today). Prices live on the shop listing
 * and in meta; GL3's items table carries none.
 *
 * Shops: MCCodes has no stock model (infinite), but p_inventory_shop_stock
 * requires an integer — a near-exhaustible sentinel preserves behavior for
 * any realistic game's life, documented divergence (spec §4), and the admin
 * restock surface exists.
 */

/** PHP serialize() for the one shape MCCodes item effects use: a flat
 *  assoc array of strings and ints. Anything else reports and drops. */
function unserializePhpAssoc(text: string): Record<string, string | number> | null {
  let pos = 0;
  const read = (pattern: RegExp): RegExpExecArray | null => {
    const match = pattern.exec(text.slice(pos));
    if (match === null) return null;
    pos += match[0].length;
    return match;
  };
  if (read(/^a:\d+:\{/) === null) return null;
  const out: Record<string, string | number> = {};
  while (pos < text.length) {
    if (text[pos] === "}") break; // end of array
    const keyMatch = read(/^s:(\d+):"([^"]*)";/);
    if (keyMatch === null) return null;
    const key = keyMatch[2]!;
    const strValue = read(/^s:(\d+):"([^"]*)";/);
    if (strValue !== null) {
      out[key] = strValue[2]!;
      continue;
    }
    const intValue = read(/^i:(-?\d+);/);
    if (intValue !== null) {
      out[key] = Number(intValue[1]);
      continue;
    }
    return null; // nested arrays/bools/null — not this engine's shape
  }
  return pos === text.length - 1 && text[pos] === "}" ? out : null;
}

interface ItemRow {
  itmid: number; itmtype: number; itmname: string; itmdesc: string;
  itmbuyprice: number; itmsellprice: number;
  effect1_on: number; effect1: string; weapon: number; armor: number;
}
interface ItemTypeRow { itmtypeid: number; itmtypename: string; }
interface ShopRow { shopID: number; shopLOCATION: number; }
interface ShopItemRow { sitemID: number; sitemSHOP: number; sitemITEMID: number; }

/** MCCodes' infinite stock, expressed for an integer NOT NULL column. */
const STOCK_SENTINEL = 2_000_000_000;

/** GL3's itemType vocabulary (lowercase) — matched case-insensitively so
 *  stock "Weapon"/"Armor" names land on the right equip gates. */
const KNOWN_TYPES = new Set(["weapon", "armor", "consumable"]);

export async function migrateMcItems(
  pool: mysql.Pool, exec: Executor, report: MigrationReport,
  targetTables?: ReadonlySet<string>,
): Promise<void> {
  const [typeRows] = await pool.query<(ItemTypeRow & mysql.RowDataPacket)[]>(
    "SELECT itmtypeid, itmtypename FROM itemtypes",
  );
  const typeNameById = new Map(typeRows.map((r) => [r.itmtypeid, r.itmtypename]));

  const [itemRows] = await pool.query<(ItemRow & mysql.RowDataPacket)[]>(
    "SELECT itmid, itmtype, itmname, itmdesc, itmbuyprice, itmsellprice, " +
    "effect1_on, effect1, weapon, armor FROM items",
  );

  for (const row of itemRows) {
    bumpTable(report, "items", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "items", row.itmid);

    const rawType = typeNameById.get(row.itmtype) ?? String(row.itmtype);
    const itemType = rawType.toLowerCase();
    if (!KNOWN_TYPES.has(itemType)) {
      recordOrphan(report, "items", row.itmid, `item type "${rawType}" has no GL3 equivalent; imported verbatim`);
    }

    // The model marker: `weapon` is melee, `armor` is armor, effect1 is the
    // generic engine. Precedence mirrors combat's loadWeapon (melee first).
    let effects: Record<string, unknown> = {};
    if (row.weapon > 0) {
      effects = { power: row.weapon };
    } else if (row.armor > 0) {
      effects = { armor: row.armor };
    } else if (row.effect1_on === 1 && row.effect1 !== "") {
      const parsed = unserializePhpAssoc(row.effect1);
      if (parsed === null) {
        recordOrphan(report, "items", row.itmid, `effect1 does not unserialize: ${row.effect1.slice(0, 80)}`);
      } else {
        effects = parsed;
      }
    }

    const values = {
      id: v3Id,
      name: row.itmname,
      itemType,
      effects,
      meta: {
        description: row.itmdesc,
        buyPrice: row.itmbuyprice,
        sellPrice: row.itmsellprice,
      },
    };
    await exec.insert(items).values(values).onConflictDoUpdate({ target: items.id, set: values });
    bumpTable(report, "items", "written");
  }

  // --- shops -> p_inventory_shop_stock --------------------------------------
  if (!targetHas(targetTables, "p_inventory_shop_stock")) {
    recordAbsentTargetTable(report, "p_inventory_shop_stock");
    return;
  }
  const [shopRows] = await pool.query<(ShopRow & mysql.RowDataPacket)[]>(
    "SELECT shopID, shopLOCATION FROM shops",
  );
  const shopById = new Map(shopRows.map((r) => [r.shopID, r]));
  const [shopItemRows] = await pool.query<(ShopItemRow & mysql.RowDataPacket)[]>(
    "SELECT sitemID, sitemSHOP, sitemITEMID FROM shopitems",
  );
  const priceByItem = new Map(itemRows.map((r) => [r.itmid, r.itmbuyprice]));

  for (const row of shopItemRows) {
    bumpTable(report, "shopitems", "read");
    const shop = shopById.get(row.sitemSHOP);
    const locationId = shop ? await lookupV3Id(exec, "cities", shop.shopLOCATION) : null;
    const itemId = await lookupV3Id(exec, "items", row.sitemITEMID);
    if (locationId === null || itemId === null) {
      recordOrphan(report, "shopitems", row.sitemID,
        `shop ${row.sitemSHOP} or item ${row.sitemITEMID} was not migrated`);
      bumpTable(report, "shopitems", "skipped");
      continue;
    }
    const price = BigInt(priceByItem.get(row.sitemITEMID) ?? 0);
    await exec.insert(shopStock).values({ locationId, itemId, price, stock: STOCK_SENTINEL })
      .onConflictDoUpdate({
        target: [shopStock.locationId, shopStock.itemId],
        set: { price, stock: STOCK_SENTINEL },
      });
    bumpTable(report, "shopitems", "written");
  }
}
