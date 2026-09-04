export {
  PluginError, JobAlreadyAppliedError, InsufficientFundsError, InsufficientGangFundsError,
  isPluginError, isJobAlreadyAppliedError, isInsufficientFundsError, isInsufficientGangFundsError,
} from "./errors.js";
export {
  filterPoint,
  on,
  runFilterChain,
  type FilterPoint,
  type FilterFn,
  type FilterSubscription,
  type FilterPolicy,
  type BoundFilterSubscription,
} from "./filters.js";
export {
  coreProfileView,
  coreDashboard,
  coreHud,
  coreMenuBadges,
  coreMoneyFormat,
  coreActionCost,
  coreHospitalStay,
  clampDiscountBp,
  hospitalDiscountFor,
  type HospitalStayQuote,
  type HospitalStayBatch,
} from "./core-points.js";
export type {
  CoreEventInput,
  GangLogEntry,
  JobContext,
  PlayerSnapshot,
  PluginBalanceChange,
  PluginCtx,
  PluginDbTx,
  PluginEventInput,
  PluginGangBalanceChange,
  PluginRng,
  PluginTx,
  RankUpResult,
} from "./ctx.js";
export { newId } from "./id.js";
export {
  PageSchemaSchema,
  ViewNodeSchema,
  MenuEntrySchema,
  type PageSchema,
  type ViewNode,
  type MenuEntry,
} from "./pages.js";
export { renderDescribe, PluginEventDeclSchema, type PluginEventDecl } from "./events.js";
export {
  definePlugin,
  parsePluginManifest,
  PLUGIN_ID_PATTERN,
  SEMVER_PATTERN,
  PLUGIN_API_VERSION,
  type PluginManifest,
  type PluginManifestInput,
  type PluginMigration,
  type ExpApplier,
  type PropertyTypeDecl,
  type AssetSlotDecl,
  type AssetSlot,
  SINGLETON_ENTITY_ID,
} from "./manifest.js";
export { route, type PluginRoute, type RouteDef, type RouteResult } from "./route.js";
export { hasPermission } from "./authz.js";
export {
  settlePool,
  type Pool,
  type TrainedAttr,
  type ActionCost,
  type AttributePoolDecl,
  type PlayerAttributes,
  type PoolSettlement,
} from "./attributes.js";
// The progression model `ctx.progression` reports; re-exported so a plugin
// branching on it need not depend on @gl3/shared itself.
export type { ProgressionModel } from "@gl3/shared";
