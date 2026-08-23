import type { ComponentType } from "react";
import { AdminEconomy } from "../pages/AdminEconomy.js";
import { Bounties } from "../pages/Bounties.js";
import { Bullets } from "../pages/Bullets.js";
import { Casino } from "../pages/Casino.js";
import { Combat } from "../pages/Combat.js";
import { Crimes } from "../pages/Crimes.js";
import { Detectives } from "../pages/Detectives.js";
import { Gang } from "../pages/Gang.js";
import { Hospital } from "../pages/Hospital.js";
import { Jail } from "../pages/Jail.js";
import { OrganizedCrime } from "../pages/OrganizedCrime.js";
import { Travel } from "../pages/Travel.js";

/**
 * Maps a page id to a hand-written React component. Every existing core page
 * has (or will have) an override; a page id with no override renders through
 * the generic PageRenderer. A page with neither an override nor a parseable
 * schema renders a "no UI installed" panel.
 *
 * The gameplay pages below are plugin-DECLARED (their manifests carry the
 * page + menu entry; jail/hospital ride the payload as synthetic core pages
 * under the full profile) but plugin-RENDERED here: their bespoke React
 * components are unchanged, they simply exist exactly when the server says
 * the page does. A framework boot sends no such page ids, so neither the
 * route nor the nav entry appears.
 */
export const PAGE_OVERRIDES: ReadonlyMap<string, ComponentType> = new Map([
  ["core-economy-admin", AdminEconomy],
  ["crimes.index", Crimes],
  ["combat.index", Combat],
  ["bounties.index", Bounties],
  ["detectives.index", Detectives],
  ["oc.index", OrganizedCrime],
  ["casino.index", Casino],
  ["gangs.index", Gang],
  ["bullets.index", Bullets],
  ["travel.index", Travel],
  ["jail", Jail],
  ["hospital", Hospital],
]);
