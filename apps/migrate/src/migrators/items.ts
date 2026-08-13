import type mysql from "mysql2/promise";
import { items } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface ItemRow { I_id: number; I_name: string; I_type: string; }
interface ItemEffectRow { IE_item: number; IE_effect: string; IE_value: number; }
interface ItemMetaRow { IM_item: number; IM_key: string; IM_value: string | null; }

export async function migrateItems(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
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
    const bucket = effectsByItem.get(row.IE_item) ?? {};
    bucket[row.IE_effect] = row.IE_value;
    effectsByItem.set(row.IE_item, bucket);
    bumpTable(report, "itemEffects", "written");
  }

  const [metaRows] = await pool.query<(ItemMetaRow & mysql.RowDataPacket)[]>(
    "SELECT IM_item, IM_key, IM_value FROM itemMeta",
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
    bucket[row.IM_key] = row.IM_value;
    metaByItem.set(row.IM_item, bucket);
    bumpTable(report, "itemMeta", "written");
  }

  for (const row of itemRows) {
    bumpTable(report, "items", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "items", row.I_id);
    const values = {
      id: v3Id, name: row.I_name, itemType: row.I_type,
      effects: effectsByItem.get(row.I_id) ?? {}, meta: metaByItem.get(row.I_id) ?? {},
    };
    await exec.insert(items).values(values).onConflictDoUpdate({ target: items.id, set: values });
    bumpTable(report, "items", "written");
  }
}
