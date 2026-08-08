import { z } from "zod";

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
 * The collection element types are `unknown` for now — Tasks 2, 3, 4 and 10
 * replace each with its real type (filters, pages, events, routes) as it is
 * defined.
 */
export interface PluginManifestInput {
  id: string;
  version: string;
  basePaths: string[];
  tables?: Record<string, unknown>;
  migrations?: PluginMigration[];
  routes?: unknown[];
  pages?: unknown[];
  events?: unknown[];
  jobs?: Record<string, unknown>;
  provides?: unknown[];
  filters?: unknown[];
}

/** The normalised manifest every consumer sees: no field is ever `undefined`. */
export interface PluginManifest {
  id: string;
  version: string;
  basePaths: string[];
  tables: Record<string, unknown>;
  migrations: PluginMigration[];
  routes: unknown[];
  pages: unknown[];
  events: unknown[];
  jobs: Record<string, unknown>;
  provides: unknown[];
  filters: unknown[];
}

/**
 * Validated at definition time rather than only at boot, so a malformed
 * manifest fails on `import` with the plugin's own id in the message. The
 * loader re-checks cross-plugin concerns (collisions) it cannot see from here.
 *
 * Function-bearing fields are `z.unknown()`: their shape is enforced by the
 * TypeScript types, and a zod schema over a function would only assert
 * `typeof === "function"`. `.strict()` is what rejects unknown fields.
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
    pages: z.array(z.unknown()).optional(),
    events: z.array(z.unknown()).optional(),
    jobs: z.record(z.unknown()).optional(),
    provides: z.array(z.unknown()).optional(),
    filters: z.array(z.unknown()).optional(),
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
