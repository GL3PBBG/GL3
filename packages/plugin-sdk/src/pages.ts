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
const Leaf = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), value: z.string() }).strict(),
  z.object({ kind: z.literal("money"), value: z.string() }).strict(),
  z.object({ kind: z.literal("error"), value: z.string() }).strict(),
  z.object({ kind: z.literal("link"), label: z.string(), to: z.string() }).strict(),
  z.object({ kind: z.literal("button"), label: z.string(), action: z.string() }).strict(),
  z
    .object({
      kind: z.literal("cooldownButton"),
      label: z.string(),
      action: z.string(),
      cooldownAction: z.string(),
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
      action: z.string(),
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
]);

export type ViewNode =
  | z.infer<typeof Leaf>
  | { kind: "panel"; title: string; children: ViewNode[] }
  | { kind: "list"; items: ViewNode[] };

/**
 * `panel` and `list` nest, so the schema is recursive and needs the explicit
 * type annotation zod requires for `z.lazy` — inference cannot close the loop
 * on its own.
 */
export const ViewNodeSchema: z.ZodType<ViewNode> = z.lazy(() =>
  z.union([
    Leaf,
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

export const PageSchemaSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().regex(/^\/[a-z0-9\-/:]*$/, "page path must be absolute"),
    menu: MenuEntrySchema.optional(),
    view: ViewNodeSchema,
  })
  .strict();

export type MenuEntry = z.infer<typeof MenuEntrySchema>;
export type PageSchema = z.infer<typeof PageSchemaSchema>;
