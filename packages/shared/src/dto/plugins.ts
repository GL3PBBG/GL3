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
/**
 * `link.to` reaches the renderer as an `href` and `*.action` reaches it as a
 * `fetch` target, so both are sinks and neither may be a free string. A leading
 * `/` followed by neither `/` nor `\` rejects `javascript:`, `data:`, absolute
 * `http(s)://` and protocol-relative `//evil.example` — the same posture
 * `avatarUrl` already takes, and the same one `PageSchemaSchema.path` takes in
 * the SDK. Exported because `@gl3/plugin-sdk` applies them to the authoring
 * schema too: a bad view should fail at boot, not at the browser.
 *
 * The backslash is not decoration. WHATWG treats `\` as `/` in the
 * relative-slash state for special schemes, so `/\evil.example` is another
 * spelling of `//evil.example` and resolves cross-origin; it is barred in the
 * first position and in the body, since a later `\` reaches the same state
 * through a segment that only looks relative.
 */
export const INTERNAL_PATH_RE = /^\/(?![/\\])[^\s\\]*$/;
export const VIEW_ACTION_RE = /^(GET|POST|PUT|PATCH|DELETE) \/(?![/\\])[^\s\\]*$/;

/**
 * `cooldownAction` is not an HTTP action — it is the middle segment of
 * `cooldown:<action>:<playerId>` (`apps/server/src/game/cooldown.ts`), so it is
 * a Redis key sink. Barring `:` is the point: without it a view could name a
 * key belonging to a different action or player.
 */
export const COOLDOWN_ACTION_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * `panel` and `list` nest without limit, and the schema that parses them is
 * recursive — so the bound has to be checked *before* the recursive parse runs,
 * or a deep payload overflows the stack inside `z.lazy` rather than failing
 * validation. `checkViewBounds` walks the raw value breadth-first with an
 * explicit queue (no recursion of its own) and is piped ahead of the node
 * schema; a dirty refinement aborts a `ZodPipeline` before its second stage.
 */
export const MAX_VIEW_DEPTH = 16;
export const MAX_VIEW_NODES = 512;

function childrenOf(node: unknown): readonly unknown[] {
  if (typeof node !== "object" || node === null) return [];
  if ("children" in node && Array.isArray(node.children)) return node.children;
  if ("items" in node && Array.isArray(node.items)) return node.items;
  return [];
}

export function checkViewBounds(value: unknown, ctx: z.RefinementCtx): void {
  let level: readonly unknown[] = [value];
  let seen = 0;
  for (let depth = 1; level.length > 0; depth += 1) {
    if (depth > MAX_VIEW_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `view nests deeper than ${MAX_VIEW_DEPTH} levels`,
      });
      return;
    }
    const next: unknown[] = [];
    for (const node of level) {
      seen += 1;
      if (seen > MAX_VIEW_NODES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `view has more than ${MAX_VIEW_NODES} nodes`,
        });
        return;
      }
      // One at a time, not `push(...children)`: the spread passes every child
      // as an argument and blows V8's argument limit at ~124k, throwing a
      // RangeError long before the node bound is consulted — the crash this
      // function exists to turn into a validation error.
      for (const child of childrenOf(node)) next.push(child);
    }
    level = next;
  }
}

const leafOptions = [
  z.object({ kind: z.literal("text"), value: z.string() }).strict(),
  z.object({ kind: z.literal("money"), value: z.string() }).strict(),
  z.object({ kind: z.literal("error"), value: z.string() }).strict(),
  z.object({
    kind: z.literal("link"),
    label: z.string(),
    to: z.string().regex(INTERNAL_PATH_RE, "link.to must be an app-internal absolute path"),
  }).strict(),
  z.object({
    kind: z.literal("button"),
    label: z.string(),
    action: z.string().regex(VIEW_ACTION_RE, "action must be `METHOD /absolute/path`"),
  }).strict(),
  z.object({
    kind: z.literal("cooldownButton"),
    label: z.string(),
    action: z.string().regex(VIEW_ACTION_RE, "action must be `METHOD /absolute/path`"),
    cooldownAction: z
      .string()
      .regex(COOLDOWN_ACTION_RE, "cooldownAction must be a bare cooldown key segment"),
  }).strict(),
  z.object({
    kind: z.literal("keyValue"),
    rows: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
  }).strict(),
  z.object({
    kind: z.literal("form"),
    action: z.string().regex(VIEW_ACTION_RE, "action must be `METHOD /absolute/path`"),
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

/**
 * What a page's `view` is parsed with: the size bound first, the recursive node
 * schema second. Parse `ViewNodeDtoSchema` directly only for a node already
 * known to be bounded.
 */
export const BoundedViewNodeDtoSchema: z.ZodType<unknown, z.ZodTypeDef, unknown> = z
  .unknown()
  .superRefine(checkViewBounds)
  .pipe(ViewNodeDtoSchema);

export const MenuItemSchema = z.object({
  pageId: z.string().min(1),
  // The same value as the page's own `path` (manifest-endpoint.ts copies it)
  // and the same sink — the nav renders it as an `href`, so it carries the
  // same rule rather than relying on the page copy to fail first.
  path: z.string().regex(INTERNAL_PATH_RE, "menu path must be an app-internal absolute path"),
  label: z.string().min(1),
  order: z.number().int(),
}).strict();

export const PagePayloadSchema = z.object({
  pluginId: z.string().min(1),
  id: z.string().min(1),
  path: z.string().regex(INTERNAL_PATH_RE, "page path must be an app-internal absolute path"),
  view: BoundedViewNodeDtoSchema,
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
