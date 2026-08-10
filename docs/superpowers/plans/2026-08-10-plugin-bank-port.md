# `bank` Module Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/server/src/game/bank/` into a plugin package `@gl3/plugin-bank` with byte-identical HTTP responses and events, closing the SDK gap that makes a plugin overdraft a 500.

**Architecture:** Four tasks. Task 1 adds `InsufficientFundsError` to the plugin SDK and translates core's into it inside `plugins/ctx.ts`, so a plugin can answer 409. Task 2 adds a test helper that drives a plugin route in-process, replacing the direct `performBankTransaction` imports three core test files depend on. Task 3 creates the plugin, wires all eight registration sites, deletes the core module and migrates those three test files — atomic, because two Fastify routes cannot own the same path. Task 4 is docs plus the full verification run.

**Tech Stack:** TypeScript (strict, ESM), Fastify 5, drizzle-orm 0.45.2, zod 3, Postgres 16, Redis 7, vitest 2.

**Spec:** `docs/superpowers/specs/2026-08-10-plugin-bank-port-design.md`

## Global Constraints

- **No `any` in `packages/*`** — none, not even a cast. In `apps/*` prefer `unknown` plus a zod parse, and type guards over casts.
- ESM only; relative imports carry a `.js` extension despite `.ts` sources.
- A plugin package may import **only** `@gl3/plugin-sdk`, `zod` and `drizzle-orm`. Never `@gl3/shared`, never anything under `apps/`.
- Money is `bigint` in Postgres and TypeScript, and crosses the wire as a **decimal string**. Never a JSON number.
- Publish events only after the transaction commits — never inside `db.transaction(...)`. `tx.events.publishCore` buffers and is already structural; do not add a publish path around it.
- Every test asserting on `game:events` filters by its own `actorId` via `awaitOwnEvent()` from `test/helpers/events.ts`.
- Integration tests run against **real** Postgres and Redis. No mocks for DB, queue or bus paths, ever.
- Conventional Commits.
- Env for every command in this plan:
  ```bash
  export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
  export REDIS_URL=redis://localhost:6379
  ```
- **Never run two full test suites at once.** Never run `FLUSHALL` / `FLUSHDB` — Redis is shared across every test file and every concurrent agent.
- Read `npm run verify`'s **exit code**, never its printed summary. An unhandled rejection makes vitest exit non-zero while still printing `Tests N passed (N)`.

---

### Task 1: SDK `InsufficientFundsError` and the ctx translation

**Files:**
- Create: none
- Modify: `packages/plugin-sdk/src/errors.ts` (append), `packages/plugin-sdk/src/index.ts:1`, `apps/server/src/plugins/ctx.ts:5` and `:99-104`
- Test: `apps/server/test/plugin-ctx-port-prereqs.test.ts` (append a second inline plugin and a second `describe`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `InsufficientFundsError` exported from `@gl3/plugin-sdk`, constructor `(playerId: string, kind: "cash" | "bank" | "points")`, with readonly `playerId` and `kind` properties and `name === "InsufficientFundsError"`. Task 3's plugin catches it.

**Why:** `tx.economy.applyBalanceChange` throws core's `InsufficientFundsError` (`apps/server/src/economy/ledger.ts:18`). A plugin package may not import from `apps/`, and the route loader (`apps/server/src/plugins/routes.ts:55-60`) maps only `PluginError` — everything else rethrows into Fastify as a 500. So today a ported bank cannot produce the 409 core produces.

- [ ] **Step 1: Write the failing test**

In `apps/server/test/plugin-ctx-port-prereqs.test.ts`, add `InsufficientFundsError` and `PluginError` to the existing `@gl3/plugin-sdk` import on line 1, add `transactions` to the `../src/db/schema/index.js` import on line 6, then append this manifest after the existing `prereqPlugin` definition (which ends at line 45):

```ts
/**
 * An overdraft is the one `applyBalanceChange` failure a ported module must
 * turn into a specific HTTP response (409 for bank/travel/bullets, 400 for
 * gangs). Core's InsufficientFundsError lives in apps/server, which a plugin
 * package may not import, so the SDK exports its own and the ctx translates.
 */
const overdraftPlugin = definePlugin({
  id: "pcod",
  version: "1.0.0",
  basePaths: ["/api/pcod"],
  routes: [
    route({
      method: "POST",
      path: "/api/pcod/overdraft",
      handler: async (ctx) => {
        const playerId = ctx.player?.id;
        if (playerId === undefined) throw new Error("expected authenticated player");
        return ctx.transaction(async (tx) => {
          try {
            await tx.economy.applyBalanceChange({
              playerId, amount: -1n, kind: "cash", reason: "test.overdraft",
            });
          } catch (error) {
            if (error instanceof InsufficientFundsError) {
              throw new PluginError("insufficient_funds", 409, { kind: error.kind });
            }
            throw error;
          }
          return { status: 200, body: { ok: true } };
        });
      },
    }),
  ],
});
```

Change the `beforeAll` on line 74 to boot both manifests:

```ts
beforeAll(async () => {
  ({ app, close: closeServer } = await bootTestServer({ plugins: [prereqPlugin, overdraftPlugin] }));
});
```

Append this `describe` at the end of the file:

```ts
describe("plugin ctx overdraft translation", () => {
  it("surfaces an overdraft as the SDK's InsufficientFundsError and rolls the transaction back", async () => {
    // A freshly registered player starts at 0 cash, so debiting 1 overdrafts.
    const { token, playerId } = await register(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/pcod/overdraft",
      headers: { authorization: `Bearer ${token}` },
    });

    // 409, not 500: the plugin caught a class it is allowed to import.
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "insufficient_funds", kind: "cash" });

    // Fresh reads on a separate connection: the failed leg committed nothing.
    const [stats] = await db.select({ cash: playerStats.cash })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.cash).toBe(0n);
    expect(await db.select().from(transactions)
      .where(eq(transactions.playerId, playerId))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run --project @gl3/server test/plugin-ctx-port-prereqs.test.ts
```

Expected: FAIL at module load — `SyntaxError: The requested module '.../packages/plugin-sdk/src/index.ts' does not provide an export named 'InsufficientFundsError'`. That is the correct red: the class does not exist yet.

- [ ] **Step 3: Add the SDK error class**

Append to `packages/plugin-sdk/src/errors.ts`:

```ts
/**
 * Thrown by `tx.economy.applyBalanceChange` when a debit would take a balance
 * below zero. Core's own `InsufficientFundsError` (`economy/ledger.ts`) lives
 * in `apps/server`, which a plugin package may not import, so the ctx
 * translates it into this one on the way out.
 *
 * Deliberately NOT mapped to a status by the route loader: three modules
 * answer 409 `insufficient_funds` (bank, travel, bullets) and one answers 400
 * `insufficient_cash` (gangs, `game/gangs/routes.ts:789`). A central mapping
 * would have to change one of them, so each plugin catches this and throws its
 * own `PluginError`.
 */
export class InsufficientFundsError extends Error {
  constructor(
    readonly playerId: string,
    readonly kind: PluginBalanceChange["kind"],
  ) {
    super(`insufficient ${kind} for player ${playerId}`);
    this.name = "InsufficientFundsError";
  }
}
```

Add the type-only import at the top of the same file (`ctx.ts` does not import `errors.ts`, so there is no cycle):

```ts
import type { PluginBalanceChange } from "./ctx.js";
```

Change `packages/plugin-sdk/src/index.ts:1` to:

```ts
export { PluginError, JobAlreadyAppliedError, InsufficientFundsError } from "./errors.js";
```

- [ ] **Step 4: Translate core's error in the ctx**

In `apps/server/src/plugins/ctx.ts`, change the `@gl3/plugin-sdk` value import on line 5 to:

```ts
import {
  InsufficientFundsError as SdkInsufficientFundsError,
  JobAlreadyAppliedError,
  runFilterChain,
} from "@gl3/plugin-sdk";
```

Add `InsufficientFundsError` to the existing `../economy/ledger.js` import (lines 14-18), which already pulls `applyBalanceChange` from that module:

```ts
import {
  addExp, applyBalanceChange, applyGangBalanceChange, InsufficientFundsError,
  lockGangAndPlayerForUpdate, lockLocationForUpdate, lockPlayersForUpdate,
  type Tx,
} from "../economy/ledger.js";
```

Replace the `applyBalanceChange` wrapper at lines 99-104 with:

```ts
applyBalanceChange: async (change) => {
  let after: bigint;
  try {
    after = await applyBalanceChange(tx, change);
  } catch (error) {
    // Only this call is wrapped, and only this one error is translated:
    // a plugin cannot import core's class, so without this every overdraft
    // escapes the loader's PluginError catch and Fastify 500s. Everything
    // else propagates untouched.
    if (error instanceof InsufficientFundsError) {
      throw new SdkInsufficientFundsError(change.playerId, change.kind);
    }
    throw error;
  }
  // Deliberately outside the try: a leg that threw must buffer no score.
  // `points` has no leaderboard — LeaderboardKind is cash/bank/exp.
  if (change.kind !== "points") bufferScore(change.kind, change.playerId, after);
  return after;
},
```

`applyGangBalanceChange` is **not** wrapped. `InsufficientGangFundsError` has the identical gap and no caller until the `gangs` port, which is the plan that can prove it end to end (spec §4).

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server test/plugin-ctx-port-prereqs.test.ts
```

Expected: PASS, both tests in the file.

- [ ] **Step 6: Prove the translation is what makes it pass**

Temporarily change the `throw new SdkInsufficientFundsError(...)` line back to `throw error;` and re-run. Expected: FAIL with status 500 instead of 409 — the plugin's `instanceof` no longer matches. Restore the line and re-run to green before committing. A test never shown red proves nothing.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add packages/plugin-sdk/src/errors.ts packages/plugin-sdk/src/index.ts \
        apps/server/src/plugins/ctx.ts apps/server/test/plugin-ctx-port-prereqs.test.ts
git commit -m "feat(plugin-sdk): add InsufficientFundsError so a plugin can answer 409"
```

---

### Task 2: `callPluginRoute` test helper

**Files:**
- Create: `apps/server/test/helpers/plugin-route.ts`
- Modify: `apps/server/src/plugins/routes.ts:78` (add `export` to `loadSnapshot`)
- Test: `apps/server/test/plugin-routes.test.ts` (append one `describe`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  callPluginRoute(
    manifest: PluginManifest,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: {
      db: Db; redis: Redis; leaderboardPrefix: string; playerId: string;
      body?: unknown; params?: unknown;
    },
  ): Promise<RouteResult>
  ```
  Task 3's three migrated test files call it. A `PluginError` thrown by the handler propagates to the caller — it is **not** turned into a status.

**Why:** `test/bank.test.ts`, `test/economy-invariant.test.ts` and `test/leaderboard.test.ts` import `performBankTransaction` directly. Task 3 deletes it. The helper is how those three keep driving bank's real code path in-process instead of degrading into HTTP rewrites or ledger stand-ins.

- [ ] **Step 1: Export `loadSnapshot`**

In `apps/server/src/plugins/routes.ts`, line 78, change:

```ts
async function loadSnapshot(deps: PluginCtxDeps, playerId: string): Promise<PlayerSnapshot | null> {
```

to:

```ts
export async function loadSnapshot(deps: PluginCtxDeps, playerId: string): Promise<PlayerSnapshot | null> {
```

The helper must not carry its own copy — a test's ctx drifting from the one the real route builds is how a suite starts proving the wrong thing.

- [ ] **Step 2: Write the failing test**

Append to `apps/server/test/plugin-routes.test.ts`:

```ts
describe("callPluginRoute helper", () => {
  it("drives a real plugin route in-process against the manifest's own schemas", async () => {
    const { callPluginRoute } = await import("./helpers/plugin-route.js");
    const ranksPlugin = (await import("@gl3/plugin-ranks")).default;
    const { seedRanks } = await import("../src/db/seed.js");

    await seedRanks(db);
    const playerId = uuidv7();
    await db.insert(players).values({ id: playerId, username: `helper${Date.now()}` });
    await db.insert(playerStats).values({ playerId });

    const result = await callPluginRoute(ranksPlugin, "GET", "/api/ranks", {
      db, redis, leaderboardPrefix: `helper-test-${playerId}`, playerId,
    });

    expect(result.status).toBe(200);
    const body = result.body as { ranks: { name: string; current: boolean }[] };
    expect(body.ranks.length).toBeGreaterThan(0);

    // A path the manifest does not serve must fail loudly rather than
    // silently test nothing.
    await expect(
      callPluginRoute(ranksPlugin, "GET", "/api/nope", {
        db, redis, leaderboardPrefix: `helper-test-${playerId}`, playerId,
      }),
    ).rejects.toThrow(/no GET route "\/api\/nope"/);
  });
});
```

Check the file's existing imports before adding: it needs `db`, `redis`, `uuidv7`, `players` and `playerStats` in scope. Add whichever are missing, matching how `test/bank.test.ts:1-15` sets up `testDb()` and `createRedis(loadConfig(process.env).redisUrl)`.

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run --project @gl3/server test/plugin-routes.test.ts
```

Expected: FAIL — `Cannot find module './helpers/plugin-route.js'`.

- [ ] **Step 4: Write the helper**

Create `apps/server/test/helpers/plugin-route.ts`:

```ts
import type { PluginManifest, RouteResult } from "@gl3/plugin-sdk";
import type { Redis } from "ioredis";
import type { Db } from "../../src/db/client.js";
import { createPluginCtx } from "../../src/plugins/ctx.js";
import { loadSnapshot } from "../../src/plugins/routes.js";

export interface CallPluginRouteOptions {
  db: Db;
  redis: Redis;
  /**
   * Required, never defaulted: an omitted prefix silently means the
   * production `leaderboard:*` keys, which every concurrent test file and
   * agent shares. Same reasoning as `PluginCtxDeps.leaderboardPrefix`.
   */
  leaderboardPrefix: string;
  playerId: string;
  body?: unknown;
  params?: unknown;
}

/**
 * Drives one plugin route in-process: real Postgres, real Redis, the real
 * ctx, the route's own zod schemas and the real handler.
 *
 * This is NOT the HTTP contract and must not be mistaken for it. It runs no
 * jail gate, no auth, and no `PluginError` → status mapping — a `PluginError`
 * propagates to the caller, so a test asserts on `error.code`/`error.status`
 * rather than a response body. Status codes, the 423 jail path and the 401
 * belong in an `app.inject` test (see the block at the bottom of
 * `test/bank.test.ts`). A helper that resembles `registerPluginRoutes`
 * without being it is how a suite starts proving the wrong thing.
 *
 * It exists because three core test files drove `game/bank/service.ts`
 * directly before that module became a plugin, and the `travel`, `bullets`,
 * `crimes` and `gangs` ports face the same coupling.
 */
export async function callPluginRoute(
  manifest: PluginManifest,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: CallPluginRouteOptions,
): Promise<RouteResult> {
  const pluginRoute = manifest.routes.find((r) => r.method === method && r.path === path);
  if (pluginRoute === undefined) {
    // Loud, not silent: a typo'd path would otherwise make the call a no-op
    // that a passing test reads as coverage.
    throw new Error(`plugin "${manifest.id}" has no ${method} route "${path}"`);
  }

  const deps = {
    db: opts.db,
    redis: opts.redis,
    queues: new Map(),
    settings: {},
    leaderboardPrefix: opts.leaderboardPrefix,
  };

  const player = await loadSnapshot(deps, opts.playerId);
  const ctx = createPluginCtx(deps, {
    pluginId: manifest.id,
    player,
    job: null,
    filters: manifest.filters,
  });

  // The route's OWN schemas, so a test cannot pass a body the real route
  // would have rejected with a 400.
  const params = pluginRoute.params.parse(opts.params ?? {});
  const body = pluginRoute.body.parse(opts.body ?? {});

  return await pluginRoute.handler(ctx, { params, body });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server test/plugin-routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add apps/server/test/helpers/plugin-route.ts apps/server/src/plugins/routes.ts \
        apps/server/test/plugin-routes.test.ts
git commit -m "test(server): add callPluginRoute helper for in-process plugin route tests"
```

---

### Task 3: The `bank` plugin, registration, core deletion, test migration

**Files:**
- Create: `packages/plugins/bank/package.json`, `packages/plugins/bank/tsconfig.json`, `packages/plugins/bank/src/index.ts`
- Delete: `apps/server/src/game/bank/routes.ts`, `apps/server/src/game/bank/service.ts` (and the now-empty directory)
- Modify: `apps/server/package.json:12-14`, `apps/server/tsconfig.json:9`, `tsconfig.json:3-12`, `vitest.workspace.ts:17-38`, `apps/server/src/plugins/core-plugins.ts:1-20`, `apps/server/src/app.ts:8` and `:66`, `Dockerfile.server` (five sites)
- Test: `apps/server/test/bank.test.ts`, `apps/server/test/economy-invariant.test.ts:106`, `apps/server/test/leaderboard.test.ts:84`

**Interfaces:**
- Consumes: `InsufficientFundsError` from `@gl3/plugin-sdk` (Task 1); `callPluginRoute` from `test/helpers/plugin-route.js` (Task 2).
- Produces: `@gl3/plugin-bank` default export — a `PluginManifest` with `id: "bank"` and two routes, `POST /api/bank/deposit` and `POST /api/bank/withdraw`.

**Why this is one task:** two Fastify routes cannot own the same path. The moment the plugin registers `/api/bank/deposit`, `registerBankRoutes` must be gone, which deletes `performBankTransaction`, which breaks the three test files in the same commit. There is no green intermediate state.

- [ ] **Step 1: Create the package manifest and tsconfig**

`packages/plugins/bank/package.json` (copied from `packages/plugins/news/package.json`, name changed):

```json
{
  "name": "@gl3/plugin-bank",
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

`packages/plugins/bank/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../plugin-sdk" }]
}
```

There is no `src/schema.ts`. This plugin mirrors no core tables: `actorName` comes from `ctx.player.username`, and both balances come from the two `applyBalanceChange` return values.

- [ ] **Step 2: Write the plugin**

`packages/plugins/bank/src/index.ts`:

```ts
import { definePlugin, InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { z } from "zod";

/**
 * Ported from `apps/server/src/game/bank/routes.ts` and `service.ts`: paths,
 * status codes, error strings, response bodies and the `bank.transacted`
 * event are byte-identical. `apps/server/test/bank.test.ts`'s `app.inject`
 * block is unchanged and is the proof.
 *
 * Three deliberate differences from core:
 *  - No post-commit `SELECT cash, bank`. `applyBalanceChange` returns the new
 *    balance, and both directions touch both columns, so both numbers are
 *    already in hand.
 *  - No `players` read for `actorName`; `ctx.player.username` has it.
 *  - `recordScore` is gone from the module. `tx.economy.applyBalanceChange`
 *    buffers a leaderboard write per changed kind and flushes it after
 *    commit (core-events design §B1), which covers exactly the `cash` and
 *    `bank` writes core made by hand.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `MoneySchema`'s regex
 * is restated below rather than imported.
 */
const AmountSchema = z.object({
  amount: z.string().regex(/^-?\d+$/, "must be an integer string"),
});

type Direction = "deposit" | "withdraw";

/**
 * Two literal-path routes from one factory, mirroring core's
 * `routes.ts:12`. NOT one route with a `:direction` param — that would match
 * paths core's two never matched.
 */
const bankRoute = (direction: Direction) =>
  route({
    method: "POST",
    path: `/api/bank/${direction}`,
    body: AmountSchema,
    // accessInJail defaults to true. Core's bank routes never call
    // releaseIfExpired, so gating here would add a 423 to a route that has
    // never returned one.
    handler: async (ctx, { body }) => {
      const player = ctx.player;
      if (player === null) throw new PluginError("unauthorized", 401);

      const amount = BigInt(body.amount);
      // Kept in the handler, not as a zod `.refine()`: the loader answers
      // every schema failure with `invalid_request`, which would silently
      // drop this distinct error string.
      if (amount <= 0n) throw new PluginError("amount_must_be_positive", 400);

      return ctx.transaction(async (tx) => {
        let cash: bigint;
        let bank: bigint;
        try {
          if (direction === "deposit") {
            cash = await tx.economy.applyBalanceChange({
              playerId: player.id, amount: -amount, kind: "cash", reason: "bank.deposit",
            });
            bank = await tx.economy.applyBalanceChange({
              playerId: player.id, amount, kind: "bank", reason: "bank.deposit",
            });
          } else {
            bank = await tx.economy.applyBalanceChange({
              playerId: player.id, amount: -amount, kind: "bank", reason: "bank.withdraw",
            });
            cash = await tx.economy.applyBalanceChange({
              playerId: player.id, amount, kind: "cash", reason: "bank.withdraw",
            });
          }
        } catch (error) {
          if (error instanceof InsufficientFundsError) {
            throw new PluginError("insufficient_funds", 409);
          }
          throw error;
        }

        // Buffered here, published after commit — events are facts, not
        // commands. The audience is PRIVATE: bank state is not broadcast,
        // unlike news.posted's { kind: "global" }.
        await tx.events.publishCore({
          type: "bank.transacted",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "player", playerId: player.id },
          direction,
          amount: amount.toString(),
          cash: cash.toString(),
          bank: bank.toString(),
        });

        return { status: 200, body: { cash: cash.toString(), bank: bank.toString() } };
      });
    },
  });

export default definePlugin({
  id: "bank",
  version: "1.0.0",
  basePaths: ["/api/bank"],
  routes: [bankRoute("deposit"), bankRoute("withdraw")],
});
```

- [ ] **Step 3: Wire the eight registration sites**

Five of these fail silently or only in CI. Do all of them now.

1. `apps/server/package.json` — add `"@gl3/plugin-bank": "*",` to `dependencies`, alphabetically before `"@gl3/plugin-notifications"`.
2. `apps/server/tsconfig.json:9` — add `{ "path": "../../packages/plugins/bank" }` to `references`. **Omitting this fails only in CI's image build**; the root tsconfig's own reference makes `npm run typecheck` pass regardless.
3. root `tsconfig.json` — add `{ "path": "./packages/plugins/bank" },` to `references`.
4. `vitest.workspace.ts` `srcAliases` — add:
   ```ts
   "@gl3/plugin-bank": fileURLToPath(
     new URL("./packages/plugins/bank/src/index.ts", import.meta.url),
   ),
   ```
   **Omitting this fails nothing** and silently grades the last `tsc --build`, because the package ships a populated `dist/`. This bit the `notifications` port.
5. `apps/server/src/plugins/core-plugins.ts` — add `import bankPlugin from "@gl3/plugin-bank";` and append `bankPlugin` to `CORE_PLUGINS`.
6. `apps/server/src/app.ts` — delete the `registerBankRoutes` import (line 8) and its call (line 66).
7. `Dockerfile.server` — add `packages/plugins/bank` at **five** sites: the builder manifest COPY block (after line 49), the builder tsconfig+src COPY block (after line 66), the runtime manifest COPY block (after line 100), the runtime dist COPY block (after line 113), and the header comment that enumerates the packages (lines 6-22). **CI-only failure**; Docker cannot run on this machine.
8. Install the workspace link:
   ```bash
   npm install
   ```

- [ ] **Step 4: Delete the core module**

```bash
git rm apps/server/src/game/bank/routes.ts apps/server/src/game/bank/service.ts
```

`BankTransactionRequestSchema` stays in `@gl3/shared` even though nothing server-side imports it now — same as what the `news` port did with `PostNewsRequestSchema`. `BankStatusResponseSchema` is still parsed by `apps/web/src/api/queries.ts:121`.

- [ ] **Step 5: Migrate `test/bank.test.ts`**

Replace the imports of `performBankTransaction` and `InsufficientFundsError` (lines 7-8) with:

```ts
import bankPlugin from "@gl3/plugin-bank";
import { PluginError } from "@gl3/plugin-sdk";
import { callPluginRoute } from "./helpers/plugin-route.js";
```

Add a file-local prefix and a wrapper next to the existing `beforeEach`:

```ts
// This file drives the plugin handler directly (no bootTestServer), so
// nothing namespaces its leaderboard writes automatically — pass a
// run-unique prefix so it never zadd's into the shared `leaderboard:*` keys
// other concurrent test files and agents read.
const leaderboardPrefix = `bank-test-${uuidv7()}`;

async function bank(direction: "deposit" | "withdraw", amount: bigint): Promise<{ cash: bigint; bank: bigint }> {
  const result = await callPluginRoute(bankPlugin, "POST", `/api/bank/${direction}`, {
    db, redis, leaderboardPrefix, playerId, body: { amount: amount.toString() },
  });
  const body = result.body as { cash: string; bank: string };
  return { cash: BigInt(body.cash), bank: BigInt(body.bank) };
}
```

Add the prefix cleanup to the existing `afterAll` (line 24), before `conn.end()`:

```ts
await redis.del(`${leaderboardPrefix}:cash`, `${leaderboardPrefix}:bank`);
```

Rename the first `describe` from `"performBankTransaction"` to `"bank plugin routes"` and rewrite its four bodies to use `bank(...)`:

```ts
it("moves cash into the bank in one transaction with two ledger rows", async () => {
  await subscriber.subscribe(GAME_EVENTS_CHANNEL);
  // `game:events` is a global channel shared by every test file running in
  // parallel — filter on this test's own actor (CLAUDE.md rule 4).
  const received = awaitOwnEvent(subscriber, playerId);

  expect(await bank("deposit", 400n)).toEqual({ cash: 600n, bank: 400n });

  const event = await received;
  expect(event.type).toBe("bank.transacted");
  if (event.type !== "bank.transacted") throw new Error("unreachable");
  expect(event.direction).toBe("deposit");
  expect(event.amount).toBe("400");
  // Bank state is NOT broadcast. The field most easily got wrong by copying
  // the news port, whose audience is { kind: "global" }.
  expect(event.audience).toEqual({ kind: "player", playerId });

  const ledger = await db.select().from(transactions).orderBy(transactions.balanceKind);
  expect(ledger).toHaveLength(2);
  expect(ledger.find((r) => r.balanceKind === "cash")?.amount).toBe(-400n);
  expect(ledger.find((r) => r.balanceKind === "bank")?.amount).toBe(400n);
});

it("moves bank cash back to cash on withdraw", async () => {
  await bank("deposit", 400n);
  expect(await bank("withdraw", 150n)).toEqual({ cash: 750n, bank: 250n });
});

it("rejects an overdraft on either leg and leaves both balances untouched", async () => {
  await expect(bank("withdraw", 1n)).rejects.toMatchObject({
    name: "PluginError", code: "insufficient_funds", status: 409,
  });
  const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
  expect(row?.cash).toBe(1000n);
  expect(row?.bank).toBe(0n);
  expect(await db.select().from(transactions)).toHaveLength(0);
});

it("serializes two concurrent withdrawals so only one can succeed against a tight balance", async () => {
  await bank("deposit", 100n);
  const results = await Promise.allSettled([bank("withdraw", 60n), bank("withdraw", 60n)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const [row] = await db.select({ bank: playerStats.bank }).from(playerStats).where(eq(playerStats.playerId, playerId));
  expect(row?.bank).toBe(40n);
});
```

Keep `PluginError` imported — if `toMatchObject` proves awkward against the class, `await expect(...).rejects.toBeInstanceOf(PluginError)` plus a separate `.code` assertion is equivalent; do not weaken it to a bare `.rejects.toThrow()`, which would pass on any error including a 500-shaped one.

The `describe("POST /api/bank/deposit and /withdraw")` block at the bottom is **unchanged**. `buildApp`'s default path loads `CORE_PLUGINS`, and `bank` declares no jobs, so it clears the guard at `app.ts:104`.

- [ ] **Step 6: Migrate `test/economy-invariant.test.ts`**

Replace the `performBankTransaction` import (line 7) with:

```ts
import bankPlugin from "@gl3/plugin-bank";
import { PluginError } from "@gl3/plugin-sdk";
import { callPluginRoute } from "./helpers/plugin-route.js";
```

Replace the `bank` op body (lines ~104-107):

```ts
} else if (opName === "bank") {
  const direction = rand() < 0.5 ? "deposit" : "withdraw";
  const amount = BigInt(1 + Math.floor(rand() * 200));
  await callPluginRoute(bankPlugin, "POST", `/api/bank/${direction}`, {
    db, redis, leaderboardPrefix, playerId, body: { amount: amount.toString() },
  });
}
```

Extend the catch list — bank now rejects with a `PluginError`, while the other four ops still throw core classes:

```ts
if (
  err instanceof InsufficientFundsError || err instanceof AlreadyAtLocationError ||
  err instanceof InsufficientStockError || err instanceof NoLocationError ||
  err instanceof LocationNotFoundError ||
  // bank is a plugin now: its overdraft arrives as the PluginError its
  // handler throws, not as core's InsufficientFundsError.
  (err instanceof PluginError && err.code === "insufficient_funds")
) continue;
throw err;
```

Keep the core `InsufficientFundsError` import — `travel`, `bullets` and the direct `points` op still throw it.

- [ ] **Step 7: Migrate `test/leaderboard.test.ts`**

Replace the `performBankTransaction` import (line 7) with:

```ts
import bankPlugin from "@gl3/plugin-bank";
import { callPluginRoute } from "./helpers/plugin-route.js";
```

Replace the call at line 84:

```ts
await callPluginRoute(bankPlugin, "POST", "/api/bank/deposit", {
  db, redis, leaderboardPrefix: PREFIX, playerId, body: { amount: "300" },
});
```

This is what proves the core-events design's §B1 covers both kinds without any plugin-side `recordScore`: the assertion below it still expects the player's `cash` score to be `"700"`.

- [ ] **Step 8: Run the three files**

```bash
npx vitest run --project @gl3/server test/bank.test.ts test/leaderboard.test.ts test/economy-invariant.test.ts
```

Expected: PASS, all three. If `bank.test.ts`'s `app.inject` block 404s, the plugin is not in `CORE_PLUGINS` (site 5). If a test resolves stale code, `srcAliases` is missing (site 4).

- [ ] **Step 9: Prove each guard can fail**

Three named reds. Make each change, run the command, confirm the stated failure, then revert and re-run to green.

1. Delete `if (amount <= 0n) throw new PluginError(...)` from the plugin → the zero and negative cases in `bank.test.ts`'s inject block fail (they expect 400).
2. Change `throw new PluginError("insufficient_funds", 409)` to `throw error` → the overdraft test fails, and the inject block's overdraft returns 500 instead of 409.
3. Delete the second `applyBalanceChange` leg from the deposit branch → the two-ledger-row assertion fails, and `economy-invariant.test.ts`'s `sum(ledger) == balance` fails.

- [ ] **Step 10: Typecheck both ways and commit**

```bash
npm run typecheck
# The exact command Dockerfile.server:83 runs. Unlike the root build above,
# this one fails on a missing apps/server/tsconfig.json reference (site 2).
npx tsc --build --force apps/server/tsconfig.json
git add -A
git commit -m "feat(plugins): port the bank module to @gl3/plugin-bank"
```

---

### Task 4: Documentation and full verification

**Files:**
- Modify: `docs/STATUS.md`, `CLAUDE.md`
- Test: the whole suite

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: nothing code-facing.

- [ ] **Step 1: Update `docs/STATUS.md`**

In the M5 row of the status table (line 17), change "three of twelve module ports shipped (`ranks`, `notifications`, `news`)" to "four of twelve module ports shipped (`ranks`, `notifications`, `news`, `bank`)" and "the six remaining pending ports" to "the five remaining pending ports".

Add a section after "Core-event publishing + the `news` port (Plan 4)" recording: the `bank` port; the new SDK `InsufficientFundsError` and why the loader deliberately does not map it centrally (gangs answers 400 `insufficient_cash`); the new `callPluginRoute` helper and its explicit non-coverage of the HTTP contract; and that `InsufficientGangFundsError` is deferred to the `gangs` port. Change the closing line "Six module ports remain: `bank`, `bullets`, `travel`, `crimes`, `mail`, `gangs`" to five, dropping `bank`.

- [ ] **Step 2: Update `CLAUDE.md`**

In "Current state", change "three of the twelve `game/*` module ports have shipped (`ranks`, `notifications`, `news`)" to four including `bank`, and "the six remaining ports (`bank`, `bullets`, `travel`, `crimes`, `mail`, `gangs`)" to the five without `bank`. Update the test count after Step 3 gives the real number.

- [ ] **Step 3: Full verification**

Confirm no other suite is running first — overlapping runs produce hook timeouts and cross-talk that look exactly like real regressions.

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. **Judge by the exit code, never the printed summary** — an unhandled rejection makes vitest exit non-zero while still printing `Tests N passed (N)`. If it is non-zero, `grep -nE "FAIL|Unhandled|✗" /tmp/verify.log` and fix before committing.

Read the final `Tests N passed` count out of the log and put it in `CLAUDE.md`'s "Suite:" line.

- [ ] **Step 4: Commit**

```bash
git add docs/STATUS.md CLAUDE.md
git commit -m "docs: record the bank port and the SDK insufficient-funds error"
```

---

## Self-Review

**Spec coverage:**

| Spec § | Task |
|---|---|
| §1 scope, no `schema.ts`, two literal routes | T3 S1-S2 |
| §1 gang routes excluded | T3 (absent by construction); recorded in T4 S1 |
| §2 wire contract, all five responses | T3 S2 (handler), T3 S5 (inject block unchanged) |
| §3 event, private audience | T3 S2, asserted T3 S5 |
| §3 leaderboard via B1 | T3 S7 (`leaderboard.test.ts`) |
| §4 SDK error + ctx translation, no central mapping | T1 |
| §4 gang error deferred | T1 S4 note, T4 S1 |
| §5 helper, `loadSnapshot` export, not-the-HTTP-contract | T2 |
| §5 three coupled files | T3 S5-S7 |
| §5 three named reds | T3 S9 (plus T1 S6) |
| §6 eight registration sites | T3 S3-S4 |
| §6 verification commands | T3 S10, T4 S3 |
| §7 sequencing | T4 S1 |

**Placeholder scan:** clean — every code step carries the actual code.

**Type consistency:** `callPluginRoute(manifest, method, path, opts)` has one signature, used identically in T2 S2, T3 S5, T3 S6 and T3 S7. `InsufficientFundsError(playerId, kind)` is defined in T1 S3 and caught in T1 S1 and T3 S2. `RouteResult.body` is `unknown`, so every caller casts it through a named local type before reading fields.
