import type { ActionCost, DashboardWidget, HudEntry, MenuBadge, MoneyFormat, ProfileViewValue } from "@gl3/shared";
import { filterPoint } from "./filters.js";

/**
 * Core-owned extension points (spec §2) — the six points core itself
 * declares and applies, on top of the ordinary plugin-owned points
 * (`combat.killResolved`, `casino.games`, `membership.benefits`,
 * `properties.leverSet`, `inventory.itemActions`). The five UI seams use the
 * `"collect"` policy (`coreActionCost` alone is `"propagate"` — see below): a throwing subscriber is logged and dropped, and the
 * chain carries on with whatever the previous subscriber produced — a UI
 * seam should degrade, not break the page, when one plugin misbehaves.
 *
 * Subscriber conventions:
 * - **Attribute every contributed entry with `ctx.pluginId`.** `runFilterChain`
 *   hands each subscriber its own plugin's ctx (keyed by the subscription's
 *   *owner*, never the plugin that triggered the chain), so `ctx.pluginId`
 *   inside a `core.*` subscriber is always the subscriber's own id — use it
 *   on every `ProfileExtra`/`DashboardWidget`/`HudEntry`/`ItemAction` you
 *   append, never a hardcoded string.
 * - **`"collect"` drops a throwing subscriber's contribution**, not the whole
 *   chain — write subscribers to be cheap and side-effect-light (reads, not
 *   writes) since a slow or failing one only costs its own entry.
 * - **Links are the action verb.** A `ProfileExtra`/`ItemAction` of kind
 *   `"link"` should read as an imperative ("Hire detective", "Place bounty",
 *   "Repair"), not a noun phrase — it is the thing clicking it does.
 * - **`MenuBadge.path` follows the badge-path convention** documented on
 *   `coreMenuBadges` below: the literal, unencoded nav path, matched by exact
 *   string equality on the client.
 */
export const coreProfileView = filterPoint<ProfileViewValue>("core.profileView", "collect");
export const coreDashboard = filterPoint<DashboardWidget[]>("core.dashboard", "collect");
export const coreHud = filterPoint<HudEntry[]>("core.hud", "collect");
/**
 * `MenuBadge.path` must be the literal, UNENCODED nav path the badge attaches
 * to — a core page's own path (e.g. `"/detectives"`) or `"/plugins/<pageId>"`
 * for a plugin page addressed by its raw page id. The client keys badge
 * lookup by exact string equality against that same convention (`Shell.tsx`),
 * so a subscriber must match the target link's `to`/`action` string verbatim.
 */
export const coreMenuBadges = filterPoint<MenuBadge[]>("core.menuBadges", "collect");
export const coreMoneyFormat = filterPoint<MoneyFormat>("core.moneyFormat", "collect");

/**
 * What an action costs in attribute pools. The acting plugin seeds
 * `{ action, costs: {} }` and applies the chain; subscribers add to `costs`.
 * With nothing subscribed the map stays empty and the action is free, which
 * is the state of every install with no attribute plugin loaded.
 *
 * POLICY IS "propagate", unlike the five UI points above, and the difference
 * is load-bearing. Those five are seams that should degrade rather than break
 * someone's page, so a throwing subscriber is logged and dropped. Dropping a
 * throwing subscriber HERE would mean the action runs FREE — a silently
 * mispriced economy rather than a visible failure. A throw must abort.
 */
export const coreActionCost = filterPoint<ActionCost>("core.actionCost", "propagate");
