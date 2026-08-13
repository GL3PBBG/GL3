import type mysql from "mysql2/promise";
import { garage, playerItems } from "../../../server/src/db/schema/index.js";
import { getOrCreateV3Id, lookupV3Id } from "../id-map.js";
import { bumpTable, recordOrphan, type MigrationReport } from "../report.js";
import type { Executor } from "../pg/types.js";

interface InventoryRow { UI_user: number; UI_item: number; UI_qty: number; }
interface GarageRow { GA_id: number; GA_user: number; GA_car: number; GA_damage: number; GA_location: number | null; }

export async function migrateInventory(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
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

  const [garageRows] = await pool.query<(GarageRow & mysql.RowDataPacket)[]>(
    "SELECT GA_id, GA_user, GA_car, GA_damage, GA_location FROM garage",
  );
  for (const row of garageRows) {
    bumpTable(report, "garage", "read");
    const playerId = await lookupV3Id(exec, "users", row.GA_user);
    if (!playerId) {
      recordOrphan(report, "garage", row.GA_user, `user ${row.GA_user} does not exist`);
      bumpTable(report, "garage", "skipped");
      continue;
    }
    const carId = await lookupV3Id(exec, "cars", row.GA_car);
    if (!carId) {
      recordOrphan(report, "garage", row.GA_user, `car ${row.GA_car} does not exist`);
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
