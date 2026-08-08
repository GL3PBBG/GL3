import { z } from "zod";
import type { FilterPoint, FilterSubscription } from "./filters.js";
import { PageSchemaSchema, type PageSchema } from "./pages.js";

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export interface PluginMigration {
  name: string;
  sql: string;
}

const MigrationSchema = z.object({ name: z.string().min(1), sql: z.string().min(1) }).strict();

/**
 * What a plugin author writes. Every collection is optional here and required
 * on `PluginManifest`; normalising once in `definePlugin` is what stops every
 * downstream consumer from writing `?? []` under `exactOptionalPropertyTypes`.
 *
 * The remaining `unknown` element types are placeholders — Tasks 4 and 10
 * replace each with its real type (events, routes) as it is defined. Task 2 has
 * already done so for `provides` and `filters`, and Task 3 for `pages`.
 */
export interface PluginManifestInput {
  id: string;
  version: string;
  basePaths: string[];
  tables?: Record<string, unknown>;
  migrations?: PluginMigration[];
  routes?: unknown[];
  pages?: PageSchema[];
  events?: unknown[];
  jobs?: Record<string, unknown>;
  provides?: FilterPoint<unknown>[];
  filters?: FilterSubscription[];
}

/** The normalised manifest every consumer sees: no field is ever `undefined`. */
export interface PluginManifest {
  id: string;
  version: string;
  basePaths: string[];
  tables: Record<string, unknown>;
  migrations: PluginMigration[];
  routes: unknown[];
  pages: PageSchema[];
  events: unknown[];
  jobs: Record<string, unknown>;
  provides: FilterPoint<unknown>[];
  filters: FilterSubscription[];
}

/**
 * Validated at definition time rather than only at boot, so a malformed
 * manifest fails on `import` with the plugin's own id in the message. The
 * loader re-checks cross-plugin concerns (collisions) it cannot see from here.
 *
 * The function-bearing fields — `routes`, `events` and `jobs` — are
 * `z.unknown()`: their shape is enforced by the TypeScript types, and a zod
 * schema over a function would only assert `typeof === "function"`.
 * `.strict()` is what rejects unknown fields.
 *
 * `pages` is the exception: page schemas are pure data, so `PageSchemaSchema`
 * checks them for real here, and a malformed view node fails at definition time
 * rather than at render.
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
    routes: z.array(z.unknown()).optional(),
    pages: z.array(PageSchemaSchema).optional(),
    events: z.array(z.unknown()).optional(),
    jobs: z.record(z.unknown()).optional(),
    provides: z.array(z.custom<FilterPoint<unknown>>()).optional(),
    filters: z.array(z.custom<FilterSubscription>()).optional(),
  })
  .strict();

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
    events: parsed.events ?? [],
    jobs: parsed.jobs ?? {},
    provides: parsed.provides ?? [],
    filters: parsed.filters ?? [],
  };
}
