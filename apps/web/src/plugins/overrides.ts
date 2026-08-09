import type { ComponentType } from "react";

/**
 * Maps a plugin page id to a hand-written React component. Every existing core
 * page has (or will have) an override; a page id with no override renders
 * through the generic PageRenderer. A page with neither an override nor a
 * parseable schema renders a "no UI installed" panel.
 *
 * v1 ships this empty: the hello-plugin example and any third-party plugin use
 * the generic renderer. Core pages are not yet plugin pages (that is Stage 3).
 */
export const PAGE_OVERRIDES: ReadonlyMap<string, ComponentType> = new Map();
