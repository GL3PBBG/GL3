import type { Tx } from "../../economy/ledger.js";
import { notifications } from "../../db/schema/index.js";

export interface InsertNotificationParams {
  id: string;
  playerId: string;
  body: string;
}

/** Must be called inside an existing transaction — never outside `db.transaction(...)`. */
export async function insertNotification(tx: Tx, params: InsertNotificationParams): Promise<void> {
  await tx.insert(notifications).values({ id: params.id, playerId: params.playerId, body: params.body });
}
