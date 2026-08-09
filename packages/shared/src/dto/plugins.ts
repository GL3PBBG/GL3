import { z } from "zod";

/**
 * DTO schemas for the `GET /api/plugins` response. The shapes mirror what the
 * server serializes (apps/server/src/plugins/manifest-endpoint.ts) and the SDK's
 * `ViewNode` (packages/plugin-sdk/src/pages.ts), but @gl3/shared is the base
 * layer and may not depend on @gl3/plugin-sdk, so the ten-kind schema is
 * recreated here to keep the DTO self-contained.
 *
 * Every node is `.strict()` — a typo'd prop would otherwise be silently
 * dropped by the renderer, the failure mode hardest to spot from a page that
 * renders wrong.
 */
const leafOptions = [
  z.object({ kind: z.literal("text"), value: z.string() }).strict(),
  z.object({ kind: z.literal("money"), value: z.string() }).strict(),
  z.object({ kind: z.literal("error"), value: z.string() }).strict(),
  z.object({ kind: z.literal("link"), label: z.string(), to: z.string() }).strict(),
  z.object({ kind: z.literal("button"), label: z.string(), action: z.string() }).strict(),
  z.object({
    kind: z.literal("cooldownButton"),
    label: z.string(),
    action: z.string(),
    cooldownAction: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("keyValue"),
    rows: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
  }).strict(),
  z.object({
    kind: z.literal("form"),
    action: z.string(),
    submitLabel: z.string(),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        type: z.enum(["text", "number", "money", "password"]),
      }).strict(),
    ),
  }).strict(),
] as const;

/**
 * `panel` and `list` nest, so the schema is recursive and needs the explicit
 * type annotation zod requires for `z.lazy` — inference cannot close the loop
 * on its own. Typed `z.ZodType<unknown>` because the recursive `z.lazy` cannot
 * close its own inference loop; the renderer narrows per-kind at render time.
 */
export const ViewNodeDtoSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    ...leafOptions,
    z.object({
      kind: z.literal("panel"),
      title: z.string(),
      children: z.array(ViewNodeDtoSchema),
    }).strict(),
    z.object({ kind: z.literal("list"), items: z.array(ViewNodeDtoSchema) }).strict(),
  ]),
);

export const MenuItemSchema = z.object({
  pageId: z.string().min(1),
  path: z.string().min(1),
  label: z.string().min(1),
  order: z.number().int(),
}).strict();

export const PagePayloadSchema = z.object({
  pluginId: z.string().min(1),
  id: z.string().min(1),
  path: z.string().min(1),
  view: ViewNodeDtoSchema,
}).strict();

export const EventMetaSchema = z.object({
  pluginId: z.string().min(1),
  name: z.string().min(1),
  describe: z.string().min(1),
  invalidates: z.array(z.string().min(1)),
}).strict();

export const PluginsPayloadSchema = z.object({
  menu: z.array(MenuItemSchema),
  pages: z.array(PagePayloadSchema),
  events: z.array(EventMetaSchema),
}).strict();

export type PluginsPayload = z.infer<typeof PluginsPayloadSchema>;
export type MenuItem = z.infer<typeof MenuItemSchema>;
export type PagePayload = z.infer<typeof PagePayloadSchema>;
export type EventMeta = z.infer<typeof EventMetaSchema>;
