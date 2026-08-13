# Admin Pages + ABAC Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First registered player becomes admin; admins manage game content through plugin-contributed admin pages (towns, bullets, shop/items, news, crimes, ranks) plus core role management.

**Architecture:** Grants live in the existing `roles` / `role_module_access` tables (`*` = wildcard). One SDK helper `hasPermission(grants, moduleKey)` backs both the plugin loader's new `auth: "admin"` route gate and core's admin routes. Plugins contribute `adminPages` (declarative view schema, one new `table` node kind for live data); core serves `GET /api/admin/plugins` filtered per requester. Plugin not loaded → its admin routes, pages, and grants surface don't exist.

**Tech Stack:** TypeScript strict ESM, Fastify, drizzle-orm/Postgres, zod, vitest (real Postgres + Redis), React + react-query.

**Spec:** `docs/superpowers/specs/2026-08-13-admin-abac-design.md`

## Global Constraints

- TypeScript strict; **no `any` in `packages/*`**, not even a cast. In `apps/*` prefer `unknown` + zod parse.
- ESM only; relative imports carry `.js` extension despite `.ts` sources.
- Zod-validate every external boundary: HTTP bodies, route params, WS frames, bus messages.
- Money is `bigint` in Postgres/TS, decimal **string** on the wire (`MoneySchema`). Never a JSON number.
- Bigint column defaults written `` .default(sql`0`) `` — never `.default(0n)`.
- Integration tests against **real** Postgres and Redis; no mocks for DB/queue/bus.
- Publish events only after the transaction commits (no events needed in this plan, but if you add one, obey this).
- Run the suite via `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"` and read the **exit code**, not the summary. Non-zero = failure even if all tests passed.
- **Never run two full test suites at once.** Single-file runs during TDD: `npx vitest run apps/server/test/<file>.test.ts` from repo root.
- Environment: `export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3` and `export REDIS_URL=redis://localhost:6379` before any test run.
- Conventional Commits.
- No new plugin packages in this plan — all admin sections live in existing plugin packages, so the eight-registration-site checklist and `Dockerfile.server` do **not** apply.

---

### Task 1: SDK authz helper

**Files:**
- Create: `packages/plugin-sdk/src/authz.ts`
- Modify: `packages/plugin-sdk/src/index.ts` (add export)
- Test: `packages/plugin-sdk/test/authz.test.ts`

**Interfaces:**
- Produces: `hasPermission(grants: readonly string[], moduleKey: string): boolean` — exported from `@gl3/plugin-sdk`. Later tasks (loader gate, core admin routes) call exactly this.

- [ ] **Step 1: Write the failing test**

```ts
// packages/plugin-sdk/test/authz.test.ts
import { describe, expect, it } from "vitest";
import { hasPermission } from "../src/authz.js";

describe("hasPermission", () => {
  it("denies with no grants", () => {
    expect(hasPermission([], "news")).toBe(false);
  });

  it("denies when grants name a different module", () => {
    expect(hasPermission(["mail"], "news")).toBe(false);
  });

  it("allows an exact module grant", () => {
    expect(hasPermission(["news"], "news")).toBe(true);
  });

  it("allows the * wildcard for any module", () => {
    expect(hasPermission(["*"], "news")).toBe(true);
    expect(hasPermission(["*"], "travel")).toBe(true);
  });

  it("does not treat * as a prefix pattern", () => {
    // "news*" or "n*" must NOT match — only the literal wildcard row does.
    expect(hasPermission(["news*"], "news")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/plugin-sdk/test/authz.test.ts`
Expected: FAIL — cannot resolve `../src/authz.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/plugin-sdk/src/authz.ts
/**
 * GL3 authorization: role → module grants → this check. A player's role
 * (players.roleId → role_module_access rows) yields a list of module keys;
 * a grant for the module or the V2-preserved `*` wildcard passes.
 *
 * Deny-by-default: no role means no grants means false; an unknown module
 * key matches nothing.
 *
 * Future (deliberately not plumbed — see the design doc): the ABAC gist this
 * takes inspiration from allows `boolean | (user, data) => boolean` per
 * check. Every v1 check is a boolean grant; the predicate level lands with
 * its first real consumer, not before.
 */
export function hasPermission(grants: readonly string[], moduleKey: string): boolean {
  return grants.some((g) => g === moduleKey || g === "*");
}
```

```ts
// packages/plugin-sdk/src/index.ts — add alongside existing exports:
export { hasPermission } from "./authz.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/plugin-sdk/test/authz.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-sdk/src/authz.ts packages/plugin-sdk/src/index.ts packages/plugin-sdk/test/authz.test.ts
git commit -m "feat(sdk): hasPermission — module-grant authz with * wildcard"
```

---

### Task 2: SDK route auth `"admin"` and manifest `adminPages`

**Files:**
- Modify: `packages/plugin-sdk/src/route.ts`
- Modify: `packages/plugin-sdk/src/manifest.ts`
- Test: `packages/plugin-sdk/test/manifest.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `RouteDef.auth` / `PluginRoute.auth` type widens to `"player" | "public" | "admin"`. `PluginManifestInput.adminPages?: PageSchema[]`; `PluginManifest.adminPages: PageSchema[]` (normalized, never undefined). Admin page `path` must start with `/admin/`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/plugin-sdk/test/manifest.test.ts` (follow the file's existing style — it builds manifests via `definePlugin` and asserts on throw messages):

```ts
describe("adminPages", () => {
  it("normalizes absent adminPages to []", () => {
    const m = definePlugin({ id: "hello", version: "1.0.0", basePaths: ["/api/hello"] });
    expect(m.adminPages).toEqual([]);
  });

  it("accepts a valid admin page and preserves it", () => {
    const m = definePlugin({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: { kind: "panel", title: "Hello Admin", children: [{ kind: "text", value: "hi" }] },
      }],
    });
    expect(m.adminPages).toHaveLength(1);
    expect(m.adminPages[0]?.path).toBe("/admin/hello");
  });

  it("rejects an admin page whose path is outside /admin/", () => {
    expect(() => definePlugin({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello"],
      adminPages: [{
        id: "hello-admin", path: "/hello",
        view: { kind: "text", value: "hi" },
      }],
    })).toThrow(/admin page path must start with \/admin\//);
  });

  it("rejects a malformed admin page view at definition time", () => {
    expect(() => definePlugin({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: { kind: "nonsense" },
      }],
    })).toThrow(/invalid plugin manifest/);
  });
});

describe("route auth admin", () => {
  it("route() accepts auth admin and carries it through", () => {
    const r = route({
      method: "GET", path: "/api/admin/hello/things", auth: "admin",
      handler: async () => ({ status: 200 }),
    });
    expect(r.auth).toBe("admin");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/plugin-sdk/test/manifest.test.ts`
Expected: FAIL — `adminPages` unknown key rejected by `.strict()`, `auth: "admin"` type error at compile.

- [ ] **Step 3: Implement**

In `packages/plugin-sdk/src/route.ts`, change both occurrences of the auth union (in `RouteDef` and `PluginRoute`):

```ts
auth?: "player" | "public" | "admin";   // RouteDef
auth: "player" | "public" | "admin";    // PluginRoute
```

(`route()`'s `def.auth ?? "player"` line is already correct.)

In `packages/plugin-sdk/src/manifest.ts`:

1. Add to `PluginManifestInput`: `adminPages?: PageSchema[];`
2. Add to `PluginManifest`: `adminPages: PageSchema[];`
3. Add to `InputSchema` (data field — validate for real, like `pages`):

```ts
adminPages: z
  .array(
    PageSchemaSchema.refine((p) => p.path === "/admin" || p.path.startsWith("/admin/"), {
      message: "admin page path must start with /admin/",
      path: ["path"],
    }),
  )
  .optional(),
```

4. Add to the return object in `definePlugin`: `adminPages: parsed.adminPages ?? [],`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/plugin-sdk/test/manifest.test.ts packages/plugin-sdk/test`
Expected: PASS, including all pre-existing manifest tests.

- [ ] **Step 5: Typecheck the workspace** (manifest consumers construct `PluginManifest` literals; a new required field breaks them until normalized-object builders are updated — `apps/server/test` helpers may build manifests inline)

Run: `npm run typecheck`
Expected: PASS. If a test helper builds a `PluginManifest` object literal by hand, add `adminPages: []` there.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-sdk/src/route.ts packages/plugin-sdk/src/manifest.ts packages/plugin-sdk/test/manifest.test.ts
git commit -m "feat(sdk): auth 'admin' route tier and adminPages manifest field"
```

---

### Task 3: `table` view node — SDK schema + shared DTO + contract

**Files:**
- Modify: `packages/plugin-sdk/src/pages.ts`
- Modify: `packages/shared/src/dto/plugins.ts`
- Test: `packages/plugin-sdk/test/pages.test.ts` (extend), `packages/plugin-sdk/test/view-schema-contract.test.ts` (read first — it asserts SDK and DTO schemas agree; the new node must satisfy it)

**Interfaces:**
- Produces: view node `{ kind: "table", source: "GET /abs/path", columns: [{ key, label }] }` valid in both the SDK authoring schema and the shared DTO. `source` matches `VIEW_ACTION_RE` restricted to GET. Table sources count as view actions for containment (Task 4 wires validate.ts).

- [ ] **Step 1: Read `packages/plugin-sdk/test/view-schema-contract.test.ts`** to learn how the SDK↔DTO sync is asserted, and `packages/shared/src/dto/plugins.ts` lines 80–end to see the DTO node union and `childrenOf`. Follow both patterns exactly.

- [ ] **Step 2: Write the failing tests**

Add to `packages/plugin-sdk/test/pages.test.ts`:

```ts
describe("table node", () => {
  const page = (view: unknown) => ({ id: "p", path: "/admin/p", view });

  it("accepts a table with a GET source and columns", () => {
    expect(PageSchemaSchema.safeParse(page({
      kind: "table",
      source: "GET /api/admin/hello/things",
      columns: [{ key: "id", label: "Id" }, { key: "name", label: "Name" }],
    })).success).toBe(true);
  });

  it("rejects a non-GET source", () => {
    expect(PageSchemaSchema.safeParse(page({
      kind: "table", source: "POST /api/admin/hello/things", columns: [{ key: "id", label: "Id" }],
    })).success).toBe(false);
  });

  it("rejects a table with unknown props", () => {
    expect(PageSchemaSchema.safeParse(page({
      kind: "table", source: "GET /api/x", columns: [], rows: [] ,
    })).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run packages/plugin-sdk/test/pages.test.ts`
Expected: FAIL — `invalid_union`, `table` not a known kind.

- [ ] **Step 4: Implement**

In `packages/plugin-sdk/src/pages.ts`, add to `leafOptions` (and update the "exactly ten node kinds and does not grow" comment: now eleven; state the bar — a node gets added only when plugin-contributed pages need data the static vocabulary cannot carry, as `table` did for admin lists; core pages still get bespoke overrides instead):

```ts
z
  .object({
    kind: z.literal("table"),
    /**
     * GET-only: a table renders data, it must never mutate on mount. The
     * loader's containment pass treats this as a view action, so it must
     * live under the plugin's basePaths like any button/form action.
     */
    source: z.string().regex(/^GET \/(?![/\\])[^\s\\]*$/, "table source must be `GET /absolute/path`"),
    columns: z.array(z.object({ key: z.string(), label: z.string() }).strict()).min(1),
  })
  .strict(),
```

In `packages/shared/src/dto/plugins.ts`: add the same node (same shape, same `.strict()`) to the DTO's leaf union, and extend `childrenOf` to include `columns`:

```ts
if ("columns" in node && Array.isArray(node.columns)) return node.columns;
```

(Insert alongside the existing `rows` / `fields` branches, same reasoning: bounded objects.)

Also export the row-payload schema tables fetch, next to the DTO:

```ts
/** What a `table.source` endpoint returns: pre-stringified rows, column keys as props. */
export const TableRowsResponseSchema = z.object({
  rows: z.array(z.record(z.string())),
}).strict();
export type TableRowsResponse = z.infer<typeof TableRowsResponseSchema>;
```

- [ ] **Step 5: Run SDK + shared + contract tests**

Run: `npx vitest run packages/plugin-sdk/test packages/shared`
Expected: PASS, including `view-schema-contract.test.ts`. If the contract test enumerates kinds, add `table` where it instructs.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-sdk/src/pages.ts packages/shared/src/dto/plugins.ts packages/plugin-sdk/test/pages.test.ts packages/plugin-sdk/test/view-schema-contract.test.ts
git commit -m "feat(sdk,shared): table view node — GET source + columns"
```

---

### Task 4: Loader validation — admin rules

**Files:**
- Modify: `apps/server/src/plugins/validate.ts`
- Modify: `apps/server/src/plugins/manifest-endpoint.ts` (explicitly ignore adminPages — no code change needed if it already only reads `manifest.pages`; add the leak test regardless)
- Test: create `apps/server/test/admin-validate.test.ts`

**Interfaces:**
- Consumes: `PluginManifest.adminPages`, `PluginRoute.auth` from Task 2; `viewActions` / `containedIn` / `claimedPages` internals of validate.ts.
- Produces: boot-time failures for: (a) plugin route under `/api/admin/` without `auth: "admin"`; (b) admin page id colliding with any page id; (c) admin page view action outside basePaths; (d) plugin basePath overlapping core-reserved `/api/admin/plugins` or `/api/admin/roles`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/admin-validate.test.ts
import { definePlugin, route } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import { validatePlugins } from "../src/plugins/validate.js";

const ok = route({ method: "GET", path: "/api/admin/hello/things", auth: "admin", handler: async () => ({ status: 200 }) });

function manifest(overrides: Parameters<typeof definePlugin>[0]): ReturnType<typeof definePlugin> {
  return definePlugin(overrides);
}

describe("admin validation rules", () => {
  it("accepts an admin route with auth admin under /api/admin/<id>", () => {
    const m = manifest({
      id: "hello", version: "1.0.0",
      basePaths: ["/api/hello", "/api/admin/hello"], routes: [ok],
    });
    expect(() => validatePlugins([m])).not.toThrow();
  });

  it("rejects an /api/admin/ route without auth admin", () => {
    const bad = route({ method: "GET", path: "/api/admin/hello/things", auth: "player", handler: async () => ({ status: 200 }) });
    const m = manifest({
      id: "hello", version: "1.0.0",
      basePaths: ["/api/hello", "/api/admin/hello"], routes: [bad],
    });
    expect(() => validatePlugins([m])).toThrow(/must declare auth "admin"/);
  });

  it("rejects a basePath overlapping the reserved core admin endpoints", () => {
    const m = manifest({ id: "sneaky", version: "1.0.0", basePaths: ["/api/admin/roles"] });
    expect(() => validatePlugins([m])).toThrow(/reserved to core/);
  });

  it("rejects an admin page id colliding with a public page id across plugins", () => {
    const a = manifest({
      id: "aaa", version: "1.0.0", basePaths: ["/api/aaa"],
      pages: [{ id: "clash", path: "/aaa", view: { kind: "text", value: "x" } }],
    });
    const b = manifest({
      id: "bbb", version: "1.0.0", basePaths: ["/api/bbb"],
      adminPages: [{ id: "clash", path: "/admin/bbb", view: { kind: "text", value: "x" } }],
    });
    expect(() => validatePlugins([a, b])).toThrow(/page id "clash"/);
  });

  it("rejects an admin page action outside the plugin's basePaths", () => {
    const m = manifest({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: { kind: "form", action: "POST /api/bank/deposit", submitLabel: "x", fields: [] },
      }],
    });
    expect(() => validatePlugins([m])).toThrow(/outside/);
  });

  it("treats a table source as a view action for containment", () => {
    const m = manifest({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: { kind: "table", source: "GET /api/other/things", columns: [{ key: "a", label: "A" }] },
      }],
    });
    expect(() => validatePlugins([m])).toThrow(/outside/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/server/test/admin-validate.test.ts`
Expected: FAIL on the four new rules (the reserved-path test fails because `/api/admin/roles` is not yet reserved, etc.).

- [ ] **Step 3: Implement in `validate.ts`**

1. Reserved paths — exact core endpoints only (reserving `/api/admin` wholesale would boot-fail every plugin's `/api/admin/<id>` basePath):

```ts
export const RESERVED_BASE_PATHS = [
  "/api/auth", "/api/ws", "/api/plugins", "/health",
  // Core admin shell endpoints. Deliberately NOT "/api/admin": plugins claim
  // /api/admin/<their-id> for their own admin routes.
  "/api/admin/plugins", "/api/admin/roles",
] as const;
```

2. In `viewActions`, add a case for the new node:

```ts
case "table":
  actions.push(node.source);
  break;
```

(`actionPath` already strips the `GET ` prefix.)

3. In the first per-manifest loop, extend the page-id collision check to cover `manifest.adminPages` with the same `claimedPages` map (admin and public pages share one id namespace — the client routes by page id).

4. In the containment loop, iterate `[...manifest.pages, ...manifest.adminPages]` for view-action containment, and add the auth rule alongside the existing route containment check:

```ts
for (const route of manifest.routes) {
  const path = routePath(route, manifest.id);
  if (!containedIn(path, manifest.basePaths)) {
    fail(`plugin "${manifest.id}" registers "${path}", outside ${scope}`);
  }
  if ((path === "/api/admin" || path.startsWith("/api/admin/")) && routeAuth(route) !== "admin") {
    fail(`plugin "${manifest.id}" registers "${path}" under /api/admin/ and must declare auth "admin"`);
  }
}
```

with a narrowing helper next to `routePath` (same pattern, same reasoning):

```ts
function routeAuth(route: unknown): string {
  if (typeof route === "object" && route !== null && "auth" in route) {
    const { auth } = route;
    if (typeof auth === "string") return auth;
  }
  return "";
}
```

- [ ] **Step 4: Run to verify pass, plus existing loader tests**

Run: `npx vitest run apps/server/test/admin-validate.test.ts apps/server/test/plugin-manifest-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the manifest-endpoint leak test**

In `apps/server/test/admin-validate.test.ts` (or extend `plugin-manifest-endpoint.test.ts`, whichever file already imports `buildPluginsPayload`):

```ts
import { buildPluginsPayload } from "../src/plugins/manifest-endpoint.js";

it("buildPluginsPayload never includes adminPages", () => {
  const m = manifest({
    id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
    pages: [{ id: "pub", path: "/hello", view: { kind: "text", value: "x" } }],
    adminPages: [{ id: "adm", path: "/admin/hello", view: { kind: "text", value: "x" } }],
  });
  const payload = buildPluginsPayload([m]);
  expect(payload.pages.map((p) => p.id)).toEqual(["pub"]);
});
```

Run it; it should pass with no code change (`buildPluginsPayload` reads only `manifest.pages`). It exists to catch a future refactor leaking admin views.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/plugins/validate.ts apps/server/test/admin-validate.test.ts
git commit -m "feat(server): boot-time admin rules — reserved core paths, auth-admin enforcement, adminPages containment"
```

---

### Task 5: Loader route gate for `auth: "admin"`

**Files:**
- Modify: `apps/server/src/plugins/routes.ts`
- Test: create `apps/server/test/admin-gate.test.ts`

**Interfaces:**
- Consumes: `hasPermission` (Task 1), `auth: "admin"` (Task 2).
- Produces: an `auth: "admin"` plugin route answers 401 with no/bad token, 403 without a matching grant, and runs the handler with a matching grant or `*`. Also produces `loadGrants(db, playerId): Promise<string[]>` exported from `routes.ts` for core reuse (Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/admin-gate.test.ts
import { definePlugin, route } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const testPlugin = definePlugin({
  id: "gatecheck",
  version: "1.0.0",
  basePaths: ["/api/gatecheck", "/api/admin/gatecheck"],
  routes: [
    route({
      method: "GET", path: "/api/admin/gatecheck/ping", auth: "admin",
      handler: async () => ({ status: 200, body: { pong: true } }),
    }),
  ],
});

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

async function registerPlayer(username: string): Promise<{ token: string; playerId: string }> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  return res.json();
}

async function giveRole(playerId: string, moduleKey: string): Promise<void> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKey}` });
  await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer({ plugins: [testPlugin] }));
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("auth: admin gate", () => {
  it("401s with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/gatecheck/ping" });
    expect(res.statusCode).toBe(401);
  });

  it("403s a player with no role", async () => {
    // First-registered player auto-becomes admin (Task 6) — register a
    // sacrificial first user, then test with the second.
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("NoRole");
    const res = await app.inject({
      method: "GET", url: "/api/admin/gatecheck/ping",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  it("403s a role granting a different module", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("MailMod");
    await giveRole(p.playerId, "mail");
    const res = await app.inject({
      method: "GET", url: "/api/admin/gatecheck/ping",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("200s an exact module grant", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("GateMod");
    await giveRole(p.playerId, "gatecheck");
    const res = await app.inject({
      method: "GET", url: "/api/admin/gatecheck/ping",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });

  it("200s a * wildcard grant", async () => {
    await registerPlayer("FirstAdmin");
    const p = await registerPlayer("Wildcard");
    await giveRole(p.playerId, "*");
    const res = await app.inject({
      method: "GET", url: "/api/admin/gatecheck/ping",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
```

Note: until Task 6 lands, the sacrificial `FirstAdmin` registrations are harmless no-ops (nobody gets a role). Written this way now so this file does not need touching after Task 6.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/server/test/admin-gate.test.ts`
Expected: the 403/200 cases FAIL (routes with `auth: "admin"` currently get an empty preHandler — line 17 of routes.ts only checks `=== "player"` — so the no-token case may even 500 or 200; all wrong).

- [ ] **Step 3: Implement in `apps/server/src/plugins/routes.ts`**

```ts
import { hasPermission } from "@gl3/plugin-sdk";
import { roleModuleAccess } from "../db/schema/index.js";

// preHandler: admin routes authenticate exactly like player routes; the
// grant check runs in the handler body where `db` is in scope.
const preHandler = pluginRoute.auth === "public" ? [] : [app.requireAuth];
```

Then, in the handler before the jail/hospital blocks:

```ts
if (pluginRoute.auth === "admin") {
  // requireAuth has run; playerId is set. Grants resolve fresh per request —
  // no cache, so a revoked role loses access on its next request.
  const grants = await loadGrants(deps.db, playerId as string);
  if (!hasPermission(grants, manifest.id)) {
    return reply.code(403).send({ error: "forbidden" });
  }
}
```

And export the grants loader (used again by core in Task 8):

```ts
/** Module keys granted by the player's role; [] when roleless. */
export async function loadGrants(db: Db, playerId: string): Promise<string[]> {
  const rows = await db
    .select({ moduleKey: roleModuleAccess.moduleKey })
    .from(players)
    .innerJoin(roleModuleAccess, eq(roleModuleAccess.roleId, players.roleId))
    .where(eq(players.id, playerId));
  return rows.map((r) => r.moduleKey);
}
```

(`players` and `eq` are already imported in this file. `Db` type: `import type { Db } from "../db/client.js";`)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/server/test/admin-gate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/plugins/routes.ts apps/server/test/admin-gate.test.ts
git commit -m "feat(server): loader gate for auth-admin plugin routes"
```

---

### Task 6: First registered player becomes admin

**Files:**
- Modify: `apps/server/src/auth/routes.ts` (register handler transaction)
- Test: create `apps/server/test/first-admin.test.ts`

**Interfaces:**
- Consumes: registration transaction in `POST /api/auth/register`.
- Produces: on the very first registration ever, a role named `Administrator` exists with a `role_module_access` row `*`, and the player's `roleId` points at it. Every later registration is roleless.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/first-admin.test.ts
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

async function register(username: string) {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { playerId: string; token: string };
}

async function grantsOf(playerId: string): Promise<string[]> {
  const rows = await db
    .select({ moduleKey: roleModuleAccess.moduleKey })
    .from(players)
    .innerJoin(roleModuleAccess, eq(roleModuleAccess.roleId, players.roleId))
    .where(eq(players.id, playerId));
  return rows.map((r) => r.moduleKey);
}

describe("first registered player becomes admin", () => {
  it("gives the very first player the Administrator role with *", async () => {
    const first = await register("Founder");
    expect(await grantsOf(first.playerId)).toEqual(["*"]);
    const [role] = await db.select().from(roles);
    expect(role?.name).toBe("Administrator");
  });

  it("gives the second player no role", async () => {
    await register("Founder");
    const second = await register("Latecomer");
    expect(await grantsOf(second.playerId)).toEqual([]);
    const [row] = await db.select({ roleId: players.roleId }).from(players)
      .where(eq(players.id, second.playerId));
    expect(row?.roleId).toBeNull();
  });

  it("exactly one admin under concurrent first registrations", async () => {
    // Ten simultaneous registrations against an empty players table. Without
    // the advisory lock, read committed lets several count only their own
    // insert and all claim admin.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        app.inject({
          method: "POST", url: "/api/auth/register",
          payload: { username: `Racer${i}`, password: "hunter2hunter2" },
        }),
      ),
    );
    // Rate limit is 5/hour/IP — if any 429s appear, lower to 4 concurrent
    // registrations; the race only needs 2.
    const created = results.filter((r) => r.statusCode === 201);
    expect(created.length).toBeGreaterThanOrEqual(2);
    const admins = await db.select({ id: players.id }).from(players)
      .innerJoin(roles, eq(players.roleId, roles.id));
    expect(admins).toHaveLength(1);
  });
});
```

**Rate-limit note:** `bootTestServer` gives this file a private rate-limit prefix, but `register` is capped at 5/hour per IP within it. `beforeEach` resets the DB, not Redis buckets. Budget: use ≤4 registrations per test, or boot with more headroom by registering across tests sparingly. If 429s surface, reduce the concurrency test to 4 parallel registrations — the race needs only 2.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/server/test/first-admin.test.ts`
Expected: FAIL — no role assigned.

- [ ] **Step 3: Implement in the register handler**

Inside the existing `db.transaction` in `POST /api/auth/register` (after the two inserts):

```ts
// First-player-ever becomes Administrator. The advisory lock is
// load-bearing: under read committed, two concurrent first registrations
// each see only their own insert — both would count 1 and both would claim
// admin. The lock serializes count-and-claim; it releases at commit.
await tx.execute(sql`SELECT pg_advisory_xact_lock(7461001)`);
const [{ n }] = await tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM players`);
if (n === "1") {
  const adminRoleId = uuidv7();
  await tx.insert(roles).values({ id: adminRoleId, name: "Administrator" });
  await tx.insert(roleModuleAccess).values({ roleId: adminRoleId, moduleKey: "*" });
  await tx.update(players).set({ roleId: adminRoleId }).where(eq(players.id, playerId));
}
```

Imports to add in `auth/routes.ts`: `sql` from `drizzle-orm`, `roles, roleModuleAccess` from `../db/schema/index.js`. Check how `tx.execute` returns rows in this codebase (drizzle's `execute` result shape differs by driver — mirror an existing `db.execute(sql...)` usage such as `resetDb`; if row access is awkward, use `tx.select({ n: sql<number>`count(*)` }).from(players)` instead and compare `Number(n) === 1`).

**Lock scope note:** the advisory lock is taken AFTER the player insert. Correctness holds because the count-and-claim (not the insert) is the racy section, and both racers serialize on the lock before counting — the loser counts 2. Taking it before the insert would also work but holds the lock across the insert for nothing.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/server/test/first-admin.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Prove the concurrency test can fail**

Temporarily comment out the `pg_advisory_xact_lock` line, run the concurrency test, and confirm it FAILS (more than one admin). Restore the line, re-run, confirm PASS. Record the observed failure in the commit message body. If it happens to pass without the lock (scheduling luck), run it a few times — it must fail at least once without the lock before this step counts.

- [ ] **Step 6: Sweep for collateral test breakage**

Every existing test file's FIRST registration after `resetDb` now mints an Administrator + `*` role row and assigns it. Audit findings so far: `news.test.ts` is safe by construction (its first registration "Editor" gets explicitly overwritten to the Staff role; "Vito" registers second). Run the full suite once and triage:

Run: `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"`

For any failure caused by an unexpectedly-privileged or unexpectedly-role-bearing first player, fix the TEST (register a sacrificial first user, or `db.update(players).set({ roleId: null })` the affected player) — do not weaken the feature. List each fixed file in the commit message.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/auth/routes.ts apps/server/test/first-admin.test.ts <any swept test files>
git commit -m "feat(auth): first registered player becomes Administrator with * grant"
```

---

### Task 7: Expose grants on /api/auth/me

**Files:**
- Modify: `apps/server/src/auth/routes.ts` (`GET /api/auth/me`)
- Modify: `packages/shared/src/dto/` (the file exporting `MeResponseSchema` — find with `grep -rn "MeResponseSchema" packages/shared/src`)
- Test: extend `apps/server/test/auth.test.ts` (it already covers /me) or `first-admin.test.ts`

**Interfaces:**
- Consumes: `loadGrants` (Task 5).
- Produces: `/api/auth/me` response gains `grants: string[]`; `MeResponseSchema` gains `grants: z.array(z.string())`. Web (Task 15) reads `me.grants`.

- [ ] **Step 1: Write the failing test** (in `first-admin.test.ts`, where admin and roleless players already exist)

```ts
it("reports grants on /api/auth/me", async () => {
  const first = await register("Founder");
  const second = await register("Latecomer");
  const adminMe = await app.inject({
    method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${first.token}` },
  });
  expect(adminMe.json().grants).toEqual(["*"]);
  const plainMe = await app.inject({
    method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${second.token}` },
  });
  expect(plainMe.json().grants).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/server/test/first-admin.test.ts`, expected FAIL (`grants` undefined).

- [ ] **Step 3: Implement**

In the `/api/auth/me` handler: `const grants = await loadGrants(db, playerId);` (import from `../plugins/routes.js`) and add `grants` to the response object. In the shared DTO, add `grants: z.array(z.string())` to `MeResponseSchema`.

- [ ] **Step 4: Run to verify pass** — same file, plus `npx vitest run apps/server/test/auth.test.ts` (its /me assertions may use `.toEqual` on the whole body; update them to include `grants: []` — remembering the first player registered in THAT file now has `["*"]`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth/routes.ts packages/shared/src/dto apps/server/test
git commit -m "feat(auth): expose role grants on /api/auth/me"
```

---

### Task 8: Core admin shell — /api/admin/plugins and role management

**Files:**
- Create: `apps/server/src/admin/routes.ts`
- Create: `apps/server/src/admin/roles-page.ts` (the synthesized core section's PageSchema)
- Modify: `apps/server/src/app.ts` (register admin routes; grep for `registerAuthRoutes` to find the registration site and mirror it — admin routes need `manifests` too, so register after plugins load)
- Test: create `apps/server/test/admin-shell.test.ts`

**Interfaces:**
- Consumes: `loadGrants` (Task 5), `hasPermission` (Task 1), loaded `manifests` (each with `adminPages`), `PageSchema` type.
- Produces:
  - `GET /api/admin/plugins` → `{ sections: { pluginId: string; pages: PageSchema[] }[] }` — one entry per loaded plugin whose id the requester's grants cover AND which has ≥1 admin page, plus a synthetic `{ pluginId: "roles", pages: [rolesPage] }` when grants cover `roles`. 403 when the requester's grants cover nothing.
  - `GET /api/admin/roles` → `{ roles: { id, name, moduleKeys: string[] }[] }`.
  - `POST /api/admin/roles/assign` body `{ username: string; roleId: string | null }` → 204; 404 unknown username; 400 `cannot_demote_self` when the requester targets themself with `roleId: null` (or any change away from their current role — v1 blocks self-modification entirely, simplest safe rule); 404 unknown roleId.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/test/admin-shell.test.ts
import { definePlugin } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const withAdminPage = (id: string) => definePlugin({
  id, version: "1.0.0", basePaths: [`/api/${id}`, `/api/admin/${id}`],
  adminPages: [{
    id: `${id}-admin`, path: `/admin/${id}`,
    view: { kind: "panel", title: id, children: [{ kind: "text", value: id }] },
  }],
});

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer({
    plugins: [withAdminPage("alpha"), withAdminPage("beta")],
  }));
});

afterAll(async () => { await closeServer(); await conn.end(); });

async function register(username: string) {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  return res.json() as { playerId: string; token: string };
}

async function giveRole(playerId: string, moduleKeys: string[]): Promise<string> {
  const roleId = uuidv7();
  await db.insert(roles).values({ id: roleId, name: `role-${moduleKeys.join("-")}` });
  for (const moduleKey of moduleKeys) {
    await db.insert(roleModuleAccess).values({ roleId, moduleKey });
  }
  await db.update(players).set({ roleId }).where(eq(players.id, playerId));
  return roleId;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("GET /api/admin/plugins", () => {
  it("403s a player with no grants", async () => {
    await register("Founder");
    const p = await register("Nobody");
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(p.token) });
    expect(res.statusCode).toBe(403);
  });

  it("returns only the granted plugin's section for a narrow role", async () => {
    await register("Founder");
    const p = await register("AlphaOnly");
    await giveRole(p.playerId, ["alpha"]);
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(p.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().sections.map((s: { pluginId: string }) => s.pluginId)).toEqual(["alpha"]);
  });

  it("returns all sections plus the core roles section for *", async () => {
    const founder = await register("Founder"); // auto-admin with *
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(founder.token) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().sections.map((s: { pluginId: string }) => s.pluginId);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
    expect(ids).toContain("roles");
  });

  it("a plugin not loaded contributes no section", async () => {
    const founder = await register("Founder");
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth(founder.token) });
    const ids = res.json().sections.map((s: { pluginId: string }) => s.pluginId);
    expect(ids).not.toContain("gamma"); // never loaded — feature absent
  });
});

describe("role management", () => {
  it("lists roles with their module keys", async () => {
    const founder = await register("Founder");
    const res = await app.inject({ method: "GET", url: "/api/admin/roles", headers: auth(founder.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual([
      expect.objectContaining({ name: "Administrator", moduleKeys: ["*"] }),
    ]);
  });

  it("assigns and clears a role by username", async () => {
    const founder = await register("Founder");
    const p = await register("Promotee");
    const [adminRole] = await db.select().from(roles);
    const assign = await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Promotee", roleId: adminRole?.id },
    });
    expect(assign.statusCode).toBe(204);
    const clear = await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Promotee", roleId: null },
    });
    expect(clear.statusCode).toBe(204);
    const [row] = await db.select({ roleId: players.roleId }).from(players)
      .where(eq(players.id, p.playerId));
    expect(row?.roleId).toBeNull();
  });

  it("refuses self-modification", async () => {
    const founder = await register("Founder");
    const res = await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Founder", roleId: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "cannot_demote_self" });
  });

  it("404s an unknown username and an unknown roleId", async () => {
    const founder = await register("Founder");
    const ghost = await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Nobody", roleId: null },
    });
    expect(ghost.statusCode).toBe(404);
    const badRole = await app.inject({
      method: "POST", url: "/api/admin/roles/assign", headers: auth(founder.token),
      payload: { username: "Founder", roleId: uuidv7() },
    });
    expect(badRole.statusCode).toBe(404);
  });

  it("403s role routes for a role without the roles grant", async () => {
    await register("Founder");
    const p = await register("AlphaOnly");
    await giveRole(p.playerId, ["alpha"]);
    const res = await app.inject({ method: "GET", url: "/api/admin/roles", headers: auth(p.token) });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure** — routes don't exist → 404s.

- [ ] **Step 3: Implement**

`apps/server/src/admin/roles-page.ts` — a plain `PageSchema` value:

```ts
import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's role-management section, served through the same payload as plugin
 * adminPages so the client renders core and plugins through one code path.
 */
export const rolesPage: PageSchema = {
  id: "core-roles-admin",
  path: "/admin/roles",
  view: {
    kind: "panel",
    title: "Roles",
    children: [
      { kind: "table", source: "GET /api/admin/roles/table", columns: [
        { key: "id", label: "Role id" },
        { key: "name", label: "Name" },
        { key: "moduleKeys", label: "Grants" },
      ] },
      { kind: "form", action: "POST /api/admin/roles/assign", submitLabel: "Assign role", fields: [
        { name: "username", label: "Username", type: "text" },
        { name: "roleId", label: "Role id (empty clears)", type: "text" },
      ] },
    ],
  },
};
```

Containment note: core pages are not plugin manifests, so `validatePlugins` never sees this page and no basePath rule applies; the client's DTO parse still runs, and these paths satisfy `INTERNAL_PATH_RE`/`VIEW_ACTION_RE`.

`apps/server/src/admin/routes.ts`:

```ts
import { hasPermission, type PageSchema, type PluginManifest } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { players, roleModuleAccess, roles } from "../db/schema/index.js";
import { loadGrants } from "../plugins/routes.js";
import { rolesPage } from "./roles-page.js";

const AssignBodySchema = z.object({
  username: z.string().min(1),
  roleId: z.string().uuid().nullable(),
}).strict();

export function registerAdminRoutes(
  app: FastifyInstance, db: Db, manifests: readonly PluginManifest[],
): void {
  // requireAuth is decorated by registerAuthRoutes, which app.ts runs first.
  // The grant check is two inline lines per handler on purpose: a helper
  // hiding reply.code(403) behind a return value reads worse than the
  // repetition.

  app.get("/api/admin/plugins", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const grants = await loadGrants(db, request.playerId as string);
    const sections: { pluginId: string; pages: PageSchema[] }[] = [];
    for (const manifest of manifests) {
      if (manifest.adminPages.length === 0) continue;
      if (!hasPermission(grants, manifest.id)) continue;
      sections.push({ pluginId: manifest.id, pages: manifest.adminPages });
    }
    if (hasPermission(grants, "roles")) {
      sections.push({ pluginId: "roles", pages: [rolesPage] });
    }
    if (sections.length === 0) return reply.code(403).send({ error: "forbidden" });
    return reply.send({ sections });
  });

  app.get("/api/admin/roles", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const grants = await loadGrants(db, request.playerId as string);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const roleRows = await db.select().from(roles);
    const accessRows = await db.select().from(roleModuleAccess);
    const byRole = new Map<string, string[]>();
    for (const row of accessRows) {
      const list = byRole.get(row.roleId) ?? [];
      list.push(row.moduleKey);
      byRole.set(row.roleId, list);
    }
    return reply.send({
      roles: roleRows.map((r) => ({ id: r.id, name: r.name, moduleKeys: byRole.get(r.id) ?? [] })),
    });
  });

  // Table-source twin of GET /api/admin/roles: pre-stringified rows.
  app.get("/api/admin/roles/table", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const grants = await loadGrants(db, request.playerId as string);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const roleRows = await db.select().from(roles);
    const accessRows = await db.select().from(roleModuleAccess);
    const byRole = new Map<string, string[]>();
    for (const row of accessRows) {
      const list = byRole.get(row.roleId) ?? [];
      list.push(row.moduleKey);
      byRole.set(row.roleId, list);
    }
    return reply.send({
      rows: roleRows.map((r) => ({
        id: r.id, name: r.name, moduleKeys: (byRole.get(r.id) ?? []).join(", "),
      })),
    });
  });

  app.post("/api/admin/roles/assign", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const grants = await loadGrants(db, request.playerId as string);
    if (!hasPermission(grants, "roles")) return reply.code(403).send({ error: "forbidden" });
    const parsed = AssignBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const [target] = await db.select({ id: players.id }).from(players)
      .where(eq(players.username, parsed.data.username));
    if (!target) return reply.code(404).send({ error: "player_not_found" });
    if (target.id === request.playerId) {
      return reply.code(400).send({ error: "cannot_demote_self" });
    }
    if (parsed.data.roleId !== null) {
      const [role] = await db.select({ id: roles.id }).from(roles)
        .where(eq(roles.id, parsed.data.roleId));
      if (!role) return reply.code(404).send({ error: "role_not_found" });
    }
    await db.update(players).set({ roleId: parsed.data.roleId }).where(eq(players.id, target.id));
    return reply.code(204).send();
  });
}
```

Empty-form-field note: the assign form sends `roleId: ""` for "clear"; the HTTP API contract is `null`. The web PageRenderer sends strings — so ALSO accept `""` as clear: change the schema line to `roleId: z.union([z.string().uuid(), z.literal(""), z.null()]).transform((v) => (v === "" ? null : v))`.

Register in `app.ts` after plugins load (the loader returns `manifests`): `registerAdminRoutes(app, db, loaded.manifests);` — find the exact seam by grepping `registerPluginRoutes` in `app.ts` and add the call adjacent, passing the same manifest list.

**Note the self-check ordering:** existence (404) before self-check (400)? No — self-check compares against the requester, who always exists; check target existence first (404), then self (400), then roleId existence (404). That is the order written above; keep it — it mirrors the "existence before permission" convention documented in gangs.

- [ ] **Step 4: Run to verify pass** — `npx vitest run apps/server/test/admin-shell.test.ts`
Expected: PASS (9 tests). The roles-table route is covered implicitly by the DTO leak test? No — add one assertion to the "lists roles" test hitting `/api/admin/roles/table` and expecting `rows[0]` to equal `expect.objectContaining({ name: "Administrator", moduleKeys: "*" })`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/admin apps/server/src/app.ts apps/server/test/admin-shell.test.ts
git commit -m "feat(server): core admin shell — filtered sections payload and role management"
```

---

### Task 9: Travel admin section (towns)

**Files:**
- Modify: `packages/plugins/travel/src/index.ts` (basePaths, routes, adminPages)
- Test: create `apps/server/test/admin-travel.test.ts`

**Interfaces:**
- Consumes: `auth: "admin"` gate; `locations` schema mirror already imported in the travel plugin.
- Produces:
  - `GET /api/admin/travel/locations` → `{ rows: [{ id, name, travelCost, travelCooldownSeconds }] }` (all strings).
  - `POST /api/admin/travel/locations` body `{ name, travelCost, travelCooldownSeconds }` → 201 `{ id }`.
  - `POST /api/admin/travel/locations/update` body `{ id, name, travelCost, travelCooldownSeconds }` → 204; 404 unknown id.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/admin-travel.test.ts
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let adminToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  const founder = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "Founder", password: "hunter2hunter2" },
  });
  adminToken = founder.json().token; // first registration → * grant (Task 6)
});

afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${adminToken}` });

describe("travel admin", () => {
  it("creates a town and lists it", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/travel/locations", headers: auth(),
      payload: { name: "Palermo", travelCost: "500", travelCooldownSeconds: 60 },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json();

    const list = await app.inject({ method: "GET", url: "/api/admin/travel/locations", headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows).toEqual([
      { id, name: "Palermo", travelCost: "500", travelCooldownSeconds: "60" },
    ]);

    const [row] = await db.select().from(locations).where(eq(locations.id, id));
    expect(row?.travelCost).toBe(500n);
  });

  it("updates a town", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/travel/locations", headers: auth(),
      payload: { name: "Palermo", travelCost: "500", travelCooldownSeconds: 60 },
    });
    const { id } = create.json();
    const update = await app.inject({
      method: "POST", url: "/api/admin/travel/locations/update", headers: auth(),
      payload: { id, name: "Corleone", travelCost: "750", travelCooldownSeconds: 90 },
    });
    expect(update.statusCode).toBe(204);
    const [row] = await db.select().from(locations).where(eq(locations.id, id));
    expect(row?.name).toBe("Corleone");
    expect(row?.travelCost).toBe(750n);
  });

  it("404s an update to an unknown id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/travel/locations/update", headers: auth(),
      payload: { id: "00000000-0000-7000-8000-000000000000", name: "X", travelCost: "1", travelCooldownSeconds: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a negative travel cost", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/travel/locations", headers: auth(),
      payload: { name: "X", travelCost: "-5", travelCooldownSeconds: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403s a non-admin", async () => {
    const p = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Pleb", password: "hunter2hunter2" },
    });
    const res = await app.inject({
      method: "GET", url: "/api/admin/travel/locations",
      headers: { authorization: `Bearer ${p.json().token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure** — 404s (routes absent).

- [ ] **Step 3: Implement in `packages/plugins/travel/src/index.ts`**

Body schemas (top of file, near the existing zod schemas). Money crosses as decimal string; nonnegative:

```ts
const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");
const TownBodySchema = z.object({
  name: z.string().min(1).max(80),
  travelCost: AdminMoney,
  travelCooldownSeconds: z.number().int().nonnegative(),
}).strict();
const TownUpdateSchema = TownBodySchema.extend({ id: z.string().uuid() }).strict();
```

Routes (mirror the plugin's existing `route({...})` style; `newId()` — check what the travel plugin uses for uuid generation, likely `newId` from the SDK's `id.js`, else `uuidv7`):

```ts
const adminListRoute = route({
  method: "GET", path: "/api/admin/travel/locations", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(locations));
    return {
      status: 200,
      body: {
        rows: rows.map((l) => ({
          id: l.id, name: l.name,
          travelCost: l.travelCost.toString(),
          travelCooldownSeconds: String(l.travelCooldownSeconds),
        })),
      },
    };
  },
});

const adminCreateRoute = route({
  method: "POST", path: "/api/admin/travel/locations", auth: "admin",
  body: TownBodySchema,
  handler: async (ctx, { body }) => {
    const id = newId();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(locations).values({
        id, name: body.name,
        travelCost: BigInt(body.travelCost),
        travelCooldownSeconds: body.travelCooldownSeconds,
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminUpdateRoute = route({
  method: "POST", path: "/api/admin/travel/locations/update", auth: "admin",
  body: TownUpdateSchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db.update(locations)
        .set({
          name: body.name,
          travelCost: BigInt(body.travelCost),
          travelCooldownSeconds: body.travelCooldownSeconds,
        })
        .where(eq(locations.id, body.id))
        .returning({ id: locations.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("location_not_found", 404);
    return { status: 204 };
  },
});
```

Admin page + manifest changes:

```ts
const adminPage: PageSchema = {
  id: "travel-admin",
  path: "/admin/travel",
  view: {
    kind: "panel", title: "Towns",
    children: [
      { kind: "table", source: "GET /api/admin/travel/locations", columns: [
        { key: "id", label: "Id" }, { key: "name", label: "Name" },
        { key: "travelCost", label: "Travel cost" },
        { key: "travelCooldownSeconds", label: "Cooldown (s)" },
      ] },
      { kind: "form", action: "POST /api/admin/travel/locations", submitLabel: "Add town", fields: [
        { name: "name", label: "Name", type: "text" },
        { name: "travelCost", label: "Travel cost", type: "money" },
        { name: "travelCooldownSeconds", label: "Cooldown seconds", type: "number" },
      ] },
      { kind: "form", action: "POST /api/admin/travel/locations/update", submitLabel: "Update town", fields: [
        { name: "id", label: "Town id (paste from table)", type: "text" },
        { name: "name", label: "Name", type: "text" },
        { name: "travelCost", label: "Travel cost", type: "money" },
        { name: "travelCooldownSeconds", label: "Cooldown seconds", type: "number" },
      ] },
    ],
  },
};
```

In `definePlugin` at the bottom: `basePaths: ["/api/locations", "/api/travel", "/api/admin/travel"]`, add the three routes to `routes`, add `adminPages: [adminPage]`.

**Type note:** form `number` fields arrive as strings from the web form (PageRenderer collects string values); `travelCooldownSeconds: z.number()` would reject them over HTTP-from-renderer. Check how existing plugin forms handle numeric bodies (bank deposit uses MoneySchema strings). Use `z.coerce.number().int().nonnegative()` for `travelCooldownSeconds` so both the test's JSON number and the renderer's string parse. Apply the same coercion pattern in Tasks 10–14.

- [ ] **Step 4: Run to verify pass** — `npx vitest run apps/server/test/admin-travel.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/travel apps/server/test/admin-travel.test.ts
git commit -m "feat(travel): admin section — list, add, edit towns"
```

---

### Task 10: Bullets admin section

**Files:**
- Modify: `packages/plugins/bullets/src/index.ts`
- Test: create `apps/server/test/admin-bullets.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/admin/bullets/stock` → `{ rows: [{ id, name, bulletStock, bulletCost }] }` (strings).
  - `POST /api/admin/bullets/stock` body `{ locationId, bulletStock, bulletCost }` → 204; 404 unknown location.

- [ ] **Step 1: Write the failing test** — same skeleton as Task 9 (register Founder → adminToken; non-admin 403 case). Seed a location directly (`db.insert(locations).values({ id: uuidv7(), name: "Palermo" })`), then:

```ts
it("sets stock and price for a location", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/admin/bullets/stock", headers: auth(),
    payload: { locationId, bulletStock: 500, bulletCost: "25" },
  });
  expect(res.statusCode).toBe(204);
  const [row] = await db.select().from(locations).where(eq(locations.id, locationId));
  expect(row?.bulletStock).toBe(500);
  expect(row?.bulletCost).toBe(25n);

  const list = await app.inject({ method: "GET", url: "/api/admin/bullets/stock", headers: auth() });
  expect(list.json().rows).toEqual([
    { id: locationId, name: "Palermo", bulletStock: "500", bulletCost: "25" },
  ]);
});

it("404s an unknown location", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/admin/bullets/stock", headers: auth(),
    payload: { locationId: "00000000-0000-7000-8000-000000000000", bulletStock: 1, bulletCost: "1" },
  });
  expect(res.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — mirror Task 9 exactly: basePath `/api/admin/bullets` added; body schema `{ locationId: z.string().uuid(), bulletStock: z.coerce.number().int().nonnegative(), bulletCost: AdminMoney }`; UPDATE with `.returning` for the 404; adminPage `bullets-admin` at `/admin/bullets` with the stock table + set form. The bullets plugin already mirrors the `locations` table in its own `schema.ts` — reuse that import; single-statement UPDATE takes no explicit lock and adds no lock edge (buy path's `lockLocationForUpdate` is unaffected).

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat(bullets): admin section — per-location stock and price`

---

### Task 11: Inventory admin section (items + shop)

**Files:**
- Modify: `packages/plugins/inventory/src/index.ts`
- Test: create `apps/server/test/admin-inventory.test.ts`

**Interfaces:**
- Consumes: `WeaponEffectsSchema` / `ArmorEffectsSchema` / `ConsumableEffectsSchema` and `ITEM_TYPE_*` constants from `packages/plugins/inventory/src/effects.ts`; `items` + `shopStock` schema mirrors.
- Produces:
  - `GET /api/admin/inventory/items` → `{ rows: [{ id, name, itemType, effects }] }` (effects JSON.stringify'd).
  - `POST /api/admin/inventory/items` body `{ name, itemType: "weapon"|"armor"|"consumable", damageMin?, damageMax?, accuracy?, armor?, heal? }` → 201 `{ id }`. Effects object built per type and parsed through the REAL effects schema before insert — an item combat cannot parse must be uncreatable.
  - `GET /api/admin/inventory/shop` → `{ rows: [{ locationId, locationName, itemId, itemName, price, stock }] }` (inner-join names).
  - `POST /api/admin/inventory/shop` body `{ locationId, itemId, price, stock }` → 204, upsert `ON CONFLICT (location_id, item_id) DO UPDATE`; 404 when locationId or itemId doesn't exist (plain SELECT checks — accepted race per shop-schema.ts's documented orphan tolerance).

- [ ] **Step 1: Write the failing test** — Founder-admin skeleton; cases:

```ts
it("creates a weapon whose effects parse through the combat schema", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/admin/inventory/items", headers: auth(),
    payload: { name: "Lupara", itemType: "weapon", damageMin: 10, damageMax: 20, accuracy: 65 },
  });
  expect(res.statusCode).toBe(201);
  const [row] = await db.select().from(items).where(eq(items.id, res.json().id));
  expect(row?.itemType).toBe("weapon");
  expect(WeaponEffectsSchema.parse(row?.effects)).toMatchObject({ damageMin: 10, damageMax: 20, accuracy: 65 });
});

it("rejects a weapon with damageMax < damageMin", async () => {
  const res = await app.inject({
    method: "POST", url: "/api/admin/inventory/items", headers: auth(),
    payload: { name: "Broken", itemType: "weapon", damageMin: 20, damageMax: 10 },
  });
  expect(res.statusCode).toBe(400);
});

it("stocks the shop and the public listing sees it", async () => {
  // seed location + item, upsert stock twice (insert then update), then
  // GET the PUBLIC shop route for that location and assert the item listed
  // with the second price — proves admin writes feed the player path.
});

it("404s stocking an unknown item", async () => { /* plain SELECT check */ });
```

(Write the two sketched cases in full when creating the file — seed with `db.insert(locations)` / the admin items route, drive the public route the Shop page uses: find it with `grep -n "path: \"/api/shop" packages/plugins/inventory/src/shop.ts`.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Item-create body schema uses a discriminated union on `itemType` so the flat fields are per-type:

```ts
const ItemBodySchema = z.discriminatedUnion("itemType", [
  z.object({
    itemType: z.literal("weapon"), name: z.string().min(1).max(80),
    damageMin: z.coerce.number().int().nonnegative(),
    damageMax: z.coerce.number().int().nonnegative(),
    accuracy: z.coerce.number().int().min(0).max(100).optional(),
  }).strict(),
  z.object({
    itemType: z.literal("armor"), name: z.string().min(1).max(80),
    armor: z.coerce.number().int().nonnegative(),
  }).strict(),
  z.object({
    itemType: z.literal("consumable"), name: z.string().min(1).max(80),
    heal: z.coerce.number().int().positive(),
  }).strict(),
]);
```

Handler builds the effects candidate from the branch, then round-trips it through the real schema (`WeaponEffectsSchema.parse(...)` etc.) before insert — the parse errors become a `PluginError("invalid_effects", 400)` via try/catch. `damageMax >= damageMin` is enforced by the schema's `.refine` at that parse. Shop upsert: drizzle `.onConflictDoUpdate({ target: [shopStock.locationId, shopStock.itemId], set: { price, stock } })`.

Admin page `inventory-admin` at `/admin/inventory`: panel "Items" (items table + three create forms — one per item type, labeled "Add weapon" / "Add armor" / "Add consumable"; one form per type beats one form with dead fields) and panel "Shop stock" (shop table + stock form with locationId/itemId/price/stock fields). basePath `/api/admin/inventory`.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `feat(inventory): admin section — item creation and shop stocking`

---

### Task 12: News admin — replace the hand-rolled gate

**Files:**
- Modify: `packages/plugins/news/src/index.ts`
- Modify: `apps/server/test/news.test.ts`
- Test: extend `apps/server/test/news.test.ts`

**Interfaces:**
- Consumes: `auth: "admin"` gate.
- Produces: post route gated by the loader (`auth: "admin"`, moduleKey `news`); inline role/module scan deleted; `GET /api/admin/news` table source; `news-admin` admin page. **User requirement: replace existing permission checks with the new system — this task is that replacement.**

- [ ] **Step 1: Read `packages/plugins/news/src/index.ts` in full.** Find the post route and the transaction block quoted at lines ~50–68 (role lookup + `roleModuleAccess` scan).

- [ ] **Step 2: Update tests FIRST** in `apps/server/test/news.test.ts`:
  - The three gate tests (no role → 403; different-module role → 403; `*` → allowed) keep their names and assertions — they now exercise the loader gate. They should pass unchanged after the switch; if any asserted on a body shape the inline gate produced, align to `{ error: "forbidden" }`.
  - Delete/repoint any test comment referencing `hasModuleAccess` internals.
  - Add: `GET /api/admin/news` returns recent rows for the staff role and 403s the regular player.

- [ ] **Step 3: Run to see current state** — gate tests still pass (old gate), new admin-list test FAILS.

- [ ] **Step 4: Implement.**
  - Post route: add `auth: "admin"`, delete the author-role lookup and grants scan from the transaction (keep the author username SELECT if the insert/event needs it).
  - Add `GET /api/admin/news` (`auth: "admin"`): last 50 news rows as `{ rows: [{ id, title, createdAt }] }` (stringified).
  - Add basePath `/api/admin/news`; admin page `news-admin` at `/admin/news`: post form (title text, body text) + recent-news table.
  - **Removal check:** `grep -n "roleModuleAccess" packages/plugins/news/src/index.ts` must return nothing after this task.

- [ ] **Step 5: Run to verify pass** — `npx vitest run apps/server/test/news.test.ts`
Expected: PASS including the three original gate tests, proving behavior parity.

- [ ] **Step 6: Commit** — `refactor(news): posting gate moves to the loader's auth-admin tier`

---

### Task 13: Crimes + ranks admin sections

**Files:**
- Modify: `packages/plugins/crimes/src/index.ts`, `packages/plugins/ranks/src/index.ts`
- Test: create `apps/server/test/admin-crimes.test.ts`, `apps/server/test/admin-ranks.test.ts`

Two sections in one task because they are the same shape as Task 9 with different columns and no create route (V2 games ship seeded crime/rank lists; admin edits balance numbers — creating a crime/rank is out of scope, matching "deletes deferred").

**Interfaces:**
- Produces:
  - `GET /api/admin/crimes/list` → rows `{ id, name, cooldownSeconds, minPayout, maxPayout, expReward, jailChancePercent, jailSeconds }` (strings). `POST /api/admin/crimes/update` body `{ id, cooldownSeconds, minPayout, maxPayout, expReward, jailChancePercent, jailSeconds }` → 204/404. Refine `maxPayout >= minPayout` (a violated bound would make the worker's payout roll throw or silently invert).
  - `GET /api/admin/ranks/list` → rows `{ id, name, expRequired, cashReward, bulletReward, maxHealth }`. `POST /api/admin/ranks/update` body same fields + id → 204/404.
- basePaths `/api/admin/crimes`, `/api/admin/ranks`; pages `crimes-admin` (`/admin/crimes`), `ranks-admin` (`/admin/ranks`) — table + edit form each.

- [ ] **Step 1: Write both failing test files** — Founder-admin skeleton; per file: list shows seeded row (seed one crime/rank via `db.insert`), update mutates + row assert (bigints compared as `123n`), 404 unknown id, 400 on `maxPayout < minPayout` (crimes only), 403 non-admin.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — Task 9's exact pattern. Note crimes routes live under `/api/admin/crimes/list` and `/api/admin/crimes/update` (not bare `/api/admin/crimes`) so the basePath containment stays simple.
- [ ] **Step 4: Run both files to verify pass.**
- [ ] **Step 5: Commit** — `feat(crimes,ranks): admin sections — balance-number editing`

---

### Task 14: Web renderer — `table` instruction

**Files:**
- Modify: `apps/web/src/plugins/render.ts`
- Modify: `apps/web/src/plugins/PageRenderer.tsx`
- Test: extend the web test file covering render/PageRenderer (find with `ls apps/web/src/**/*.test.* apps/web/test 2>/dev/null` or `grep -rln "renderNode" apps/web --include=*.test.*`)

**Interfaces:**
- Consumes: DTO `table` node (Task 3), `TableRowsResponseSchema` from `@gl3/shared`.
- Produces: `RenderInstruction` union gains `{ kind: "table"; source: string; columns: { key: string; label: string }[] }`; PageRenderer fetches `source` via the existing `api()` helper on mount, renders an HTML table, refetches after any successful `runAction` on the page.

- [ ] **Step 1: Write the failing tests** — follow the existing render test style:

```ts
it("maps a table node to a table instruction", () => {
  const out = renderNode({
    kind: "table", source: "GET /api/admin/travel/locations",
    columns: [{ key: "id", label: "Id" }],
  }, {});
  expect(out).toEqual([{
    kind: "table", source: "GET /api/admin/travel/locations",
    columns: [{ key: "id", label: "Id" }],
  }]);
});
```

Plus a PageRenderer test if the existing suite has component tests (check for `@testing-library` usage); if the web suite only tests pure functions, the render.ts test is the required minimum and PageRenderer behavior is covered by Task 16's page-level test.

- [ ] **Step 2: Run to verify failure** — `npx vitest run` scoped to the web project's test file.

- [ ] **Step 3: Implement.**

`render.ts`: add to the `RenderInstruction` union and a `renderNode` branch:

```ts
if (isNode(node, "table")) {
  const columns = childArray(node.columns).map((c) => ({
    key: isRecord(c) ? String(c.key) : "",
    label: isRecord(c) ? String(c.label) : "",
  }));
  return [{ kind: "table", source: String(node.source), columns }];
}
```

`PageRenderer.tsx`: a `TableBlock` component — `useQuery` keyed on the source path, `queryFn` strips the `"GET "` prefix and calls the existing `api()` helper, parses with `TableRowsResponseSchema`, renders `<table>` with the declared columns (`row[col.key] ?? ""` per cell), `Loading`/`ErrorText` states. Refetch-after-action: `runAction`'s success path invalidates the table queries on this page (`queryClient.invalidateQueries` with the page-scoped key prefix). Match existing styling via `pages.module.css` / `ui.tsx` conventions — look at how `keyValue` renders and sit next to it.

- [ ] **Step 4: Run web tests + typecheck** — `npm run typecheck` and the web project tests.

- [ ] **Step 5: Commit** — `feat(web): table view node — fetch-on-mount rows with post-action refetch`

---

### Task 15: Web /admin page + nav link

**Files:**
- Create: `apps/web/src/pages/Admin.tsx`
- Modify: `apps/web/src/App.tsx` (route), `apps/web/src/components/Shell.tsx` (nav link), `apps/web/src/api/queries.ts` (`useAdminSections`), `apps/web/src/api/keys.ts` (query key)
- Test: web test for the sections query parsing + (if component tests exist) an Admin page render test

**Interfaces:**
- Consumes: `GET /api/admin/plugins` payload (Task 8), `me.grants` (Task 7), PageRenderer + renderNode (Task 14).
- Produces: `/admin` route; "Admin" NavLink in Shell visible when `me.data.grants.length > 0`.

- [ ] **Step 1: Define the DTO** in `packages/shared/src/dto/plugins.ts`: `AdminSectionsResponseSchema = z.object({ sections: z.array(z.object({ pluginId: z.string(), pages: z.array(PageDtoSchema) }).strict()) }).strict()` — reusing the file's existing page DTO schema (find its exported name; it's whatever `PluginsPayload.pages` elements parse with).

- [ ] **Step 2: `useAdminSections` in queries.ts** — mirror `usePlugins`: `useQuery({ queryKey: keys.adminSections, queryFn: async () => AdminSectionsResponseSchema.parse(await api("/api/admin/plugins")), enabled: (me.data?.grants.length ?? 0) > 0 })`. Note `api()` must surface the 403 as an error, which `ErrorText` renders — check how `api()` treats non-2xx (existing pattern).

- [ ] **Step 3: `Admin.tsx`** — sections list: for each section, render its pages' views through `renderNode` + `<PageRenderer key={...}>` per page (key = `${section.pluginId}:${page.id}` — the Shell's documented form-state-bleed bug class). A simple vertical layout matching existing pages is fine; no tabs needed for v1 (sections are panels with titles already).

- [ ] **Step 4: Route + nav.** `App.tsx`: `<Route path="admin" element={<Admin />} />`. `Shell.tsx`: after the `LINKS` map, conditionally render `<NavLink to="/admin">Admin</NavLink>` (same class pattern as siblings) when `me.data && me.data.grants.length > 0`.

- [ ] **Step 5: Tests** — DTO parse test (valid payload parses; extra key rejected — `.strict()` proof) in the web/shared test suite; component test only if the suite already does component tests.

- [ ] **Step 6: Typecheck + web tests + commit** — `feat(web): /admin page rendering plugin admin sections, grant-gated nav`

---

### Task 16: Acceptance test — plugin-absence and end-to-end admin flow

**Files:**
- Create: `apps/server/test/admin-acceptance.test.ts`

**Interfaces:** consumes everything above.

- [ ] **Step 1: Write the test.** Two-boot structure in one file (two `bootTestServer` calls, sequential — never parallel suites, this is one file):
  1. Boot A (all core plugins, default): Founder registers (→ admin). `GET /api/admin/plugins` lists sections including `travel`, `bullets`, `inventory`, `news`, `crimes`, `ranks`, `roles`. Founder: creates a town; sets its bullet stock; creates an item; stocks the shop with it; posts news. Then a SECOND player registers, travels is irrelevant — assert the PUBLIC surfaces see admin's work: locations list contains the town, shop listing at that location contains the item, news list contains the post. This is the "admin fills the game world, player sees it" acceptance.
  2. Boot B (`bootTestServer({ plugins: [] })` — but core plugins always load via `withCorePlugins`, so instead pick the one optional-manifest seam: read `apps/server/src/plugins/core-plugins.ts` to determine whether any of the six admin-bearing plugins can be excluded; if all six are CORE_PLUGINS and cannot be excluded, replace Boot B with the already-shipped Task 8 test (custom `alpha`/`beta` manifests prove present-only-when-loaded) and note that here — do NOT fight the core-plugin invariant.
- [ ] **Step 2: Run, verify the flow passes.**
- [ ] **Step 3: Commit** — `test(admin): acceptance — admin fills the world, players see it`

---

### Task 17: Docs, full verification, merge readiness

**Files:**
- Modify: `docs/STATUS.md`, `CLAUDE.md` (current-state paragraphs), `docs/ENGINEERING-NOTES.md` (authz paragraph)

- [ ] **Step 1: Docs.**
  - `docs/STATUS.md`: admin+ABAC shipped on `feat/admin-abac` — first-user-admin (advisory-lock protected), `auth: "admin"` loader tier over `role_module_access` grants, `adminPages` + `table` node, six plugin sections + core role management; test-count delta.
  - `docs/ENGINEERING-NOTES.md`: authorization model — role → module grants → `hasPermission`; why the ABAC gist's predicate level is deferred; why `/api/admin` is not wholesale-reserved (plugins claim `/api/admin/<id>`); the first-registration advisory lock.
  - `CLAUDE.md`: one paragraph in "Current state"; add to conventions if anything general emerged (e.g. "`/api/admin/` routes must declare `auth: \"admin\"` — enforced at boot").
- [ ] **Step 2: Full verify.** `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"` — exit code 0 required. Run twice back-to-back (repo convention for green claims).
- [ ] **Step 3: Commit docs** — `docs: record admin + ABAC in STATUS, CLAUDE and ENGINEERING-NOTES`
- [ ] **Step 4: Finish the branch** — invoke `superpowers:finishing-a-development-branch` (goal is merged to `main`; CI's `verify:ci` + `images` must pass on the PR; remember CI does NOT run the integration suite — the local double-verify in Step 2 is the real gate).
