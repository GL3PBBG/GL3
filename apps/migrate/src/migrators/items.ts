import type mysql from "mysql2/promise";
import { items } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

// V2's I_type is an int id into the `itemTypes` settings registry — a JSON
// array of {id, name, type} rows (class/items.php getType() matches on
// t.id). GL3 keeps the type string on each item row instead, so the registry
// is resolved here per item; the setting itself is not copied across (it is
// in the settings migrator's SKIPPED_KEYS).
interface ItemRow { I_id: number; I_name: string; I_type: number; }
// IE_value is a VARCHAR in V2 — numeric strings like "15". GL3's effects
// jsonb is Record<string, number>, so values are coerced (and reported if
// a real dump holds something non-numeric).
interface ItemEffectRow { IE_item: number; IE_effect: string; IE_value: string; }
interface ItemMetaRow { IM_item: number; IM_meta: string; IM_value: string | null; }
interface ItemTypesSettingRow { S_value: string | null; }

interface V2ItemType { id?: number; name?: string; type?: string }

export async function migrateItems(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [typeSettingRows] = await pool.query<(ItemTypesSettingRow & mysql.RowDataPacket)[]>(
    "SELECT S_value FROM settings WHERE S_desc = 'itemTypes'",
  );
  let registered: V2ItemType[] = [];
  try {
    const parsed = JSON.parse(typeSettingRows[0]?.S_value ?? "[]");
    if (Array.isArray(parsed)) registered = parsed;
  } catch {
    // Malformed registry: leave empty — every item falls back below and is
    // reported, nothing is silently mistyped.
  }
  const typeById = new Map<number, V2ItemType>();
  for (const t of registered) {
    if (typeof t.id === "number") typeById.set(t.id, t);
  }

  const [itemRows] = await pool.query<(ItemRow & mysql.RowDataPacket)[]>("SELECT I_id, I_name, I_type FROM items");
  const knownItemIds = new Set(itemRows.map((r) => r.I_id));

  const [effectRows] = await pool.query<(ItemEffectRow & mysql.RowDataPacket)[]>(
    "SELECT IE_item, IE_effect, IE_value FROM itemEffects",
  );
  const effectsByItem = new Map<number, Record<string, number>>();
  for (const row of effectRows) {
    bumpTable(report, "itemEffects", "read");
    if (!knownItemIds.has(row.IE_item)) {
      recordOrphan(report, "itemEffects", row.IE_item, `item ${row.IE_item} does not exist`);
      bumpTable(report, "itemEffects", "skipped");
      continue;
    }
    const value = Number(row.IE_value);
    if (Number.isNaN(value)) {
      recordOrphan(report, "itemEffects", row.IE_item, `effect ${row.IE_effect} value "${row.IE_value}" is not numeric`);
      bumpTable(report, "itemEffects", "skipped");
      continue;
    }
    const bucket = effectsByItem.get(row.IE_item) ?? {};
    bucket[row.IE_effect] = value;
    effectsByItem.set(row.IE_item, bucket);
    bumpTable(report, "itemEffects", "written");
  }

  const [metaRows] = await pool.query<(ItemMetaRow & mysql.RowDataPacket)[]>(
    "SELECT IM_item, IM_meta, IM_value FROM itemMeta",
  );
  const metaByItem = new Map<number, Record<string, string | null>>();
  for (const row of metaRows) {
    bumpTable(report, "itemMeta", "read");
    if (!knownItemIds.has(row.IM_item)) {
      recordOrphan(report, "itemMeta", row.IM_item, `item ${row.IM_item} does not exist`);
      bumpTable(report, "itemMeta", "skipped");
      continue;
    }
    const bucket = metaByItem.get(row.IM_item) ?? {};
    bucket[row.IM_meta] = row.IM_value;
    metaByItem.set(row.IM_item, bucket);
    bumpTable(report, "itemMeta", "written");
  }

  for (const row of itemRows) {
    bumpTable(report, "items", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "items", row.I_id);
    const registeredType = typeById.get(row.I_type);
    if (!registeredType) {
      // Still migrates under a lossless fallback name, but reported so the
      // operator can fix the registry before a real run.
      recordOrphan(report, "items", row.I_id, `type ${row.I_type} has no itemTypes registry entry`);
    }
    const itemType = registeredType?.type ?? registeredType?.name ?? String(row.I_type);
    const values = {
      id: v3Id, name: row.I_name, itemType,
      effects: effectsByItem.get(row.I_id) ?? {}, meta: metaByItem.get(row.I_id) ?? {},
    };
    await exec.insert(items).values(values).onConflictDoUpdate({ target: items.id, set: values });
    bumpTable(report, "items", "written");
  }
}
