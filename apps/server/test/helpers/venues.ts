import { uuidv7 } from "uuidv7";
import type { Db } from "../../src/db/client.js";
import { locations } from "../../src/db/schema/index.js";
import { propertiesPlugin as propertiesTable } from "./plugin-tables.js";

/**
 * Spec 2026-09-21 town-venues §0: a venue EXISTS only where a property row
 * does. Tests that seed towns and then play at the casino (or expect the
 * casino door on the street) seed the blackjack venue here — a state-run
 * row, owner null — instead of relying on the every-town synthesis this
 * cluster removed. Idempotent: the unique index absorbs a second call.
 */
export async function seedVenues(db: Db, locationIds?: string[], types: readonly string[] = ["blackjack"]): Promise<void> {
  const ids = locationIds ?? (await db.select({ id: locations.id }).from(locations)).map((r) => r.id);
  if (ids.length === 0) return;
  await db.insert(propertiesTable)
    .values(ids.flatMap((locationId) => types.map((pluginId) => ({ id: uuidv7(), locationId, pluginId, ownerPlayerId: null, cost: 0n, profit: 0n }))))
    .onConflictDoNothing();
}
