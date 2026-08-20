# Extension Surface Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give plugin authors V2-class UI injection (menus, profile, HUD, dashboard, item actions, money format) through GL3's one existing extension mechanism — typed filter points — grown into core, with per-subscriber ctx binding and policy-on-the-point.

**Architecture:** Core declares five filter points (tokens in `@gl3/plugin-sdk`, value schemas in `@gl3/shared`); core routes apply them at DTO seams and the web app renders the typed fragments generically. `runFilterChain` changes in place to take bound subscriptions plus a ctx factory; `filterPoint` changes in place to take a required failure policy. Real consumers (bounties, detectives, membership, crimes, combat) prove each seam.

**Tech Stack:** TypeScript strict ESM, zod, Fastify, drizzle, React + react-query, vitest against real Postgres/Redis.

**Spec:** `docs/superpowers/specs/2026-08-20-extension-surface-design.md` (read it first — every task argues from it).

## Global Constraints

- **ONE SUBAGENT AT A TIME. Tasks are strictly sequential — never dispatch two in parallel.** Shared Postgres/Redis on this box; concurrent suites produce cross-talk that looks like regressions (CLAUDE.md). Never run two test suites at once, including your own alongside an agent's.
- Work in this worktree (`.claude/worktrees/feat-extension-surface`), branch `worktree-feat-extension-surface`. Do not cd to the main checkout.
- Before ANY test run: check `pgrep -fa vitest` (ignore your own shell's echo self-match) and `psql "$DATABASE_URL" -tc "select datname from pg_database where datname like 'gl3_tmpl%'"` for another session's runs. If found, wait.
- During iteration use scoped runs (`npx vitest run <file>` via the matching workspace project, or `npm run test:related -- <files>`). The bare `npm run verify` runs ONCE, at the merge gate (final task). Read its exit code from the process — never append `; echo` or pipe through grep/tail.
- `export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3` and `export REDIS_URL=redis://localhost:6379` before test runs. `MYSQL_ADMIN_URL` per `.env.example` only if running `apps/migrate` tests (this plan never does).
- **Compatibility regime (spec):** breaking changes to `@gl3/shared` and `@gl3/plugin-sdk` are authorized — change signatures in place, no parallel functions, no deprecated shims. No publish in this plan; publishing is a separate user-approved act.
- TypeScript strict, no `any` in `packages/*`. ESM imports carry `.js`. Zod at every external boundary. Money is bigint/decimal-string.
- No new tables, no migrations, no new lock-graph edges, no new `GameEvent` variants (spec 1d). If you think a task needs one, STOP and report — that's a spec violation.
- **Every new `apps/server/test/*.test.ts` file MUST be added to `vitest.workspace.ts`'s matching project `include`, or it silently never runs.** SDK tests under `packages/plugin-sdk/test/` are picked up by the `@gl3/plugin-sdk` project already.
- Conventional Commits. Commit at the end of every task.

---

### Task 1: SDK — `filterPoint` policy + `runFilterChain` ctx factory (in place)

**Files:**
- Modify: `packages/plugin-sdk/src/filters.ts`
- Modify: `packages/plugin-sdk/src/ctx.ts` (add `readonly pluginId: string` to `PluginCtx` if not already present; check first)
- Modify: `packages/plugin-sdk/src/index.ts` (export new names if barrel-exported)
- Test: `packages/plugin-sdk/test/filters.test.ts` (update existing + new cases)

**Interfaces (produced — later tasks rely on these exact shapes):**

```ts
export type FilterPolicy = "propagate" | "collect";
export interface FilterPoint<T> {
  readonly name: string;
  readonly policy: FilterPolicy;
  readonly _type?: (value: never) => T;
}
export function filterPoint<T>(name: string, policy: FilterPolicy): FilterPoint<T>;

export interface BoundFilterSubscription {
  readonly ownerId: string;
  readonly subscription: FilterSubscription;
}

export async function runFilterChain<T>(
  bound: readonly BoundFilterSubscription[],
  point: FilterPoint<T>,
  ctxFor: (ownerId: string) => PluginCtx,
  value: T,
): Promise<T>;
```

`on()` and `FilterSubscription` are unchanged. Keep the `_type` phantom-variance comment block and the `_Concrete`/`_Distinct` compile-time guards exactly as they are.

- [ ] **Step 1: Write the failing tests.** In `packages/plugin-sdk/test/filters.test.ts` add (mock ctx objects are fine here — this is the pure-function project, no DB):

```ts
it("hands each subscriber its own plugin's ctx, not the applier's", async () => {
  const point = filterPoint<string[]>("t1.ownerCtx", "propagate");
  const seen: string[] = [];
  const sub = on(point, async (ctx, value) => { seen.push(ctx.pluginId); return value; });
  const ctxFor = (ownerId: string) => ({ pluginId: ownerId } as unknown as PluginCtx);
  await runFilterChain([{ ownerId: "bounties", subscription: sub }], point, ctxFor, []);
  expect(seen).toEqual(["bounties"]);
});

it("collect policy drops a throwing subscriber and continues the chain", async () => {
  const point = filterPoint<number[]>("t1.collect", "collect");
  const bad = on(point, async () => { throw new Error("boom"); });
  const good = on(point, async (_ctx, value) => [...value, 1]);
  const ctxFor = (ownerId: string) =>
    ({ pluginId: ownerId, log: { error: () => {} } } as unknown as PluginCtx);
  const result = await runFilterChain(
    [{ ownerId: "a", subscription: bad }, { ownerId: "b", subscription: good }],
    point, ctxFor, [],
  );
  expect(result).toEqual([1]);
});

it("propagate policy rethrows a subscriber's error", async () => {
  const point = filterPoint<number>("t1.propagate", "propagate");
  const bad = on(point, async () => { throw new Error("boom"); });
  const ctxFor = () => ({ pluginId: "a", log: { error: () => {} } } as unknown as PluginCtx);
  await expect(runFilterChain([{ ownerId: "a", subscription: bad }], point, ctxFor, 0))
    .rejects.toThrow("boom");
});
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run packages/plugin-sdk/test/filters.test.ts` — expect FAIL (compile errors: `filterPoint` arity, `runFilterChain` signature). This is the red proof for the signature change; the whole file will not compile, which is expected.
- [ ] **Step 3: Implement.** In `filters.ts`: add `FilterPolicy`; add required `policy` param to `filterPoint` and `policy` field to `FilterPoint`; add `BoundFilterSubscription`; rewrite `runFilterChain`:

```ts
export async function runFilterChain<T>(
  bound: readonly BoundFilterSubscription[],
  point: FilterPoint<T>,
  ctxFor: (ownerId: string) => PluginCtx,
  value: T,
): Promise<T> {
  const chain = bound
    .filter((b) => b.subscription.pointName === point.name)
    .sort((a, b) => a.subscription.order - b.subscription.order);
  let current: unknown = value;
  for (const { ownerId, subscription } of chain) {
    const ctx = ctxFor(ownerId);
    if (point.policy === "collect") {
      try {
        current = await subscription.run(ctx, current);
      } catch (error) {
        ctx.log.error(`filter subscriber for "${point.name}" dropped`, { ownerId, error });
      }
    } else {
      current = await subscription.run(ctx, current);
    }
  }
  return current as T;
}
```

  In `ctx.ts`: if `PluginCtx` lacks `readonly pluginId: string`, add it (check `apps/server/src/plugins/ctx.ts`'s `createPluginCtx` — it receives `options.pluginId`; if the built ctx object doesn't already expose it, Task 2 wires it). Fix any existing tests in the file that call `filterPoint("name")` one-arg — give them explicit `"propagate"`.
- [ ] **Step 4: Run to verify pass.** `npx vitest run packages/plugin-sdk/test/filters.test.ts` — expect PASS. Note: `apps/server` and `packages/plugins/*` will NOT typecheck yet (their call sites are Task 2); do not run repo-wide typecheck here.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(sdk)!: filterPoint takes a required policy; runFilterChain takes bound subscriptions and a ctx factory"`

---

### Task 2: Wire the new signatures through plugins and server

**Files:**
- Modify: `packages/plugins/casino/src/games.ts:57`, `packages/plugins/properties/src/index.ts:308`, `packages/plugins/membership/src/api.ts:8`, `packages/plugins/travel/src/index.ts:99`, `packages/plugins/combat/src/index.ts:35` — each `filterPoint<T>("name")` → `filterPoint<T>("name", "propagate")`
- Modify: `apps/server/src/plugins/ctx.ts` — `PluginCtxOptions.filters` becomes `readonly BoundFilterSubscription[]`; `ctx.filters.apply` uses a memoized sibling-ctx factory; expose `pluginId` on the built ctx if Task 1 added it to the interface
- Modify: every site that populates `PluginCtxOptions.filters` (find with `grep -rn "filters:" apps/server/src apps/server/test/helpers` — expect `plugins/routes.ts`, `plugins/jobs.ts`, `test/helpers/plugin-route.ts`, `test/helpers/server.ts`): map `manifests.flatMap((m) => m.filters.map((subscription) => ({ ownerId: m.id, subscription })))`
- Test: `apps/server/test/filter-subscriber-ctx.test.ts` (new — register in `vitest.workspace.ts` under the default `@gl3/server` project)

**Interfaces:**
- Consumes: Task 1's `BoundFilterSubscription`, `runFilterChain(bound, point, ctxFor, value)`.
- Produces: `createPluginCtx` builds sibling ctxs internally — no caller passes a factory. Sibling construction inside `createPluginCtx`:

```ts
const siblings = new Map<string, PluginCtx>();
const ctxFor = (ownerId: string): PluginCtx => {
  if (ownerId === options.pluginId) return ctx;
  let sibling = siblings.get(ownerId);
  if (sibling === undefined) {
    sibling = createPluginCtx(deps, { ...options, pluginId: ownerId });
    siblings.set(ownerId, sibling);
  }
  return sibling;
};
// in the ctx literal:
// filters: { apply: (point, value) => runFilterChain(options.filters, point, ctxFor, value) }
```

- [ ] **Step 1: Write the failing integration test** (`apps/server/test/filter-subscriber-ctx.test.ts`). Boot with two tiny inline test plugins via the existing test-server helper pattern (copy the shape from `apps/server/test/plugin-ctx-core-events.test.ts` or `casino-rogue-game.test.ts`): plugin `applier` declares a point `applier.hook` (`"propagate"`) and a route that calls `ctx.filters.apply`; plugin `subscriber` subscribes and, inside the subscriber, publishes a plugin event via `tx.events.publish` and returns `ctx.pluginId`. Assert (a) the returned value is `"subscriber"`, and (b) the published event arrives on `game:events` attributed to `subscriber`, not `applier` — use `awaitOwnEvent()` from `test/helpers/events.ts` (rule 4: filter by your own actorId).
- [ ] **Step 2: Run to verify it fails.** It fails to compile until the wiring lands (filters array shape). `npx vitest run apps/server/test/filter-subscriber-ctx.test.ts`.
- [ ] **Step 3: Implement** the modifications listed under Files. Keep `ctx.filters.apply`'s public signature identical — plugins are untouched beyond the five one-line `"propagate"` additions.
- [ ] **Step 4: Typecheck + scoped tests.** `npm run typecheck`, then `npx vitest run apps/server/test/filter-subscriber-ctx.test.ts` (PASS), then `npm run test:related -- apps/server/src/plugins/ctx.ts` to sweep existing filter consumers (casino, membership, travel, properties, combat suites).
- [ ] **Step 5: Commit.** `git commit -am "feat(server)!: bind each filter subscriber to its own plugin ctx"`

---

### Task 3: Retire the legacy duck-type arm in SDK error guards

**Files:**
- Modify: `packages/plugin-sdk/src/errors.ts` — delete `named()` and the fallback arm in all four guards; brand-only:

```ts
export function isPluginError(value: unknown): value is PluginError {
  return branded(value, PLUGIN_ERROR);
}
export function isInsufficientFundsError(value: unknown): value is InsufficientFundsError {
  return branded(value, INSUFFICIENT_FUNDS);
}
export function isInsufficientGangFundsError(value: unknown): value is InsufficientGangFundsError {
  return branded(value, INSUFFICIENT_GANG_FUNDS);
}
export function isJobAlreadyAppliedError(value: unknown): value is JobAlreadyAppliedError {
  return branded(value, JOB_ALREADY_APPLIED);
}
```

  Rewrite the doc comment: brand-only; `Symbol.for` is process-global so the check survives a second SDK copy; the pre-brand duck-type arm was removed under the compat regime (no plugin published against 0.1.0–0.1.8 exists).
- Modify: `packages/plugin-sdk/test/error-guards.test.ts` — delete the "accepts an unbranded error from an SDK copy older than the brand" case and the `LegacyPluginError` fixture (line ~32); **keep and strengthen** the impostor case: an `Error` with `name = "PluginError"`, `code`, and `status` must now be **rejected**.
- Modify: `packages/plugin-sdk/test/errors.test.ts` — remove/flip any case pinning the `named()` fallback (search `name = "` in the file).

- [ ] **Step 1: Flip the tests first** (impostor now rejected; unbranded-legacy case deleted). Run `npx vitest run packages/plugin-sdk/test/error-guards.test.ts packages/plugin-sdk/test/errors.test.ts` — expect the flipped impostor assertion to FAIL against current code (it currently passes the guard). That's the red.
- [ ] **Step 2: Implement the deletion** in `errors.ts`.
- [ ] **Step 3: Run both files — PASS.** Then `npm run typecheck`.
- [ ] **Step 4: Commit.** `git commit -am "refactor(sdk)!: error guards are brand-only; retire pre-brand duck-type arm"`

---

### Task 4: Enforce the point-name convention in `validatePlugins`

**Files:**
- Modify: `apps/server/src/plugins/validate.ts` — inside the first per-manifest loop of `validatePlugins` add:

```ts
for (const point of manifest.provides) {
  if (point.name === "core" || point.name.startsWith("core.")) {
    fail(`plugin "${manifest.id}" declares filter point "${point.name}" — the "core." prefix is reserved to the SDK`);
  }
  if (!point.name.startsWith(`${manifest.id}.`)) {
    fail(`plugin "${manifest.id}" declares filter point "${point.name}", which must start with "${manifest.id}."`);
  }
}
```

- Test: `apps/server/test/plugin-point-names.test.ts` (new — this is a pure-manifests test, no DB: register it in `vitest.workspace.ts` under `@gl3/server:unit`)

- [ ] **Step 1: Write the failing test.** Build minimal manifests with `definePlugin` (id `evil`, `basePaths: ["/api/evil"]`, `provides: [filterPoint("core.hijack", "propagate")]` and a second case `provides: [filterPoint("other.thing", "propagate")]`) and assert `validatePlugins([...])` throws with the exact messages above; a third case with `provides: [filterPoint("evil.fine", "propagate")]` passes. Note `filterPoint` throws on duplicate names process-wide — use unique names per case.
- [ ] **Step 2: Run — FAIL** (no error thrown yet). `npx vitest run apps/server/test/plugin-point-names.test.ts`.
- [ ] **Step 3: Implement, run — PASS.** Also `npm run test:related -- apps/server/src/plugins/validate.ts` (existing loader tests must stay green — all five real points already conform).
- [ ] **Step 4: Commit.** `git commit -am "feat(loader): enforce filter point name prefix; reserve core. to the SDK"`

---

### Task 5: Shared schemas for extension fragments

**Files:**
- Create: `packages/shared/src/dto/extensions.ts`
- Modify: `packages/shared/src/dto/profile.ts` — `ProfileDtoSchema` gains `extras: z.array(ProfileExtraSchema).optional()`
- Modify: `packages/shared/src/dto/plugins.ts` — `PluginsPayloadSchema` gains `moneyFormat: MoneyFormatSchema`
- Modify: `packages/shared/src/dto/inventory.ts` — the per-item schema gains `actions: z.array(ItemActionSchema).optional()`
- Modify: `packages/shared/src/index.ts` (or wherever dto modules are re-exported — match `dto/rounds.ts`'s registration)
- Test: `packages/shared/test/extensions.test.ts` (new; `@gl3/shared` project auto-includes its test dir — verify by running it)

**Interfaces (produced):**

```ts
import { z } from "zod";
import { TimestampSchema } from "../primitives.js";
import { ViewNodeDtoSchema } from "./plugins.js"; // reuse the existing view-node schema; check its real export name in dto/plugins.ts

export const ProfileExtraSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stat"), pluginId: z.string().min(1), label: z.string().min(1), value: z.string() }).strict(),
  z.object({ kind: z.literal("link"), pluginId: z.string().min(1), label: z.string().min(1), to: z.string().min(1) }).strict(),
]);
export type ProfileExtra = z.infer<typeof ProfileExtraSchema>;

export const DashboardWidgetSchema = z.object({
  pluginId: z.string().min(1), title: z.string().min(1), view: ViewNodeDtoSchema,
}).strict();
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;

export const HudEntrySchema = z.object({
  pluginId: z.string().min(1), label: z.string().min(1), value: z.string(),
  countdownTo: TimestampSchema.optional(),
}).strict();
export type HudEntry = z.infer<typeof HudEntrySchema>;

export const MenuBadgeSchema = z.object({
  path: z.string().startsWith("/"), count: z.number().int().nonnegative(),
}).strict();
export type MenuBadge = z.infer<typeof MenuBadgeSchema>;

export const MoneyFormatSchema = z.object({
  symbol: z.string().min(1).max(8),
  position: z.enum(["prefix", "suffix"]),
  thousandsSep: z.string().max(3),
}).strict();
export type MoneyFormat = z.infer<typeof MoneyFormatSchema>;
export const DEFAULT_MONEY_FORMAT: MoneyFormat = { symbol: "$", position: "prefix", thousandsSep: "," };

export const ItemActionSchema = z.object({
  pluginId: z.string().min(1), label: z.string().min(1), to: z.string().min(1),
}).strict();
export type ItemAction = z.infer<typeof ItemActionSchema>;

export const ProfileViewValueSchema = z.object({
  targetId: z.string().uuid(), extras: z.array(ProfileExtraSchema),
}).strict();
export type ProfileViewValue = z.infer<typeof ProfileViewValueSchema>;

export const HudExtrasResponseSchema = z.object({ entries: z.array(HudEntrySchema) }).strict();
export const MenuBadgesResponseSchema = z.object({ badges: z.array(MenuBadgeSchema) }).strict();
export const DashboardWidgetsResponseSchema = z.object({ widgets: z.array(DashboardWidgetSchema) }).strict();
```

- [ ] **Step 1: Write the failing test** — parse a valid instance of each schema; reject an extra with unknown `kind`; reject a badge path not starting with `/`; assert `DEFAULT_MONEY_FORMAT` parses. Run `npx vitest run packages/shared/test/extensions.test.ts` — FAIL (module missing).
- [ ] **Step 2: Implement.** If `PluginsPayloadSchema` is `.strict()`, adding a required `moneyFormat` breaks the server's payload builder until Task 7 — that is fine mid-branch, but keep the repo compiling: also update `apps/server/src/plugins/manifest-endpoint.ts`'s local `PluginsPayload` interface with `moneyFormat: MoneyFormat` and have `buildPluginsPayload` fill `DEFAULT_MONEY_FORMAT` for now (Task 7 replaces it with the filter application).
- [ ] **Step 3: Run — PASS**, then `npm run typecheck` (the web app parses the payload; the new required field arrives from the server default, so it stays green).
- [ ] **Step 4: Commit.** `git commit -am "feat(shared): extension fragment schemas (profile extras, widgets, hud, badges, money format, item actions)"`

---

### Task 6: SDK core points + server-side core applier

**Files:**
- Create: `packages/plugin-sdk/src/core-points.ts`:

```ts
import type { DashboardWidget, HudEntry, MenuBadge, MoneyFormat, ProfileViewValue } from "@gl3/shared";
import { filterPoint } from "./filters.js";

/** Core-owned UI seams (spec §2). Subscribers attribute entries with ctx.pluginId. */
export const coreProfileView = filterPoint<ProfileViewValue>("core.profileView", "collect");
export const coreDashboard = filterPoint<DashboardWidget[]>("core.dashboard", "collect");
export const coreHud = filterPoint<HudEntry[]>("core.hud", "collect");
export const coreMenuBadges = filterPoint<MenuBadge[]>("core.menuBadges", "collect");
export const coreMoneyFormat = filterPoint<MoneyFormat>("core.moneyFormat", "collect");
```

- Modify: `packages/plugin-sdk/src/index.ts` — export them.
- Create: `apps/server/src/plugins/core-filters.ts`:

```ts
import type { FilterPoint, PluginManifest } from "@gl3/plugin-sdk";
import { runFilterChain, type BoundFilterSubscription } from "@gl3/plugin-sdk";
import { createPluginCtx, type PluginCtxDeps } from "./ctx.js";
import type { PlayerSnapshot } from "@gl3/plugin-sdk"; // adjust import site to wherever PlayerSnapshot really lives

export interface CoreFilters {
  apply<T>(point: FilterPoint<T>, player: PlayerSnapshot | null, value: T): Promise<T>;
}

/** Mirror the option collection `registerPluginRoutes` performs (propertyTypes, installedPluginIds, assetSlots) — read `plugins/routes.ts` and reuse its collectors. */
export function buildCoreFilters(deps: PluginCtxDeps, manifests: readonly PluginManifest[]): CoreFilters {
  const bound: BoundFilterSubscription[] = manifests.flatMap((m) =>
    m.filters.map((subscription) => ({ ownerId: m.id, subscription })));
  // propertyTypes / installedPluginIds / assetSlots: same collector calls routes.ts makes.
  return {
    apply: (point, player, value) =>
      runFilterChain(bound, point, (ownerId) =>
        createPluginCtx(deps, { pluginId: ownerId, player, job: null, filters: bound, /* + collected options */ }), value),
  };
}
```

  (Memoize per-owner ctx per `apply` call if `createPluginCtx` allocation shows up; do not memoize across calls — `player` differs per call.)
- Modify: `apps/server/src/plugins/loader.ts` — `LoadedPlugins` gains `coreFilters: CoreFilters`; `loadPlugins` builds it after queues exist and returns it.
- Test: `apps/server/test/core-filters.test.ts` (new — register in `vitest.workspace.ts`, default `@gl3/server` project)

**Interfaces:**
- Consumes: Task 1 `runFilterChain`/`BoundFilterSubscription`, Task 5 types.
- Produces: `LoadedPlugins.coreFilters` with `apply<T>(point, player, value)` — Tasks 7–8 call it.

- [ ] **Step 1: Write the failing test** — boot the test server with an inline plugin subscribing to `coreHud` (returns `[...value, { pluginId: ctx.pluginId, label: "T", value: "1" }]`), grab `coreFilters` off the loaded result (or apply through a thin route if the helper hides it — follow `bootTestServer`'s return shape), call `apply(coreHud, snapshot, [])`, assert the entry arrives with `pluginId` of the subscriber. Add a second subscriber that throws and assert it is dropped (collect policy) while the first still contributes.
- [ ] **Step 2: Run — FAIL** (`core-points.ts` missing).
- [ ] **Step 3: Implement.** Check whether `@gl3/plugin-sdk`'s `package.json` already depends on `@gl3/shared` (it does — range `^0.1.6`); no manifest change needed.
- [ ] **Step 4: Run — PASS**, `npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -am "feat(sdk,server): core-owned filter points and core applier"`

---

### Task 7: Apply `core.profileView` and `core.moneyFormat`

**Files:**
- Modify: `apps/server/src/game/profile/routes.ts` — `registerProfileRoutes` gains a `coreFilters: CoreFilters` parameter; after the money-rank bracket query and before `reply.send`:

```ts
const { extras } = await coreFilters.apply(coreProfileView, null, {
  targetId: row.playerId, extras: [],
});
```

  and add `extras` to the response object. The route is public — the subscriber ctx gets `player: null`; subscribers key off `value.targetId`.
- Modify: `apps/server/src/plugins/manifest-endpoint.ts` — `registerPluginsEndpoint` gains `coreFilters`; the handler becomes per-request:

```ts
app.get("/api/plugins", { preHandler: [app.requireAuth] }, async () => ({
  ...payload,
  moneyFormat: await coreFilters.apply(coreMoneyFormat, null, DEFAULT_MONEY_FORMAT),
}));
```

  Remove Task 5's temporary `DEFAULT_MONEY_FORMAT` fill from `buildPluginsPayload` (the boot-built payload stays static; only the format is per-request).
- Modify: `apps/server/src/app.ts` — thread `loaded.coreFilters` into both registration calls (find the existing call sites; `loadPlugins` runs before route registration — if it doesn't in the current order, move route registration after it and say so in the commit body).
- Test: `apps/server/test/core-profile-extras.test.ts` (new — register in `vitest.workspace.ts`)

- [ ] **Step 1: Write the failing test** — boot with an inline plugin whose manifest `filters` subscribes `coreProfileView` (adds one stat + one link with `ctx.pluginId`) and `coreMoneyFormat` (returns `{ symbol: "£", position: "prefix", thousandsSep: "." }`). Register a player (use the existing register/login helper), `GET /api/players/:id/profile` → assert `extras` has both entries and `ProfileDtoSchema.parse` accepts the body. `GET /api/plugins` with the session cookie → assert `moneyFormat.symbol === "£"`. Add a throwing `coreProfileView` subscriber in a second plugin → profile still 200, its entries absent.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS**, plus `npm run test:related -- apps/server/src/game/profile/routes.ts`.
- [ ] **Step 5: Commit.** `git commit -am "feat(core): profile extras and money format flow through core filter points"`

---

### Task 8: Extension routes — HUD extras, menu badges, dashboard widgets

**Files:**
- Create: `apps/server/src/plugins/extension-routes.ts`:

```ts
export function registerExtensionRoutes(
  app: FastifyInstance, db: Db, coreFilters: CoreFilters,
): void {
  // requireAuth via app.requireAuth (same preHandler shape registerPluginsEndpoint uses).
  // Load the caller's PlayerSnapshot with the same loader plugins/routes.ts uses (loadSnapshot).
  app.get("/api/hud/extras", { preHandler: [app.requireAuth] }, async (request) => {
    const snapshot = await loadSnapshot(db, request.playerId as string);
    return { entries: await coreFilters.apply(coreHud, snapshot, []) };
  });
  app.get("/api/menu/badges", { preHandler: [app.requireAuth] }, async (request) => {
    const snapshot = await loadSnapshot(db, request.playerId as string);
    return { badges: await coreFilters.apply(coreMenuBadges, snapshot, []) };
  });
  app.get("/api/dashboard/widgets", { preHandler: [app.requireAuth] }, async (request) => {
    const snapshot = await loadSnapshot(db, request.playerId as string);
    return { widgets: await coreFilters.apply(coreDashboard, snapshot, []) };
  });
}
```

  (`loadSnapshot` is exported from `apps/server/src/plugins/routes.ts:156` — import it, don't copy it. If it isn't exported, export it.)
- Modify: `apps/server/src/app.ts` — register after plugin load.
- Modify: `apps/server/src/plugins/validate.ts` `RESERVED_BASE_PATHS` — confirm `/api/hud`, `/api/menu`, `/api/dashboard` are reserved to core; add them if the list is path-prefix based (read how `/api/admin` entries are expressed and match).
- Test: `apps/server/test/extension-routes.test.ts` (new — register in `vitest.workspace.ts`)

- [ ] **Step 1: Write the failing test** — inline plugin subscribes all three points, keyed off `ctx.player` (assert subscriber sees the CALLER's id: have it emit `value + [{ label: "pid", value: ctx.player!.id }]`-style entries). Authenticated GETs to all three routes; zod-parse responses with Task 5's response schemas; assert the caller's player id round-tripped (proves the snapshot reached the subscriber ctx). Unauthenticated GET → 401.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS**, `npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -am "feat(core): hud extras, menu badges and dashboard widget routes"`

---

### Task 9: Web — money format + query plumbing

**Files:**
- Modify: `apps/web/src/lib/money.ts` — `formatMoney(value: string, format?: MoneyFormat)` and `formatAmount(value: string, format?: MoneyFormat)`; default behaviour identical to today when `format` is omitted (existing tests must not change).
- Create: `apps/web/src/lib/formatContext.tsx` — React context carrying `MoneyFormat`, default `DEFAULT_MONEY_FORMAT`; provider reads `usePlugins().data?.moneyFormat`.
- Modify: `apps/web/src/components/ui.tsx` — `Money`/`Amount` read the context and pass it to the formatters.
- Modify: `apps/web/src/components/Shell.tsx` (or `App.tsx`, whichever wraps every page — Shell is inside auth, use Shell) — mount the provider around the shell body.
- Modify: `apps/web/src/api/keys.ts` — add `hudExtras: () => ["hudExtras"] as const`, `menuBadges: () => ["menuBadges"] as const`, `dashboardWidgets: () => ["dashboardWidgets"] as const`.
- Modify: `apps/web/src/api/queries.ts` — `useHudExtras`, `useMenuBadges`, `useDashboardWidgets` hooks fetching the three routes, zod-parsed with Task 5's response schemas (match how existing hooks parse — follow `usePlugins`).
- Modify: `apps/web/src/ws/invalidation.ts` — plugin-event `invalidates` strings already map to query keys; ensure `"hudExtras"`, `"menuBadges"`, `"dashboardWidgets"` resolve (read the file; if it maps names→keys via the `keys` factory, the additions above may suffice — verify, don't assume).

- [ ] **Step 1: Write the failing unit test** for the formatter (`apps/web` has a test setup under the `@gl3/web` project — find an existing `*.test.ts` under `apps/web` to copy conventions; if none tests `lib/`, add `apps/web/src/lib/money.test.ts` and confirm the project's `include` picks it up by running it):

```ts
expect(formatMoney("1234567")).toBe("$1,234,567"); // unchanged default
expect(formatMoney("1234567", { symbol: "£", position: "prefix", thousandsSep: "." })).toBe("£1.234.567");
expect(formatMoney("1234567", { symbol: " kr", position: "suffix", thousandsSep: " " })).toBe("1 234 567 kr");
```

- [ ] **Step 2: Run — FAIL**, implement, **run — PASS.**
- [ ] **Step 3: Implement the context, hooks, keys, invalidation entries.** `npm run typecheck` and run the `@gl3/web` project tests.
- [ ] **Step 4: Commit.** `git commit -am "feat(web): plugin-driven money format and extension query plumbing"`

---

### Task 10: Web — render extras, widgets, HUD entries, badges

**Files:**
- Modify: `apps/web/src/components/ProfileCard.tsx` — render `profile.extras ?? []`: `stat` entries as additional rows in whatever row structure the card already uses; `link` entries as react-router `<Link>`s in an actions area.
- Modify: `apps/web/src/pages/Dashboard.tsx` — `useDashboardWidgets()`; render each widget in a `<Panel title={w.title}>` via `renderNode(w.view, {})` + `PageRenderer` (copy the exact call shape from `PluginPage.tsx:35-43`, keyed per widget `pluginId + title`).
- Modify: `apps/web/src/components/Shell.tsx` — `useHudExtras()`: append `<Stat label={e.label}>{e.value}</Stat>` per entry after the built-in stats; when `countdownTo` is set render a ticking countdown (reuse the countdown hook the jail banner uses — `useSentenceCountdown` is jail-specific; if not reusable, compute remaining seconds with a 1s `setInterval` effect in a tiny `CountdownValue` component). `useMenuBadges()`: build `pluginBadges: Record<string, number>` keyed by badge `path` and merge with the existing `badges` record so core LINKS and pluginLinks both show counts (plugin link paths are `/plugins/<pageId>` — subscribers write that literal path).
- Test: typecheck + `@gl3/web` project suite; rendering is proven end-to-end by the retrofit tasks' server-side assertions plus manual smoke in Task 16.

- [ ] **Step 1: Implement all four render sites.**
- [ ] **Step 2: `npm run typecheck` and run the `@gl3/web` project tests — PASS.**
- [ ] **Step 3: Commit.** `git commit -am "feat(web): render profile extras, dashboard widgets, hud entries and nav badges"`

---

### Task 11: Retrofit — bounties on the profile

**Files:**
- Modify: `packages/plugins/bounties/src/index.ts` — manifest `filters` gains:

```ts
on(coreProfileView, async (ctx, value) => {
  const rows = await ctx.transaction(async (tx) => tx.db
    .select({ amount: bounties.amount })
    .from(bounties)
    .where(/* open bounties on value.targetId — read schema.ts for the real open/claimed discriminator */));
  const total = rows.reduce((sum, r) => sum + r.amount, 0n);
  const extras = [...value.extras,
    { kind: "link" as const, pluginId: ctx.pluginId, label: "Place bounty", to: `/bounties?target=${value.targetId}` }];
  if (total > 0n) {
    extras.unshift({ kind: "stat" as const, pluginId: ctx.pluginId, label: "Open bounty", value: `$${total.toString()}` });
  }
  return { ...value, extras };
})
```

  Import `coreProfileView` and `on` from `@gl3/plugin-sdk`; import the table from the plugin's own `schema.js`.
- Modify: `apps/web/src/pages/Bounties.tsx` — read `?target=` (`useSearchParams`) and prefill the place-bounty form's target field.
- Test: `apps/server/test/profile-extras-bounties.test.ts` (new — register in `vitest.workspace.ts`)

- [ ] **Step 1: Write the failing test** — boot the real server (bounties is a core plugin, already loaded), create two players, have A place a bounty on B through `POST /api/bounties` (read the route's body schema in the plugin source), then `GET /api/players/B/profile` and assert an `extras` stat entry `Open bounty` with the amount and a link entry `to` containing `target=`+B's id, both `pluginId: "bounties"`. Also assert a player with no bounty gets the link but no stat.
- [ ] **Step 2: Run — FAIL**, implement, **run — PASS.**
- [ ] **Step 3: Commit.** `git commit -am "feat(bounties): profile shows open bounty and place-bounty action"`

---

### Task 12: Retrofit — detectives (profile link + nav badge)

**Files:**
- Modify: `packages/plugins/detectives/src/index.ts` — manifest `filters` gains:

```ts
on(coreProfileView, async (ctx, value) => ({
  ...value,
  extras: [...value.extras,
    { kind: "link" as const, pluginId: ctx.pluginId, label: "Hire detective", to: `/detectives?target=${value.targetId}` }],
})),
on(coreMenuBadges, async (ctx, value) => {
  const player = ctx.player;
  if (player === null) return value;
  const ready = await ctx.transaction(async (tx) => /* count of p_detectives_searches rows for player.id where ends_at <= now() and (expires_at is null or expires_at > now()) — read the plugin's schema.ts for real column names */);
  return ready > 0 ? [...value, { path: "/detectives", count: ready }] : value;
})
```

- Modify: `apps/web/src/pages/Detectives.tsx` — prefill from `?target=` like Task 11.
- Test: `apps/server/test/detectives-extras.test.ts` (new — register in `vitest.workspace.ts`)

- [ ] **Step 1: Write the failing test** — profile of any player carries the detectives link; a player with a search whose `ends_at` is in the past (insert the row directly, the way `detectives-worker.test.ts` seeds) gets `{ path: "/detectives", count: 1 }` from `GET /api/menu/badges`; a player with none gets no detectives badge.
- [ ] **Step 2: Run — FAIL**, implement, **run — PASS.**
- [ ] **Step 3: Commit.** `git commit -am "feat(detectives): profile hire action and ready-report nav badge"`

---

### Task 13: Retrofit — membership (HUD countdown + profile stat)

**Files:**
- Modify: `packages/plugins/membership/src/index.ts` — manifest `filters` gains:

```ts
on(coreHud, async (ctx, value) => {
  const player = ctx.player;
  if (player === null) return value;
  const until = await ctx.transaction(async (tx) => membershipUntil(tx, player.id));
  if (until === null) return value;
  return [...value, {
    pluginId: ctx.pluginId, label: "Membership", value: "Member", countdownTo: until.toISOString(),
  }];
}),
on(coreProfileView, async (ctx, value) => {
  const member = await ctx.transaction(async (tx) => isMember(tx, value.targetId));
  if (!member) return value;
  return { ...value, extras: [...value.extras,
    { kind: "stat" as const, pluginId: ctx.pluginId, label: "Membership", value: "Member" }] };
})
```

  **Caution:** `membershipUntil` performs lazy expiry notification (DELETE-as-claim). Called from a HUD read that fires often, that is exactly its designed idempotent path (the claim happens once). Do not "optimize" it into a raw select.
- Test: `apps/server/test/membership-extras.test.ts` (new — register in `vitest.workspace.ts`)

- [ ] **Step 1: Write the failing test** — give a player membership through the plugin's own buy route (or seed the `player_timers` row keyed `membership` the way `membership` tests already do), then `GET /api/hud/extras` asserts an entry with `countdownTo` ≈ the expiry, and the profile shows the Member stat; a non-member gets neither.
- [ ] **Step 2: Run — FAIL**, implement, **run — PASS.**
- [ ] **Step 3: Commit.** `git commit -am "feat(membership): hud countdown and profile member stat"`

---

### Task 14: Retrofit — crimes dashboard widget

**Files:**
- Modify: `packages/plugins/crimes/src/index.ts` — manifest `filters` gains:

```ts
on(coreDashboard, async (ctx, value) => {
  const player = ctx.player;
  if (player === null) return value;
  const remaining = await ctx.cooldown.peek("crime", player.id);
  return [...value, {
    pluginId: ctx.pluginId,
    title: "Crimes",
    view: {
      kind: "panel" as const, title: "Crimes",
      children: [
        { kind: "text" as const, value: remaining > 0 ? `Next crime ready in ${remaining}s` : "A crime is ready." },
        { kind: "link" as const, label: "Go to crimes", to: "/crimes" },
      ],
    },
  }];
})
```

  (Match the exact `ViewNode` field names against `packages/plugin-sdk/src/pages.ts` — `link` nodes there use `label`/`to`.) The cooldown scope: under per-subscriber binding the ctx is crimes' own, so `ctx.cooldown.peek("crime", …)` reads the same key the commit route writes — assert that in the test, it is the whole point.
- Test: `apps/server/test/crimes-widget.test.ts` (new — register in `vitest.workspace.ts`)

- [ ] **Step 1: Write the failing test** — fresh player: widget says ready; after `POST /api/crimes/:id/commit` (existing test helpers know how), `GET /api/dashboard/widgets` shows `Next crime ready in` (cooldown now armed — proves the sibling ctx reads crimes' real cooldown scope). Zod-parse with `DashboardWidgetsResponseSchema`.
- [ ] **Step 2: Run — FAIL**, implement, **run — PASS.**
- [ ] **Step 3: Commit.** `git commit -am "feat(crimes): dashboard next-crime widget"`

---

### Task 15: `inventory.itemActions` + combat's gunsmith link

**Files:**
- Modify: `packages/plugins/inventory/src/index.ts` — declare and apply the point:

```ts
export interface ItemActionsValue {
  items: { itemId: string; itemType: string }[];
  actions: { itemId: string; pluginId: string; label: string; to: string }[];
}
export const itemActions = filterPoint<ItemActionsValue>("inventory.itemActions", "collect");
```

  Add `itemActions` to the manifest's `provides`. In `listRoute`'s handler, after `owned` is loaded (outside the transaction — filters must not run inside it; the query result is already materialized, so apply after `ctx.transaction` returns, then merge):

```ts
const acted = await ctx.filters.apply(itemActions, {
  items: owned.map((row) => ({ itemId: row.itemId, itemType: row.itemType })),
  actions: [],
});
// per item in the response body:
// actions: acted.actions.filter((a) => a.itemId === row.itemId)
```

  Restructure the handler minimally so the DTO assembly happens after the transaction; return shape otherwise unchanged. (Shared side landed in Task 5: optional `actions` on the item schema.)
- Modify: `packages/plugins/combat/src/index.ts` — manifest `filters` gains (combat→inventory dependency already exists):

```ts
on(itemActions, async (ctx, value) => ({
  ...value,
  actions: [...value.actions, ...value.items
    .filter((item) => item.itemType === ITEM_TYPE_WEAPON) // import the constant from inventory's public surface; if effects.ts isn't exported, compare against the literal the DTO carries — check how combat already reads item types
    .map((item) => ({ itemId: item.itemId, pluginId: ctx.pluginId, label: "Repair at gunsmith", to: "/combat" }))],
}))
```

- Modify: `apps/web/src/pages/Inventory.tsx` — render each item's `actions ?? []` as `<Link>`s alongside the existing per-item controls.
- Test: `apps/server/test/inventory-item-actions.test.ts` (new — register in `vitest.workspace.ts`)

- [ ] **Step 1: Write the failing test** — seed a player with one weapon item and one consumable (existing combat/inventory tests show the seeding), `GET /api/inventory`, assert the weapon row carries exactly one action `{ pluginId: "combat", label: "Repair at gunsmith" }` and the consumable carries none; parse the body with the shared inventory response schema.
- [ ] **Step 2: Run — FAIL**, implement, **run — PASS**, plus `npm run test:related -- packages/plugins/inventory/src/index.ts`.
- [ ] **Step 3: Commit.** `git commit -am "feat(inventory,combat): item action injection; gunsmith repair discoverable from inventory"`

---

### Task 16: Docs, version stamps, merge gate

**Files:**
- Modify: `docs/STATUS.md` — new section for this cluster: surface grown 5→11 points (5 existing + 5 core + `inventory.itemActions`), per-subscriber ctx binding (trap retired), policy-on-the-point, brand-only error guards, point-name enforcement, the compat-regime decision and its end condition (first third-party plugin author), retrofit list, and the explicit non-changes (no tables/migrations/lock edges/GameEvent variants).
- Modify: `CLAUDE.md` — update the filter-point census where it says "GL3 has five filter points" context lives (the current-state section); note the ctx-binding trap is FIXED (the two recorded workarounds no longer necessary for new code); add the compat-regime line with its end condition.
- Modify: `packages/shared/package.json` and `packages/plugin-sdk/package.json` — bump each to the next free patch number **after checking the registry** (`npm view @gl3/shared versions --registry https://npm.gl3.dev`, same for the SDK). Do NOT publish.
- Modify: `packages/plugin-sdk/src/index.ts` docs / README if the SDK carries one — document the five core points and the subscriber conventions (attribute with `ctx.pluginId`; collect policy; links as action verb).

- [ ] **Step 1: Write the doc updates.**
- [ ] **Step 2: Concurrency check, then merge gate.** Verify no other suite is running (`pgrep -fa vitest`, `gl3_tmpl%` query — see Global Constraints), then run the bare gate:

```bash
npm run verify > /tmp/claude-1000/-home-dlite-GL3/86b2c370-8a38-4417-9394-fb19bf96f881/scratchpad/verify.log 2>&1
echo "exit=$?"   # run as a SEPARATE command so the exit code read is the verify process's
```

  Actually run them as two separate Bash invocations so the harness reports `npm run verify`'s own exit status. Treat ANY non-zero exit as failure even if the summary shows all tests passed (unhandled rejections). If `casino-lock-order`'s ABBA case fails with a bare 500 on `lockPlayersForUpdate`, that is the documented open flake — re-run the file standalone AND report the occurrence; do not silently retry the whole suite.
- [ ] **Step 3: Fix anything red, re-run the gate clean.** Expected drift guards that may fire if earlier tasks missed something: `packages/shared/test/events.test.ts` census (should NOT fire — no new GameEvent variants), `schema.test.ts` (should NOT fire — no migrations). If either fires, a task violated spec 1d — stop and report, don't restate counts.
- [ ] **Step 4: Commit.** `git commit -am "docs: extension surface cluster status; version stamps"`

---

## Self-review notes (already applied)

- Spec coverage: 1a→Tasks 1–2, 1b→Task 6, 1c→Task 1, point-name enforcement→Task 4, legacy-arm retirement→Task 3, compat regime→Global Constraints + Task 16, seam catalogue→Tasks 5–8, rendering→Tasks 9–10, retrofits→Tasks 11–15, versioning/docs/gate→Task 16.
- `core.moneyFormat` has no natural consumer by spec; its behaviour is proven by Task 7's test subscriber. Deliberate, not a gap.
- Task ordering is dependency-ordered and MUST run sequentially, one subagent at a time (user constraint; shared DB/Redis).
- Where a step says "read the plugin's schema.ts for real column names", that is a deliberate instruction to the executor to verify against source rather than trust this plan's guess — the columns exist, only their exact names are to be confirmed. These are verification instructions, not placeholders.
