import { z } from "zod";
import { MoneySchema } from "../primitives.js";

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

/** Shared by `table.source` and select `optionsSource`: a GET against an app-internal absolute path. */
const GET_SOURCE_RE = /^GET \/(?![/\\])[^\s\\]*$/;

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

// Every array-of-objects field the twelve-kind vocabulary has: `panel.children`
// and `list.items` nest actual view nodes; `keyValue.rows` and `form.fields`
// nest plain leaf objects, not `ViewNode`s, but each one is still a parsed
// object the bound exists to cap — a form is not exempt from MAX_VIEW_NODES
// just because its fields aren't independently renderable. `text`, `money`,
// `error`, `link`, `button` and `cooldownButton` carry no array field and are
// correctly left out. `cards` is left out deliberately rather than by omission:
// its array holds card CODES, not parsed objects, so counting them would spend
// the node budget on strings the recursion never descends into.
function childrenOf(node: unknown): readonly unknown[] {
  if (typeof node !== "object" || node === null) return [];
  if ("children" in node && Array.isArray(node.children)) return node.children;
  if ("items" in node && Array.isArray(node.items)) return node.items;
  if ("rows" in node && Array.isArray(node.rows)) return node.rows;
  if ("fields" in node && Array.isArray(node.fields)) return node.fields;
  if ("columns" in node && Array.isArray(node.columns)) return node.columns;
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
  // MoneySchema, not z.string(): the renderer hands this to `formatAmount`,
  // which throws on anything outside `/^-?\d+$/`, and the client has no
  // ErrorBoundary — so a decimal string here unmounts the React root and blanks
  // the app mid-render. It is also the money-on-the-wire invariant every other
  // monetary field already carries. Kept identical to the SDK's `money` leaf:
  // the two diverging is how a value passes boot and then fails the browser.
  z.object({ kind: z.literal("money"), value: MoneySchema }).strict(),
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
    // Three strict branches, kept identical to the SDK's copy: select carries
    // its options wiring, hidden carries its constant, the basic branch
    // carries neither — so a branch-only property cannot ride on a text field
    // and silently vanish in the renderer.
    fields: z.array(
      z.union([
        z.object({
          name: z.string(),
          label: z.string(),
          type: z.literal("select"),
          // Same rule and same reason as `table.source`: options render on
          // mount, so the fetch must never mutate.
          optionsSource: z.string().regex(GET_SOURCE_RE, "optionsSource must be `GET /absolute/path`"),
          valueKey: z.string(),
          labelKey: z.string(),
          allowEmpty: z.boolean().optional(),
        }).strict(),
        z.object({
          name: z.string(),
          // No `label`: the field draws nothing. It submits a constant the
          // route requires.
          type: z.literal("hidden"),
          value: z.string(),
        }).strict(),
        z.object({
          name: z.string(),
          label: z.string(),
          type: z.enum(["text", "number", "decimal", "money", "password"]),
        }).strict(),
      ]),
    ),
  }).strict(),
  z
    .object({
      kind: z.literal("table"),
      /**
       * GET-only: a table renders data, it must never mutate on mount. The
       * loader's containment pass treats this as a view action, so it must
       * live under the plugin's basePaths like any button/form action.
       */
      source: z.string().regex(GET_SOURCE_RE, "table source must be `GET /absolute/path`"),
      columns: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          /** Absent renders text; `image` treats the cell value as a URL. */
          render: z.literal("image").optional(),
          /** Thumbnail size for `render: "image"`. Defaults to `sm`. */
          imageSize: z.enum(["sm", "md", "lg"]).optional(),
        }).strict(),
      ).min(1),
      /**
       * Per-row mutations. Kept identical to the SDK's copy — the parity the
       * `cards` leaf below records the hard way. Every `:token` in the action
       * path is replaced by the renderer with the row's field of that name;
       * `confirm` makes the button a two-step arm-then-fire in place.
       */
      rowActions: z.array(
        z.object({
          label: z.string().min(1),
          action: z.string().regex(VIEW_ACTION_RE, "action must be `METHOD /absolute/path`"),
          confirm: z.string().min(1).optional(),
        }).strict(),
      ).optional(),
    })
    .strict(),
  // Game art, and the admin widget that binds it. Kept identical to the SDK's
  // copy for the reason the `cards` leaf below records the hard way: a leaf in
  // one file and not the other passes boot and then fails the browser, taking
  // the WHOLE plugin payload down with it.
  z
    .object({
      kind: z.literal("image"),
      url: z.string().min(1),
      alt: z.string().min(1),
      size: z.enum(["sm", "md", "lg"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("slotImage"),
      slot: z.string().min(1),
      alt: z.string().min(1),
      size: z.enum(["sm", "md", "lg"]).optional(),
      /** Loader-stamped, like `assetBinder.scope` below. */
      scope: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("assetBinder"),
      slot: z.string().min(1),
      /** Both absent for a singleton slot: one image, nothing to pick. */
      entitySource: z.string().regex(GET_SOURCE_RE, "entitySource must be `GET /absolute/path`").optional(),
      entityLabelKey: z.string().min(1).optional(),
      /**
       * Filled in by the loader from the declaring plugin's id before the node
       * reaches the wire — which is why it is required HERE and absent from the
       * SDK's authoring schema. A plugin cannot bind another plugin's art
       * because it never writes this field.
       */
      scope: z.string().min(1),
    })
    .strict(),
  // A hand of playing cards. Values are @letele/playing-cards component names:
  // suit initial (H/D/C/S) + rank (a, 2-10, j, q, k), plus J1/J2 jokers and
  // B1/B2 backs. Kept identical to the SDK's copy for the reason the `money`
  // leaf above gives — the two diverging is how a value passes boot and then
  // fails the browser, which is exactly what happened here: the leaf shipped in
  // the SDK and not in this file, so any wire payload carrying a `cards` node
  // (a manifest-declared page, or the casino lobby's resume view) failed the
  // client-side parse of the WHOLE payload with an invalid-discriminator issue.
  z
    .object({
      kind: z.literal("cards"),
      cards: z.array(z.string().regex(/^([HDCS](a|[2-9]|10|j|q|k)|J[12]|B[12])$/, "card must be a playing-card code")),
      // How big to draw the hand. Absent is `md`, the size every hand drawn
      // before this field existed was. A multiplayer table needs the other
      // sizes: its own hand wants to be read at a glance (`lg`) and four
      // opponents' hands have to sit side by side in one content column
      // (`sm`).
      size: z.enum(["sm", "md", "lg"]).optional(),
      // A line under the hand saying whose it is — the only way to tell four
      // hands in a row apart, since a `cards` node carries no title of its own
      // and a panel per hand would stack them vertically again.
      caption: z.string().min(1).optional(),
    })
    .strict(),
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
      // How the panel's own children are laid out. Absent stacks them, which
      // is what every panel authored before this field did. `row` lays them
      // out horizontally and wraps — for a run of LEAF children only, since
      // the renderer flattens a nested panel to a sibling one and a nested
      // panel inside a row would break out of it (see PageRenderer's
      // `PanelGroup` comment).
      layout: z.literal("row").optional(),
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
  /**
   * Feed suppression, the SDK's `PluginEventDecl.silent` carried through the
   * manifest endpoint. Optional and omitted when absent, so every payload
   * built before the flag existed parses unchanged — which matters more here
   * than in the SDK, since `PluginsPayloadSchema.parse` is all-or-nothing and
   * one unparsable meta takes the WHOLE plugin payload down in the browser.
   *
   * `describe` is required either way: silence is a rendering decision the
   * client makes, and a client too old to make it renders the line.
   */
  silent: z.boolean().optional(),
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

/** What a `table.source` endpoint returns: pre-stringified rows, column keys as props. */
export const TableRowsResponseSchema = z.object({
  rows: z.array(z.record(z.string())),
}).strict();
export type TableRowsResponse = z.infer<typeof TableRowsResponseSchema>;

/** `GET /api/admin/plugins` — admin sections grouped by plugin. */
export const AdminSectionsResponseSchema = z.object({
  sections: z.array(
    z.object({
      pluginId: z.string().min(1),
      pages: z.array(PagePayloadSchema),
    }).strict(),
  ),
}).strict();
export type AdminSectionsResponse = z.infer<typeof AdminSectionsResponseSchema>;
