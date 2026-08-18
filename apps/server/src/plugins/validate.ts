import type { PluginManifest, ViewNode } from "@gl3/plugin-sdk";
import { collectAssetSlots, containsAssetBinder } from "./asset-slots.js";
import { collectPropertyTypes } from "./property-types.js";

/** Core owns these; a plugin claiming one is a hard boot failure (spec: Routes). */
export const RESERVED_BASE_PATHS = [
  "/api/auth", "/api/ws", "/api/plugins", "/health",
  // Core admin shell endpoints. Deliberately NOT "/api/admin": plugins claim
  // /api/admin/<their-id> for their own admin routes.
  "/api/admin/plugins", "/api/admin/roles", "/api/admin/rounds",
  // "/api/rounds" is deliberately NOT reserved: it is a gameplay path, and a
  // plugin replacing one is the strangler seam working as designed. A plugin
  // that claims it anyway does not shadow core — an exact duplicate is
  // FST_ERR_DUPLICATED_ROUTE at boot.
] as const;

/** Core module keys `moduleKeysOf` (admin/routes.ts) grants over. A plugin id
 *  equal to one of these makes an unrelated plugin's grant satisfy a core
 *  permission check, because grants are stored as bare, un-namespaced strings. */
const RESERVED_MODULE_KEYS = ["roles", "rounds", "*"] as const;

function fail(message: string): never {
  throw new Error(`plugin validation failed — ${message}`);
}

/** `/api/hello` overlaps `/api/hello/world` and itself, but not `/api/helloworld`. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Containment, not overlap: `/api/hello` contains `/api/hello` and
 * `/api/hello/greet`, but not `/api/helloworld` and not `/api` — the parent is
 * the one direction `overlaps` above admits and this must not.
 *
 * Shared by the route check and the view-action check so the two halves of a
 * manifest cannot drift apart on what "inside the plugin" means; a second copy
 * is how they got out of step in the first place.
 */
function containedIn(path: string, basePaths: readonly string[]): boolean {
  return basePaths.some((base) => path === base || path.startsWith(`${base}/`));
}

/**
 * The endpoint half of a `"METHOD /path"` view action. `VIEW_ACTION_RE`
 * (`@gl3/shared`) already fixed the shape at definition time — `definePlugin`
 * parses every page through `PageSchemaSchema` — so the space is always present
 * and the remainder always starts with `/`. Split on the first space rather than
 * `split(" ")` so a path that somehow carried one still yields the whole path,
 * which then fails containment rather than being silently truncated to something
 * that passes it.
 */
function actionPath(action: string): string {
  const space = action.indexOf(" ");
  return space === -1 ? action : action.slice(space + 1);
}

/**
 * True if `path` has a `.` or `..` path segment.
 *
 * `containedIn` decides containment with `startsWith`, against the literal
 * string the plugin wrote — but that is not the string that ends up on the
 * wire. The web client fires an action's path through the browser's `fetch`,
 * whose URL parser resolves `..` (and drops a redundant `.`) before the
 * request leaves the page, so `"/api/hello/../bank/withdraw"` is
 * `startsWith`-contained in `/api/hello` while the request it actually
 * produces targets `/api/bank/withdraw`. Checked as its own pass, run before
 * `containedIn`, so a traversal fails with a message about the traversal
 * rather than a confusing "outside basePaths" — the path was never really
 * outside the basePath by the string comparison, only by what a URL parser
 * does to it first.
 *
 * Only the two literal dot segments are barred, not every `.`: a plugin's
 * routable surface in this vocabulary is RPC verbs written by the author
 * (`/api/hello/greet`), not filenames, so there is no legitimate action whose
 * final segment needs a literal dot, and this does not reach for banning one.
 *
 * Deliberately blind to where a `..` would resolve to — `/api/hello/x/../y`
 * resolves back inside `/api/hello`, but it is rejected anyway. A plugin
 * author never has a reason to route through `..`, so there is no case worth
 * complicating this into "reject unless it resolves back inside."
 */
function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * Every HTTP endpoint a page's view can drive.
 *
 * Three of the ten node kinds carry one: `button`, `cooldownButton` and `form`.
 * The two other path-shaped fields are deliberately not here. `link.to` is an
 * app-internal *client* route (`/plugins/:pageId` under v1 routing), governed by
 * `INTERNAL_PATH_RE` — containing it would forbid a plugin page from linking to
 * its own sibling page. `cooldownButton.cooldownAction` is the middle segment of
 * `cooldown:<action>:<playerId>`, a Redis key segment governed by
 * `COOLDOWN_ACTION_RE`, which bars `/` outright and so can never name an
 * endpoint.
 *
 * Walked with an explicit stack. `PageSchemaSchema` has already bounded the view
 * at `MAX_VIEW_DEPTH`, so recursion would in fact be safe here — the stack is for
 * the reader, to make the traversal one thing rather than a second recursive
 * shape to keep in step with `checkViewBounds`.
 */
function viewActions(view: ViewNode): string[] {
  const actions: string[] = [];
  const pending: ViewNode[] = [view];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    switch (node.kind) {
      case "button":
      case "cooldownButton":
        actions.push(node.action);
        break;
      case "form":
        actions.push(node.action);
        // A select field's `optionsSource` fetches on mount exactly like
        // `table.source`, so it is contained the same way.
        for (const field of node.fields) {
          if (field.type === "select") actions.push(field.optionsSource);
        }
        break;
      case "table":
        actions.push(node.source);
        break;
      case "assetBinder":
        // The picker's entity list fetches on mount exactly like
        // `table.source`, so it is contained the same way. The two endpoints
        // the widget POSTs and PUTs to are CORE routes and deliberately not
        // listed here — containment is about a plugin claiming paths, and
        // `/api/admin/assets` belongs to core, not to whoever declared the
        // widget.
        // Absent on a singleton binder, which has no entity list to fetch.
        if (node.entitySource !== undefined) actions.push(node.entitySource);
        break;
      case "panel":
        for (const child of node.children) pending.push(child);
        break;
      case "list":
        for (const item of node.items) pending.push(item);
        break;
      default:
        break;
    }
  }
  return actions;
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

function routeAuth(route: unknown): string {
  if (typeof route === "object" && route !== null && "auth" in route) {
    const { auth } = route;
    if (typeof auth === "string") return auth;
  }
  return "";
}

export function validatePlugins(manifests: readonly PluginManifest[]): void {
  const seenIds = new Set<string>();
  const claimedTables = new Map<string, string>();
  const claimedPaths: { pluginId: string; path: string }[] = [];
  const claimedPages = new Map<string, string>();

  for (const manifest of manifests) {
    if (seenIds.has(manifest.id)) fail(`two plugins claim the id "${manifest.id}"`);
    seenIds.add(manifest.id);

    if ((RESERVED_MODULE_KEYS as readonly string[]).includes(manifest.id)) {
      fail(`plugin id "${manifest.id}" collides with a core admin module key`);
    }

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
    for (const page of manifest.adminPages) {
      const owner = claimedPages.get(page.id);
      if (owner !== undefined) {
        fail(`page id "${page.id}" is claimed by both "${owner}" and "${manifest.id}"`);
      }
      claimedPages.set(page.id, manifest.id);
    }
  }

  // Containment runs second: every basePath is known by now, so a route or an
  // action under a *later* basePath of the same plugin is not reported as a
  // violation.
  for (const manifest of manifests) {
    const scope = `its basePaths [${manifest.basePaths.join(", ")}]`;

    for (const route of manifest.routes) {
      const path = routePath(route, manifest.id);
      if (!containedIn(path, manifest.basePaths)) {
        fail(`plugin "${manifest.id}" registers "${path}", outside ${scope}`);
      }
      if ((path === "/api/admin" || path.startsWith("/api/admin/")) && routeAuth(route) !== "admin") {
        fail(`plugin "${manifest.id}" registers "${path}" under /api/admin/ and must declare auth "admin"`);
      }
    }

    // A page is served under the plugin's name, so the endpoints it drives are
    // attributed to the plugin. `basePaths` is that attribution, and a view
    // action reaching past it makes the manifest a false account of what the
    // plugin touches — the route half of the same manifest has never allowed it.
    // Admin pages share the same namespace: their view actions are still
    // attributed to the plugin's basePaths.
    // An upload widget on a PLAYER page would render a file picker for anyone
    // logged in. The bind route behind it still checks `hasPermission(scope)`,
    // so nothing could actually be rebound — but the page would offer an action
    // every non-admin is refused, which is a bug in the plugin either way.
    // Caught at boot rather than at render, where only an admin would see it.
    for (const page of manifest.pages) {
      if (containsAssetBinder(page.view)) {
        fail(
          `plugin "${manifest.id}" page "${page.id}" declares an assetBinder, which is valid only on an admin page`,
        );
      }
    }

    const allPages = [...manifest.pages, ...manifest.adminPages];
    for (const page of allPages) {
      for (const action of viewActions(page.view)) {
        const path = actionPath(action);
        if (hasDotSegment(path)) {
          fail(
            `plugin "${manifest.id}" page "${page.id}" declares action "${action}", whose path contains a "." or ".." segment`,
          );
        }
        if (!containedIn(path, manifest.basePaths)) {
          fail(
            `plugin "${manifest.id}" page "${page.id}" declares action "${action}", outside ${scope}`,
          );
        }
      }
    }
  }

  // A duplicate declared property type id is a hard boot failure, same as a
  // duplicate table or page id above. `collectPropertyTypes` already throws
  // with the "plugin validation failed — " prefix `fail()` uses, so calling
  // it here for its side effect is enough — the result itself is unused.
  collectPropertyTypes(manifests);

  // Same reason and same shape as `collectPropertyTypes` above: a plugin
  // declaring the same asset slot twice is a hard boot failure, and the
  // collector already throws with the right prefix.
  collectAssetSlots(manifests);
}
