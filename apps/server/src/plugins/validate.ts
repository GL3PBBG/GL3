import type { PluginManifest } from "@gl3/plugin-sdk";

/** Core owns these; a plugin claiming one is a hard boot failure (spec: Routes). */
export const RESERVED_BASE_PATHS = ["/api/auth", "/api/ws", "/api/plugins", "/health"] as const;

function fail(message: string): never {
  throw new Error(`plugin validation failed — ${message}`);
}

/** `/api/hello` overlaps `/api/hello/world` and itself, but not `/api/helloworld`. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * `PluginManifest.tables` is `Record<string, unknown>` — the plan defers the
 * final value shape (a drizzle-table accessor) to the port that proves it end
 * to end, and until then a plugin declares SQL table names as strings.
 *
 * Coercing with `String(value)` instead would turn a non-string into
 * `"[object Object]"` and then blame it for not carrying the plugin's prefix —
 * a message that describes neither the value nor the real mistake. A value the
 * loader cannot read a SQL name out of is its own failure, and says so.
 */
function tableName(value: unknown, pluginId: string, key: string): string {
  if (typeof value !== "string") {
    fail(`plugin "${pluginId}" declares table "${key}" as a ${typeof value}, expected a SQL name`);
  }
  return value;
}

/**
 * `PluginManifest.routes` is `unknown[]` until the route type lands, so the
 * path has to be recovered by narrowing rather than read off a typed field.
 *
 * A route this cannot narrow is a validation failure, never a skip: silently
 * ignoring it would let a malformed route escape containment entirely, which
 * is the one thing this pass exists to prevent.
 */
function routePath(route: unknown, pluginId: string): string {
  if (typeof route === "object" && route !== null && "path" in route) {
    const { path } = route;
    if (typeof path === "string") return path;
  }
  fail(`plugin "${pluginId}" declares a route with no string "path"`);
}

export function validatePlugins(manifests: readonly PluginManifest[]): void {
  const seenIds = new Set<string>();
  const claimedTables = new Map<string, string>();
  const claimedPaths: { pluginId: string; path: string }[] = [];
  const claimedPages = new Map<string, string>();

  for (const manifest of manifests) {
    if (seenIds.has(manifest.id)) fail(`two plugins claim the id "${manifest.id}"`);
    seenIds.add(manifest.id);

    const prefix = `p_${manifest.id.replaceAll("-", "_")}_`;
    for (const [key, value] of Object.entries(manifest.tables)) {
      const name = tableName(value, manifest.id, key);
      if (!name.startsWith(prefix)) {
        fail(`plugin "${manifest.id}" declares table "${name}", which must start with "${prefix}"`);
      }
      const owner = claimedTables.get(name);
      if (owner !== undefined) {
        fail(`table "${name}" is claimed by both "${owner}" and "${manifest.id}"`);
      }
      claimedTables.set(name, manifest.id);
    }

    for (const basePath of manifest.basePaths) {
      for (const reserved of RESERVED_BASE_PATHS) {
        if (overlaps(basePath, reserved)) {
          fail(`plugin "${manifest.id}" claims "${basePath}", which is reserved to core`);
        }
      }
      for (const claimed of claimedPaths) {
        if (overlaps(basePath, claimed.path)) {
          fail(
            `basePaths overlap: "${manifest.id}" claims "${basePath}", "${claimed.pluginId}" claims "${claimed.path}"`,
          );
        }
      }
      claimedPaths.push({ pluginId: manifest.id, path: basePath });
    }

    for (const page of manifest.pages) {
      const owner = claimedPages.get(page.id);
      if (owner !== undefined) {
        fail(`page id "${page.id}" is claimed by both "${owner}" and "${manifest.id}"`);
      }
      claimedPages.set(page.id, manifest.id);
    }
  }

  // Route containment runs second: every basePath is known by now, so a route
  // under a *later* basePath of the same plugin is not reported as a violation.
  for (const manifest of manifests) {
    for (const route of manifest.routes) {
      const path = routePath(route, manifest.id);
      const inScope = manifest.basePaths.some(
        (base) => path === base || path.startsWith(`${base}/`),
      );
      if (!inScope) {
        fail(
          `plugin "${manifest.id}" registers "${path}", outside its basePaths [${manifest.basePaths.join(", ")}]`,
        );
      }
    }
  }
}
