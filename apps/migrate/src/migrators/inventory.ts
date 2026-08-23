import type mysql from "mysql2/promise";
import { playerItems } from "../../../server/src/db/schema/index.js";
import { garage, targetHas } from "../pg/plugin-tables.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordAbsentTargetTable, recordMissingSourceTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface InventoryRow { UI_user: number; UI_item: number; UI_qty: number; }
interface GarageRow { GA_id: number; GA_uid: number; GA_car: number; GA_damage: number; GA_location: number; }

export async function migrateInventory(
  pool: mysql.Pool, exec: Executor, report: MigrationReport,
  targetTables?: ReadonlySet<string>,
): Promise<void> {
  const [invRows] = await pool.query<(InventoryRow & mysql.RowDataPacket)[]>(
    "SELECT UI_user, UI_item, UI_qty FROM userInventory",
  );
  for (const row of invRows) {
    bumpTable(report, "userInventory", "read");
    const playerId = await lookupV3Id(exec, "users", row.UI_user);
    if (!playerId) {
      recordOrphan(report, "userInventory", row.UI_user, `user ${row.UI_user} does not exist`);
      bumpTable(report, "userInventory", "skipped");
      continue;
    }
    const itemId = await lookupV3Id(exec, "items", row.UI_item);
    if (!itemId) {
      recordOrphan(report, "userInventory", row.UI_user, `item ${row.UI_item} does not exist`);
      bumpTable(report, "userInventory", "skipped");
      continue;
    }
    await exec.insert(playerItems).values({ playerId, itemId, qty: row.UI_qty })
      .onConflictDoUpdate({ target: [playerItems.playerId, playerItems.itemId], set: { qty: row.UI_qty } });
    bumpTable(report, "userInventory", "written");
  }

  // The garage half migrates only when BOTH sides have it: a framework-shaped
  // source (openPBBG) has no garage table — the inventory half above still
  // ran — and a framework-profile target has no p_theft_garage.
  const [garageTableRows] = await pool.query<({ n: number } & mysql.RowDataPacket)[]>(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'garage'",
  );
  if (garageTableRows[0]!.n === 0) {
    recordMissingSourceTable(report, "garage");
    return;
  }
  if (!targetHas(targetTables, "p_theft_garage")) {
    recordAbsentTargetTable(report, "p_theft_garage");
    return;
  }
  const [garageRows] = await pool.query<(GarageRow & mysql.RowDataPacket)[]>(
    "SELECT GA_id, GA_uid, GA_car, GA_damage, GA_location FROM garage",
  );
  for (const row of garageRows) {
    bumpTable(report, "garage", "read");
    const playerId = await lookupV3Id(exec, "users", row.GA_uid);
    if (!playerId) {
      recordOrphan(report, "garage", row.GA_uid, `user ${row.GA_uid} does not exist`);
      bumpTable(report, "garage", "skipped");
      continue;
    }
    const carId = await lookupV3Id(exec, "cars", row.GA_car);
    if (!carId) {
      recordOrphan(report, "garage", row.GA_uid, `car ${row.GA_car} does not exist`);
      bumpTable(report, "garage", "skipped");
      continue;
    }
    const locationId = row.GA_location ? await lookupV3Id(exec, "locations", row.GA_location) : null;
    const { v3Id } = await getOrCreateV3Id(exec, "garage", row.GA_id);
    const values = { id: v3Id, playerId, carId, damage: row.GA_damage, locationId };
    await exec.insert(garage).values(values).onConflictDoUpdate({ target: garage.id, set: values });
    bumpTable(report, "garage", "written");
  }
}
