import { z } from "zod";
import { PluginEventDeclSchema, type PluginEventDecl } from "./events.js";
import type { FilterPoint, FilterSubscription } from "./filters.js";
import { PageSchemaSchema, type PageSchema } from "./pages.js";
import type { PluginRoute } from "./route.js";

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export interface PluginMigration {
  name: string;
  sql: string;
}

const MigrationSchema = z.object({ name: z.string().min(1), sql: z.string().min(1) }).strict();

/**
 * A property type a plugin declares itself the implementer of — V2's
 * `PR_module` made explicit. The `properties` plugin stores `id` in
 * `plugin_id`; the loader collects every declaration into a registry so an
 * admin picks from a list rather than typing a string, and so an unknown
 * string cannot be bought.
 *
 * `id` must equal the declaring plugin's own id, and a plugin may declare at
 * most one: V2's key is `(PR_location, PR_module)`, one row per module per
 * town, and a second type would need a discriminator that key does not have.
 */
export interface PropertyTypeDecl {
  id: string;
  name: string;
  /** Acquisition price in cents. V2 hardcoded $1,000,000 → 100_000_000n. */
  price: bigint;
  /** What `cost` means for this type, shown next to the owner's input. */
  leverLabel: string;
}

const PropertyTypeDeclSchema = z
  .object({
    id: z.string().regex(PLUGIN_ID_PATTERN),
    name: z.string().min(1),
    price: z.bigint().positive(),
    leverLabel: z.string().min(1),
  })
  .strict();

/**
 * An image slot a plugin's entities can carry — one declaration per kind of
 * thing, not per row. `theft` declaring `{ slot: "car", label: "Car image" }`
 * means every row in its cars table may have art bound to it.
 *
 * There is deliberately no `scope` field. The loader derives it from the
 * declaring plugin's id, so — unlike `PropertyTypeDecl`, whose `id` an author
 * writes and `definePlugin` must check — it cannot be got wrong, two plugins
 * cannot collide, and no plugin can declare a slot that binds another's art.
 */
export interface AssetSlotDecl {
  /** Unique within the declaring plugin. Kebab-case, matches `PLUGIN_ID_PATTERN`. */
  slot: string;
  /** Shown to the admin next to the upload widget. */
  label: string;
}

/**
 * A declaration once the loader has stamped the scope on it. This is what
 * `ctx.assetSlots` serves and what the admin binder validates against; plugin
 * authors write `AssetSlotDecl` and never this.
 */
export interface AssetSlot extends AssetSlotDecl {
  /** The declaring plugin's id, or `"core"` for core-owned tables. */
  scope: string;
}

const AssetSlotDeclSchema = z
  .object({
    slot: z.string().regex(PLUGIN_ID_PATTERN, "asset slot must be lowercase kebab-case"),
    label: z.string().min(1),
  })
  .strict();

/**
 * What a plugin author writes. Every collection is optional here and required
 * on `PluginManifest`; normalising once in `definePlugin` is what stops every
 * downstream consumer from writing `?? []` under `exactOptionalPropertyTypes`.
 *
 */
export interface PluginManifestInput {
  id: string;
  version: string;
  basePaths: string[];
  tables?: Record<string, unknown>;
  migrations?: PluginMigration[];
  routes?: PluginRoute[];
  pages?: PageSchema[];
  adminPages?: PageSchema[];
  events?: PluginEventDecl[];
  jobs?: Record<string, unknown>;
  provides?: FilterPoint<unknown>[];
  providesProperties?: PropertyTypeDecl[];
  providesAssets?: AssetSlotDecl[];
  filters?: FilterSubscription[];
}

/** The normalised manifest every consumer sees: no field is ever `undefined`. */
export interface PluginManifest {
  id: string;
  version: string;
  basePaths: string[];
  tables: Record<string, unknown>;
  migrations: PluginMigration[];
  routes: PluginRoute[];
  pages: PageSchema[];
  adminPages: PageSchema[];
  events: PluginEventDecl[];
  jobs: Record<string, unknown>;
  provides: FilterPoint<unknown>[];
  providesProperties: PropertyTypeDecl[];
  providesAssets: AssetSlotDecl[];
  filters: FilterSubscription[];
}

/**
 * Validated at definition time rather than only at boot, so a malformed
 * manifest fails on `import` with the plugin's own id in the message. The
 * loader re-checks cross-plugin concerns (collisions) it cannot see from here.
 *
 * The function-bearing fields — `routes` and `jobs` — are `z.unknown()`: their
 * shape is enforced by the TypeScript types, and a zod schema over a function
 * would only assert `typeof === "function"`. `.strict()` is what rejects
 * unknown fields.
 *
 * Three fields are not function-bearing and so do not follow that rule. `pages`
 * holds pure data, so `PageSchemaSchema` checks it for real here and a malformed
 * view node fails at definition time rather than at render. `events` is data
 * apart from its `payload` schema, and `PluginEventDeclSchema` checks it the
 * same way. `tables` maps a
 * plugin's own key to the SQL name of one of its tables — data too, and today
 * just a string — but its value type is left `unknown` because the plan defers
 * the final shape (a drizzle-table accessor) to the port that proves it end to
 * end. Until then `z.record(z.unknown())` checks only that it is an object, and
 * the loader is what reads the names out of it.
 *
 * `provides` and `filters` use `z.custom<T>()` rather than `z.unknown()`. Both
 * accept every value at runtime — the difference is only that `z.custom` carries
 * the element type through to `result.data`, which is what the manifest is built
 * from.
 *
 * Neither is validated at runtime, and that is a deferred gap rather than an
 * impossibility: `FilterPoint` is `{ name: string }` and `FilterSubscription` is
 * `{ pointName: string; order: number; run: fn }`, all of which zod could check.
 * Today `filters: [{}]` or `filters: ["nonsense"]` passes `.strict()` here and
 * crashes later at `subscription.run is not a function`. Until that is closed,
 * the TypeScript types are the only guarantee on these two fields.
 */
const InputSchema = z
  .object({
    id: z.string().regex(PLUGIN_ID_PATTERN, "plugin id must be lowercase kebab-case"),
    version: z.string().regex(SEMVER_PATTERN, "version must be semver x.y.z"),
    basePaths: z
      .array(
        z
          .string()
          .regex(/^\/api\/[a-z0-9-]+(\/[a-z0-9-]+)*$/, "basePath must look like /api/<name>"),
      )
      .min(1),
    tables: z.record(z.unknown()).optional(),
    migrations: z.array(MigrationSchema).optional(),
    routes: z.array(z.custom<PluginRoute>()).optional(),
    pages: z.array(PageSchemaSchema).optional(),
    adminPages: z
      .array(
        PageSchemaSchema.refine((p) => p.path === "/admin" || p.path.startsWith("/admin/"), {
          message: "admin page path must start with /admin/",
          path: ["path"],
        }),
      )
      .optional(),
    events: z.array(PluginEventDeclSchema).optional(),
    jobs: z.record(z.unknown()).optional(),
    provides: z.array(z.custom<FilterPoint<unknown>>()).optional(),
    providesProperties: z.array(PropertyTypeDeclSchema).optional(),
    providesAssets: z.array(AssetSlotDeclSchema).optional(),
    filters: z.array(z.custom<FilterSubscription>()).optional(),
  })
  .strict()
  // Migration names must be unique *within* a plugin, and nothing downstream can
  // recover this. The runner claims each `(plugin_id, name)` with
  // `onConflictDoNothing()`, which cannot tell "already applied on a previous
  // boot" from "declared twice in this very call": the first copy applies, the
  // second's insert conflicts, and its DDL is silently skipped. Boot succeeds and
  // the omission surfaces much later as `relation "p_foo_bar" does not exist`.
  //
  // Checked here rather than in the loader's validation pass because it is an
  // intra-manifest invariant — like the id, version and basePath patterns above,
  // it needs no knowledge of any other plugin, which is what that pass exists for.
  // Refining at definition time also catches it for every consumer, not only the
  // boot path.
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.migrations?.forEach((migration, index) => {
      if (seen.has(migration.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          // The thrown message is assembled as
          // `invalid plugin manifest for "<id>" — migrations.<i>: <message>`, so
          // the plugin is already named by the wrapper; repeating it here would
          // only stutter.
          path: ["migrations", index],
          message: `duplicate migration name "${migration.name}"`,
        });
      }
      seen.add(migration.name);
    });
    if (manifest.providesProperties !== undefined) {
      if (manifest.providesProperties.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providesProperties"],
          message: "a plugin may declare at most one property type",
        });
      }
      manifest.providesProperties.forEach((decl, index) => {
        if (decl.id !== manifest.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["providesProperties", index, "id"],
            message: `must equal the plugin's own id ("${manifest.id}")`,
          });
        }
      });
    }
  });

/**
 * The id to blame in a validation failure. A manifest that fails to parse may
 * not be an object at all — it can arrive from a plugin loaded as plain JS or
 * from JSON — so reading `.id` off it needs a guard: without one the author
 * gets a TypeError instead of a message naming the manifest that is broken.
 */
function describeId(input: unknown): string {
  if (typeof input === "object" && input !== null && "id" in input) {
    const { id } = input;
    if (typeof id === "string") return id;
  }
  return "<unknown>";
}

export function definePlugin(input: PluginManifestInput): PluginManifest {
  const result = InputSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid plugin manifest for "${describeId(input)}" — ${detail}`);
  }
  // Built from `result.data`, never from `input`: the parser's output is what
  // carries any `.default()`, `.transform()` or coercion the field schemas
  // grow later, and reading `input` here would silently discard all of it.
  const parsed = result.data;
  return {
    id: parsed.id,
    version: parsed.version,
    basePaths: parsed.basePaths,
    tables: parsed.tables ?? {},
    migrations: parsed.migrations ?? [],
    routes: parsed.routes ?? [],
    pages: parsed.pages ?? [],
    adminPages: parsed.adminPages ?? [],
    events: parsed.events ?? [],
    jobs: parsed.jobs ?? {},
    provides: parsed.provides ?? [],
    providesProperties: parsed.providesProperties ?? [],
    providesAssets: parsed.providesAssets ?? [],
    filters: parsed.filters ?? [],
  };
}
