import type { DashboardWidget, HudEntry, MenuBadge, MoneyFormat, ProfileViewValue } from "@gl3/shared";
import { filterPoint } from "./filters.js";

/** Core-owned UI seams (spec §2). Subscribers attribute entries with ctx.pluginId. */
export const coreProfileView = filterPoint<ProfileViewValue>("core.profileView", "collect");
export const coreDashboard = filterPoint<DashboardWidget[]>("core.dashboard", "collect");
export const coreHud = filterPoint<HudEntry[]>("core.hud", "collect");
export const coreMenuBadges = filterPoint<MenuBadge[]>("core.menuBadges", "collect");
export const coreMoneyFormat = filterPoint<MoneyFormat>("core.moneyFormat", "collect");
