import type mysql from "mysql2/promise";
import { playerItems } from "../../../server/src/db/schema/index.js";
import { lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

/**
 * MCCodes `inventory` -> GL3 `player_items` (B4 Task 14, spec §4 phase 5).
 * Item via id_map, qty verbatim — the V2 inventory-migrator shape. Orphan
 * user or item references skip with a report entry (no source FKs, the V2
 * tolerance).
 */
interface InventoryRow { inv_id: number; inv_itemid: number; inv_userid: number; inv_qty: number; }

export async function migrateMcInventory(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(InventoryRow & mysql.RowDataPacket)[]>(
    "SELECT inv_id, inv_itemid, inv_userid, inv_qty FROM inventory",
  );
  for (const row of rows) {
    bumpTable(report, "inventory", "read");
    const playerId = await lookupV3Id(exec, "users", row.inv_userid);
    if (playerId === null) {
      recordOrphan(report, "inventory", row.inv_id, `user ${row.inv_userid} does not exist`);
      bumpTable(report, "inventory", "skipped");
      continue;
    }
    const itemId = await lookupV3Id(exec, "items", row.inv_itemid);
    if (itemId === null) {
      recordOrphan(report, "inventory", row.inv_id, `item ${row.inv_itemid} does not exist`);
      bumpTable(report, "inventory", "skipped");
      continue;
    }
    await exec.insert(playerItems).values({ playerId, itemId, qty: row.inv_qty })
      .onConflictDoUpdate({ target: [playerItems.playerId, playerItems.itemId], set: { qty: row.inv_qty } });
    bumpTable(report, "inventory", "written");
  }
}
