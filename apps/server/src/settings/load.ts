import type { Db } from "../db/client.js";
import { settings } from "../db/schema/index.js";

/**
 * Read once at boot into a plain record: `PluginCtx.settings.get` is
 * synchronous, so the values must already be in memory by the time a route
 * runs. Changing a setting therefore needs a restart, which matches V2 —
 * `settings` is admin-edited configuration, not live game state.
 *
 * Before this existed, every `PluginCtxDeps.settings` site passed `{}` and
 * `ctx.settings.get()` answered null for every key in the game.
 */
export async function loadSettings(db: Db): Promise<Record<string, string>> {
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
