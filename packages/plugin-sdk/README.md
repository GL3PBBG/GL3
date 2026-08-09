# @gl3/plugin-sdk

The SDK a GL3 plugin is written against. A plugin is a workspace package that
`definePlugin`s a manifest and imports only `@gl3/plugin-sdk`, `zod`,
`drizzle-orm`, and its own files. There is **no import path from a plugin into
`apps/server`** — that isolation is enforced by the compiler, not by review. See
`examples/hello-plugin/` for a complete working plugin.

The design is `docs/superpowers/specs/2026-08-09-plugin-sdk-design.md`. The
foundation (SDK + loader + example) is shipped; the twelve core `game/*` module
ports and the web page renderer are planned follow-up work.

## Install

```bash
npm install @gl3/plugin-sdk zod drizzle-orm
```

`@gl3/shared` comes transitively. A plugin may **not** depend on `apps/server`.

## A plugin in one file

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
            last_at timestamptz NOT NULL DEFAULT now())`,
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
          const [row] = await tx.db.insert(greetings)
            .values({ playerId: player.id, count: 1 })
            .onConflictDoUpdate({
              target: greetings.playerId,
              set: { count: sql`${greetings.count} + 1`, lastAt: sql`now()` },
            })
            .returning({ count: greetings.count });

          // Buffered — published only after the transaction commits.
          await tx.events.publish({
            name: "greeted",
            actorId: player.id,
            actorName: "player",
            audience: { kind: "global" },
            payload: { count: String(row?.count ?? 1) },
          });
          return row?.count ?? 1;
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
      kind: "panel", title: "Hello",
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

Every collection except `id`, `version`, `basePaths` is optional.

## The manifest

`definePlugin(input: PluginManifestInput): PluginManifest` validates the manifest
at definition time and returns the normalised form (no field is ever
`undefined` downstream). A malformed manifest throws on `import`, naming the
plugin id in the message.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Lowercase kebab-case `[a-z][a-z0-9-]*`. Used as the table prefix base and in every boot-failure message. |
| `version` | `string` | Semver `x.y.z`. |
| `basePaths` | `string[]` | At least one, each `/api/<name>...`. Every route path must sit under one of these. `/api/auth`, `/api/ws`, `/api/plugins`, `/health` are reserved to core. Overlapping basePaths across plugins is a hard boot failure. |
| `tables` | `Record<string, string>` | Maps your key to a SQL table name that **must** start with `p_<id-with-underscores>_` (e.g. id `hello` → prefix `p_hello_`). Enforced by the loader at boot. |
| `migrations` | `{ name, sql }[]` | Plain SQL, no drizzle-kit. Applied once, tracked in `plugin_migrations`. Migration names must be unique within a plugin (checked at definition time). |
| `routes` | `PluginRoute[]` | Built with `route()` (below). |
| `pages` | `PageSchema[]` | Declarative UI; see Pages. |
| `events` | `PluginEventDecl[]` | Declares each event's payload schema, `describe` template, and query invalidations. |
| `jobs` | `Record<string, JobHandler>` | Background job handlers; see Jobs. |
| `provides` | `FilterPoint[]` | Hook points this plugin owns; see Filters. |
| `filters` | `FilterSubscription[]` | Hook subscriptions; see Filters. |

`.strict()` is applied throughout — an unknown field is a validation failure.

## Routes

```ts
import { route, PluginError } from "@gl3/plugin-sdk";
import { z } from "zod";

route({
  method: "POST",
  path: "/api/myplugin/items/:itemId",
  auth: "player",          // default; "public" skips the auth prehandler
  accessInJail: false,     // default true — set false to gate on jail (V2 module.json parity)
  params: z.object({ itemId: z.string().uuid() }),
  body: z.object({ amount: z.number().int().positive() }),
  handler: async (ctx, { params, body }) => {
    // params and body are already zod-validated before the handler runs.
    return { status: 200, body: { ok: true } };
  },
})
```

The loader validates `params` and `body` with `safeParse` and returns `400
{ error: "invalid_request" }` on failure — an unvalidated UUID never reaches
Postgres. A handler returns `{ status, body? }` or throws `PluginError(code,
status, extra)`, which maps to `reply.code(status).send({ error: code, ...extra })`.

**`M5 changes no HTTP response`** is the acceptance test for every core module
port: same paths, status codes, error strings, and bodies. The existing
integration suite must pass unmodified per port.

## The ctx

A route or job handler receives a `PluginCtx`:

```ts
interface PluginCtx {
  readonly pluginId: string;
  readonly player: PlayerSnapshot | null;  // null on `auth: "public"` routes and inside jobs
  transaction<T>(fn: (tx: PluginTx) => Promise<T>): Promise<T>;
  readonly cooldown: {
    acquire(action: string, playerId: string, ttlSeconds: number): Promise<boolean>;
    peek(action: string, playerId: string): Promise<number>;
    release(action: string, playerId: string): Promise<void>;
  };
  readonly jobs: { enqueue(name: string, data: Record<string, unknown>): Promise<string> };
  readonly job: JobContext | null;          // non-null inside a job handler
  readonly filters: { apply<T>(point: FilterPoint<T>, value: T): Promise<T> };
  readonly settings: { get(key: string): string | null };
  readonly log: { info, warn, error }(...);
}
```

### `ctx.transaction(fn)` — the only write path

Every mutation goes through a transaction. Inside, `tx` exposes:

- **`tx.db`** — a Drizzle query builder **with `query` omitted**. `select`,
  `insert`, `update`, `delete`, `execute` all survive — but `tx.db.query.players`
  does not exist. A plugin can only name tables it imported itself, which is
  how the isolation rule ("nothing in core may reach into a plugin's tables, and
  the converse") becomes a compiler error. The `_NoRelationalQuery` type guard
  in `ctx.ts` fails `tsc --build` if `query` ever returns.
- **`tx.economy`** — `applyBalanceChange`, `applyGangBalanceChange`, `addExp`.
  All money is `bigint` and goes through `applyBalanceChange`; there is no other
  balance path (CLAUDE.md rule 3).
- **`tx.locks`** — `player(ids)` and `gangAndPlayer(gangId, playerId)`. Every
  gang↔player path goes through `gangAndPlayer`, which is the single lock order
  (CLAUDE.md rule 6).
- **`tx.gangLog(entry)`** — appends a gang-log row.
- **`tx.events.publish(event)`** — **buffers** the event. The loader publishes
  the buffer only after the transaction commits and discards it on rollback, so
  publishing inside a transaction is unrepresentable (CLAUDE.md rule 5).

### Jobs and idempotency

```ts
definePlugin({
  id: "pay", version: "1.0.0", basePaths: ["/api/pay"],
  jobs: {
    payout: async (ctx, data) => {
      await ctx.transaction(async (tx) => {
        await tx.locks.player([String(data["playerId"])]);
        await tx.economy.applyBalanceChange({
          playerId: String(data["playerId"]), amount: 100n, kind: "cash", reason: "payout",
        });
      });
    },
  },
});
```

Enqueue with `ctx.jobs.enqueue("payout", { playerId })`. At enqueue time the
loader injects a `seed`; on retry the same seed replays, so a job's outcome is
reproducible. Inside the handler, `ctx.job.rng` is a deterministic RNG derived
from that seed (`rng.int(min, max)`, `rng.bigint(min, max)`).

BullMQ is at-least-once, so a retry can redeliver a job that already committed.
When the transaction runs in a job context (`ctx.job !== null`), the loader
inserts a `(plugin_id, job_id)` row into `plugin_job_runs` **as the first
statement** before any handler code. A retry conflicts on that insert and aborts
via `JobAlreadyAppliedError`, which the worker swallows as success — so a
retried job applies exactly once (CLAUDE.md rule 1). A plugin never writes the
idempotency key; the structure makes forgetting it impossible.

### Cooldowns

`ctx.cooldown` delegates to core's `SET NX EX` helpers. There is no read-then-
write pair on this surface (CLAUDE.md rule 2). Keys are shared with core's
cooldown format, so a ported module's cooldown key is unchanged.

## Pages

A page is a declarative view tree rendered by a single generic component on the
client (planned: the web renderer is not yet built). The v1 vocabulary is
exactly ten node kinds and does not grow — a page needing more gets a bespoke
React override, not a bigger schema.

**Leaves:** `text`, `money`, `error`, `link`, `button`, `cooldownButton`,
`keyValue`, `form`.

**Nesting:** `panel { title, children }` and `list { items }`.

A `menu` entry on a page contributes to the merged navigation tree. Every node
is `.strict()` — a typo'd prop fails loudly rather than being silently dropped.

## Events

```ts
events: [{
  name: "greeted",
  payload: z.object({ count: z.string() }),
  describe: "{actorName} said hello ({count})",
  invalidates: ["hello"],
}]
```

The payload schema is checked at definition time (duck-typed against zod, not
`instanceof`, so a plugin bundled with its own zod copy works). At runtime the
loader wraps each published event in a `plugin.event` envelope and fans it out
over the existing WebSocket bus:

```ts
{ type: "plugin.event", pluginId: "bounties", name: "placed",
  payload: { target: "Ron", amount: "50000" } }
```

The `describe` template is rendered client-side (`{placeholder}` expansion,
single non-greedy pass). `invalidates` lists the React Query key prefixes the
event should invalidate. Both reach the client through `GET /api/plugins`, so a
third-party event renders in the feed and invalidates the right queries with no
client code change.

Publish with `tx.events.publish({ name, actorId, actorName, audience, payload })`
**inside** `ctx.transaction`. The loader buffers and publishes after commit.

## Filters

A filter point is a typed token the owning plugin exports; subscribers import it:

```ts
// owner
import { filterPoint } from "@gl3/plugin-sdk";
export const beforeResolve = filterPoint<Crime>("crimes.beforeResolve");

// subscriber
import { on } from "@gl3/plugin-sdk";
import { beforeResolve } from "@gl3/plugin-crimes";

filters: [on(beforeResolve, (ctx, crime) => ({ ...crime, cooldownSeconds: 5 }))]
```

`filterPoint()` rejects a duplicate name at definition time. Subscribers run in
declared `order` (default 100), each returning the next value. Filters may be
async but **run outside any transaction** — a filter cannot participate in the
caller's write, so a slow subscriber cannot hold a row lock open.

This is V2's `alterModuleData` pattern, generalised.

## Boot

A plugin is loaded by id from `PLUGIN_IDS` (comma-separated, default empty).
The server resolves each id to its manifest through a static import map in
`apps/server/src/index.ts` — a dynamic `import(pluginId)` is deliberately not
used, because a static import is what keeps the dependency-direction check
enforceable by the compiler.

Boot sequence:

1. Resolve plugin ids from config; `import` each package. Unknown id = hard boot failure.
2. `definePlugin` has already validated each manifest at import time.
3. Loader validates cross-plugin concerns: duplicate ids, table-prefix
   violations, table collisions, overlapping or reserved basePaths, route
   containment, duplicate page ids.
4. Apply plugin migrations in plugin-id order (tracked in `plugin_migrations`,
   idempotent across reboots).
5. Register routes, BullMQ queues/workers, and filter subscriptions.
6. Build and cache the `/api/plugins` payload.

Every failure is a hard boot failure naming the plugin id. Discovery is a static
deploy-time list — no filesystem scan, no hot reload, no runtime installation.

## Constraints (from CLAUDE.md)

These rules are structural in the SDK — a plugin cannot violate them by
construction, not merely by convention:

1. **BullMQ is at-least-once** → the `plugin_job_runs` idempotency insert runs
   first inside the transaction, before any handler code.
2. **Never check-then-act on Redis** → `ctx.cooldown` delegates to `SET NX EX`.
3. **Every balance movement through `applyBalanceChange`** → `tx.economy` is the
   only money path; `players`/`transactions` are not in any plugin's tables.
4. **Tests on `game:events` filter by their own `actorId`** (test-author concern).
5. **Events published only after commit** → `tx.events.publish` buffers; the
   loader flushes after commit.
6. **A foreign key is a lock** → every gang↔player path through
   `tx.locks.gangAndPlayer`.

Money is `bigint` and crosses the wire as a **decimal string** — never a JSON
number. No `any` in this package (not even a cast). ESM only; relative imports
carry a `.js` extension despite `.ts` sources.
