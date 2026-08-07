import { uuidv7 } from "uuidv7";
import type { Tx } from "../../economy/ledger.js";
import { gangLogs } from "../../db/schema/index.js";

/** Append-only audit trail (spec §1.2 gangLogs). Must be called inside an existing transaction. */
export async function appendGangLog(tx: Tx, gangId: string, playerId: string | null, message: string): Promise<void> {
  await tx.insert(gangLogs).values({ id: uuidv7(), gangId, playerId, message });
}
