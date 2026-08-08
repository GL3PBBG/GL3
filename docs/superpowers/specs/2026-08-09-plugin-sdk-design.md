# M5 — Plugin SDK

Design approved 2026-08-09. Supersedes SPEC §5's sketch where the two disagree;
disagreements are called out inline.

## Why this before the gameplay breadth

GL3 is missing most of V2's gameplay: combat/kill/hospital, bounties, cars,
detectives, inventory, properties, points. SPEC §6 orders M5 last, planning to
refactor *two* modules (crimes, bank) into plugins. Building ten new subsystems as
hardcoded Fastify routes first would turn that into a refactor of twelve — every one
of them written twice — and would design the plugin API against the two simplest
modules in the codebase.

V2's architecture is modules plus hooks. Those missing subsystems *are* the plugin
API's requirements. So the SDK ships first, and the gameplay is built on it.

M4 (migration CLI) is unaffected and stays queued behind a MariaDB install: it
targets tables, not routes, and the schema is already complete.

## Scope

**In:** `packages/plugin-sdk`, a boot-time loader, a declarative page renderer in the
web app, all twelve `apps/server/src/game/*` modules ported to plugins, and one
third-party example plugin.

**Out:** new gameplay of any kind; hot reload; runtime plugin installation; an admin
UI; a plugin registry or marketplace. Casino and forum stay schema-only per SPEC §7.

**Stays core, never a plugin:** auth and sessions, the ledger (`economy/ledger.ts`),
the WS gateway and bus, the BullMQ connection, the DB client, config.

### Divergences from SPEC §5

| SPEC §5 says | This design | Why |
|---|---|---|
| M5 = "crimes and bank refactored" (§6) | All twelve `game/*` modules | §5's own v1 list names ten modules; two modules is too thin a sample to design ctx against, and every module left behind is a second wiring path that survives until someone finishes the job |
| `pages: [route + React component (client)]` | Declarative page schema + an override registry for core's hand-written React | A third-party plugin must add a working page without forking the web app — SPEC §6's own M5 acceptance criterion. Core pages keep their bespoke React via override, so M5 changes no UI |
| Hook names ported from V2's ~20 | Three generic kinds: menu contribution, filter points, event listeners | V2's set is closed and includes names for subsystems GL3 deliberately has not built (`casinoMenu`, `pointsMenu`, `membershipBenefit`). Generic kinds cover both V2 patterns (§1.3) and let combat and cars add points without an SDK release |

## Architecture

```
packages/plugin-sdk/        @gl3/plugin-sdk — types, definePlugin, filterPoint, on, route, ctx interfaces
packages/plugins/<id>/      twelve core plugins, each its own workspace package
apps/server/src/plugins/    loader: resolve → validate → migrate → register → cache
apps/web/src/plugins/       page-schema renderer + override registry
examples/hello-plugin/      third-party example; imports only @gl3/plugin-sdk
```

A plugin package may depend on `@gl3/plugin-sdk`, `@gl3/shared`, `drizzle-orm` and
`zod`. It may **not** depend on `apps/server`. There is no import path from a plugin
into the server, so SPEC §5's isolation rule ("nothing in core may reach into a
plugin's tables directly", and the converse) is enforced by the compiler rather than
by review.

The loader lives in the server and depends on the SDK. Dependencies point one way:
`apps/server → @gl3/plugin-sdk ← packages/plugins/*`.

### Manifest

```ts
export default definePlugin({
  id: "crimes",
  version: "1.0.0",
  basePaths: ["/api/crimes"],
  tables: { crimes, playerCrimeSkill, crimeLog },
  migrations: [...],
  routes: [...],
  pages: [...],
  events: { ... },
  jobs: { ... },
  provides: [beforeResolve],
  filters: [on(somePoint, fn)],
});
```

`definePlugin` is typed and its output is zod-validated at boot; a manifest is an
external boundary like any other.

## The ctx API

The plugin-facing context deliberately omits `ctx.db` and `ctx.redis`. There is no
escape hatch and no `unsafe` manifest flag.

| Member | Purpose |
|---|---|
| `ctx.player` | Snapshot for the current request: `id`, `cash`, `level`, `jailed`, `gangId` |
| `ctx.transaction(fn)` | One transaction. `tx` exposes the plugin's own tables plus `tx.economy.applyBalanceChange`, `tx.locks.gangAndPlayer`, `tx.locks.player`, `tx.gangLog`, `tx.events.publish` |
| `ctx.cooldown` | `acquire` / `peek` / `release`, backed by `SET NX EX` |
| `ctx.jobs.enqueue(name, data)` | Enqueue one of this plugin's jobs; a seed is generated here, at enqueue time |
| `ctx.job` | Inside a worker only: `{ id, seed, rng }` |
| `ctx.filters.apply(point, value)` | Run a point's subscribers in declared order |
| `ctx.settings` | Per-game configuration values |
| `ctx.log` | Structured logging, plugin id attached |

### Four of the six rules become structural

CLAUDE.md lists six rules that have each already caused a real bug. The ctx surface
above is shaped so that four of them cannot be broken:

1. **BullMQ is at-least-once.** When a handler runs in a job context, `ctx.transaction`
   inserts `plugin_job_runs (plugin_id, job_id)` — UNIQUE, first, inside the same
   transaction — before the handler body executes. A conflict aborts the transaction
   and the job is treated as already applied. A plugin cannot forget the idempotency
   key because it never writes one. `crime_log.job_id` keeps its UNIQUE constraint
   after the port, but the guarantee no longer depends on it.

2. **Never check-then-act on Redis.** No raw Redis handle is reachable, and
   `ctx.cooldown` offers no read-then-write pair. The shape has no expression.

3. **Every balance movement goes through `applyBalanceChange`.** `players` is in no
   plugin's scoped tables, so `tx.economy.applyBalanceChange` is the only way to move
   money. A ledger row is not something a plugin can omit.

5. **Publish events only after the transaction commits.** `tx.events.publish` appends
   to a buffer; the loader flushes it after commit and drops it on rollback.
   Publishing from inside a transaction is unrepresentable.

Rules 4 (tests filtering `game:events` by their own actor) and 6 (a foreign key is a
lock) remain human disciplines. Rule 6 in particular the SDK **cannot** fix: an FK
insert takes `FOR KEY SHARE` with no lock call in the source. `tx.locks.gangAndPlayer`
is offered as the single obvious ordering helper, and `test/gang-lock-order.test.ts`
remains the regression net. This limitation is deliberate and stated so nobody
assumes the SDK closed it.

### Table ownership

A plugin's tables are named `p_<pluginId>_<table>` and are owned exclusively by that
plugin. The loader rejects at boot any table in a manifest whose name lacks the
plugin's prefix, and any prefix claimed by two plugins.

Existing core tables (`players`, `ledger`, `gangs`, …) keep their current names and
stay core-owned. Where a ported module owns a table today (e.g. `crimes`,
`player_crime_skill`, `crime_log`), the port renames it to the prefixed form via that
plugin's first migration. This is a rename in the plugin's own migration, not a core
schema change.

Plugin migrations are drizzle migrations owned by the plugin package, applied in
plugin-id order at boot, and tracked in a core `plugin_migrations (plugin_id, name)`
table. Re-boot applies nothing twice.

## Routes

```ts
route({
  method: "POST",
  path: "/api/crimes/:crimeId/commit",
  auth: "player",
  accessInJail: false,          // V2 module.json parity
  params: z.object({ crimeId: IdSchema }),
  handler: async (ctx, { params }) => { ... },
})
```

Every route declares zod schemas for params and body; the loader validates before the
handler runs, so an unvalidated UUID can never reach Postgres. `accessInJail: false`
is enforced by the loader, replacing each module's hand-rolled jail check.

A plugin may only register paths under one of its declared `basePaths`. Overlapping
basePaths across plugins is a hard boot failure naming both plugin ids. `/api/auth`
and `/api/ws` are reserved to core.

Handlers return a typed value or throw `PluginError(code, status)`. Error codes and
statuses are preserved exactly from the current implementations.

### The acceptance test for every port

**M5 changes no HTTP response.** Same paths, same status codes, same error strings,
same bodies, same headers.

The existing integration suite is therefore the proof that a port is correct, and it
must pass **unmodified**. A test file edited during a port is a failed port, not a
passing one. (Adding *new* tests for new SDK behaviour is expected and fine; changing
an existing assertion about an existing endpoint is not.)

## Pages

`GET /api/plugins` returns, for the authenticated player, the merged menu tree plus
each page's view schema and each plugin's event metadata. Menus are filtered
server-side, so a page the player cannot reach is not described to them.

The web app renders a page schema through one generic component.
`apps/web/src/plugins/overrides.ts` maps page id to a hand-written React component,
and the override wins where present. Every existing core page has an override, so M5
leaves the UI byte-identical.

Renderer vocabulary, v1: `panel`, `list`, `keyValue`, `form`, `button`,
`cooldownButton`, `money`, `text`, `link`, `error`. The vocabulary is deliberately
small and the example plugin's page must be buildable from exactly these — that
constraint is what keeps it from growing into a UI framework.

A page id with neither an override nor a parseable schema renders a plain "this
plugin has no UI installed" panel rather than crashing the shell.

## Events

`GameEventSchema`'s twenty variants and both exhaustive client switches (`describe()`
in `EventFeed.tsx`, `invalidationKeys()` in `ws/invalidation.ts`) are unchanged. One
new variant carries every plugin event:

```ts
{ type: "plugin.event", pluginId: "bounties", name: "placed",
  payload: { target: "Ron", amount: "50000" } }
```

The plugin's manifest declares each event's payload schema, a `describe` template
string, and the query keys it invalidates. Both reach the client through
`/api/plugins`, so a third-party event renders in the feed and invalidates the right
queries with no client code change.

Ported core modules keep emitting their existing typed variants. The envelope is for
new events, not a migration of the old ones.

## Filters

The plugin that owns a hook point exports a typed token; subscribers import it from
that package:

```ts
// owner
export const beforeResolve = filterPoint<Crime>("crimes.beforeResolve");

// subscriber
import { beforeResolve } from "@gl3/plugin-crimes";
filters: [on(beforeResolve, (ctx, crime) => ({ ...crime, cooldownSeconds: ... }))]
```

Cross-plugin filters are type-safe without a global registry. Subscribers run in
declared sort order, each returning the next value. Filters may be async but run
outside any transaction — a filter cannot participate in the caller's write.

This is V2's `alterModuleData` pattern (SPEC §1.3), generalised. Menu contribution,
V2's other pattern, is a `menu` descriptor on a page rather than a hook.

## Boot sequence

1. Resolve plugin ids from config; import each package.
2. Zod-validate every manifest. Reject unknown fields.
3. Reject table-prefix violations, duplicate prefixes, and overlapping `basePaths`.
4. Apply plugin migrations in plugin-id order.
5. Register routes, job processors, and filter subscriptions.
6. Build and cache the `/api/plugins` payload shape.

Every failure is a hard boot failure naming the plugin id. Discovery is a static list
in config resolved as workspace packages — no filesystem scan, no hot reload, no
runtime installation. A game's plugin set is a deploy-time decision.

## Testing

- **SDK unit tests** (no DB, `@gl3/shared`-style project): manifest validation, filter
  chain ordering, basePath and table-prefix collision detection, `describe` template
  rendering, page-schema parsing.
- **Loader integration** (real Postgres and Redis): boots with `examples/hello-plugin`;
  its menu entry appears in `/api/plugins`; its page renders; its migration applies
  once across two boots.
- **Structural tests**: an event published inside a transaction is not delivered until
  commit and is dropped on rollback; a job retried with the same `job.id` produces
  exactly one side effect; a plugin referencing a table outside its scope fails to
  typecheck (type-level test).
- **Regression**: `npm run verify` green with the suite **unmodified** after each of
  the twelve ports. Per CLAUDE.md, run locally — CI does not run the integration
  suite.
- Per CLAUDE.md's working method, every new test is shown failing before it passes.

## Sequencing

Strangler, not big-bang. The SDK and loader are built alongside today's `app.ts`; the
loader registers plugin routes on the same Fastify instance while `app.ts` keeps
registering un-ported modules directly. Modules move one per task, each landing with
the full suite green. The old wiring is deleted when the last module moves.

Two registration paths coexist for the length of M5. That is the cost, and it buys
the thing that matters: a flaw in the ctx design surfaces on module two rather than
module twelve, and every task boundary is revertible.

Suggested port order — cheapest first, so ctx gaps are found early, then the modules
that stress a specific guarantee:

1. `ranks`, `leaderboard`, `news`, `notifications`, `profile` — read-mostly, prove
   routes, pages and menus.
2. `bank`, `bullets`, `travel` — prove `tx.economy` and `ctx.cooldown`.
3. `jail`, `crimes` — prove jobs, seeded RNG, `plugin_job_runs`, and buffered events.
4. `mail`, `gangs` — prove cross-player events, gang permissions, and lock ordering.

`gangs` is last deliberately: it is the module that owns rule 6's regression test.

## Known risks

- **Size.** Twelve ports plus SDK, loader, renderer and example is the largest
  milestone so far — larger than M3. The strangler route makes it incremental and
  abandonable at any module boundary, but it will not be quick.
- **ctx completeness.** A capability-scoped ctx with no escape hatch means the first
  gameplay module needing something unanticipated is blocked on extending the SDK.
  This is the accepted cost of making rules 1, 2, 3 and 5 structural. The port order
  above exists to surface those gaps during M5 rather than after it.
- **Renderer creep.** The declarative vocabulary will be under constant pressure to
  grow. The override registry is the pressure valve: a core page that needs more
  goes to bespoke React, not to a bigger schema.
