/**
 * The per-plugin handle a plugin receives for every route, job and filter it
 * runs. A stub for now: Task 8 fills in the transaction, economy, cooldown,
 * settings and log surfaces. It exists this early because `FilterFn` takes one.
 */
export interface PluginCtx {
  readonly pluginId: string;
}
