import {
  checkViewBounds,
  COOLDOWN_ACTION_RE,
  INTERNAL_PATH_RE,
  MoneySchema,
  VIEW_ACTION_RE,
} from "@gl3/shared";
import { z } from "zod";

/**
 * The view vocabulary is twelve node kinds and grows only when a plugin-contributed
 * page needs data the static vocabulary cannot carry, as `table` did for admin
 * lists. A core page that needs more than this gets a bespoke React override.
 * Ten of the twelve are leaves; `panel` and `list` nest and so live on
 * `ViewNodeSchema` below.
 *
 * Every node is `.strict()`. A typo'd prop on a node would otherwise be
 * silently dropped by the renderer, which is the failure mode hardest to spot
 * from the page that renders wrong.
 */
/** Shared by `table.source` and select `optionsSource`: a GET against an app-internal absolute path. */
const GET_SOURCE_RE = /^GET \/(?![/\\])[^\s\\]*$/;

const leafOptions = [
  z.object({ kind: z.literal("text"), value: z.string() }).strict(),
  // MoneySchema, not z.string(): the web renderer hands this to `formatAmount`,
  // which throws on anything outside `/^-?\d+$/`, and the client has no
  // ErrorBoundary — so a decimal string here unmounts the React root and blanks
  // the app mid-render. Constrained at authoring time so a plugin declaring
  // "10.00" fails the boot that loads it. Kept identical to the DTO's `money`
  // leaf: the two diverging is how a value passes boot and then fails the
  // browser.
  z.object({ kind: z.literal("money"), value: MoneySchema }).strict(),
  z.object({ kind: z.literal("error"), value: z.string() }).strict(),
  z
    .object({
      kind: z.literal("link"),
      label: z.string(),
      to: z.string().regex(INTERNAL_PATH_RE, "link.to must be an app-internal absolute path"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("button"),
      label: z.string(),
      action: z.string().regex(VIEW_ACTION_RE, "action must be `METHOD /absolute/path`"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cooldownButton"),
      label: z.string(),
      action: z.string().regex(VIEW_ACTION_RE, "action must be `METHOD /absolute/path`"),
      cooldownAction: z
        .string()
        .regex(COOLDOWN_ACTION_RE, "cooldownAction must be a bare cooldown key segment"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("keyValue"),
      rows: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("form"),
      action: z.string().regex(VIEW_ACTION_RE, "action must be `METHOD /absolute/path`"),
      submitLabel: z.string(),
      // Three strict branches: select carries its options wiring, hidden
      // carries its constant, the basic branch carries neither — so a
      // branch-only property cannot ride on a text field and silently vanish
      // in the renderer.
      fields: z.array(
        z.union([
          z
            .object({
              name: z.string(),
              label: z.string(),
              type: z.literal("select"),
              // Same rule and same reason as `table.source`: options render on
              // mount, so the fetch must never mutate, and the loader's
              // containment pass treats it as a view action.
              optionsSource: z
                .string()
                .regex(GET_SOURCE_RE, "optionsSource must be `GET /absolute/path`"),
              valueKey: z.string(),
              labelKey: z.string(),
              allowEmpty: z.boolean().optional(),
            })
            .strict(),
          z
            .object({
              name: z.string(),
              // No `label`: the field draws nothing, so there is nowhere to
              // put one. It submits a constant the route requires — a
              // discriminator the admin would otherwise have to type by hand,
              // where one typo is a 400.
              type: z.literal("hidden"),
              value: z.string(),
            })
            .strict(),
          z
            .object({
              name: z.string(),
              label: z.string(),
              // `decimal` is `number` for fractional values. `number` renders
              // as `<input type="number">`, whose default `step` of 1 makes
              // the browser reject 1.5 before it is ever submitted.
              type: z.enum(["text", "number", "decimal", "money", "password"]),
            })
            .strict(),
        ]),
      ),
    })
    .strict(),
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
          // Default (absent) renders the cell as text. `image` treats the cell
          // value as a URL and renders an `<img>` — additive, so every column
          // written before this existed is unaffected.
          render: z.literal("image").optional(),
          // Thumbnail size for `render: "image"`, ignored otherwise. Defaults
          // to `sm`, which is right for a dense table and too small for a page
          // whose whole point is the picture (the garage) — hence the choice.
          imageSize: z.enum(["sm", "md", "lg"]).optional(),
        }).strict(),
      ).min(1),
    })
    .strict(),
  // A hand of playing cards. Values are @letele/playing-cards component names:
  // suit initial (H/D/C/S) + rank (a, 2-10, j, q, k), plus J1/J2 jokers and
  // B1/B2 backs. Constrained at authoring time rather than at render, for the
  // reason this file's header gives: an unmapped code is silently dropped by
  // the renderer, which is the failure mode hardest to spot from the page.
  // Game art. Display only: binding art to an entity is an admin action and
  // goes through `assetBinder` below, never through this.
  z
    .object({
      kind: z.literal("image"),
      url: z.string().min(1),
      // Required, not optional. It is the one accessibility decision that costs
      // nothing at authoring time and cannot be retrofitted across every
      // installed plugin later.
      alt: z.string().min(1),
      size: z.enum(["sm", "md", "lg"]).optional(),
    })
    .strict(),
  // The admin upload widget: pick an entity, choose a file, and the renderer
  // does the two-step POST /api/admin/assets then PUT /api/admin/assets/bind.
  //
  // Its own node kind rather than a `form` with a file field, because a form's
  // `action` must live under the declaring plugin's basePaths (the loader's
  // containment pass) and binding is a CORE route. A node the renderer knows
  // the target of costs less than an exception in that pass.
  //
  // `scope` is absent on purpose: the loader fills it from the declaring
  // plugin's id, so a plugin cannot declare a widget that rebinds another
  // plugin's art. Valid in `adminPages` only.
  // A singleton slot's image, resolved at render time.
  //
  // Needed because a page's view is STATIC data built at boot: it cannot carry
  // a URL that depends on what an admin uploaded afterwards. The node names its
  // slot and the renderer asks `GET /api/assets/slot/:scope/:slot`. `scope` is
  // stamped by the loader, exactly as on `assetBinder`.
  z
    .object({
      kind: z.literal("slotImage"),
      slot: z.string().min(1),
      alt: z.string().min(1),
      size: z.enum(["sm", "md", "lg"]).optional(),
      scope: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("assetBinder"),
      slot: z.string().min(1),
      // GET-only for the same reason `table.source` is: the entity list renders
      // on mount and must never mutate.
      //
      // Both entity fields are omitted for a `singleton: true` slot: there is
      // one image and therefore nothing to pick.
      entitySource: z.string().regex(GET_SOURCE_RE, "entitySource must be `GET /absolute/path`").optional(),
      /** Which field of a row to show in the picker. Its id is always `id`. */
      entityLabelKey: z.string().min(1).optional(),
      /**
       * Never written by a plugin author. The loader OVERWRITES it with the
       * declaring plugin's id on the way to the wire — unconditionally, so
       * setting it here buys nothing and cannot be used to rebind another
       * plugin's art. Optional only so the authoring type and the wire type can
       * be the same shape.
       */
      scope: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cards"),
      cards: z.array(z.string().regex(/^([HDCS](a|[2-9]|10|j|q|k)|J[12]|B[12])$/, "card must be a playing-card code")),
    })
    .strict(),
] as const;

/** Type-level only: `ViewNode` infers its twelve non-nesting members from here. */
const Leaf = z.discriminatedUnion("kind", [...leafOptions]);

export type ViewNode =
  | z.infer<typeof Leaf>
  | { kind: "panel"; title: string; children: ViewNode[] }
  | { kind: "list"; items: ViewNode[] };

/**
 * `panel` and `list` nest, so the schema is recursive and needs the explicit
 * type annotation zod requires for `z.lazy` — inference cannot close the loop
 * on its own.
 *
 * One flat `discriminatedUnion` over all fourteen kinds, rather than
 * `union([Leaf, panel, list])`. The two are equivalent in what they accept and
 * reject; they are not equivalent in what they report. `ZodUnion` aborts on
 * failure and emits a single `invalid_union` issue at the path of the
 * *outermost* union — always `view` — burying the real cause in `unionErrors`,
 * which `definePlugin` discards because it maps only `error.issues`. Every
 * authoring mistake below the top level therefore came out as
 * `pages.0.view: Invalid input`. Dispatching on `kind` picks one branch and
 * reports that branch's own issues at their own paths, so a bad node three
 * levels down names itself.
 */
export const ViewNodeSchema: z.ZodType<ViewNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    ...leafOptions,
    z
      .object({
        kind: z.literal("panel"),
        title: z.string(),
        children: z.array(ViewNodeSchema),
      })
      .strict(),
    z.object({ kind: z.literal("list"), items: z.array(ViewNodeSchema) }).strict(),
  ]),
);

export const MenuEntrySchema = z
  .object({ label: z.string().min(1), order: z.number().int() })
  .strict();

/**
 * What a page's `view` is authored against: the size bound (`checkViewBounds`,
 * from `@gl3/shared`) runs first and aborts the pipeline before the recursive
 * node schema can descend, so an over-deep view fails validation instead of
 * overflowing the stack inside `z.lazy`.
 */
export const BoundedViewNodeSchema: z.ZodType<ViewNode, z.ZodTypeDef, unknown> = z
  .unknown()
  .superRefine(checkViewBounds)
  .pipe(ViewNodeSchema);

export const PageSchemaSchema = z
  .object({
    id: z.string().min(1),
    /**
     * Two rules, both load-bearing. `INTERNAL_PATH_RE` is the DTO's rule, so a
     * path that boots here also parses on the client — the strict object over
     * `pages[]` means one path the DTO rejects takes down parsing of the whole
     * payload, in the browser, which is the failure this schema exists to move
     * to boot time. The charset is the narrower SDK-only rule on top.
     */
    path: z
      .string()
      .regex(INTERNAL_PATH_RE, "page path must be an app-internal absolute path")
      .regex(/^[a-z0-9\-/:]*$/, "page path must be lowercase"),
    menu: MenuEntrySchema.optional(),
    view: BoundedViewNodeSchema,
  })
  .strict();

export type MenuEntry = z.infer<typeof MenuEntrySchema>;
export type PageSchema = z.infer<typeof PageSchemaSchema>;
