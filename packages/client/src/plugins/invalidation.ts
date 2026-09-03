import type { EventMeta } from "@gl3/shared";
import { keys } from "../api/keys.js";

/**
 * The narrow slice of a `plugin.event` this lookup reads. Declared locally
 * rather than importing the union member so the function stays callable from a
 * test with a hand-built literal — the fields below are the whole contract.
 */
type PluginEvent = {
  type: "plugin.event"; pluginId: string; name: string;
};

/**
 * Resolves a plugin event to the query-key prefixes its manifest declares, plus
 * `keys.plugins()` — the manifest payload itself can change as plugins boot, so
 * every plugin event refreshes it, including one whose metadata this client has
 * not seen yet. That unmatched case is exactly when the manifest is most likely
 * stale, so returning nothing there would strand the client on it.
 *
 * The declared entries are bare prefix strings (`"hello"`), wrapped into
 * single-element key tuples so `queryClient.invalidateQueries({ queryKey })`
 * matches any key starting with them.
 */
export function pluginInvalidationKeys(
  event: PluginEvent, metas: readonly EventMeta[],
): readonly (readonly string[])[] {
  const meta = metas.find((m) => m.pluginId === event.pluginId && m.name === event.name);
  const declared = meta?.invalidates.map((prefix) => [prefix] as const) ?? [];
  return [keys.plugins(), ...declared];
}
