# M5 Plugin SDK — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@gl3/plugin-sdk`, a boot-time loader, and a third-party example plugin, so a package outside `apps/server` can add tables, routes, jobs, events and a page to a running GL3 server without editing core.

**Architecture:** A new workspace package `packages/plugin-sdk` holds the manifest types, `definePlugin`, filter tokens, page-schema vocabulary and the plugin-facing `ctx` interfaces — and nothing else; it has no runtime dependency on the server. `apps/server/src/plugins/` implements the loader that validates manifests, applies plugin migrations, builds a `ctx` per request or job, and registers routes on the same Fastify instance `app.ts` already uses. Plugins depend on the SDK; the server depends on the SDK; nothing depends on a plugin except the boot list in config. Strangler, per the spec: this plan adds the second registration path and changes zero existing routes.

**Tech Stack:** Node 22 ESM, TypeScript 5.6 strict (`composite`, project references), Fastify 5, Drizzle ORM 0.45, PostgreSQL 16, ioredis 5, BullMQ 5, zod 3, vitest 2.

## Global Constraints

Copied from `docs/superpowers/specs/2026-08-09-plugin-sdk-design.md` and `CLAUDE.md`. Every task below inherits these.

- **M5 changes no HTTP response.** Same paths, statuses, error strings, bodies, headers. The existing integration suite must pass **unmodified** — a test file edited to accommodate this work is a failed task, not a passing one. New tests for new SDK behaviour are expected and fine.
- **No `any` in `packages/*`** — none, not even a cast. `packages/plugin-sdk` is bound by this. Prefer `unknown` plus a zod parse.
- ESM only. Relative imports carry a `.js` extension despite `.ts` sources.
- Zod-validates **every** external boundary — HTTP bodies, **route params**, WS frames, bus messages, and plugin manifests.
- Money is `bigint` in Postgres and TypeScript and crosses the wire as a **decimal string** (`MoneySchema`). Never a JSON number.
- Bigint column defaults are written `` .default(sql`0`) ``, never `.default(0n)` — drizzle-kit's serialiser crashes on `BigInt`.
- Integration tests run against **real** Postgres and Redis. No mocks for DB, queue or bus paths, ever.
- Conventional Commits. Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Cooldown keys stay byte-identical to today's**: `cooldown:<action>:<playerId>`, with no plugin-id namespacing. The ports in the follow-on plan depend on this; changing it changes behaviour.
- **The jail guard's response is exactly** `423 { error: "jailed", remainingSeconds }`, produced after `releaseIfExpired(db, redis, playerId)` — matching `game/crimes/routes.ts:56`, `game/bullets/routes.ts:20`, `game/travel/routes.ts:43`.
- **Rule 1 (BullMQ is at-least-once):** a job-context `ctx.transaction` inserts `plugin_job_runs (plugin_id, job_id)` — UNIQUE, first, inside the same transaction — before the handler body runs.
- **Rule 2 (never check-then-act on Redis):** `SET NX EX`, `GETDEL`, or Lua. `ctx.cooldown` exposes no read-then-write pair.
- **Rule 3 (every balance movement goes through `applyBalanceChange`):** `players`/`player_stats` are in no plugin's tables; `tx.economy.applyBalanceChange` is the only path.
- **Rule 5 (publish events only after commit):** `tx.events.publish` buffers; the loader flushes after commit and drops on rollback.
- **Rule 6 (a foreign key is a lock):** unchanged and still human. `tx.locks.gangAndPlayer` wraps `lockGangAndPlayerForUpdate`; `test/gang-lock-order.test.ts` stays the net.
- **Rule 4 (tests filter `game:events` by their own `actorId`)** via `awaitOwnEvent()` from `test/helpers/events.ts`.
- Plugin tables are named `p_<pluginId>_<table>`. Core tables keep their names and stay core-owned.
- `/api/auth` and `/api/ws` are reserved to core. A plugin may only register under its own declared `basePaths`.
- Every loader failure is a **hard boot failure naming the plugin id**.
- **Verification runs locally.** CI does not run the integration suite. Before each commit:
  ```bash
  export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
  export REDIS_URL=redis://localhost:6379
  npm run verify
  ```
- **Never run two full test suites at once.** **Never run `FLUSHALL`/`FLUSHDB`.** `maxWorkers` stays 6.
- Every new test is shown failing before it passes.

## Scope

**This plan (foundation):** the SDK package, the loader, `ctx`, the two core runtime tables, `GET /api/plugins`, the `plugin.event` envelope, and `examples/hello-plugin` booting on a real server.

**Not this plan:** the declarative page renderer and override registry in `apps/web` (plan 2), and the twelve `game/*` module ports (plan 3). Both consume interfaces this plan produces, which is why they are written after it lands rather than now.

## File Structure

| File | Responsibility |
|---|---|
| `packages/plugin-sdk/package.json` · `tsconfig.json` | Workspace package; deps `zod`, `drizzle-orm`, `@gl3/shared` |
| `packages/plugin-sdk/src/errors.ts` | `PluginError`, `JobAlreadyAppliedError` |
| `packages/plugin-sdk/src/ctx.ts` | `PluginCtx`, `PluginTx`, `PlayerSnapshot`, `PluginDbTx` — interfaces only, no implementation |
| `packages/plugin-sdk/src/route.ts` | `route()`, `PluginRoute`, `RouteInput`, `RouteResult` |
| `packages/plugin-sdk/src/filters.ts` | `filterPoint()`, `on()`, `runFilterChain()` |
| `packages/plugin-sdk/src/pages.ts` | Page-schema vocabulary (zod), `PageSchema`, `MenuEntry` |
| `packages/plugin-sdk/src/events.ts` | Plugin event declaration + `renderDescribe()` template |
| `packages/plugin-sdk/src/manifest.ts` | `definePlugin()`, `PluginManifest`, `PluginManifestSchema` |
| `packages/plugin-sdk/src/index.ts` | Public surface re-export |
| `apps/server/src/db/schema/plugins.ts` | `pluginMigrations`, `pluginJobRuns` core tables |
| `apps/server/drizzle/0004_plugin_runtime.sql` | Migration creating both |
| `apps/server/src/plugins/validate.ts` | Manifest zod pass + prefix/basePath/reserved-path collision checks (no I/O) |
| `apps/server/src/plugins/migrate.ts` | Applies plugin migrations in plugin-id order, tracked, idempotent |
| `apps/server/src/plugins/ctx.ts` | The real `ctx`: transaction, buffered events, economy, locks, cooldown, jobs, settings, log |
| `apps/server/src/plugins/routes.ts` | Fastify registration: auth, jail guard, zod validation, `PluginError` mapping |
| `apps/server/src/plugins/manifest-endpoint.ts` | `GET /api/plugins` payload build + cache |
| `apps/server/src/plugins/loader.ts` | Boot sequence orchestration, exported `loadPlugins()` |
| `examples/hello-plugin/` | Third-party example: one table, one migration, one route, one job, one event, one page |

---
### Task 1: Scaffold `@gl3/plugin-sdk` and `definePlugin`

**Files:**
- Create: `packages/plugin-sdk/package.json`, `packages/plugin-sdk/tsconfig.json`, `packages/plugin-sdk/src/errors.ts`, `packages/plugin-sdk/src/manifest.ts`, `packages/plugin-sdk/src/index.ts`
- Modify: `tsconfig.json` (root, add reference), `package.json` (root, `test:nodb` script)
- Test: `packages/plugin-sdk/test/manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `definePlugin(input: PluginManifestInput): PluginManifest`; `PluginManifest` with every field required and array/record fields defaulted to empty; `PluginError` with `code: string`, `status: number`, `extra: Record<string, unknown>`; `PLUGIN_ID_PATTERN`, `SEMVER_PATTERN`.

- [ ] **Step 1: Create the package manifest and tsconfig**

`packages/plugin-sdk/package.json`:
```json
{
  "name": "@gl3/plugin-sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": { "@gl3/shared": "*", "drizzle-orm": "^0.45.2", "zod": "^3.23.8" }
}
```

`packages/plugin-sdk/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../shared" }]
}
```

Add the reference to the root `tsconfig.json` (before `./apps/server`, which will depend on it):
```json
{
  "files": [],
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/plugin-sdk" },
    { "path": "./apps/server" },
    { "path": "./apps/web" }
  ]
}
```

Add the project to the no-DB script in the root `package.json` so CI runs SDK tests:
```json
"test:nodb": "vitest run --project @gl3/server:unit --project @gl3/shared --project @gl3/plugin-sdk --project @gl3/web",
```

Then `npm install` to link the workspace.

- [ ] **Step 2: Write the failing test**

`packages/plugin-sdk/test/manifest.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/index.js";

const valid = { id: "bounties", version: "1.0.0", basePaths: ["/api/bounties"] };

describe("definePlugin", () => {
  it("defaults every collection field so consumers never handle undefined", () => {
    const manifest = definePlugin(valid);
    expect(manifest.routes).toEqual([]);
    expect(manifest.migrations).toEqual([]);
    expect(manifest.pages).toEqual([]);
    expect(manifest.events).toEqual([]);
    expect(manifest.filters).toEqual([]);
    expect(manifest.provides).toEqual([]);
    expect(manifest.tables).toEqual({});
    expect(manifest.jobs).toEqual({});
  });

  it("rejects an id that is not lowercase kebab-case", () => {
    expect(() => definePlugin({ ...valid, id: "Bounties" })).toThrow(/plugin id/);
  });

  it("rejects a version that is not semver", () => {
    expect(() => definePlugin({ ...valid, version: "1.0" })).toThrow(/semver/);
  });

  it("rejects a basePath outside /api", () => {
    expect(() => definePlugin({ ...valid, basePaths: ["/bounties"] })).toThrow(/basePath/);
  });

  it("rejects an empty basePaths list", () => {
    expect(() => definePlugin({ ...valid, basePaths: [] })).toThrow();
  });

  it("names the plugin in the error message", () => {
    expect(() => definePlugin({ ...valid, version: "x" })).toThrow(/bounties/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/plugin-sdk`
Expected: FAIL — `Failed to resolve import "../src/index.js"`.

- [ ] **Step 4: Write `errors.ts`**

```ts
/**
 * The only error type a plugin route handler is expected to throw. The loader
 * maps it to `reply.code(status).send({ error: code, ...extra })`, which is how
 * ported modules keep their existing status codes and error strings byte for
 * byte (spec: "M5 changes no HTTP response").
 */
export class PluginError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "PluginError";
  }
}

/**
 * Thrown by a job-context `ctx.transaction` when `plugin_job_runs` already has
 * this (plugin_id, job_id). BullMQ is at-least-once, so this is the expected
 * outcome of a retry after a committed run — the worker wrapper treats it as
 * success, not failure (CLAUDE.md rule 1).
 */
export class JobAlreadyAppliedError extends Error {
  constructor(readonly pluginId: string, readonly jobId: string) {
    super(`job ${jobId} already applied for plugin ${pluginId}`);
    this.name = "JobAlreadyAppliedError";
  }
}
```

- [ ] **Step 5: Write `manifest.ts`**

```ts
import { z } from "zod";

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export interface PluginMigration { name: string; sql: string }

const MigrationSchema = z.object({ name: z.string().min(1), sql: z.string().min(1) }).strict();

/**
 * Validated at definition time rather than only at boot, so a malformed
 * manifest fails on `import` with the plugin's own id in the message. The
 * loader re-checks cross-plugin concerns (collisions) it cannot see from here.
 *
 * Function-bearing fields are `z.unknown()`: their shape is enforced by the
 * TypeScript types, and a zod schema over a function would only assert
 * `typeof === "function"`. `.strict()` is what rejects unknown fields.
 */
const InputSchema = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN, "plugin id must be lowercase kebab-case"),
  version: z.string().regex(SEMVER_PATTERN, "version must be semver x.y.z"),
  basePaths: z.array(
    z.string().regex(/^\/api\/[a-z0-9-]+(\/[a-z0-9-]+)*$/, "basePath must look like /api/<name>"),
  ).min(1),
  tables: z.record(z.unknown()).optional(),
  migrations: z.array(MigrationSchema).optional(),
  routes: z.array(z.unknown()).optional(),
  pages: z.array(z.unknown()).optional(),
  events: z.array(z.unknown()).optional(),
  jobs: z.record(z.unknown()).optional(),
  provides: z.array(z.unknown()).optional(),
  filters: z.array(z.unknown()).optional(),
}).strict();

export function definePlugin(input: PluginManifestInput): PluginManifest {
  const result = InputSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
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
```

Declare the two interfaces in the same file. `PluginManifestInput` has every collection optional; `PluginManifest` has all of them required — normalising once here is what stops every downstream consumer from writing `?? []` under `exactOptionalPropertyTypes`. For now type the collections as `unknown[]` / `Record<string, unknown>`; Tasks 2, 3, 4 and 10 replace each with its real type as it is defined.

- [ ] **Step 6: Write `index.ts`**

```ts
export { PluginError, JobAlreadyAppliedError } from "./errors.js";
export {
  definePlugin, PLUGIN_ID_PATTERN, SEMVER_PATTERN,
  type PluginManifest, type PluginManifestInput, type PluginMigration,
} from "./manifest.js";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/plugin-sdk`
Expected: PASS, 6 tests.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add packages/plugin-sdk tsconfig.json package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(plugin-sdk): scaffold package with definePlugin manifest validation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Filter points and the chain runner

**Files:**
- Create: `packages/plugin-sdk/src/filters.ts`
- Modify: `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/src/manifest.ts` (type `provides` and `filters`)
- Test: `packages/plugin-sdk/test/filters.test.ts`

**Interfaces:**
- Consumes: `PluginManifest` (Task 1).
- Produces: `filterPoint<T>(name: string): FilterPoint<T>`; `on<T>(point: FilterPoint<T>, fn: FilterFn<T>, order?: number): FilterSubscription`; `runFilterChain<T>(subscriptions: readonly FilterSubscription[], point: FilterPoint<T>, ctx: PluginCtx, value: T): Promise<T>`. `FilterSubscription` carries `{ pointName: string; order: number; run(ctx: PluginCtx, value: unknown): Promise<unknown> }`.

- [ ] **Step 1: Write the failing test**

`packages/plugin-sdk/test/filters.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { filterPoint, on, runFilterChain } from "../src/index.js";
import type { PluginCtx } from "../src/index.js";

interface Crime { name: string; cooldownSeconds: number }
const beforeResolve = filterPoint<Crime>("crimes.beforeResolve");
const other = filterPoint<Crime>("crimes.afterResolve");

// The chain never reads ctx in these tests; the cast documents that rather
// than building a fake server (no mocks for DB/queue/bus paths — this is
// neither, it is an unused argument).
const ctx = {} as unknown as PluginCtx;

describe("runFilterChain", () => {
  it("returns the input unchanged when nothing subscribes", async () => {
    const crime: Crime = { name: "Pickpocket", cooldownSeconds: 30 };
    expect(await runFilterChain([], beforeResolve, ctx, crime)).toEqual(crime);
  });

  it("feeds each subscriber the previous one's return value", async () => {
    const subs = [
      on(beforeResolve, (_c, crime) => ({ ...crime, cooldownSeconds: crime.cooldownSeconds * 2 })),
      on(beforeResolve, (_c, crime) => ({ ...crime, cooldownSeconds: crime.cooldownSeconds + 1 })),
    ];
    const out = await runFilterChain(subs, beforeResolve, ctx, { name: "P", cooldownSeconds: 30 });
    expect(out.cooldownSeconds).toBe(61);
  });

  it("runs subscribers in declared sort order, not registration order", async () => {
    const seen: number[] = [];
    const subs = [
      on(beforeResolve, (_c, crime) => { seen.push(2); return crime; }, 20),
      on(beforeResolve, (_c, crime) => { seen.push(1); return crime; }, 10),
    ];
    await runFilterChain(subs, beforeResolve, ctx, { name: "P", cooldownSeconds: 1 });
    expect(seen).toEqual([1, 2]);
  });

  it("ignores subscribers registered against a different point", async () => {
    const subs = [on(other, (_c, crime) => ({ ...crime, cooldownSeconds: 999 }))];
    const out = await runFilterChain(subs, beforeResolve, ctx, { name: "P", cooldownSeconds: 30 });
    expect(out.cooldownSeconds).toBe(30);
  });

  it("awaits async subscribers", async () => {
    const subs = [on(beforeResolve, async (_c, crime) => ({ ...crime, cooldownSeconds: 7 }))];
    const out = await runFilterChain(subs, beforeResolve, ctx, { name: "P", cooldownSeconds: 30 });
    expect(out.cooldownSeconds).toBe(7);
  });

  it("rejects two points sharing a name", () => {
    expect(() => filterPoint<Crime>("crimes.beforeResolve")).toThrow(/already declared/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/plugin-sdk filters`
Expected: FAIL — `filterPoint is not exported`.

- [ ] **Step 3: Write `filters.ts`**

```ts
import type { PluginCtx } from "./ctx.js";

/**
 * A typed token identifying a hook point. The plugin that owns the point
 * exports the token; subscribers import it from that package, which is what
 * makes cross-plugin filters type-safe without a global registry (spec:
 * Filters). The phantom `_type` field exists only to make `FilterPoint<Crime>`
 * and `FilterPoint<Gang>` structurally distinct to the compiler.
 */
export interface FilterPoint<T> { readonly name: string; readonly _type?: (value: T) => T }

export type FilterFn<T> = (ctx: PluginCtx, value: T) => T | Promise<T>;

export interface FilterSubscription {
  readonly pointName: string;
  readonly order: number;
  run(ctx: PluginCtx, value: unknown): Promise<unknown>;
}

const declared = new Set<string>();

export function filterPoint<T>(name: string): FilterPoint<T> {
  if (declared.has(name)) throw new Error(`filter point "${name}" already declared`);
  declared.add(name);
  return { name };
}

/** `order` defaults to 100 so a subscriber can sort before or after the norm. */
export function on<T>(point: FilterPoint<T>, fn: FilterFn<T>, order = 100): FilterSubscription {
  return {
    pointName: point.name,
    order,
    async run(ctx: PluginCtx, value: unknown): Promise<unknown> {
      // `value` re-enters as T: runFilterChain only ever routes a point's own
      // value here, and the chain's public signature is what enforces that.
      return await fn(ctx, value as T);
    },
  };
}

/**
 * Filters run outside any transaction (spec: Filters) — a filter cannot
 * participate in the caller's write, so a slow subscriber cannot hold a row
 * lock open.
 */
export async function runFilterChain<T>(
  subscriptions: readonly FilterSubscription[],
  point: FilterPoint<T>,
  ctx: PluginCtx,
  value: T,
): Promise<T> {
  const chain = subscriptions
    .filter((s) => s.pointName === point.name)
    .sort((a, b) => a.order - b.order);
  let current: unknown = value;
  for (const subscription of chain) current = await subscription.run(ctx, current);
  return current as T;
}
```

`ctx.js` does not exist yet — create `packages/plugin-sdk/src/ctx.ts` with `export interface PluginCtx { readonly pluginId: string }` as a stub. Task 8 fills it in.

- [ ] **Step 4: Export from `index.ts` and type the manifest fields**

Add to `index.ts`:
```ts
export { filterPoint, on, runFilterChain, type FilterPoint, type FilterFn, type FilterSubscription } from "./filters.js";
export type { PluginCtx } from "./ctx.js";
```

In `manifest.ts`, change `provides: unknown[]` to `provides: FilterPoint<unknown>[]` and `filters: unknown[]` to `filters: FilterSubscription[]` in both `PluginManifest` and `PluginManifestInput`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/plugin-sdk`
Expected: PASS, 12 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add packages/plugin-sdk
git commit -m "$(cat <<'EOF'
feat(plugin-sdk): add typed filter points and ordered chain runner

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Page schema vocabulary and menu descriptor

**Files:**
- Create: `packages/plugin-sdk/src/pages.ts`
- Modify: `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/src/manifest.ts` (type `pages`)
- Test: `packages/plugin-sdk/test/pages.test.ts`

**Interfaces:**
- Consumes: `PluginManifest` (Task 1).
- Produces: `PageSchema` (`{ id, path, menu, view }`), `ViewNode` (the ten-node union), `PageSchemaSchema` (zod), `MenuEntry` (`{ label, order }`).

- [ ] **Step 1: Write the failing test**

`packages/plugin-sdk/test/pages.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { PageSchemaSchema } from "../src/index.js";

const page = {
  id: "hello.index",
  path: "/hello",
  menu: { label: "Hello", order: 50 },
  view: {
    kind: "panel",
    title: "Hello",
    children: [
      { kind: "text", value: "Say hello to the server." },
      { kind: "keyValue", rows: [{ label: "Greetings", value: "0" }] },
      { kind: "money", value: "1000" },
      { kind: "cooldownButton", label: "Greet", action: "POST /api/hello/greet", cooldownAction: "hello" },
    ],
  },
};

describe("PageSchemaSchema", () => {
  it("accepts a page built from the v1 vocabulary", () => {
    expect(PageSchemaSchema.parse(page).id).toBe("hello.index");
  });

  it("rejects a node kind outside the v1 vocabulary", () => {
    const bad = { ...page, view: { kind: "panel", title: "x", children: [{ kind: "chart", data: [] }] } };
    expect(() => PageSchemaSchema.parse(bad)).toThrow();
  });

  it("rejects a page whose path is not absolute", () => {
    expect(() => PageSchemaSchema.parse({ ...page, path: "hello" })).toThrow();
  });

  it("makes menu optional so a page can exist without a nav entry", () => {
    const { menu: _menu, ...noMenu } = page;
    expect(PageSchemaSchema.parse(noMenu).menu).toBeUndefined();
  });

  it("rejects unknown fields on a node", () => {
    const bad = { ...page, view: { kind: "text", value: "x", colour: "red" } };
    expect(() => PageSchemaSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/plugin-sdk pages`
Expected: FAIL — `PageSchemaSchema is not exported`.

- [ ] **Step 3: Write `pages.ts`**

The v1 vocabulary is exactly ten node kinds and does not grow in this plan: `panel`, `list`, `keyValue`, `form`, `button`, `cooldownButton`, `money`, `text`, `link`, `error`. A core page needing more goes to a bespoke React override (plan 2), not to a bigger schema.

```ts
import { z } from "zod";

const Leaf = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), value: z.string() }).strict(),
  z.object({ kind: z.literal("money"), value: z.string() }).strict(),
  z.object({ kind: z.literal("error"), value: z.string() }).strict(),
  z.object({ kind: z.literal("link"), label: z.string(), to: z.string() }).strict(),
  z.object({ kind: z.literal("button"), label: z.string(), action: z.string() }).strict(),
  z.object({
    kind: z.literal("cooldownButton"), label: z.string(), action: z.string(),
    cooldownAction: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("keyValue"),
    rows: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
  }).strict(),
  z.object({
    kind: z.literal("form"), action: z.string(), submitLabel: z.string(),
    fields: z.array(z.object({
      name: z.string(), label: z.string(),
      type: z.enum(["text", "number", "money", "password"]),
    }).strict()),
  }).strict(),
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
export const ViewNodeSchema: z.ZodType<ViewNode> = z.lazy(() => z.union([
  Leaf,
  z.object({ kind: z.literal("panel"), title: z.string(), children: z.array(ViewNodeSchema) }).strict(),
  z.object({ kind: z.literal("list"), items: z.array(ViewNodeSchema) }).strict(),
]));

export const MenuEntrySchema = z.object({ label: z.string().min(1), order: z.number().int() }).strict();

export const PageSchemaSchema = z.object({
  id: z.string().min(1),
  path: z.string().regex(/^\/[a-z0-9\-/:]*$/, "page path must be absolute"),
  menu: MenuEntrySchema.optional(),
  view: ViewNodeSchema,
}).strict();

export type MenuEntry = z.infer<typeof MenuEntrySchema>;
export type PageSchema = z.infer<typeof PageSchemaSchema>;
```

- [ ] **Step 4: Export and type the manifest field**

Add to `index.ts`:
```ts
export { PageSchemaSchema, ViewNodeSchema, MenuEntrySchema, type PageSchema, type ViewNode, type MenuEntry } from "./pages.js";
```
In `manifest.ts`, change `pages: unknown[]` to `pages: PageSchema[]` in both interfaces.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/plugin-sdk`
Expected: PASS, 17 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add packages/plugin-sdk
git commit -m "$(cat <<'EOF'
feat(plugin-sdk): add v1 declarative page vocabulary

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The `plugin.event` envelope

**Files:**
- Create: `packages/plugin-sdk/src/events.ts`
- Modify: `packages/shared/src/events.ts` (append one variant), `apps/web/src/components/EventFeed.tsx` (`describe`), `apps/web/src/ws/invalidation.ts` (`invalidationKeys`), `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/src/manifest.ts`
- Test: `packages/plugin-sdk/test/events.test.ts`, `apps/web/test/invalidation.test.ts` (existing — extend, do not rewrite)

**Interfaces:**
- Consumes: `PluginManifest` (Task 1).
- Produces: `PluginEventDecl` (`{ name, payload: z.ZodTypeAny, describe: string, invalidates: string[] }`), `renderDescribe(template: string, values: Record<string, unknown>): string`. In `@gl3/shared`: the `plugin.event` variant of `GameEventSchema` carrying `pluginId`, `name`, `payload`.

- [ ] **Step 1: Write the failing test**

`packages/plugin-sdk/test/events.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { renderDescribe } from "../src/index.js";

describe("renderDescribe", () => {
  it("substitutes payload values into the template", () => {
    const out = renderDescribe("{actorName} placed a bounty on {target} for {amount}", {
      actorName: "Ron", target: "Vic", amount: "50000",
    });
    expect(out).toBe("Ron placed a bounty on Vic for 50000");
  });

  it("leaves an unknown placeholder visible rather than printing undefined", () => {
    expect(renderDescribe("{actorName} did {what}", { actorName: "Ron" })).toBe("Ron did {what}");
  });

  it("does not recurse into substituted values", () => {
    expect(renderDescribe("{a}", { a: "{a}" })).toBe("{a}");
  });

  it("renders a template with no placeholders unchanged", () => {
    expect(renderDescribe("something happened", {})).toBe("something happened");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/plugin-sdk events`
Expected: FAIL — `renderDescribe is not exported`.

- [ ] **Step 3: Write `events.ts`**

```ts
import type { z } from "zod";

export interface PluginEventDecl {
  /** Event name, unique within the plugin. Reaches the client as `name`. */
  name: string;
  payload: z.ZodTypeAny;
  /** Template over the payload plus `actorName`, e.g. "{actorName} placed a bounty on {target}". */
  describe: string;
  /** React Query key prefixes this event invalidates on the client. */
  invalidates: string[];
}

/**
 * One non-greedy pass over the template. A single pass — rather than repeated
 * replacement — is what stops a payload value that itself contains braces from
 * being re-expanded, which would let a player-supplied string address other
 * placeholders. An unmatched placeholder stays literal so a manifest typo is
 * visible in the feed instead of rendering "undefined".
 */
export function renderDescribe(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}
```

- [ ] **Step 4: Add the envelope variant to `@gl3/shared`**

Append as the last member of `GameEventSchema`'s discriminated union in `packages/shared/src/events.ts`:
```ts
  /**
   * The envelope every plugin event travels in. The twenty core variants above
   * stay closed and unchanged; ported core modules keep emitting their own
   * typed variants (spec: Events). A plugin declares the payload schema, the
   * `describe` template and the invalidation keys in its manifest, and all
   * three reach the client through GET /api/plugins.
   */
  z.object({
    ...base,
    type: z.literal("plugin.event"),
    pluginId: z.string(),
    name: z.string(),
    payload: z.record(z.unknown()),
  }),
```

- [ ] **Step 5: Handle the new variant in both exhaustive client switches**

`apps/web/src/components/EventFeed.tsx`, in `describe()`:
```tsx
    case "plugin.event":
      // Plan 2 replaces this with the manifest's `describe` template fetched
      // from GET /api/plugins. Until then the envelope renders its own fields
      // rather than crashing the feed.
      return `${event.actorName}: ${event.pluginId}.${event.name}`;
```

`apps/web/src/ws/invalidation.ts`, in `invalidationKeys()`:
```ts
    case "plugin.event":
      // Plan 2 maps this to the manifest's `invalidates` list. Returning no
      // keys is correct until that metadata reaches the client: a plugin
      // event invalidating nothing is stale data, not a wrong render.
      return [];
```

- [ ] **Step 6: Extend the existing invalidation test**

`apps/web/test/invalidation.test.ts` derives its type list from the schema, so the new variant is picked up automatically. Add one explicit case asserting the deliberate empty result, so a future change has to be intentional:
```ts
  it("returns no keys for a plugin.event until manifest metadata reaches the client", () => {
    expect(invalidationKeys({
      id: "01920000-0000-7000-8000-000000000000",
      at: new Date().toISOString(),
      actorId: "01920000-0000-7000-8000-000000000001",
      actorName: "Ron",
      audience: { kind: "global" },
      type: "plugin.event",
      pluginId: "hello",
      name: "greeted",
      payload: {},
    }, "01920000-0000-7000-8000-000000000001")).toEqual([]);
  });
```
Check `invalidationKeys`' current arity before writing this — it takes `(event, viewerId)`. Match the file's existing calls exactly.

- [ ] **Step 7: Export and type the manifest field**

`index.ts`: `export { renderDescribe, type PluginEventDecl } from "./events.js";`
In `manifest.ts`, change `events: unknown[]` to `events: PluginEventDecl[]` in both interfaces.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run --project @gl3/plugin-sdk --project @gl3/shared --project @gl3/web`
Expected: PASS. SDK 21 tests; web suite green with one added case.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add packages/plugin-sdk packages/shared apps/web
git commit -m "$(cat <<'EOF'
feat(events): add plugin.event envelope variant and describe templating

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Core runtime tables `plugin_migrations` and `plugin_job_runs`

**Files:**
- Create: `apps/server/src/db/schema/plugins.ts`, `apps/server/drizzle/0004_plugin_runtime.sql`
- Modify: `apps/server/src/db/schema/index.ts`, `apps/server/package.json` (add `@gl3/plugin-sdk` dependency)
- Test: `apps/server/test/plugin-runtime-schema.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: drizzle tables `pluginMigrations` (`pluginId`, `name`, `appliedAt`; PK `(plugin_id, name)`) and `pluginJobRuns` (`pluginId`, `jobId`, `appliedAt`; PK `(plugin_id, job_id)`), both exported from `db/schema/index.ts`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/plugin-runtime-schema.test.ts` (add to the `@gl3/server:db-only` project's `include` list in `vitest.workspace.ts`):
```ts
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pluginJobRuns, pluginMigrations } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";

describe("plugin runtime tables", () => {
  it("records a migration once per (plugin_id, name)", async () => {
    const db = testDb();
    await db.insert(pluginMigrations).values({ pluginId: "hello", name: "0001_init" });
    await expect(
      db.insert(pluginMigrations).values({ pluginId: "hello", name: "0001_init" }),
    ).rejects.toThrow();
  });

  it("allows the same migration name under a different plugin", async () => {
    const db = testDb();
    await db.insert(pluginMigrations).values({ pluginId: "a", name: "0001_init" });
    await db.insert(pluginMigrations).values({ pluginId: "b", name: "0001_init" });
    const rows = await db.select().from(pluginMigrations).where(sql`name = '0001_init'`);
    expect(rows).toHaveLength(2);
  });

  it("records a job run once per (plugin_id, job_id)", async () => {
    const db = testDb();
    await db.insert(pluginJobRuns).values({ pluginId: "hello", jobId: "job-1" });
    await expect(
      db.insert(pluginJobRuns).values({ pluginId: "hello", jobId: "job-1" }),
    ).rejects.toThrow();
  });
});
```
Check `test/helpers/db.ts` for the exact accessor name used by `test/ledger.test.ts` and match it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server:db-only plugin-runtime-schema`
Expected: FAIL — `pluginMigrations is not exported`.

- [ ] **Step 3: Write the drizzle schema**

`apps/server/src/db/schema/plugins.ts`:
```ts
import { sql } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Which plugin migrations have been applied. Core-owned, not prefixed
 * `p_<pluginId>_`: this is the loader's own bookkeeping, and a plugin cannot
 * reach it (spec: Table ownership).
 */
export const pluginMigrations = pgTable("plugin_migrations", {
  pluginId: text("plugin_id").notNull(),
  name: text("name").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => ({ pk: primaryKey({ columns: [t.pluginId, t.name] }) }));

/**
 * CLAUDE.md rule 1 made structural: a job-context `ctx.transaction` inserts
 * here first, inside the same transaction as the handler's writes. BullMQ is
 * at-least-once, so a retry of an already-committed job hits this primary key
 * and aborts before re-applying any side effect. A plugin cannot forget the
 * idempotency key because it never writes one.
 */
export const pluginJobRuns = pgTable("plugin_job_runs", {
  pluginId: text("plugin_id").notNull(),
  jobId: text("job_id").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (t) => ({ pk: primaryKey({ columns: [t.pluginId, t.jobId] }) }));
```

Re-export both from `apps/server/src/db/schema/index.ts`, following the file's existing `export * from "./<name>.js"` style.

- [ ] **Step 4: Generate the migration**

```bash
npm run db:generate -w @gl3/server
```
Confirm it produced `apps/server/drizzle/0004_*.sql` containing both `CREATE TABLE`s and both composite primary keys, and that `drizzle/meta/_journal.json` gained the entry. Rename the file to `0004_plugin_runtime.sql` **only if** drizzle-kit's generated name is not descriptive — and if you rename it, update `_journal.json`'s `tag` to match, or the migrator will not find it.

- [ ] **Step 5: Run the test to verify it passes**

The suite's template database is built by `test/helpers/global-setup.ts` from `drizzle/`, so the new migration is picked up automatically on the next run.

Run: `npx vitest run --project @gl3/server:db-only plugin-runtime-schema`
Expected: PASS, 3 tests.

- [ ] **Step 6: Add the SDK dependency to the server and commit**

Add `"@gl3/plugin-sdk": "*"` to `apps/server/package.json` dependencies, add `{ "path": "../../packages/plugin-sdk" }` to `apps/server/tsconfig.json` references, then `npm install`.

```bash
npm run verify
git add apps/server packages package-lock.json vitest.workspace.ts
git commit -m "$(cat <<'EOF'
feat(db): add plugin_migrations and plugin_job_runs runtime tables

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Loader validation pass

**Files:**
- Create: `apps/server/src/plugins/validate.ts`
- Test: `apps/server/test/plugin-validate.test.ts` (add to the `@gl3/server:unit` project's `include` list — this task touches neither Postgres nor Redis)

**Interfaces:**
- Consumes: `PluginManifest`, `PageSchema` (Tasks 1, 3).
- Produces: `validatePlugins(manifests: readonly PluginManifest[]): void` — throws `Error` naming the offending plugin id(s) on any violation; returns void on success. `RESERVED_BASE_PATHS = ["/api/auth", "/api/ws", "/api/plugins", "/health"]`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/plugin-validate.test.ts`:
```ts
import { definePlugin } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import { validatePlugins } from "../src/plugins/validate.js";

const plugin = (id: string, basePaths: string[], tables: Record<string, string> = {}) =>
  definePlugin({ id, version: "1.0.0", basePaths, tables });

describe("validatePlugins", () => {
  it("accepts a well-formed set", () => {
    expect(() => validatePlugins([
      plugin("hello", ["/api/hello"], { greetings: "p_hello_greetings" }),
      plugin("bounties", ["/api/bounties"], { bounties: "p_bounties_bounties" }),
    ])).not.toThrow();
  });

  it("rejects two plugins claiming the same id", () => {
    expect(() => validatePlugins([plugin("hello", ["/api/hello"]), plugin("hello", ["/api/hi"])]))
      .toThrow(/hello/);
  });

  it("rejects a table without the plugin's prefix, naming the plugin", () => {
    expect(() => validatePlugins([plugin("hello", ["/api/hello"], { players: "players" })]))
      .toThrow(/hello.*p_hello_/s);
  });

  it("rejects a table claimed by two plugins", () => {
    expect(() => validatePlugins([
      plugin("hello", ["/api/hello"], { t: "p_hello_t" }),
      plugin("hi", ["/api/hi"], { t: "p_hello_t" }),
    ])).toThrow(/p_hello_t/);
  });

  it("rejects overlapping basePaths naming both plugins", () => {
    expect(() => validatePlugins([
      plugin("hello", ["/api/hello"]),
      plugin("hello-world", ["/api/hello/world"]),
    ])).toThrow(/hello.*hello-world|hello-world.*hello/s);
  });

  it("rejects a basePath reserved to core", () => {
    expect(() => validatePlugins([plugin("evil", ["/api/auth"])])).toThrow(/reserved/);
  });

  it("rejects a route path outside the plugin's declared basePaths", () => {
    const manifest = definePlugin({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello"],
      routes: [{ method: "GET", path: "/api/bounties", auth: "player", handler: async () => ({ status: 200 }) }],
    });
    expect(() => validatePlugins([manifest])).toThrow(/\/api\/bounties/);
  });

  it("rejects two pages sharing an id", () => {
    const page = { id: "dup", path: "/dup", view: { kind: "text" as const, value: "x" } };
    expect(() => validatePlugins([
      definePlugin({ id: "a", version: "1.0.0", basePaths: ["/api/a"], pages: [page] }),
      definePlugin({ id: "b", version: "1.0.0", basePaths: ["/api/b"], pages: [page] }),
    ])).toThrow(/dup/);
  });
});
```

The `routes` field is still typed `unknown[]` until Task 10; write the route object as shown and let Task 10's type replace it. If TypeScript rejects the literal before then, add `routes: []` and move the route-path case into Task 10's test file instead — do not weaken the check.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server:unit plugin-validate`
Expected: FAIL — cannot resolve `../src/plugins/validate.js`.

- [ ] **Step 3: Write `validate.ts`**

```ts
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

export function validatePlugins(manifests: readonly PluginManifest[]): void {
  const seenIds = new Set<string>();
  const claimedTables = new Map<string, string>();
  const claimedPaths: { pluginId: string; path: string }[] = [];
  const claimedPages = new Map<string, string>();

  for (const manifest of manifests) {
    if (seenIds.has(manifest.id)) fail(`two plugins claim the id "${manifest.id}"`);
    seenIds.add(manifest.id);

    const prefix = `p_${manifest.id.replaceAll("-", "_")}_`;
    for (const tableName of Object.values(manifest.tables)) {
      const name = String(tableName);
      if (!name.startsWith(prefix)) {
        fail(`plugin "${manifest.id}" declares table "${name}", which must start with "${prefix}"`);
      }
      const owner = claimedTables.get(name);
      if (owner !== undefined) fail(`table "${name}" is claimed by both "${owner}" and "${manifest.id}"`);
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
          fail(`basePaths overlap: "${manifest.id}" claims "${basePath}", "${claimed.pluginId}" claims "${claimed.path}"`);
        }
      }
      claimedPaths.push({ pluginId: manifest.id, path: basePath });
    }

    for (const page of manifest.pages) {
      const owner = claimedPages.get(page.id);
      if (owner !== undefined) fail(`page id "${page.id}" is claimed by both "${owner}" and "${manifest.id}"`);
      claimedPages.set(page.id, manifest.id);
    }
  }

  // Route containment runs second: every basePath is known by now, so a route
  // under a *later* basePath of the same plugin is not reported as a violation.
  for (const manifest of manifests) {
    for (const route of manifest.routes) {
      const inScope = manifest.basePaths.some((base) => route.path === base || route.path.startsWith(`${base}/`));
      if (!inScope) {
        fail(`plugin "${manifest.id}" registers "${route.path}", outside its basePaths [${manifest.basePaths.join(", ")}]`);
      }
    }
  }
}
```

`manifest.tables` maps a plugin's own key to its drizzle table object; the loader needs the **SQL** name. Until Task 13 proves the shape end to end, treat `tables` as `Record<string, string>` of SQL table names — the example plugin declares them that way, and a follow-on port can add a drizzle-table accessor without changing this check.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/server:unit plugin-validate`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove a check can fail**

Delete the `overlaps` call in the reserved-path loop, re-run, confirm `rejects a basePath reserved to core` goes red, restore. Record the red output in the task report.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run verify
git add apps/server vitest.workspace.ts
git commit -m "$(cat <<'EOF'
feat(plugins): add boot-time manifest collision validation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 7: Plugin migration runner

**Files:**
- Create: `apps/server/src/plugins/migrate.ts`
- Test: `apps/server/test/plugin-migrate.test.ts` (`@gl3/server:db-only`)

**Interfaces:**
- Consumes: `PluginManifest`, `PluginMigration` (Task 1); `pluginMigrations` (Task 5).
- Produces: `runPluginMigrations(db: Db, manifests: readonly PluginManifest[]): Promise<string[]>` — returns the `"<pluginId>:<name>"` keys applied on *this* call, empty on a second boot.

- [ ] **Step 1: Write the failing test**

`apps/server/test/plugin-migrate.test.ts`:
```ts
import { definePlugin } from "@gl3/plugin-sdk";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { testDb } from "./helpers/db.js";

const plugin = (id: string, migrations: { name: string; sql: string }[]) =>
  definePlugin({ id, version: "1.0.0", basePaths: [`/api/${id}`], migrations });

describe("runPluginMigrations", () => {
  it("applies a migration once across two boots", async () => {
    const db = testDb();
    const manifest = plugin("m1", [
      { name: "0001_init", sql: "CREATE TABLE p_m1_things (id text primary key)" },
    ]);
    expect(await runPluginMigrations(db, [manifest])).toEqual(["m1:0001_init"]);
    // Second boot: no re-apply. Without the tracking row this re-runs the DDL
    // and fails with 42P07 "relation already exists".
    expect(await runPluginMigrations(db, [manifest])).toEqual([]);
    await db.execute(sql`select 1 from p_m1_things limit 1`);
  });

  it("applies migrations in plugin-id order, then declaration order", async () => {
    const db = testDb();
    const applied = await runPluginMigrations(db, [
      plugin("zeta", [{ name: "0001", sql: "CREATE TABLE p_zeta_a (id text)" }]),
      plugin("alpha", [
        { name: "0001", sql: "CREATE TABLE p_alpha_a (id text)" },
        { name: "0002", sql: "CREATE TABLE p_alpha_b (id text)" },
      ]),
    ]);
    expect(applied).toEqual(["alpha:0001", "alpha:0002", "zeta:0001"]);
  });

  it("rolls back the tracking row when the migration SQL fails", async () => {
    const db = testDb();
    const broken = plugin("m3", [{ name: "0001", sql: "CREATE TABLE (((" }]);
    await expect(runPluginMigrations(db, [broken])).rejects.toThrow();
    // The retry must see the migration as unapplied, or a syntax error at boot
    // would permanently mark a table as created that never was.
    const fixed = plugin("m3", [{ name: "0001", sql: "CREATE TABLE p_m3_a (id text)" }]);
    expect(await runPluginMigrations(db, [fixed])).toEqual(["m3:0001"]);
  });
});
```

Each test creates real tables in the per-file isolated database, so no cleanup is needed — but confirm `test/helpers/db.ts` gives each file its own database before relying on that. If it truncates a fixed table list instead, prefix each test's table names uniquely as shown (`p_m1_`, `p_zeta_`, …) — which the tests above already do.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server:db-only plugin-migrate`
Expected: FAIL — cannot resolve `../src/plugins/migrate.js`.

- [ ] **Step 3: Write `migrate.ts`**

```ts
import type { PluginManifest } from "@gl3/plugin-sdk";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pluginMigrations } from "../db/schema/index.js";

/**
 * Applies each plugin's migrations in plugin-id order (spec: Table ownership),
 * tracked in `plugin_migrations` so a re-boot applies nothing twice.
 *
 * The tracking row is inserted FIRST, inside the same transaction as the DDL —
 * the same shape as CLAUDE.md rule 1. Postgres has transactional DDL, so the
 * pair is atomic in both directions: a second concurrent boot blocks on the
 * primary key and then sees zero rows returned, and a failing migration rolls
 * the tracking row back with it.
 */
export async function runPluginMigrations(
  db: Db,
  manifests: readonly PluginManifest[],
): Promise<string[]> {
  const applied: string[] = [];
  const ordered = [...manifests].sort((a, b) => a.id.localeCompare(b.id));

  for (const manifest of ordered) {
    for (const migration of manifest.migrations) {
      await db.transaction(async (tx) => {
        const claimed = await tx
          .insert(pluginMigrations)
          .values({ pluginId: manifest.id, name: migration.name })
          .onConflictDoNothing()
          .returning({ name: pluginMigrations.name });
        if (claimed.length === 0) return;

        // sql.raw is correct here and nowhere else in this codebase: the string
        // is plugin-authored DDL from a manifest resolved at boot, not a value
        // from a request. Nothing player-supplied can reach it.
        await tx.execute(sql.raw(migration.sql));
        applied.push(`${manifest.id}:${migration.name}`);
      });
    }
  }
  return applied;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/server:db-only plugin-migrate`
Expected: PASS, 3 tests.

- [ ] **Step 5: Prove the idempotency check can fail**

Delete the `if (claimed.length === 0) return;` line, re-run, confirm the two-boot test fails with `42P07 relation "p_m1_things" already exists`, restore. Record the red output.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add apps/server
git commit -m "$(cat <<'EOF'
feat(plugins): apply plugin migrations once per plugin at boot

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `ctx.transaction` — buffered events, economy, locks

**Files:**
- Modify: `packages/plugin-sdk/src/ctx.ts` (replace the Task 2 stub), `packages/plugin-sdk/src/index.ts`
- Create: `apps/server/src/plugins/ctx.ts`
- Test: `apps/server/test/plugin-ctx-transaction.test.ts` (`@gl3/server`, the full DB+Redis project)

**Interfaces:**
- Consumes: `applyBalanceChange`, `addExp`, `applyGangBalanceChange`, `lockPlayersForUpdate`, `lockGangAndPlayerForUpdate`, `Tx` (`economy/ledger.ts`); `publishEvent` (`bus/publish.ts`); `PluginError` (Task 1).
- Produces (SDK, types only): `PluginCtx`, `PluginTx`, `PluginDbTx`, `PlayerSnapshot`, `PluginBalanceChange`, `PluginEventInput`.
- Produces (server): `createPluginCtx(deps: PluginCtxDeps, options: PluginCtxOptions): PluginCtx`, where `PluginCtxDeps = { db: Db; redis: Redis; queues: Map<string, Queue>; settings: Record<string, string> }` and `PluginCtxOptions = { pluginId: string; player: PlayerSnapshot | null; job: JobContext | null; filters: readonly FilterSubscription[] }`.

- [ ] **Step 1: Define the ctx types in the SDK**

Replace `packages/plugin-sdk/src/ctx.ts`:
```ts
import type { GameEvent } from "@gl3/shared";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FilterPoint } from "./filters.js";

/**
 * The transaction handle a plugin sees. No schema parameter is attached, so
 * `tx.db.query.players` does not exist — a plugin can only name tables it
 * imported itself, which is how "nothing in core may reach into a plugin's
 * tables, and the converse" (spec) becomes a compiler rule.
 *
 * Verify against drizzle 0.45.2's generic arity when implementing: if this
 * does not compile, widen to `PgDatabase<PgQueryResultHKT, Record<string, never>>`.
 */
export type PluginDbTx = PgDatabase<PgQueryResultHKT>;

export interface PlayerSnapshot {
  id: string;
  cash: bigint;
  bank: bigint;
  level: number;
  jailed: boolean;
  gangId: string | null;
}

/** No `jobId`: a plugin never writes an idempotency key (spec, rule 1). */
export interface PluginBalanceChange {
  playerId: string;
  amount: bigint;
  kind: "cash" | "bank" | "points";
  reason: string;
  refId?: string;
}

export interface PluginGangBalanceChange {
  gangId: string;
  amount: bigint;
  reason: string;
  actorPlayerId: string;
  refId?: string;
}

/** What a plugin supplies; the loader wraps it in the `plugin.event` envelope. */
export interface PluginEventInput {
  name: string;
  actorId: string;
  actorName: string;
  audience: GameEvent["audience"];
  payload: Record<string, unknown>;
}

export interface PluginTx {
  readonly db: PluginDbTx;
  readonly economy: {
    applyBalanceChange(change: PluginBalanceChange): Promise<bigint>;
    applyGangBalanceChange(change: PluginGangBalanceChange): Promise<bigint>;
    addExp(playerId: string, amount: bigint): Promise<void>;
  };
  readonly locks: {
    player(playerIds: string[]): Promise<void>;
    gangAndPlayer(gangId: string, playerId: string): Promise<void>;
  };
  gangLog(entry: GangLogEntry): Promise<void>;
  /**
   * Buffers the event. The loader publishes after commit and discards on
   * rollback, which makes CLAUDE.md rule 5 unrepresentable rather than merely
   * documented.
   */
  readonly events: { publish(event: PluginEventInput): Promise<void> };
}

export interface JobContext { readonly id: string; readonly seed: string; readonly rng: PluginRng }
export interface PluginRng { int(minInclusive: number, maxExclusive: number): number; bigint(min: bigint, max: bigint): bigint }

export interface PluginCtx {
  readonly pluginId: string;
  /** Null on a `auth: "public"` route and inside a job. */
  readonly player: PlayerSnapshot | null;
  transaction<T>(fn: (tx: PluginTx) => Promise<T>): Promise<T>;
  readonly cooldown: {
    acquire(action: string, playerId: string, ttlSeconds: number): Promise<boolean>;
    peek(action: string, playerId: string): Promise<number>;
    release(action: string, playerId: string): Promise<void>;
  };
  readonly jobs: { enqueue(name: string, data: Record<string, unknown>): Promise<string> };
  readonly job: JobContext | null;
  readonly filters: { apply<T>(point: FilterPoint<T>, value: T): Promise<T> };
  readonly settings: { get(key: string): string | null };
  readonly log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
}
```

`GangLogEntry` must mirror the existing `appendGangLog` helper exactly. Open it first (`apps/server/src/game/gangs/`) and copy its parameter object field for field — do not invent field names. Declare the interface in this file with those fields.

Export every new type from `index.ts`.

- [ ] **Step 2: Write the failing test**

`apps/server/test/plugin-ctx-transaction.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ledger, players } from "../src/db/schema/index.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { testDb, testRedis } from "./helpers/db.js";
import { createPlayer } from "./helpers/factories.js";
import { awaitOwnEvent } from "./helpers/events.js";

const deps = () => ({ db: testDb(), redis: testRedis(), queues: new Map(), settings: {} });
const opts = { pluginId: "t", player: null, job: null, filters: [] };

describe("ctx.transaction", () => {
  it("publishes a buffered event only after commit", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    // awaitOwnEvent filters by this actorId — game:events is global across the
    // suite and matching on type alone captures another file's traffic
    // (CLAUDE.md rule 4).
    const received = awaitOwnEvent(player.id, (e) => e.type === "plugin.event");
    await ctx.transaction(async (tx) => {
      await tx.events.publish({
        name: "greeted", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, payload: { times: "1" },
      });
    });
    const event = await received;
    expect(event).toMatchObject({ type: "plugin.event", pluginId: "t", name: "greeted" });
  });

  it("drops buffered events when the transaction rolls back", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    let delivered = false;
    const received = awaitOwnEvent(player.id, (e) => e.type === "plugin.event").then(() => { delivered = true; });
    await expect(ctx.transaction(async (tx) => {
      await tx.events.publish({
        name: "greeted", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, payload: {},
      });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(delivered).toBe(false);
    void received;
  });

  it("moves money through the ledger, never by a bare update", async () => {
    const player = await createPlayer({ cash: 1000n });
    const ctx = createPluginCtx(deps(), opts);
    const after = await ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      return await tx.economy.applyBalanceChange({
        playerId: player.id, amount: -250n, kind: "cash", reason: "plugin_test",
      });
    });
    expect(after).toBe(750n);
    const rows = await testDb().select().from(ledger).where(eq(ledger.playerId, player.id));
    expect(rows).toHaveLength(1);
    const [row] = await testDb().select().from(players).where(eq(players.id, player.id));
    expect(row?.cash).toBe(750n);
  });
});
```

Match `test/helpers/db.ts` and `test/helpers/factories.ts` accessor names to what `test/ledger.test.ts` and `test/bank.test.ts` already use — read those two files first rather than assuming the names above.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server plugin-ctx-transaction`
Expected: FAIL — cannot resolve `../src/plugins/ctx.js`.

- [ ] **Step 4: Write `apps/server/src/plugins/ctx.ts`**

```ts
import type {
  FilterSubscription, JobContext, PlayerSnapshot, PluginCtx, PluginEventInput, PluginTx,
} from "@gl3/plugin-sdk";
import { runFilterChain } from "@gl3/plugin-sdk";
import type { GameEvent } from "@gl3/shared";
import type { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { publishEvent } from "../bus/publish.js";
import {
  addExp, applyBalanceChange, applyGangBalanceChange,
  lockGangAndPlayerForUpdate, lockPlayersForUpdate,
} from "../economy/ledger.js";
import { appendGangLog } from "../game/gangs/log.js";

export interface PluginCtxDeps {
  db: Db;
  redis: Redis;
  /** Per-plugin BullMQ queues, keyed `<pluginId>:<jobName>`. Task 11 fills it. */
  queues: Map<string, Queue>;
  settings: Record<string, string>;
}

export interface PluginCtxOptions {
  pluginId: string;
  player: PlayerSnapshot | null;
  job: JobContext | null;
  filters: readonly FilterSubscription[];
}

export function createPluginCtx(deps: PluginCtxDeps, options: PluginCtxOptions): PluginCtx {
  const ctx: PluginCtx = {
    pluginId: options.pluginId,
    player: options.player,
    job: options.job,

    async transaction<T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> {
      // The buffer lives in this call's closure, so two concurrent requests on
      // the same ctx factory cannot see each other's pending events.
      const buffered: PluginEventInput[] = [];

      const result = await deps.db.transaction(async (tx) => {
        const pluginTx: PluginTx = {
          db: tx,
          economy: {
            applyBalanceChange: (change) => applyBalanceChange(tx, change),
            applyGangBalanceChange: (change) => applyGangBalanceChange(tx, change),
            addExp: (playerId, amount) => addExp(tx, playerId, amount),
          },
          locks: {
            player: (playerIds) => lockPlayersForUpdate(tx, playerIds),
            gangAndPlayer: (gangId, playerId) => lockGangAndPlayerForUpdate(tx, gangId, playerId),
          },
          gangLog: (entry) => appendGangLog(tx, entry),
          events: {
            publish: async (event) => { buffered.push(event); },
          },
        };
        return await fn(pluginTx);
      });

      // Only reached on commit — a throw above propagates and `buffered` is
      // discarded with the closure (CLAUDE.md rule 5).
      for (const event of buffered) {
        await publishEvent(deps.redis, toEnvelope(options.pluginId, event));
      }
      return result;
    },

    cooldown: { /* Task 9 */ } as PluginCtx["cooldown"],
    jobs: { /* Task 11 */ } as PluginCtx["jobs"],

    filters: {
      apply: (point, value) => runFilterChain(options.filters, point, ctx, value),
    },
    settings: {
      get: (key) => deps.settings[`${options.pluginId}.${key}`] ?? null,
    },
    log: {
      info: (message, fields) => console.log({ plugin: options.pluginId, ...fields }, message),
      warn: (message, fields) => console.warn({ plugin: options.pluginId, ...fields }, message),
      error: (message, fields) => console.error({ plugin: options.pluginId, ...fields }, message),
    },
  };
  return ctx;
}

function toEnvelope(pluginId: string, event: PluginEventInput): GameEvent {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    actorId: event.actorId,
    actorName: event.actorName,
    audience: event.audience,
    type: "plugin.event",
    pluginId,
    name: event.name,
    payload: event.payload,
  };
}
```

Two notes for the implementer:

- The `as PluginCtx["cooldown"]` placeholders are scaffolding for Tasks 9 and 11 **and must not survive them**. `apps/*` permits a cast, but leaving one here after Task 11 means a plugin calling `ctx.cooldown.acquire` gets a runtime `undefined is not a function`. If you would rather not carry them, implement Tasks 8, 9 and 11's ctx members together and split only the tests — but then the cooldown tests still come first, red, per Task 9.
- Confirm `appendGangLog`'s real module path and signature before wiring it. If it takes positional arguments rather than an entry object, change `GangLogEntry` in the SDK to match the real shape rather than adapting at the call site — the SDK type is the plugin-facing contract and must not diverge from what core actually does.
- Copy `toEnvelope`'s `id`/`at` construction from an existing emitter (e.g. `game/mail/routes.ts`) so plugin events are shaped exactly like core's.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/server plugin-ctx-transaction`
Expected: PASS, 3 tests.

- [ ] **Step 6: Prove the rollback guarantee can fail**

Move the publish loop inside the `db.transaction` callback, re-run, confirm `drops buffered events when the transaction rolls back` goes red. Restore. Record the red output — this is the assertion that makes rule 5 structural, and an untested version of it proves nothing.

- [ ] **Step 7: Commit**

```bash
npm run verify
git add packages/plugin-sdk apps/server
git commit -m "$(cat <<'EOF'
feat(plugins): add ctx.transaction with post-commit event flush

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `ctx.cooldown`, `ctx.settings`, `ctx.log`

**Files:**
- Modify: `apps/server/src/plugins/ctx.ts`
- Test: `apps/server/test/plugin-ctx-cooldown.test.ts` (`@gl3/server:redis-only`)

**Interfaces:**
- Consumes: `cooldownKey`, `acquireCooldown`, `peekCooldown`, `releaseCooldown` (`game/cooldown.ts`); `createPluginCtx` (Task 8).
- Produces: a working `ctx.cooldown` — no new exported names.

- [ ] **Step 1: Write the failing test**

`apps/server/test/plugin-ctx-cooldown.test.ts`:
```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cooldownKey } from "../src/game/cooldown.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { testRedis } from "./helpers/redis.js";

const ctxFor = (pluginId: string) => createPluginCtx(
  { db: undefined as never, redis: testRedis(), queues: new Map(), settings: { "hello.greeting": "hi" } },
  { pluginId, player: null, job: null, filters: [] },
);

describe("ctx.cooldown", () => {
  it("writes the byte-identical key the core helper uses", async () => {
    const playerId = randomUUID();
    await ctxFor("hello").cooldown.acquire("hello-greet", playerId, 30);
    // If the SDK invented its own key format, a ported module would stop
    // sharing a cooldown with the client's countdown and with any core code
    // still reading it during the strangler window.
    expect(await testRedis().ttl(cooldownKey(playerId, "hello-greet"))).toBeGreaterThan(0);
  });

  it("refuses a second acquire inside the window", async () => {
    const playerId = randomUUID();
    const ctx = ctxFor("hello");
    expect(await ctx.cooldown.acquire("greet", playerId, 30)).toBe(true);
    expect(await ctx.cooldown.acquire("greet", playerId, 30)).toBe(false);
  });

  it("reports 0 for a cooldown that was never set", async () => {
    expect(await ctxFor("hello").cooldown.peek("greet", randomUUID())).toBe(0);
  });

  it("re-allows the action after release", async () => {
    const playerId = randomUUID();
    const ctx = ctxFor("hello");
    await ctx.cooldown.acquire("greet", playerId, 30);
    await ctx.cooldown.release("greet", playerId);
    expect(await ctx.cooldown.acquire("greet", playerId, 30)).toBe(true);
  });
});

describe("ctx.settings", () => {
  it("reads only this plugin's namespace", () => {
    expect(ctxFor("hello").settings.get("greeting")).toBe("hi");
    expect(ctxFor("other").settings.get("greeting")).toBeNull();
  });
});
```

Use whatever redis accessor the existing redis-only tests use; `test/helpers/redis.ts` may not be the real path — check `test/rate-limit.test.ts` first. Never call `FLUSHALL`/`FLUSHDB` in setup: the random `playerId` per test is what keeps these keys from colliding with other files.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server:redis-only plugin-ctx-cooldown`
Expected: FAIL — `ctx.cooldown.acquire is not a function` (the Task 8 placeholder).

- [ ] **Step 3: Implement**

Replace the placeholder in `createPluginCtx`:
```ts
    cooldown: {
      // Delegates to the core helpers rather than re-deriving the key, so a
      // ported module's Redis keys are unchanged and `SET NX EX` stays the
      // only write shape available (CLAUDE.md rule 2 — there is no read-then-
      // write pair on this surface to misuse).
      acquire: (action, playerId, ttlSeconds) =>
        acquireCooldown(deps.redis, cooldownKey(playerId, action), ttlSeconds),
      peek: (action, playerId) => peekCooldown(deps.redis, cooldownKey(playerId, action)),
      release: (action, playerId) => releaseCooldown(deps.redis, cooldownKey(playerId, action)),
    },
```
Import the four helpers from `../game/cooldown.js`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/server:redis-only plugin-ctx-cooldown`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add apps/server
git commit -m "$(cat <<'EOF'
feat(plugins): back ctx.cooldown with the core SET NX EX helpers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 10: Route registration

**Files:**
- Create: `packages/plugin-sdk/src/route.ts`, `apps/server/src/plugins/routes.ts`
- Modify: `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/src/manifest.ts` (type `routes`), `apps/server/src/app.ts`, `apps/server/test/helpers/server.ts`
- Test: `apps/server/test/plugin-routes.test.ts` (`@gl3/server`)

**Interfaces:**
- Consumes: `PluginCtx` (Task 8), `PluginError` (Task 1), `app.requireAuth` (`auth/routes.ts`), `releaseIfExpired` (`game/jail/status.ts`).
- Produces: `route(def): PluginRoute`, `PluginRoute`, `RouteResult` (SDK); `registerPluginRoutes(app: FastifyInstance, manifests, deps: PluginCtxDeps): void` (server); `buildApp(config, deps)` gains an optional `plugins?: readonly PluginManifest[]` dependency, defaulting to `[]`.

- [ ] **Step 1: Write `route.ts` in the SDK**

```ts
import { z } from "zod";
import type { PluginCtx } from "./ctx.js";

export interface RouteResult { status: number; body?: unknown }

export interface RouteDef<P extends z.ZodTypeAny, B extends z.ZodTypeAny> {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  auth?: "player" | "public";
  /** V2 module.json parity. Default true — only actions gate on jail. */
  accessInJail?: boolean;
  params?: P;
  body?: B;
  handler: (ctx: PluginCtx, input: { params: z.infer<P>; body: z.infer<B> }) => Promise<RouteResult>;
}

/**
 * The type-erased form the loader stores. `handler` is declared with METHOD
 * SHORTHAND on purpose: method parameters are bivariant, so a handler typed
 * against the plugin's own `z.infer<P>` assigns here without a cast. Written
 * as a property (`handler: (…) => …`) `strictFunctionTypes` would reject it
 * contravariantly and force an `any` — which `packages/*` does not permit.
 */
export interface PluginRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  auth: "player" | "public";
  accessInJail: boolean;
  params: z.ZodTypeAny;
  body: z.ZodTypeAny;
  handler(ctx: PluginCtx, input: { params: unknown; body: unknown }): Promise<RouteResult>;
}

export function route<P extends z.ZodTypeAny = z.ZodUnknown, B extends z.ZodTypeAny = z.ZodUnknown>(
  def: RouteDef<P, B>,
): PluginRoute {
  return {
    method: def.method,
    path: def.path,
    auth: def.auth ?? "player",
    accessInJail: def.accessInJail ?? true,
    params: def.params ?? z.unknown(),
    body: def.body ?? z.unknown(),
    handler: def.handler,
  };
}
```

Export from `index.ts`; change `routes: unknown[]` to `routes: PluginRoute[]` in both manifest interfaces.

- [ ] **Step 2: Write the failing test**

`apps/server/test/plugin-routes.test.ts`:
```ts
import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { bootTestServer } from "./helpers/server.js";
import { registerAndLogin, jailPlayer } from "./helpers/factories.js";

const testPlugin = definePlugin({
  id: "rt", version: "1.0.0", basePaths: ["/api/rt"],
  routes: [
    route({ method: "GET", path: "/api/rt/open", auth: "public",
      handler: async () => ({ status: 200, body: { ok: true } }) }),
    route({ method: "GET", path: "/api/rt/me",
      handler: async (ctx) => ({ status: 200, body: { playerId: ctx.player?.id ?? null } }) }),
    route({ method: "POST", path: "/api/rt/act", accessInJail: false,
      handler: async () => ({ status: 204 }) }),
    route({ method: "POST", path: "/api/rt/items/:itemId", params: z.object({ itemId: z.string().uuid() }),
      body: z.object({ amount: z.number().int().positive() }),
      handler: async (_ctx, { params, body }) => ({ status: 200, body: { ...params, ...body } }) }),
    route({ method: "GET", path: "/api/rt/boom",
      handler: async () => { throw new PluginError("too_poor", 409, { need: "500" }); } }),
  ],
});

describe("plugin routes", () => {
  it("serves a public route without a token", async () => {
    const { app } = await bootTestServer({ plugins: [testPlugin] });
    const res = await app.inject({ method: "GET", url: "/api/rt/open" });
    expect(res.statusCode).toBe(200);
  });

  it("401s an authed route without a token", async () => {
    const { app } = await bootTestServer({ plugins: [testPlugin] });
    const res = await app.inject({ method: "GET", url: "/api/rt/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("exposes the authenticated player on ctx", async () => {
    const { app } = await bootTestServer({ plugins: [testPlugin] });
    const { token, playerId } = await registerAndLogin(app);
    const res = await app.inject({ method: "GET", url: "/api/rt/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toEqual({ playerId });
  });

  it("returns the exact core jail response on accessInJail: false", async () => {
    const { app } = await bootTestServer({ plugins: [testPlugin] });
    const { token, playerId } = await registerAndLogin(app);
    await jailPlayer(playerId, 120);
    const res = await app.inject({ method: "POST", url: "/api/rt/act", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(423);
    // Byte-identical to crimes/bullets/travel: M5 changes no HTTP response.
    expect(res.json()).toMatchObject({ error: "jailed" });
    expect(typeof res.json().remainingSeconds).toBe("number");
  });

  it("400s an invalid uuid param before it reaches Postgres", async () => {
    const { app } = await bootTestServer({ plugins: [testPlugin] });
    const { token } = await registerAndLogin(app);
    const res = await app.inject({ method: "POST", url: "/api/rt/items/not-a-uuid",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  it("400s an invalid body", async () => {
    const { app } = await bootTestServer({ plugins: [testPlugin] });
    const { token } = await registerAndLogin(app);
    const res = await app.inject({ method: "POST", url: "/api/rt/items/01920000-0000-7000-8000-000000000000",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: -1 } });
    expect(res.statusCode).toBe(400);
  });

  it("maps PluginError to its declared status and extra fields", async () => {
    const { app } = await bootTestServer({ plugins: [testPlugin] });
    const { token } = await registerAndLogin(app);
    const res = await app.inject({ method: "GET", url: "/api/rt/boom", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "too_poor", need: "500" });
  });
});
```

`registerAndLogin` and `jailPlayer` may not exist under those names — read `test/crimes.test.ts` for how it authenticates and how it puts a player in jail, and reuse those helpers verbatim. Do not add a second way to jail a player.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server plugin-routes`
Expected: FAIL — `bootTestServer` rejects the unknown `plugins` option, or 404 on every plugin path.

- [ ] **Step 4: Write `apps/server/src/plugins/routes.ts`**

```ts
import type { PluginManifest, PlayerSnapshot } from "@gl3/plugin-sdk";
import { PluginError } from "@gl3/plugin-sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { players, playerStats } from "../db/schema/index.js";
import { releaseIfExpired } from "../game/jail/status.js";
import { createPluginCtx, type PluginCtxDeps } from "./ctx.js";

export function registerPluginRoutes(
  app: FastifyInstance,
  manifests: readonly PluginManifest[],
  deps: PluginCtxDeps,
): void {
  for (const manifest of manifests) {
    for (const pluginRoute of manifest.routes) {
      const preHandler = pluginRoute.auth === "player" ? [app.requireAuth] : [];

      app.route({
        method: pluginRoute.method,
        url: pluginRoute.path,
        preHandler,
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
          const playerId = request.playerId;

          if (!pluginRoute.accessInJail && playerId !== undefined) {
            // Same call, same order, same response as crimes/bullets/travel —
            // GET-side release still happens here, so a sentence that expired
            // ends on the next action rather than on a poll.
            const jail = await releaseIfExpired(deps.db, deps.redis, playerId);
            if (jail.jailed) {
              return reply.code(423).send({ error: "jailed", remainingSeconds: jail.remainingSeconds });
            }
          }

          // Zod before the handler: an unvalidated UUID reaching Postgres 500s
          // instead of returning a clean 400.
          const params = pluginRoute.params.safeParse(request.params);
          if (!params.success) return reply.code(400).send({ error: "invalid_request" });
          const body = pluginRoute.body.safeParse(request.body);
          if (!body.success) return reply.code(400).send({ error: "invalid_request" });

          const player = playerId === undefined ? null : await loadSnapshot(deps, playerId);
          const ctx = createPluginCtx(deps, {
            pluginId: manifest.id, player, job: null, filters: collectFilters(manifests),
          });

          try {
            const result = await pluginRoute.handler(ctx, { params: params.data, body: body.data });
            return result.body === undefined
              ? await reply.code(result.status).send()
              : await reply.code(result.status).send(result.body);
          } catch (error) {
            if (error instanceof PluginError) {
              return reply.code(error.status).send({ error: error.code, ...error.extra });
            }
            throw error;
          }
        },
      });
    }
  }
}

function collectFilters(manifests: readonly PluginManifest[]) {
  return manifests.flatMap((m) => m.filters);
}

async function loadSnapshot(deps: PluginCtxDeps, playerId: string): Promise<PlayerSnapshot | null> {
  const [row] = await deps.db
    .select({
      id: players.id, cash: players.cash, bank: players.bank,
      level: playerStats.level, jailedUntil: playerStats.jailedUntil, gangId: playerStats.gangId,
    })
    .from(players)
    .innerJoin(playerStats, eq(playerStats.playerId, players.id))
    .where(eq(players.id, playerId));
  if (row === undefined) return null;
  return {
    id: row.id, cash: row.cash, bank: row.bank, level: row.level,
    jailed: row.jailedUntil !== null && row.jailedUntil.getTime() > Date.now(),
    gangId: row.gangId,
  };
}
```

The column names in `loadSnapshot` are a guess at the current schema — open `db/schema/players.ts` and correct them before running. If `level` lives on `players` rather than `player_stats`, drop the join.

- [ ] **Step 5: Wire the dependency through `buildApp` and `bootTestServer`**

In `app.ts`, add `plugins?: readonly PluginManifest[]` to the dependency object, and after the existing module registrations:
```ts
  // Strangler seam: plugin routes register on the same Fastify instance while
  // app.ts keeps registering un-ported modules directly (spec: Sequencing).
  // Both paths coexist for the length of M5 and the old one is deleted last.
  registerPluginRoutes(app, deps.plugins ?? [], {
    db: deps.db, redis: deps.redis, queues: new Map(), settings: {},
  });
```
In `test/helpers/server.ts`, accept `plugins` in `bootTestServer`'s options and pass it straight through to `buildApp`. Leave every other option untouched — the private queue name, `leaderboardPrefix` and `rateLimitPrefix` are what keep concurrent test files from colliding.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/server plugin-routes`
Expected: PASS, 7 tests.

- [ ] **Step 7: Prove the jail guard can fail**

Change `423` to `403`, re-run, confirm the jail test goes red, restore. Record the red output — the "M5 changes no HTTP response" acceptance rests on this one line.

- [ ] **Step 8: Commit**

```bash
npm run verify
git add packages/plugin-sdk apps/server
git commit -m "$(cat <<'EOF'
feat(plugins): register plugin routes with auth, jail and zod gates

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Jobs, seeded RNG, and `plugin_job_runs` idempotency

**Files:**
- Create: `apps/server/src/plugins/jobs.ts`
- Modify: `apps/server/src/plugins/ctx.ts` (replace the `jobs` placeholder, add job-context transaction), `apps/server/src/app.ts`
- Test: `apps/server/test/plugin-jobs.test.ts` (`@gl3/server`)

**Interfaces:**
- Consumes: `createRng`, `newSeed` (`game/rng.ts`); `pluginJobRuns` (Task 5); `createPluginCtx` (Task 8); `JobAlreadyAppliedError` (Task 1).
- Produces: `createPluginQueues(redis, manifests, queuePrefix): Map<string, Queue>`; `createPluginWorkers(deps, manifests, queuePrefix): Worker[]`; `runPluginJob(deps, manifest, name, job): Promise<void>` — the processor body, exported so a test can invoke it twice with the same `job.id`.
- SDK: `JobHandler = (ctx: PluginCtx, data: Record<string, unknown>) => Promise<void>`; `manifest.jobs: Record<string, JobHandler>`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/plugin-jobs.test.ts`:
```ts
import { definePlugin } from "@gl3/plugin-sdk";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ledger } from "../src/db/schema/index.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import { testDb, testRedis } from "./helpers/db.js";
import { createPlayer } from "./helpers/factories.js";

const paying = definePlugin({
  id: "pay", version: "1.0.0", basePaths: ["/api/pay"],
  jobs: {
    payout: async (ctx, data) => {
      await ctx.transaction(async (tx) => {
        await tx.locks.player([String(data["playerId"])]);
        await tx.economy.applyBalanceChange({
          playerId: String(data["playerId"]), amount: 100n, kind: "cash", reason: "plugin_payout",
        });
      });
    },
  },
});

const deps = () => ({ db: testDb(), redis: testRedis(), queues: new Map(), settings: {} });

describe("plugin jobs", () => {
  it("applies a retried job exactly once", async () => {
    const player = await createPlayer({ cash: 0n });
    const jobId = randomUUID();
    const job = { id: jobId, data: { playerId: player.id, seed: "abcdef" } };

    await runPluginJob(deps(), paying, "payout", job);
    // BullMQ is at-least-once: this is a retry of a job that already committed.
    await runPluginJob(deps(), paying, "payout", job);

    const rows = await testDb().select().from(ledger).where(eq(ledger.playerId, player.id));
    expect(rows).toHaveLength(1);
  });

  it("gives the handler a deterministic rng derived from the job seed", async () => {
    const seen: number[] = [];
    const rolling = definePlugin({
      id: "roll", version: "1.0.0", basePaths: ["/api/roll"],
      jobs: { roll: async (ctx) => { seen.push(ctx.job?.rng.int(0, 1000) ?? -1); } },
    });
    await runPluginJob(deps(), rolling, "roll", { id: randomUUID(), data: { seed: "deadbeef" } });
    await runPluginJob(deps(), rolling, "roll", { id: randomUUID(), data: { seed: "deadbeef" } });
    expect(seen[0]).toBe(seen[1]);
  });

  it("throws on an unknown job name rather than silently succeeding", async () => {
    await expect(runPluginJob(deps(), paying, "nope", { id: randomUUID(), data: {} }))
      .rejects.toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server plugin-jobs`
Expected: FAIL — cannot resolve `../src/plugins/jobs.js`.

- [ ] **Step 3: Add the job-context transaction to `ctx.ts`**

`createPluginCtx` already builds `options.job`. When it is non-null, the transaction inserts the idempotency row before running the handler body:
```ts
      const result = await deps.db.transaction(async (tx) => {
        if (options.job !== null) {
          // CLAUDE.md rule 1, made structural: FIRST statement in the
          // transaction, before any handler code. A retry of an already-
          // committed job conflicts here and aborts before re-applying
          // anything. A plugin cannot forget this because it never writes it.
          const claimed = await tx
            .insert(pluginJobRuns)
            .values({ pluginId: options.pluginId, jobId: options.job.id })
            .onConflictDoNothing()
            .returning({ jobId: pluginJobRuns.jobId });
          if (claimed.length === 0) {
            throw new JobAlreadyAppliedError(options.pluginId, options.job.id);
          }
        }
        const pluginTx: PluginTx = { /* unchanged */ };
        return await fn(pluginTx);
      });
```
And replace the `jobs` placeholder:
```ts
    jobs: {
      enqueue: async (name, data) => {
        const queue = deps.queues.get(`${options.pluginId}:${name}`);
        if (queue === undefined) throw new Error(`plugin "${options.pluginId}" has no job "${name}"`);
        // The seed is generated here, at enqueue time (spec: ctx API), so a
        // retry replays the same seed and the outcome is reproducible.
        const job = await queue.add(name, { ...data, seed: newSeed() });
        return String(job.id);
      },
    },
```

- [ ] **Step 4: Write `apps/server/src/plugins/jobs.ts`**

```ts
import type { PluginManifest } from "@gl3/plugin-sdk";
import { JobAlreadyAppliedError } from "@gl3/plugin-sdk";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { createRng } from "../game/rng.js";
import { createPluginCtx, type PluginCtxDeps } from "./ctx.js";

/** Shape of the parts of a BullMQ job this module reads. */
export interface PluginJobLike { id?: string | undefined; data: Record<string, unknown> }

export function pluginQueueName(prefix: string, pluginId: string, jobName: string): string {
  return `${prefix}${pluginId}:${jobName}`;
}

export function createPluginQueues(
  redis: Redis, manifests: readonly PluginManifest[], prefix = "",
): Map<string, Queue> {
  const queues = new Map<string, Queue>();
  for (const manifest of manifests) {
    for (const jobName of Object.keys(manifest.jobs)) {
      queues.set(`${manifest.id}:${jobName}`, new Queue(
        pluginQueueName(prefix, manifest.id, jobName), { connection: redis },
      ));
    }
  }
  return queues;
}

/**
 * The processor body, exported so a test can invoke it twice with the same
 * job id — which is exactly what a BullMQ retry does, without needing to
 * force a real failure to observe it.
 */
export async function runPluginJob(
  deps: PluginCtxDeps, manifest: PluginManifest, name: string, job: PluginJobLike,
): Promise<void> {
  const handler = manifest.jobs[name];
  if (handler === undefined) throw new Error(`plugin "${manifest.id}" has no job "${name}"`);
  const jobId = job.id;
  if (jobId === undefined) throw new Error(`plugin job "${manifest.id}:${name}" ran without a job id`);

  const seed = String(job.data["seed"] ?? "");
  const ctx = createPluginCtx(deps, {
    pluginId: manifest.id,
    player: null,
    job: { id: jobId, seed, rng: createRng(seed) },
    filters: manifest.filters,
  });

  try {
    await handler(ctx, job.data);
  } catch (error) {
    // Already applied is the expected outcome of a retry after a committed
    // run, not a failure — swallowing it here is what stops BullMQ from
    // burning its remaining attempts on work that is already done.
    if (error instanceof JobAlreadyAppliedError) return;
    throw error;
  }
}

export function createPluginWorkers(
  deps: PluginCtxDeps, manifests: readonly PluginManifest[], prefix = "",
): Worker[] {
  const workers: Worker[] = [];
  for (const manifest of manifests) {
    for (const name of Object.keys(manifest.jobs)) {
      workers.push(new Worker(
        pluginQueueName(prefix, manifest.id, name),
        async (job) => { await runPluginJob(deps, manifest, name, job); },
        { connection: deps.redis },
      ));
    }
  }
  return workers;
}
```

`prefix` exists for the same reason `bootTestServer` generates `crime-test-<uuid>`: shared BullMQ queue names across concurrent test files have already caused flakes here. Production passes `""`; tests pass a per-boot random prefix.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/server plugin-jobs`
Expected: PASS, 3 tests.

- [ ] **Step 6: Prove the idempotency guard can fail**

Remove the `pluginJobRuns` insert from `ctx.transaction`, re-run, confirm `applies a retried job exactly once` fails with `expected length 1, received 2` — a double-pay, the exact bug M1 shipped. Restore. Record the red output.

- [ ] **Step 7: Commit**

```bash
npm run verify
git add packages/plugin-sdk apps/server
git commit -m "$(cat <<'EOF'
feat(plugins): add plugin jobs with seeded rng and run-once idempotency

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `GET /api/plugins`

**Files:**
- Create: `apps/server/src/plugins/manifest-endpoint.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/plugin-manifest-endpoint.test.ts` (`@gl3/server`)

**Interfaces:**
- Consumes: `PluginManifest`, `PageSchema`, `PluginEventDecl` (Tasks 1, 3, 4).
- Produces: `buildPluginsPayload(manifests): PluginsPayload` — pure, called once at boot; `registerPluginsEndpoint(app, payload): void`. `PluginsPayload = { menu: MenuItem[]; pages: PagePayload[]; events: EventMeta[] }`, `MenuItem = { pageId, path, label, order }`, `PagePayload = { pluginId, id, path, view }`, `EventMeta = { pluginId, name, describe, invalidates }`.

**Deviation from the spec, to state in the task report:** the spec says menus are "filtered server-side, so a page the player cannot reach is not described to them". No manifest field expresses reachability, and inventing one now would be guessing at what the twelve ports need. V1 returns the full merged tree, built and cached at boot. Per-player filtering lands with the first ported module that actually has a gated page (plan 3), which is also when the predicate's shape becomes knowable. The endpoint still requires auth, so the tree is not public.

- [ ] **Step 1: Write the failing test**

`apps/server/test/plugin-manifest-endpoint.test.ts`:
```ts
import { definePlugin } from "@gl3/plugin-sdk";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { buildPluginsPayload } from "../src/plugins/manifest-endpoint.js";
import { bootTestServer } from "./helpers/server.js";
import { registerAndLogin } from "./helpers/factories.js";

const alpha = definePlugin({
  id: "alpha", version: "1.0.0", basePaths: ["/api/alpha"],
  pages: [
    { id: "alpha.index", path: "/alpha", menu: { label: "Alpha", order: 20 },
      view: { kind: "text", value: "a" } },
    { id: "alpha.hidden", path: "/alpha/hidden", view: { kind: "text", value: "h" } },
  ],
  events: [{ name: "pinged", payload: z.object({}), describe: "{actorName} pinged", invalidates: ["alpha"] }],
});
const beta = definePlugin({
  id: "beta", version: "1.0.0", basePaths: ["/api/beta"],
  pages: [{ id: "beta.index", path: "/beta", menu: { label: "Beta", order: 10 },
    view: { kind: "text", value: "b" } }],
});

describe("buildPluginsPayload", () => {
  it("merges menus across plugins and sorts by order", () => {
    expect(buildPluginsPayload([alpha, beta]).menu.map((m) => m.label)).toEqual(["Beta", "Alpha"]);
  });

  it("omits pages that declare no menu entry", () => {
    expect(buildPluginsPayload([alpha]).menu).toHaveLength(1);
  });

  it("still describes a menu-less page so it can be routed to directly", () => {
    expect(buildPluginsPayload([alpha]).pages.map((p) => p.id)).toContain("alpha.hidden");
  });

  it("carries each event's describe template and invalidation keys", () => {
    expect(buildPluginsPayload([alpha]).events).toEqual([
      { pluginId: "alpha", name: "pinged", describe: "{actorName} pinged", invalidates: ["alpha"] },
    ]);
  });
});

describe("GET /api/plugins", () => {
  it("401s without a token", async () => {
    const { app } = await bootTestServer({ plugins: [alpha] });
    expect((await app.inject({ method: "GET", url: "/api/plugins" })).statusCode).toBe(401);
  });

  it("returns the merged payload to an authenticated player", async () => {
    const { app } = await bootTestServer({ plugins: [alpha, beta] });
    const { token } = await registerAndLogin(app);
    const res = await app.inject({ method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().menu.map((m: { label: string }) => m.label)).toEqual(["Beta", "Alpha"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server plugin-manifest-endpoint`
Expected: FAIL — cannot resolve `../src/plugins/manifest-endpoint.js`.

- [ ] **Step 3: Write `manifest-endpoint.ts`**

```ts
import type { PluginManifest, ViewNode } from "@gl3/plugin-sdk";
import type { FastifyInstance } from "fastify";

export interface MenuItem { pageId: string; path: string; label: string; order: number }
export interface PagePayload { pluginId: string; id: string; path: string; view: ViewNode }
export interface EventMeta { pluginId: string; name: string; describe: string; invalidates: string[] }
export interface PluginsPayload { menu: MenuItem[]; pages: PagePayload[]; events: EventMeta[] }

/**
 * Pure and called once at boot (spec: Boot sequence step 6) — the payload is
 * identical for every player in v1, so rebuilding it per request would be
 * work with no result to show for it.
 */
export function buildPluginsPayload(manifests: readonly PluginManifest[]): PluginsPayload {
  const menu: MenuItem[] = [];
  const pages: PagePayload[] = [];
  const events: EventMeta[] = [];

  for (const manifest of manifests) {
    for (const page of manifest.pages) {
      pages.push({ pluginId: manifest.id, id: page.id, path: page.path, view: page.view });
      if (page.menu !== undefined) {
        menu.push({ pageId: page.id, path: page.path, label: page.menu.label, order: page.menu.order });
      }
    }
    for (const event of manifest.events) {
      events.push({
        pluginId: manifest.id, name: event.name,
        describe: event.describe, invalidates: event.invalidates,
      });
    }
  }

  // Ties break on page id so the order is stable across boots rather than
  // depending on the config's plugin order.
  menu.sort((a, b) => a.order - b.order || a.pageId.localeCompare(b.pageId));
  return { menu, pages, events };
}

export function registerPluginsEndpoint(app: FastifyInstance, payload: PluginsPayload): void {
  app.get("/api/plugins", { preHandler: [app.requireAuth] }, async () => payload);
}
```

Wire it in `app.ts` next to `registerPluginRoutes`, building the payload once from the same manifest list.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/server plugin-manifest-endpoint`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add apps/server
git commit -m "$(cat <<'EOF'
feat(plugins): serve merged menu, pages and event metadata at /api/plugins

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: `examples/hello-plugin` and the boot path

**Files:**
- Create: `examples/hello-plugin/package.json`, `examples/hello-plugin/tsconfig.json`, `examples/hello-plugin/src/index.ts`, `examples/hello-plugin/src/schema.ts`, `apps/server/src/plugins/loader.ts`
- Modify: `package.json` (root, workspaces), `tsconfig.json` (root), `apps/server/src/config.ts`, `apps/server/src/index.ts`, `apps/server/src/app.ts`
- Test: `apps/server/test/plugin-loader.test.ts` (`@gl3/server`)

**Interfaces:**
- Consumes: everything from Tasks 1–12.
- Produces: `loadPlugins(deps, manifests): Promise<LoadedPlugins>` — runs validate → migrate → build payload, returning `{ manifests, payload, queues, workers }`; `config.pluginIds: string[]` from `PLUGIN_IDS` (comma-separated, default empty).

This is the acceptance task: the spec's own M5 criterion is that a package outside the server adds a working page, route, migration and event without any core edit. `hello-plugin` imports **only** `@gl3/plugin-sdk`, `zod` and `drizzle-orm` — if it needs anything from `apps/server`, the SDK has a gap and that gap is the finding.

- [ ] **Step 1: Write the failing test**

`apps/server/test/plugin-loader.test.ts`:
```ts
import helloPlugin from "@gl3/hello-plugin";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadPlugins } from "../src/plugins/loader.js";
import { bootTestServer } from "./helpers/server.js";
import { registerAndLogin } from "./helpers/factories.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { testDb, testRedis } from "./helpers/db.js";

const deps = () => ({ db: testDb(), redis: testRedis(), queues: new Map(), settings: {} });

describe("hello-plugin end to end", () => {
  it("applies its migration once across two boots", async () => {
    await loadPlugins(deps(), [helloPlugin]);
    await loadPlugins(deps(), [helloPlugin]);
    await testDb().execute(sql`select 1 from p_hello_greetings limit 1`);
  });

  it("contributes a menu entry to /api/plugins", async () => {
    const { app } = await bootTestServer({ plugins: [helloPlugin] });
    const { token } = await registerAndLogin(app);
    const res = await app.inject({ method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` } });
    expect(res.json().menu).toContainEqual(expect.objectContaining({ label: "Hello", path: "/hello" }));
  });

  it("serves its route and publishes its event on the bus", async () => {
    const { app } = await bootTestServer({ plugins: [helloPlugin] });
    const { token, playerId } = await registerAndLogin(app);
    const received = awaitOwnEvent(playerId, (e) => e.type === "plugin.event" && e.name === "greeted");

    const res = await app.inject({ method: "POST", url: "/api/hello/greet", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ greetings: 1 });

    const event = await received;
    expect(event).toMatchObject({ type: "plugin.event", pluginId: "hello", name: "greeted" });
  });

  it("counts repeat greetings in the plugin's own table", async () => {
    const { app } = await bootTestServer({ plugins: [helloPlugin] });
    const { token } = await registerAndLogin(app);
    await app.inject({ method: "POST", url: "/api/hello/greet", headers: { authorization: `Bearer ${token}` } });
    const res = await app.inject({ method: "POST", url: "/api/hello/greet", headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toEqual({ greetings: 2 });
  });

  it("rejects a plugin whose basePath collides with core", async () => {
    const evil = { ...helloPlugin, id: "evil", basePaths: ["/api/auth"] };
    await expect(loadPlugins(deps(), [evil])).rejects.toThrow(/reserved/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server plugin-loader`
Expected: FAIL — cannot resolve `@gl3/hello-plugin`.

- [ ] **Step 3: Create the example package**

Add `"examples/*"` to the root `package.json` workspaces array and a `{ "path": "./examples/hello-plugin" }` reference to the root `tsconfig.json`.

`examples/hello-plugin/package.json` — note the dependency list, which is the point of the example:
```json
{
  "name": "@gl3/hello-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": { "@gl3/plugin-sdk": "*", "drizzle-orm": "^0.45.2", "zod": "^3.23.8" }
}
```
`tsconfig.json` mirrors `packages/plugin-sdk/tsconfig.json` with `references: [{ "path": "../../packages/plugin-sdk" }]`.

`examples/hello-plugin/src/schema.ts`:
```ts
import { sql } from "drizzle-orm";
import { integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/** Prefixed `p_hello_` — the loader rejects any other name for this plugin. */
export const greetings = pgTable("p_hello_greetings", {
  playerId: uuid("player_id").primaryKey(),
  count: integer("count").notNull().default(0),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull().default(sql`now()`),
});
```
No foreign key to `players`: an FK is a lock (CLAUDE.md rule 6), and a plugin table referencing a core row would take `FOR KEY SHARE` on it invisibly. The example deliberately does not model that, and a port that needs an FK owns the lock-order analysis.

`examples/hello-plugin/src/index.ts`:
```ts
import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { greetings } from "./schema.js";

export default definePlugin({
  id: "hello",
  version: "1.0.0",
  basePaths: ["/api/hello"],
  tables: { greetings: "p_hello_greetings" },
  migrations: [{
    name: "0001_init",
    sql: `CREATE TABLE p_hello_greetings (
            player_id uuid PRIMARY KEY,
            count integer NOT NULL DEFAULT 0,
            last_at timestamptz NOT NULL DEFAULT now()
          )`,
  }],
  routes: [
    route({
      method: "POST",
      path: "/api/hello/greet",
      accessInJail: false,
      handler: async (ctx) => {
        const player = ctx.player;
        if (player === null) throw new PluginError("unauthorized", 401);

        const count = await ctx.transaction(async (tx) => {
          const [row] = await tx.db
            .insert(greetings)
            .values({ playerId: player.id, count: 1 })
            .onConflictDoUpdate({
              target: greetings.playerId,
              set: { count: sql`${greetings.count} + 1`, lastAt: sql`now()` },
            })
            .returning({ count: greetings.count });
          const total = row?.count ?? 1;

          // Buffered — the loader publishes this after the transaction commits.
          await tx.events.publish({
            name: "greeted",
            actorId: player.id,
            actorName: "player",
            audience: { kind: "global" },
            payload: { count: String(total) },
          });
          return total;
        });

        return { status: 200, body: { greetings: count } };
      },
    }),
  ],
  pages: [{
    id: "hello.index",
    path: "/hello",
    menu: { label: "Hello", order: 90 },
    view: {
      kind: "panel",
      title: "Hello",
      children: [
        { kind: "text", value: "Say hello to the server." },
        { kind: "button", label: "Greet", action: "POST /api/hello/greet" },
      ],
    },
  }],
  events: [{
    name: "greeted",
    payload: z.object({ count: z.string() }),
    describe: "{actorName} said hello ({count})",
    invalidates: ["hello"],
  }],
});
```

`actorName: "player"` is a placeholder because `PlayerSnapshot` carries no username. If that reads wrong once you see it in the feed, add `username` to `PlayerSnapshot` and to `loadSnapshot` in Task 10 — that is a real SDK gap the example surfaced, which is what the example is for. Note it in the task report either way.

- [ ] **Step 4: Write `loader.ts`**

```ts
import type { PluginManifest } from "@gl3/plugin-sdk";
import type { Queue, Worker } from "bullmq";
import { buildPluginsPayload, type PluginsPayload } from "./manifest-endpoint.js";
import { createPluginQueues, createPluginWorkers } from "./jobs.js";
import { runPluginMigrations } from "./migrate.js";
import { validatePlugins } from "./validate.js";
import type { PluginCtxDeps } from "./ctx.js";

export interface LoadedPlugins {
  manifests: readonly PluginManifest[];
  payload: PluginsPayload;
  queues: Map<string, Queue>;
  workers: Worker[];
}

/**
 * Boot sequence steps 2-6 (spec). Step 1 — resolving ids to packages — is the
 * caller's, because a static `import` is what keeps the dependency direction
 * checkable by the compiler; a dynamic import by id would not be.
 *
 * Every failure here is a hard boot failure naming the plugin id.
 */
export async function loadPlugins(
  deps: Omit<PluginCtxDeps, "queues">,
  manifests: readonly PluginManifest[],
  queuePrefix = "",
): Promise<LoadedPlugins> {
  validatePlugins(manifests);
  await runPluginMigrations(deps.db, manifests);
  const queues = createPluginQueues(deps.redis, manifests, queuePrefix);
  const workers = createPluginWorkers({ ...deps, queues }, manifests, queuePrefix);
  return { manifests, payload: buildPluginsPayload(manifests), queues, workers };
}
```

Then in `app.ts`, take the loaded result rather than raw manifests: `buildApp` receives `plugins?: LoadedPlugins`, passing `plugins.queues` into the ctx deps and `plugins.payload` into `registerPluginsEndpoint`. Update `bootTestServer` to call `loadPlugins` with a random `queuePrefix` (`hello-test-<uuid>:`) when its `plugins` option is present — same reason `crime-test-<uuid>` exists.

In `config.ts`, add `PLUGIN_IDS: z.string().default("")` to the env schema and `pluginIds` to `Config`, splitting on `,` and dropping blanks. In `index.ts`, map ids to the statically imported manifests and pass the result to `loadPlugins` before `buildApp`. Keep the map small and explicit:
```ts
const AVAILABLE_PLUGINS: Record<string, PluginManifest> = { hello: helloPlugin };
```
An id with no entry is a hard boot failure naming it.

`awaitOwnEvent`'s signature is `(actorId, predicate)` as written above only if that
matches `test/helpers/events.ts` — open it and match it exactly. Rule 4 exists because
five files once matched on event type alone and captured another file's traffic.

- [ ] **Step 5: Add the type-level scope test**

The spec asks for proof that a plugin referencing a table outside its scope fails to
*typecheck*, not merely at boot. `PluginDbTx` is `PgDatabase<PgQueryResultHKT>` with no
schema attached, so there is no `tx.db.query.*` to reach core tables through — the only
tables nameable are the ones the plugin imported. Assert that in
`packages/plugin-sdk/test/scope.test-d.ts`:

```ts
import type { PluginTx } from "../src/index.js";
import { expectTypeOf } from "vitest";

// The escape hatch the spec forbids: no raw handle, and no schema-bound query
// builder to reach `players` or `ledger` through.
expectTypeOf<PluginTx>().not.toHaveProperty("redis");
// @ts-expect-error — `query` is unreachable because PluginDbTx carries no schema.
type _NoQuery = PluginTx["db"]["query"];
```

Run: `npx vitest run --project @gl3/plugin-sdk --typecheck scope`
Expected: PASS. Then delete the `@ts-expect-error` line and re-run — it must fail with
"Unused '@ts-expect-error' directive" if `query` ever becomes reachable. Restore.
If the project has no `typecheck` config, add `typecheck: { enabled: true }` to
`packages/plugin-sdk`'s vitest project rather than dropping the test.

- [ ] **Step 6: Run the whole suite**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify
```
Expected: typecheck clean; every existing test still passing **unmodified** (spec: "M5 changes no HTTP response"); the new SDK, loader, ctx, route, job and endpoint tests green. If any pre-existing test needed an edit to pass, that is a failed task, not a passing one — stop and report.

- [ ] **Step 7: Boot the real server with the plugin**

```bash
npm run build -w @gl3/server
PLUGIN_IDS=hello node apps/server/dist/index.js
```
In another shell, register a player, then `curl -X POST -H "Authorization: Bearer <token>" localhost:3000/api/hello/greet` and confirm `{"greetings":1}`. Stop and restart the server; confirm no migration error on the second boot and that `greet` still returns an incrementing count. Docker is unavailable here, so this local run plus `npm run verify` is the whole of what can be checked on this machine.

- [ ] **Step 8: Commit**

```bash
git add examples packages apps/server package.json package-lock.json tsconfig.json
git commit -m "$(cat <<'EOF'
feat(plugins): add hello-plugin example and boot-time loader

Wires validate -> migrate -> register -> cache into buildApp behind
PLUGIN_IDS, and proves a package outside apps/server can add a table,
route, page and event with no core edit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## After this plan

Plan 2 (`apps/web/src/plugins/`): the page-schema renderer, the override registry, and manifest-driven `describe()` / `invalidationKeys()` replacing the two generic fallbacks Task 4 left behind.

Plan 3: the twelve ports, in the spec's order — `ranks`, `leaderboard`, `news`, `notifications`, `profile`; then `bank`, `bullets`, `travel`; then `jail`, `crimes`; then `mail`, `gangs`. Each lands with the existing suite green and **unmodified**, and the old `app.ts` wiring is deleted when the last one moves.

## Deviations from the spec, collected

Three, each stated at its task and repeated here so a reviewer does not have to hunt:

1. **Plugin migrations are `{ name, sql }` pairs exported from TypeScript**, not drizzle-kit migrations owned by each plugin package (spec: Table ownership). Twelve packages each carrying a drizzle-kit config, a `drizzle/` directory and a `_journal.json` is a lot of machinery for what is a list of DDL strings; the `plugin_migrations` tracking table and the apply-once guarantee are unchanged. Revisit if a port needs generated migrations.
2. **`/api/plugins` is not filtered per player** (spec: Pages). No manifest field expresses reachability, and the shape of the predicate is not knowable until a ported module has a gated page. The endpoint requires auth; filtering lands in plan 3.
3. **`plugin.event` renders generically on the client** until plan 2 — `describe()` prints `pluginId.name` and `invalidationKeys()` returns `[]`. The manifest already carries the template and the keys, and `/api/plugins` already serves them; only the client half is deferred.



