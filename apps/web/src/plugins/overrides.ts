import type { ComponentType } from "react";
import { AdminEconomy } from "../pages/AdminEconomy.js";

/**
 * Maps a page id to a hand-written React component. Every existing core page
 * has (or will have) an override; a page id with no override renders through
 * the generic PageRenderer. A page with neither an override nor a parseable
 * schema renders a "no UI installed" panel.
 *
 * v1 shipped this empty: the hello-plugin example and any third-party plugin
 * use the generic renderer. The first entry is the admin economy dashboard —
 * total tiles and charts are not static-vocabulary kinds, which is exactly
 * the "a core page that needs more than this gets a bespoke React override"
 * case the SDK's view-vocabulary comment names. Its page payload
 * (economy-page.ts) still declares id/path/grant; only the rendering is
 * bespoke, and both PluginPage and the Admin sections list consult this map.
 */
export const PAGE_OVERRIDES: ReadonlyMap<string, ComponentType> = new Map([
  ["core-economy-admin", AdminEconomy],
]);
