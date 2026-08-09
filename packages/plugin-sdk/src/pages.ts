import {
  checkViewBounds,
  COOLDOWN_ACTION_RE,
  INTERNAL_PATH_RE,
  MoneySchema,
  VIEW_ACTION_RE,
} from "@gl3/shared";
import { z } from "zod";

/**
 * The v1 view vocabulary is exactly ten node kinds and does not grow: a core
 * page that needs more than this gets a bespoke React override rather than a
 * bigger schema. Eight of the ten are leaves; `panel` and `list` nest and so
 * live on `ViewNodeSchema` below.
 *
 * Every node is `.strict()`. A typo'd prop on a node would otherwise be
 * silently dropped by the renderer, which is the failure mode hardest to spot
 * from the page that renders wrong.
 */
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
      fields: z.array(
        z
          .object({
            name: z.string(),
            label: z.string(),
            type: z.enum(["text", "number", "money", "password"]),
          })
          .strict(),
      ),
    })
    .strict(),
] as const;

/** Type-level only: `ViewNode` infers its eight non-nesting members from here. */
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
 * One flat `discriminatedUnion` over all ten kinds, rather than
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
