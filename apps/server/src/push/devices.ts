import { and, eq, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../db/client.js";
import { pushDevices } from "../db/schema/index.js";

export interface PushDevice { id: string; expoToken: string }

/**
 * Idempotent on the token — one statement, no check-then-act. Re-registering
 * the same token by the same player is a no-op refresh; re-registering it as
 * a different player transfers the handset and clears any `disabled_at`.
 */
export async function registerDevice(
  db: Db, playerId: string, expoToken: string, platform: "android" | "ios",
): Promise<void> {
  await db.insert(pushDevices)
    .values({ id: uuidv7(), playerId, expoToken, platform })
    .onConflictDoUpdate({
      target: pushDevices.expoToken,
      set: { playerId, platform, lastSeenAt: sql`now()`, disabledAt: null },
    });
}

/**
 * The `player_id` predicate is what stops one player unregistering another's
 * device. Deleting nothing is not an error: sign-out must not fail because
 * the row was already gone.
 */
export async function unregisterDevice(db: Db, playerId: string, expoToken: string): Promise<void> {
  await db.delete(pushDevices)
    .where(and(eq(pushDevices.playerId, playerId), eq(pushDevices.expoToken, expoToken)));
}

/** The subscriber's only query, once per pushed event — hence push_devices_player_idx. */
export async function enabledDevicesForPlayer(db: Db, playerId: string): Promise<PushDevice[]> {
  return db.select({ id: pushDevices.id, expoToken: pushDevices.expoToken })
    .from(pushDevices)
    .where(and(eq(pushDevices.playerId, playerId), isNull(pushDevices.disabledAt)));
}

/**
 * Soft delete on an Expo `DeviceNotRegistered` ticket. The row survives so a
 * reinstall's re-registration upsert has something to clear.
 */
export async function disableDevice(db: Db, expoToken: string): Promise<void> {
  await db.update(pushDevices)
    .set({ disabledAt: sql`now()` })
    .where(eq(pushDevices.expoToken, expoToken));
}
