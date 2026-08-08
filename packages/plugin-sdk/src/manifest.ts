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

export function definePlugin(input: PluginManifestInput): PluginManifest {
  const result = InputSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid plugin manifest for "${String(input.id)}" — ${detail}`);
  }
  return {
    id: input.id,
    version: input.version,
    basePaths: input.basePaths,
    tables: input.tables ?? {},
    migrations: input.migrations ?? [],
    routes: input.routes ?? [],
    pages: input.pages ?? [],
    events: input.events ?? [],
    jobs: input.jobs ?? {},
    provides: input.provides ?? [],
    filters: input.filters ?? [],
  };
}
