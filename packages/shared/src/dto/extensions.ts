import { z } from "zod";
import { TimestampSchema } from "../primitives.js";
import { ViewNodeDtoSchema } from "./plugins.js";

/**
 * Typed fragments a plugin contributes into core-owned UI surfaces (the
 * profile page, the HUD, the nav badges, the dashboard, an item's action
 * list) via the extension filter points. Every leaf is `.strict()` for the
 * same reason the view-node vocabulary in `dto/plugins.ts` is: a typo'd or
 * extra property should fail the parse, not render silently wrong.
 */
export const ProfileExtraSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stat"), pluginId: z.string().min(1), label: z.string().min(1), value: z.string() }).strict(),
  z.object({ kind: z.literal("link"), pluginId: z.string().min(1), label: z.string().min(1), to: z.string().min(1) }).strict(),
]);
export type ProfileExtra = z.infer<typeof ProfileExtraSchema>;

export const DashboardWidgetSchema = z.object({
  pluginId: z.string().min(1), title: z.string().min(1), view: ViewNodeDtoSchema,
}).strict();
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;

export const HudEntrySchema = z.object({
  pluginId: z.string().min(1), label: z.string().min(1), value: z.string(),
  countdownTo: TimestampSchema.optional(),
}).strict();
export type HudEntry = z.infer<typeof HudEntrySchema>;

export const MenuBadgeSchema = z.object({
  path: z.string().startsWith("/"), count: z.number().int().nonnegative(),
}).strict();
export type MenuBadge = z.infer<typeof MenuBadgeSchema>;

export const ItemActionSchema = z.object({
  pluginId: z.string().min(1), label: z.string().min(1), to: z.string().min(1),
}).strict();
export type ItemAction = z.infer<typeof ItemActionSchema>;

export const ProfileViewValueSchema = z.object({
  targetId: z.string().uuid(), extras: z.array(ProfileExtraSchema),
}).strict();
export type ProfileViewValue = z.infer<typeof ProfileViewValueSchema>;

export const HudExtrasResponseSchema = z.object({ entries: z.array(HudEntrySchema) }).strict();
export const MenuBadgesResponseSchema = z.object({ badges: z.array(MenuBadgeSchema) }).strict();
export const DashboardWidgetsResponseSchema = z.object({ widgets: z.array(DashboardWidgetSchema) }).strict();
