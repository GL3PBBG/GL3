# `@gl3/plugin-gangs` Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/server/src/game/gangs/routes.ts` (838 lines, **15** routes) into a new plugin package `packages/plugins/gangs/`, serving every gang route from the plugin with byte-identical HTTP responses, and delete the core route file.

**Architecture:** Three independently reviewable commits. Commit 1 closes the SDK gap this port needs (`InsufficientGangFundsError`) and adds one new ctx capability (`tx.gangs.hasPermission`) — shared code, no caller yet. Commit 2 adds the plugin package and wires it into the build/test registration sites; core still serves the routes, so the suite is unchanged and green. Commit 3 cuts over: register the plugin in `CORE_PLUGINS`, prove it is actually live via a Fastify duplicate-route boot failure, then delete `registerGangRoutes` and `routes.ts`. `permissions.ts` and `logs.ts` **survive** in `apps/server/src/game/gangs/` — `apps/server/src/plugins/ctx.ts` imports both.

**Tech Stack:** TypeScript (strict, ESM, `.js` extensions on relative imports), Fastify, drizzle-orm + PostgreSQL 16, ioredis, zod, vitest against real Postgres/Redis.

## Global Constraints

Copied from the design spec (`docs/superpowers/specs/2026-08-11-plugin-gangs-port-design.md`) and `CLAUDE.md`. Every task's requirements implicitly include this section.

- **No `any` in `packages/*`** — none, not even a cast. Type guards over casts.
- **ESM only**; relative imports carry a `.js` extension despite `.ts` sources.
- **`@gl3/shared` is off-limits to a plugin package.** Every schema, bound, regex and constant the routes need is restated inside `packages/plugins/gangs/`.
- **Money is `bigint`** in Postgres and TypeScript, crossing the wire as a decimal string. Bigint column defaults are written `` .default(sql`0`) ``, never `.default(0n)`.
- **Publish events only after the transaction commits** (CLAUDE.md rule 5). In a plugin this is structural: `tx.events.publishCore` buffers, and the ctx flushes after commit.
- **Every `(gang, player)` lock pair goes through `tx.locks.gangAndPlayer`** (CLAUDE.md rule 6). The one exemption is create-gang, which locks the player alone because it INSERTs its own `gangs` row under a fresh id in the same transaction.
- **Zod validates every external boundary** — bodies AND route params.
- **A 400 from a plugin route carries `{ error: "invalid_request" }` with no `issues` array.** The plugin route layer owns body validation and does not forward zod's `issues`. Core's gang routes forwarded them; no test and nothing in `@gl3/web` reads them.
- **Run the suite locally and read the exit code, not the summary:**
  ```bash
  export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
  export REDIS_URL=redis://localhost:6379
  npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
  ```
  Any non-zero exit is a failure even when every test passed.
- **Never run two full test suites at once.** Never run `FLUSHALL` / `FLUSHDB`.
- **Conventional Commits.**

### Spec correction adopted by this plan

The spec says "14 routes" throughout. The actual count in `apps/server/src/game/gangs/routes.ts` is **15** — verify with:

```bash
grep -c "^  app\.\(get\|post\|put\|delete\)(" apps/server/src/game/gangs/routes.ts
```

Expected: `15`. This plan implements all 15. Nothing else in the spec changes.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `packages/plugins/gangs/package.json` | `@gl3/plugin-gangs` manifest — deps on `@gl3/plugin-sdk`, `drizzle-orm`, `zod` |
| `packages/plugins/gangs/tsconfig.json` | project-references build config, mirroring `mail` |
| `packages/plugins/gangs/src/schema.ts` | drizzle **mirrors** of seven core-owned tables. No migrations, no `tables` manifest entry — core owns and migrates all seven |
| `packages/plugins/gangs/src/index.ts` | restated zod schemas, postgres-error guards, `loadGangDto` / `removeMember` helpers, the 15 routes, `definePlugin` default export |

**Modified:**

| Path | Change |
|---|---|
| `packages/plugin-sdk/src/errors.ts` | add `InsufficientGangFundsError` (Task 1) |
| `packages/plugin-sdk/src/index.ts:1` | export it (Task 1) |
| `packages/plugin-sdk/src/ctx.ts` | add `readonly gangs` namespace to `PluginTx` (Task 1) |
| `apps/server/src/plugins/ctx.ts` | wrap `applyGangBalanceChange`; implement `tx.gangs.hasPermission` (Task 1) |
| `apps/server/test/plugin-ctx-transaction.test.ts` | add the overdraft-translation test (Task 1) |
| `apps/server/package.json` | `"@gl3/plugin-gangs": "*"` (Task 2) |
| `apps/server/tsconfig.json` | `references` entry — **fails only in CI** (Task 2) |
| `tsconfig.json` (root) | `references` entry (Task 2) |
| `vitest.workspace.ts` | `srcAliases` entry — **fails nothing**, silently grades against stale `dist/` (Task 2) |
| `Dockerfile.server` | five COPY lines — **fails only in CI** (Task 2) |
| `apps/server/src/plugins/core-plugins.ts` | import + `CORE_PLUGINS` entry (Task 3) |
| `apps/server/src/app.ts:7,58` | delete `registerGangRoutes` import and call (Task 3) |
| `docs/STATUS.md`, `CLAUDE.md` | port record, watch items, counts (Task 3) |

**Deleted:**

| Path | Note |
|---|---|
| `apps/server/src/game/gangs/routes.ts` | Task 3. `permissions.ts` and `logs.ts` in the same directory **survive** |

**Unchanged (they are the proof):** all 8 gang test files —
`gangs.test.ts`, `gang-bank.test.ts`, `gang-members.test.ts`, `gang-ledger.test.ts`,
`gang-lock-order.test.ts`, `gang-invites.test.ts`, `gang-membership.test.ts`,
`gang-transfer.test.ts`. They are entirely `app.inject`; their only direct imports
are from `permissions.ts`, which stays in core.

---

## Task 1: SDK gang-overdraft error + `tx.gangs.hasPermission`

Shared code every future plugin inherits. No caller until Task 2. Lands standalone, proven by a test shown failing first.

**Files:**
- Modify: `packages/plugin-sdk/src/errors.ts` (append after `InsufficientFundsError`)
- Modify: `packages/plugin-sdk/src/index.ts:1`
- Modify: `packages/plugin-sdk/src/ctx.ts:161` (inside `PluginTx`, after the `locks` block)
- Modify: `apps/server/src/plugins/ctx.ts:19,24,124,155-161`
- Test: `apps/server/test/plugin-ctx-transaction.test.ts` (append a case before the closing `});`)

**Interfaces:**
- Produces:
  - `class InsufficientGangFundsError extends Error { readonly gangId: string; readonly kind: "cash" | "bank" }` — exported from `@gl3/plugin-sdk`. Task 2's withdraw route catches it.
  - `PluginTx["gangs"]: { hasPermission(gangId: string, playerId: string, permission: string): Promise<boolean> }` — Task 2's withdraw and permission routes call it.
- Consumes: core's `InsufficientGangFundsError` and `hasGangPermission` / `GANG_PERMISSIONS` / `GangPermission`, all already in `apps/server`.

---

- [ ] **Step 1: Write the failing test**

Append this case to `apps/server/test/plugin-ctx-transaction.test.ts`, immediately after the existing `"moves gang money, appends a gang log, and locks both sides in one order"` case (currently ending at line 174) and before the `"reads settings under the plugin's own prefix and nowhere else"` case:

```ts
  // The gap the bank port deferred: without the ctx wrap, core's own
  // InsufficientGangFundsError escapes the loader's PluginError catch as an
  // unrecognised error and Fastify answers 500, where core's withdraw route
  // answered 400 insufficient_gang_funds (game/gangs/routes.ts:833). A plugin
  // package cannot import core's class, so the only way a ported gangs plugin
  // can catch this is if the ctx translates it into the SDK one on the way out.
  it("translates a gang overdraft into the SDK's InsufficientGangFundsError", async () => {
    const gangId = uuidv7();
    await db.insert(gangs).values({ id: gangId, name: `g${gangId.slice(0, 8)}`, bank: 100n });
    const ctx = createPluginCtx(deps(), opts);

    const thrown = await ctx.transaction(async (tx) => {
      try {
        await tx.economy.applyGangBalanceChange({
          gangId, amount: -500n, kind: "bank", reason: "plugin_gang_overdraft_test",
        });
        return null;
      } catch (error) {
        return error;
      }
    });

    expect(thrown).toBeInstanceOf(SdkInsufficientGangFundsError);
    expect(thrown).toMatchObject({ gangId, kind: "bank" });
    // The balance is untouched: applyGangBalanceChange refuses before writing.
    const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
    expect(gang?.bank).toBe(100n);
  });
```

Add the import at the top of the same file, after the `vitest` import on line 4:

```ts
import { InsufficientGangFundsError as SdkInsufficientGangFundsError } from "@gl3/plugin-sdk";
```

(`uuidv7`, `eq`, `gangs`, `db`, `deps`, `opts`, `createPluginCtx` are already imported in this file — lines 1-10, 40-42.)

- [ ] **Step 2: Run the test and verify it fails for the right reason**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npx vitest run apps/server/test/plugin-ctx-transaction.test.ts -t "translates a gang overdraft"
```

Expected: **FAIL**. Two failure modes are both acceptable proof, and you must record which one you saw:
- a TypeScript/import error — `InsufficientGangFundsError` is not exported from `@gl3/plugin-sdk` yet, **or**
- `expected [Error: insufficient gang bank for gang …] to be an instance of InsufficientGangFundsError` — core's class escaped untranslated.

If it PASSES, stop: the test is not exercising the gap and the whole task is unproven.

- [ ] **Step 3: Add `InsufficientGangFundsError` to the SDK**

Append to `packages/plugin-sdk/src/errors.ts` (after the closing brace of `InsufficientFundsError`), and widen the existing type-only import on line 1 to `import type { PluginBalanceChange, PluginGangBalanceChange } from "./ctx.js";`:

```ts
/**
 * Thrown by `tx.economy.applyGangBalanceChange` when a debit would take a
 * gang balance below zero — the gang-side twin of `InsufficientFundsError`.
 * Core's own `InsufficientGangFundsError` (`economy/ledger.ts`) lives in
 * `apps/server`, which a plugin package may not import, so the ctx translates
 * it into this one on the way out.
 *
 * Deliberately NOT mapped to a status by the route loader, for the same
 * reason `InsufficientFundsError` is not: the gang bank answers
 * `400 insufficient_gang_funds` (`game/gangs/routes.ts:833`) where the player
 * legs of other modules answer 409, so each plugin catches this and throws
 * its own `PluginError`.
 */
export class InsufficientGangFundsError extends Error {
  constructor(
    readonly gangId: string,
    readonly kind: PluginGangBalanceChange["kind"],
  ) {
    super(`insufficient gang ${kind} for gang ${gangId}`);
    this.name = "InsufficientGangFundsError";
  }
}
```

Then edit `packages/plugin-sdk/src/index.ts:1` to:

```ts
export { PluginError, JobAlreadyAppliedError, InsufficientFundsError, InsufficientGangFundsError } from "./errors.js";
```

- [ ] **Step 4: Add the `gangs` namespace to `PluginTx`**

In `packages/plugin-sdk/src/ctx.ts`, inside `interface PluginTx`, insert between the closing `};` of the `locks` block (line 161) and the `gangLog(entry: GangLogEntry)` line:

```ts
  /**
   * Reads core's three-layer gang permission mask
   * (`game/gangs/permissions.ts`): boss/underboss bypass, then a
   * `gang_permissions` row that must join a live `gang_members` row.
   *
   * `permission` is `string`, not core's `GangPermission` union — that type
   * lives in `apps/server` and the SDK may not import it. A value outside the
   * known set answers `false`, which is what the underlying query would have
   * answered anyway; a plugin validates the enum on its own route param.
   *
   * Always reads through the LIVE TRANSACTION, never a fresh connection. That
   * is what lets a caller do the lock-then-recheck TOCTOU defence
   * (CLAUDE.md rule 2): call it once before `locks.gangAndPlayer` for the
   * unlocked pre-check, and again after for a read that observes post-lock,
   * post-commit state. Core's withdraw route
   * (`game/gangs/routes.ts:823`) depends on exactly this.
   */
  readonly gangs: {
    hasPermission(gangId: string, playerId: string, permission: string): Promise<boolean>;
  };
```

- [ ] **Step 5: Implement both in `apps/server/src/plugins/ctx.ts`**

Three edits.

**5a.** Line 19 — widen the `economy/ledger.js` import to bring in core's gang error:

```ts
  addExp, applyBalanceChange, applyGangBalanceChange, InsufficientFundsError,
  InsufficientGangFundsError, lockGangAndPlayerForUpdate, lockLocationForUpdate,
  lockLocationsForUpdate, lockPlayersForUpdate, type Tx,
```

Line 5-9 — widen the `@gl3/plugin-sdk` value import:

```ts
import {
  InsufficientFundsError as SdkInsufficientFundsError,
  InsufficientGangFundsError as SdkInsufficientGangFundsError,
  JobAlreadyAppliedError,
  runFilterChain,
} from "@gl3/plugin-sdk";
```

Line 24 — add the permissions import beside the existing `appendGangLog` one:

```ts
import { appendGangLog } from "../game/gangs/logs.js";
import { GANG_PERMISSIONS, hasGangPermission, type GangPermission } from "../game/gangs/permissions.js";
```

**5b.** Replace line 124 (`applyGangBalanceChange: (change) => applyGangBalanceChange(tx, change),`) with the mirror of the `applyBalanceChange` wrap above it:

```ts
            // The gang-side mirror of the applyBalanceChange wrap above, and
            // the same reason: a plugin package cannot import core's class,
            // so without this every gang overdraft escapes the loader's
            // PluginError catch and Fastify 500s where core's withdraw route
            // answered 400 insufficient_gang_funds. Everything else
            // propagates untouched.
            //
            // No bufferScore, unlike the player wrap: gang balances have no
            // leaderboard — LeaderboardKind is cash/bank/exp on a PLAYER.
            applyGangBalanceChange: async (change) => {
              try {
                return await applyGangBalanceChange(tx, change);
              } catch (error) {
                if (error instanceof InsufficientGangFundsError) {
                  throw new SdkInsufficientGangFundsError(change.gangId, change.kind);
                }
                throw error;
              }
            },
```

**5c.** Add the `gangs` namespace to the `pluginTx` object literal, immediately after the `locks: { … },` block (which closes at line 160) and before `gangLog:`:

```ts
          /**
           * `tx`, never `db`. Defined inside this closure, so every call
           * reads through the live transaction — which is what makes a
           * post-lock recheck observe post-lock state (SDK ctx.ts, and
           * core's own withdraw route at game/gangs/routes.ts:823).
           *
           * A guard rather than a cast: `hasGangPermission` takes core's
           * `GangPermission` union, the SDK hands over a `string`, and
           * `packages/*` forbids casts. An unknown permission answers false,
           * which is what the underlying query would have answered.
           */
          gangs: {
            hasPermission: async (gangId, playerId, permission) => {
              if (!isGangPermission(permission)) return false;
              return await hasGangPermission(tx, gangId, playerId, permission);
            },
          },
```

And add this module-level helper at the bottom of the file, beside `freshStats`:

```ts
/** Narrows the SDK's `string` to core's `GangPermission` without a cast. */
function isGangPermission(value: string): value is GangPermission {
  return GANG_PERMISSIONS.some((permission) => permission === value);
}
```

- [ ] **Step 6: Run the test and verify it passes**

```bash
npx vitest run apps/server/test/plugin-ctx-transaction.test.ts
```

Expected: PASS, including the pre-existing cases in the file.

- [ ] **Step 7: Typecheck, including the CI-only path**

```bash
npm run typecheck
npx tsc --build --force apps/server/tsconfig.json
```

Expected: both exit 0. The second is the exact command the container image build runs and is the only local way to catch a missing `apps/server/tsconfig.json` reference.

- [ ] **Step 8: Run the full suite**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. Read the exit code, not the printed summary — an unhandled rejection makes vitest exit non-zero while still printing a green test count. Record the file/test totals from `/tmp/verify.log`; Task 3 updates `docs/STATUS.md` with the final figure.

- [ ] **Step 9: Commit**

```bash
git add packages/plugin-sdk/src/errors.ts packages/plugin-sdk/src/index.ts \
        packages/plugin-sdk/src/ctx.ts apps/server/src/plugins/ctx.ts \
        apps/server/test/plugin-ctx-transaction.test.ts
git commit -m "feat(plugin-sdk): add InsufficientGangFundsError and tx.gangs.hasPermission

The two ctx gaps the gangs port needs. applyGangBalanceChange now translates
core's InsufficientGangFundsError into the SDK one the same way
applyBalanceChange already translates the player-leg error, so a gang
overdraft can answer 400 instead of escaping as a 500. tx.gangs.hasPermission
delegates to core's hasGangPermission through the live transaction, which is
what lets a caller recheck under a lock.

No caller yet; the gangs plugin lands next."
```

---

## Task 2: The `@gl3/plugin-gangs` package

The plugin package plus its six build/wire registration sites. Core still serves `/api/gangs`, so the suite is unchanged and stays green — this task's proof is that the tree typechecks through the CI-only path and the suite does not regress.

**Files:**
- Create: `packages/plugins/gangs/package.json`
- Create: `packages/plugins/gangs/tsconfig.json`
- Create: `packages/plugins/gangs/src/schema.ts`
- Create: `packages/plugins/gangs/src/index.ts`
- Modify: `apps/server/package.json:13-20` (dependency list, alphabetical)
- Modify: `apps/server/tsconfig.json` (`references`)
- Modify: `tsconfig.json` (root `references`)
- Modify: `vitest.workspace.ts` (`srcAliases`)
- Modify: `Dockerfile.server:60,86,87,131,149` (five COPY lines, gangs alongside mail)

**Interfaces:**
- Consumes: `definePlugin`, `route`, `newId`, `PluginError`, `InsufficientFundsError`, `InsufficientGangFundsError`, `type PluginDbTx`, `type PluginTx` — all from `@gl3/plugin-sdk`; `tx.gangs.hasPermission` from Task 1.
- Produces: default export `PluginManifest` with `id: "gangs"`, consumed by Task 3's `CORE_PLUGINS` entry.

---

- [ ] **Step 1: Create `packages/plugins/gangs/package.json`**

```json
{
  "name": "@gl3/plugin-gangs",
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

- [ ] **Step 2: Create `packages/plugins/gangs/tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../plugin-sdk" }]
}
```

- [ ] **Step 3: Create `packages/plugins/gangs/src/schema.ts`**

Seven mirrors. Defaults are copied exactly from core because the create route omits `bank`/`cash`/`level` on insert and every timestamp column is DB-defaulted — a missing default makes drizzle's insert type demand a value core never supplied.

```ts
import { sql } from "drizzle-orm";
import { bigint, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Mirrors of core-owned tables. This plugin reads and writes all seven but
 * owns none: column names, types, nullability and defaults match
 * `apps/server/src/db/schema/social.ts` and `identity.ts` exactly, which is
 * what lets `tx.db.select` / `.insert` / `.update` type and serialise
 * correctly. None is listed in this plugin's manifest `tables` map and none
 * gets a migration here — core already owns and migrates all seven (the
 * pattern `packages/plugins/news/src/schema.ts` established; the loader
 * enforces naming and prefix rules only on tables a manifest *declares*).
 *
 * Only the columns this plugin touches are listed. Composite primary keys
 * (`gang_members`, `gang_permissions`), indexes, unique constraints and FK
 * references stay core-owned: drizzle does not need them for
 * select/insert/update/delete to typecheck, and mirroring them would add
 * drift surface for no type benefit. A wrong omission surfaces as a compile
 * error, not a silent bug — a wrong NULLABILITY or a missing DEFAULT does
 * not, which is why both are matched by hand.
 */
export const gangs = pgTable("gangs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  info: text("info").notNull().default(""),
  bank: bigint("bank", { mode: "bigint" }).notNull().default(sql`0`),
  cash: bigint("cash", { mode: "bigint" }).notNull().default(sql`0`),
  level: integer("level").notNull().default(1),
  bossPlayerId: uuid("boss_player_id"),
  underbossPlayerId: uuid("underboss_player_id"),
});

export const gangMembers = pgTable("gang_members", {
  gangId: uuid("gang_id").notNull(),
  playerId: uuid("player_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gangPermissions = pgTable("gang_permissions", {
  gangId: uuid("gang_id").notNull(),
  playerId: uuid("player_id").notNull(),
  permission: text("permission").notNull(),
});

export const gangInvites = pgTable("gang_invites", {
  id: uuid("id").primaryKey(),
  gangId: uuid("gang_id").notNull(),
  invitedPlayerId: uuid("invited_player_id").notNull(),
  invitedByPlayerId: uuid("invited_by_player_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Read-only here: writes go through `tx.gangLog`, which core owns. */
export const gangLogs = pgTable("gang_logs", {
  id: uuid("id").primaryKey(),
  gangId: uuid("gang_id").notNull(),
  playerId: uuid("player_id"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  cash: bigint("cash", { mode: "bigint" }).notNull().default(sql`0`),
  gangId: uuid("gang_id"),
});
```

- [ ] **Step 4: Create `packages/plugins/gangs/src/index.ts` — header, schemas, guards, helpers**

Write this as the top of the file; Steps 5-8 append the routes and the export.

```ts
import {
  definePlugin, InsufficientFundsError, InsufficientGangFundsError, newId, PluginError, route,
  type PluginDbTx, type PluginTx,
} from "@gl3/plugin-sdk";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  gangInvites, gangLogs, gangMembers, gangPermissions, gangs, players, playerStats,
} from "./schema.js";

/**
 * Ported from `apps/server/src/game/gangs/routes.ts`: paths, status codes,
 * error strings, response bodies and every `gang.*` / `notification.created`
 * event are byte-identical. The 8 gang test files are unchanged and are the
 * proof — they are entirely `app.inject`, and their only direct imports are
 * from `game/gangs/permissions.ts`, which stays in core.
 *
 * Five deliberate differences from core:
 *  - ONE `ctx.transaction` per route. Core split several routes into an
 *    unlocked pre-check outside a transaction and a locked mutation inside
 *    it; a plugin has only one database handle. The TOCTOU defence is about
 *    LOCK STATE, not transaction boundaries — the pre-checks below still run
 *    before any `tx.locks.*` call, and every recheck still runs after one, so
 *    the property core relied on survives intact (design §4.4).
 *  - No `AlreadyInGangError`-style private error classes. A `PluginError`
 *    thrown inside `ctx.transaction` rolls the transaction back and reaches
 *    the loader unwrapped, so the class-per-condition indirection core needed
 *    to carry a status out of `db.transaction` is unnecessary here.
 *  - `actorName` comes from `ctx.player.username` wherever the actor IS the
 *    caller (create, accept, leave) — no `players` read. Kick still reads
 *    `players`, because `gang.memberLeft`'s actor is the KICKED player.
 *  - `tx.notify` replaces `insertNotification` + a hand-built post-commit
 *    `notification.created` publish on the invite and transfer routes: it
 *    writes the row and buffers the event, with the recipient as actor —
 *    byte-identical to what core published (design §4.9).
 *  - A 400 from a bad body carries `{ error: "invalid_request" }` with no
 *    `issues` array, because the plugin route layer owns body validation
 *    (`apps/server/src/plugins/routes.ts`). Every gang test asserting a 400
 *    asserts only the status code.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `IdSchema`,
 * `noNulByte`, the `MoneySchema` regex and `GANG_PERMISSIONS` are restated
 * below. Every bound is copied from `packages/shared/src/dto/gangs.ts`
 * verbatim: a wrong bound silently changes which inputs 400.
 */
const noNulByte = <T extends z.ZodString>(schema: T): z.ZodEffects<T, string, string> =>
  schema.refine((value) => !value.includes("\u0000"), { message: "must not contain a NUL byte" });

const IdSchema = z.string().uuid();

/** Mirrors core's tuple (`game/gangs/permissions.ts:6`) and `dto/gangs.ts:47`. */
const GANG_PERMISSIONS = [
  "invite", "kick", "bank.withdraw", "edit_info", "grant_permissions",
] as const;

const GangParamsSchema = z.object({ gangId: IdSchema });
const InviteParamsSchema = z.object({ inviteId: IdSchema });
const MemberParamsSchema = z.object({ gangId: IdSchema, playerId: IdSchema });
const PermissionParamsSchema = z.object({
  gangId: IdSchema, playerId: IdSchema, permission: z.enum(GANG_PERMISSIONS),
});

const CreateGangBodySchema = z.object({
  // The regex allowlist already excludes NUL (not in the character class), so
  // `name` does not take noNulByte on top of it — matching dto/gangs.ts:5-6.
  name: z.string().min(3).max(50).regex(/^[A-Za-z0-9 _'-]+$/, "letters, digits, spaces, _ - ' only"),
  description: noNulByte(z.string().max(500)).optional(),
  info: noNulByte(z.string().max(2000)).optional(),
});
// Not persisted, but reaches Postgres as an `eq(players.username, ...)`
// parameter, and Postgres rejects an embedded NUL in ANY text parameter
// (SQLSTATE 22021) — so this needs the guard too.
const InviteBodySchema = z.object({ username: noNulByte(z.string().min(3).max(30)) });
const TransferBodySchema = z.object({ playerId: IdSchema });
const GrantBodySchema = z.object({ playerId: IdSchema, permission: z.enum(GANG_PERMISSIONS) });
// The `> 0` refine core carries on GangBankTransferRequestSchema lives in the
// handler instead: the loader answers every schema failure with
// `invalid_request`, which would silently drop the distinct error string.
// Same shape `packages/plugins/bank/src/index.ts:24` took.
const AmountBodySchema = z.object({
  amount: z.string().regex(/^-?\d+$/, "must be an integer string"),
});

/**
 * drizzle re-throws the driver's `PostgresError` either directly or wrapped
 * as an `Error` whose `cause` is it — core handled both (`routes.ts:149-161`)
 * and so must this. Read as a duck-typed property rather than an
 * `instanceof postgres.PostgresError`: no plugin depends on `postgres`, which
 * is an `apps/server` transport concern. Guards, not casts (`packages/*`).
 */
function pgErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("code" in value)) return null;
  const { code } = value;
  return typeof code === "string" ? code : null;
}

function isPgCode(error: unknown, code: string): boolean {
  if (pgErrorCode(error) === code) return true;
  return error instanceof Error && pgErrorCode(error.cause) === code;
}

const isUniqueViolation = (error: unknown): boolean => isPgCode(error, "23505");
const isForeignKeyViolation = (error: unknown): boolean => isPgCode(error, "23503");

async function loadGangDto(db: PluginDbTx, gangId: string): Promise<Record<string, unknown> | null> {
  const [gang] = await db.select().from(gangs).where(eq(gangs.id, gangId));
  if (!gang) return null;
  const [memberCount] = await db.select({ n: count() }).from(gangMembers)
    .where(eq(gangMembers.gangId, gangId));
  return {
    id: gang.id, name: gang.name, description: gang.description, info: gang.info,
    bank: gang.bank.toString(), cash: gang.cash.toString(), level: gang.level,
    bossPlayerId: gang.bossPlayerId, underbossPlayerId: gang.underbossPlayerId,
    memberCount: memberCount?.n ?? 0,
  };
}

/**
 * Deletes membership AND any permission rows, clears `player_stats.gang_id`,
 * appends the log. Caller must hold both locks via `tx.locks.gangAndPlayer`
 * first.
 *
 * The three statements are one sequence on purpose: core's three-layer
 * permission mask (`game/gangs/permissions.ts`) depends on
 * `gang_permissions` rows being cleared whenever a `gang_members` row is
 * deleted, so a dormant grant cannot go live on rejoin. Any future path here
 * that INSERTs a `gang_members` row must clear the matching permission rows
 * first — the accept route does.
 */
async function removeMember(
  tx: PluginTx, gangId: string, playerId: string, message: string,
): Promise<void> {
  await tx.db.delete(gangMembers)
    .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, playerId)));
  await tx.db.delete(gangPermissions)
    .where(and(eq(gangPermissions.gangId, gangId), eq(gangPermissions.playerId, playerId)));
  await tx.db.update(playerStats).set({ gangId: null })
    .where(eq(playerStats.playerId, playerId));
  await tx.gangLog({ gangId, playerId, message });
}
```

- [ ] **Step 5: Append the five read routes**

```ts
const getGangRoute = route({
  method: "GET",
  path: "/api/gangs/:gangId",
  params: GangParamsSchema,
  // The one gang read any authenticated player may make — no membership
  // gate. Kept public-to-members-and-outsiders alike because kick, invite,
  // PUT/DELETE permissions and both bank routes all answer 404 before 403 on
  // a nonexistent gang, which already makes existence observable.
  handler: async (ctx, { params }) => ctx.transaction(async (tx) => {
    const dto = await loadGangDto(tx.db, params.gangId);
    if (!dto) throw new PluginError("gang_not_found", 404);
    return { status: 200, body: dto };
  }),
});

const gangLogsRoute = route({
  method: "GET",
  path: "/api/gangs/:gangId/logs",
  params: GangParamsSchema,
  handler: async (ctx, { params }) => ctx.transaction(async (tx) => {
    const rows = await tx.db.select().from(gangLogs)
      .where(eq(gangLogs.gangId, params.gangId))
      .orderBy(desc(gangLogs.createdAt))
      .limit(50);
    return {
      status: 200,
      body: {
        logs: rows.map((l) => ({
          id: l.id, playerId: l.playerId, message: l.message,
          createdAt: l.createdAt.toISOString(),
        })),
      },
    };
  }),
});

const gangMembersRoute = route({
  method: "GET",
  path: "/api/gangs/:gangId/members",
  params: GangParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;

    return ctx.transaction(async (tx) => {
      const [gang] = await tx.db
        .select({ boss: gangs.bossPlayerId, underboss: gangs.underbossPlayerId })
        .from(gangs).where(eq(gangs.id, gangId));
      if (!gang) throw new PluginError("gang_not_found", 404);

      // Members only. GET /api/gangs/:gangId is open to any authenticated
      // player, but this roster carries each member's permission grants — a
      // map of who can kick and who can empty the bank — and gangs are
      // invite-only, so no non-member has a use for it.
      const [membership] = await tx.db.select({ gangId: gangMembers.gangId }).from(gangMembers)
        .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, player.id)));
      if (!membership) throw new PluginError("not_a_member", 403);

      const rows = await tx.db.select({
        playerId: gangMembers.playerId, username: players.username, joinedAt: gangMembers.joinedAt,
      }).from(gangMembers).innerJoin(players, eq(players.id, gangMembers.playerId))
        .where(eq(gangMembers.gangId, gangId))
        .orderBy(gangMembers.joinedAt);

      // Permissions are attached by joining in memory against the member
      // list, which reproduces hasGangPermission's membership requirement: a
      // gang_permissions row naming someone with no gang_members row confers
      // nothing there and must not appear here either.
      const grants = await tx.db
        .select({ playerId: gangPermissions.playerId, permission: gangPermissions.permission })
        .from(gangPermissions).where(eq(gangPermissions.gangId, gangId));
      const byPlayer = new Map<string, string[]>();
      for (const g of grants) {
        const list = byPlayer.get(g.playerId);
        if (list) list.push(g.permission);
        else byPlayer.set(g.playerId, [g.permission]);
      }

      const rank = (id: string): number => (id === gang.boss ? 0 : id === gang.underboss ? 1 : 2);
      const members = rows
        .map((m) => ({
          playerId: m.playerId,
          username: m.username,
          role: m.playerId === gang.boss ? "boss" : m.playerId === gang.underboss ? "underboss" : "member",
          // Leadership holds every permission implicitly (hasGangPermission's
          // boss/underboss bypass) and holds no gang_permissions rows to
          // report, so send the whole set rather than an empty array a client
          // would read as "can do nothing".
          permissions: m.playerId === gang.boss || m.playerId === gang.underboss
            ? [...GANG_PERMISSIONS]
            : byPlayer.get(m.playerId) ?? [],
          joinedAt: m.joinedAt.toISOString(),
        }))
        // Array.prototype.sort is stable, so equal-rank members keep the
        // joinedAt ordering the query above established.
        .sort((a, b) => rank(a.playerId) - rank(b.playerId));

      return { status: 200, body: { members } };
    });
  },
});

// find-my-way prefers the static "invites" segment over :gangId, so this does
// not shadow — nor is it shadowed by — GET /api/gangs/:gangId.
// gang-invites.test.ts pins that.
const myInvitesRoute = route({
  method: "GET",
  path: "/api/gangs/invites",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const rows = await tx.db.select({
        id: gangInvites.id, gangId: gangInvites.gangId, gangName: gangs.name,
        invitedByPlayerId: gangInvites.invitedByPlayerId, invitedByUsername: players.username,
        createdAt: gangInvites.createdAt,
      }).from(gangInvites)
        .innerJoin(gangs, eq(gangs.id, gangInvites.gangId))
        .innerJoin(players, eq(players.id, gangInvites.invitedByPlayerId))
        .where(eq(gangInvites.invitedPlayerId, player.id))
        .orderBy(desc(gangInvites.createdAt))
        .limit(50);

      // No player_stats.gang_id filter. Accepting clears every invite the
      // joiner holds, and the invite route refuses a target already in a
      // gang, so an invite that would 409 already_in_a_gang normally cannot
      // exist — but it can be raced into being. Listing it is deliberate: the
      // accept route is the authority on whether an invite still works, and
      // filtering here would leave the invitee looking at a notification for
      // an invite that is nowhere.
      return {
        status: 200,
        body: { invites: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) },
      };
    });
  },
});
```

- [ ] **Step 6: Append the six membership/invite routes**

```ts
const createGangRoute = route({
  method: "POST",
  path: "/api/gangs",
  body: CreateGangBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const gangId = newId();
    let dto: Record<string, unknown> | null;
    try {
      dto = await ctx.transaction(async (tx) => {
        // Lock this player's stats row first, then recheck under that lock —
        // the window between an unlocked pre-check and commit is exactly what
        // let two concurrent POSTs from the same player both pass.
        //
        // This is the ONE membership path that does not go through
        // locks.gangAndPlayer, and it is exempt structurally rather than by
        // oversight: the gangs row it goes on to touch (implicitly, via
        // gang_members' and gang_logs' foreign keys) is one it INSERTs in
        // this same transaction under a freshly-minted id. No other
        // transaction can hold or want a lock on a row it cannot see, so this
        // path can never be one leg of a lock cycle.
        await tx.locks.player([player.id]);
        const [existing] = await tx.db.select({ gangId: playerStats.gangId }).from(playerStats)
          .where(eq(playerStats.playerId, player.id));
        if (existing?.gangId) throw new PluginError("already_in_a_gang", 409);

        await tx.db.insert(gangs).values({
          id: gangId, name: body.name, description: body.description ?? "",
          info: body.info ?? "", bossPlayerId: player.id,
        });
        await tx.db.insert(gangMembers).values({ gangId, playerId: player.id });
        await tx.db.update(playerStats).set({ gangId }).where(eq(playerStats.playerId, player.id));
        await tx.gangLog({ gangId, playerId: player.id, message: "founded the gang" });

        await tx.events.publishCore({
          type: "gang.created",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "gang", gangId },
          gangId,
          gangName: body.name,
        });

        return await loadGangDto(tx.db, gangId);
      });
    } catch (error) {
      // Outside the transaction, not inside: a failed statement aborts the
      // Postgres transaction, so there is nothing to catch and continue from
      // in there. `gangs_name_unique` is the only unique constraint reachable
      // on this insert path (name is the only unique column), so the
      // constraint-name check core made is redundant here — see the watch
      // item this port adds to docs/STATUS.md.
      if (isUniqueViolation(error)) throw new PluginError("gang_name_taken", 409);
      throw error;
    }
    return { status: 201, body: dto };
  },
});

const inviteRoute = route({
  method: "POST",
  path: "/api/gangs/:gangId/invites",
  params: GangParamsSchema,
  body: InviteBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;

    return ctx.transaction(async (tx) => {
      // Existence before permission: hasPermission returns false for a
      // nonexistent gang, which would otherwise mask a 404 as a 403.
      const [gang] = await tx.db.select({ name: gangs.name }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gang) throw new PluginError("gang_not_found", 404);

      if (!(await tx.gangs.hasPermission(gangId, player.id, "invite"))) {
        throw new PluginError("forbidden", 403);
      }

      const [target] = await tx.db.select({ id: players.id, gangId: playerStats.gangId })
        .from(players).innerJoin(playerStats, eq(playerStats.playerId, players.id))
        .where(eq(players.username, body.username));
      if (!target) throw new PluginError("player_not_found", 404);
      if (target.gangId) throw new PluginError("already_in_a_gang", 409);

      const inviteId = newId();
      await tx.db.insert(gangInvites).values({
        id: inviteId, gangId, invitedPlayerId: target.id, invitedByPlayerId: player.id,
      });
      // Writes the notification row AND buffers notification.created with the
      // INVITEE as actor — byte-identical to what core published by hand, and
      // the actor awaitOwnEvent filters on (CLAUDE.md rule 4).
      await tx.notify(target.id, `${gang.name} invited you to join.`);
      await tx.gangLog({ gangId, playerId: player.id, message: `invited ${body.username}` });

      return { status: 201, body: { id: inviteId } };
    });
  },
});

const acceptInviteRoute = route({
  method: "POST",
  path: "/api/gangs/invites/:inviteId/accept",
  params: InviteParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const [invite] = await tx.db.select().from(gangInvites)
        .where(eq(gangInvites.id, params.inviteId));
      if (!invite || invite.invitedPlayerId !== player.id) {
        throw new PluginError("invite_not_found", 404);
      }

      // Both rows through gangAndPlayer, not player alone: this transaction
      // touches the gangs row regardless — Postgres takes FOR KEY SHARE on it
      // when the player_stats.gang_id update, the gang_members insert and the
      // gang log each check their foreign key — so taking player_stats first
      // would put this path in the opposite order from the bank routes and
      // reopen the 40P01 deadlock M3 shipped (test/gang-lock-order.test.ts).
      await tx.locks.gangAndPlayer(invite.gangId, player.id);
      const [stats] = await tx.db.select({ gangId: playerStats.gangId }).from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (stats?.gangId) throw new PluginError("already_in_a_gang", 409);

      await tx.db.update(playerStats).set({ gangId: invite.gangId })
        .where(eq(playerStats.playerId, player.id));
      await tx.db.insert(gangMembers).values({ gangId: invite.gangId, playerId: player.id });
      // Joining is the moment a dormant gang_permissions row for this
      // (gang, player) would silently go live, because the permission mask
      // only hides such a row while there is no gang_members row to join
      // against. PUT /permissions refuses a non-member target, so no route
      // can plant one — but rows predating that fix, or written out of band,
      // would still activate here. Clearing them mirrors removeMember, which
      // clears them on the way out.
      await tx.db.delete(gangPermissions).where(and(
        eq(gangPermissions.gangId, invite.gangId), eq(gangPermissions.playerId, player.id),
      ));
      await tx.db.delete(gangInvites).where(eq(gangInvites.invitedPlayerId, player.id));
      await tx.gangLog({ gangId: invite.gangId, playerId: player.id, message: "joined the gang" });

      await tx.events.publishCore({
        type: "gang.memberJoined",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "gang", gangId: invite.gangId },
        gangId: invite.gangId,
      });

      return { status: 200, body: await loadGangDto(tx.db, invite.gangId) };
    });
  },
});

const declineInviteRoute = route({
  method: "POST",
  path: "/api/gangs/invites/:inviteId/decline",
  params: InviteParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const [deleted] = await tx.db.delete(gangInvites)
        .where(and(
          eq(gangInvites.id, params.inviteId),
          eq(gangInvites.invitedPlayerId, player.id),
        ))
        .returning({ id: gangInvites.id });
      if (!deleted) throw new PluginError("invite_not_found", 404);
      return { status: 204, body: null };
    });
  },
});

const leaveRoute = route({
  method: "POST",
  path: "/api/gangs/:gangId/leave",
  params: GangParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;

    return ctx.transaction(async (tx) => {
      // Lock the gang row and the leaving player's stats row before
      // rechecking boss status under them. An unlocked pre-check followed by
      // the mutation would let a concurrent boss-transfer race this leave
      // (CLAUDE.md rule 2). gangAndPlayer, not player: removeMember ends in a
      // gang log whose insert takes FOR KEY SHARE on this gangs row anyway.
      await tx.locks.gangAndPlayer(gangId, player.id);
      const [gang] = await tx.db.select({ boss: gangs.bossPlayerId }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gang) throw new PluginError("gang_not_found", 404);
      const [stats] = await tx.db.select({ gangId: playerStats.gangId }).from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (stats?.gangId !== gangId) throw new PluginError("not_a_member", 404);
      if (gang.boss === player.id) throw new PluginError("boss_must_transfer_first", 409);
      await removeMember(tx, gangId, player.id, "left the gang");

      // gang.memberLeft's actor is the member who left — here, the caller, so
      // ctx.player.username replaces core's players read.
      await tx.events.publishCore({
        type: "gang.memberLeft",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "gang", gangId },
        gangId,
      });

      return { status: 204, body: null };
    });
  },
});

const transferRoute = route({
  method: "POST",
  path: "/api/gangs/:gangId/transfer",
  params: GangParamsSchema,
  body: TransferBodySchema,
  handler: async (ctx, { params, body }) => {
    const requester = ctx.player;
    if (requester === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;
    const targetId = body.playerId;

    return ctx.transaction(async (tx) => {
      // Same (gang, TARGET-player) pair and same helper as leave and kick.
      // Every check below reads under these locks rather than from an earlier
      // unlocked select: this route is precisely the concurrent writer that
      // leave's boss check defends against, so it must not itself act on a
      // stale boss id.
      await tx.locks.gangAndPlayer(gangId, targetId);
      const [gang] = await tx.db
        .select({ boss: gangs.bossPlayerId, underboss: gangs.underbossPlayerId, name: gangs.name })
        .from(gangs).where(eq(gangs.id, gangId));
      if (!gang) throw new PluginError("gang_not_found", 404);
      if (gang.boss !== requester.id) throw new PluginError("forbidden", 403);
      if (targetId === gang.boss) throw new PluginError("already_boss", 409);
      const [stats] = await tx.db.select({ gangId: playerStats.gangId }).from(playerStats)
        .where(eq(playerStats.playerId, targetId));
      if (stats?.gangId !== gangId) throw new PluginError("not_a_member", 404);

      await tx.db.update(gangs)
        // Promoting the underboss would otherwise leave one player holding
        // both offices, and the permission bypass reads either field —
        // harmless today, but it would make "demote the underboss" unable to
        // remove their bypass. Clear it in the same statement.
        .set(gang.underboss === targetId
          ? { bossPlayerId: targetId, underbossPlayerId: null }
          : { bossPlayerId: targetId })
        .where(eq(gangs.id, gangId));

      const [target] = await tx.db.select({ username: players.username }).from(players)
        .where(eq(players.id, targetId));
      await tx.gangLog({
        gangId, playerId: requester.id,
        message: `transferred leadership to ${target?.username ?? targetId}`,
      });
      // notification.created, not a new gang.* type: GameEventSchema is
      // consumed by exhaustive switches in the web client, so a new type
      // would be a client change too — and the new boss learning of it
      // privately is exactly what a notification is for. tx.notify writes the
      // row and buffers the event with the NEW BOSS as actor.
      await tx.notify(targetId, `You are now the boss of ${gang.name}.`);

      return { status: 204, body: null };
    });
  },
});

const kickRoute = route({
  method: "DELETE",
  path: "/api/gangs/:gangId/members/:playerId",
  params: MemberParamsSchema,
  handler: async (ctx, { params }) => {
    const requester = ctx.player;
    if (requester === null) throw new PluginError("unauthorized", 401);
    const { gangId, playerId: targetId } = params;

    return ctx.transaction(async (tx) => {
      // Existence before permission: a nonexistent gang must 404, not 403.
      // This pre-check is only ever the value used to answer 404; the boss
      // comparison below still trusts only the row re-read under the lock.
      const [gangExists] = await tx.db.select({ id: gangs.id }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gangExists) throw new PluginError("gang_not_found", 404);

      if (!(await tx.gangs.hasPermission(gangId, requester.id, "kick"))) {
        throw new PluginError("forbidden", 403);
      }

      await tx.locks.gangAndPlayer(gangId, targetId);
      const [gang] = await tx.db.select({ boss: gangs.bossPlayerId }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gang) throw new PluginError("gang_not_found", 404);
      const [stats] = await tx.db.select({ gangId: playerStats.gangId }).from(playerStats)
        .where(eq(playerStats.playerId, targetId));
      if (stats?.gangId !== gangId) throw new PluginError("not_a_member", 404);
      if (gang.boss === targetId) throw new PluginError("cannot_kick_boss", 409);
      await removeMember(tx, gangId, targetId,
        `kicked by ${requester.id === gang.boss ? "the boss" : "a permitted member"}`);

      // gang.memberLeft's actor is the member who left — for a kick that is
      // the KICKED player, not the kicker, matching gang.memberJoined's actor
      // being the joiner rather than whoever sent the invite. So this one
      // route still reads `players`, and the membership tests assert it via
      // awaitOwnEvent(subscriber, kickedPlayerId).
      const [actor] = await tx.db.select({ username: players.username }).from(players)
        .where(eq(players.id, targetId));
      await tx.events.publishCore({
        type: "gang.memberLeft",
        actorId: targetId,
        actorName: actor?.username ?? "unknown",
        audience: { kind: "gang", gangId },
        gangId,
      });

      return { status: 204, body: null };
    });
  },
});
```

- [ ] **Step 7: Append the two permission routes and the two bank routes**

```ts
const grantPermissionRoute = route({
  method: "PUT",
  path: "/api/gangs/:gangId/permissions",
  params: GangParamsSchema,
  body: GrantBodySchema,
  handler: async (ctx, { params, body }) => {
    const requester = ctx.player;
    if (requester === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;

    try {
      return await ctx.transaction(async (tx) => {
        const [gangExists] = await tx.db.select({ id: gangs.id }).from(gangs)
          .where(eq(gangs.id, gangId));
        if (!gangExists) throw new PluginError("gang_not_found", 404);

        if (!(await tx.gangs.hasPermission(gangId, requester.id, "grant_permissions"))) {
          throw new PluginError("forbidden", 403);
        }

        await tx.locks.gangAndPlayer(gangId, body.playerId);
        // Granting to a non-member used to be accepted and stored. The row
        // conferred nothing while the target was outside the gang, because
        // the permission mask inner-joins gang_members — but nothing deleted
        // it, so it lay dormant and went live the moment they joined, which
        // is a backdoor-planting primitive for anyone holding
        // grant_permissions. Refusing the grant means no dormant row is ever
        // created; accept-invite's cleanup handles rows this check cannot.
        const [member] = await tx.db.select({ gangId: gangMembers.gangId }).from(gangMembers)
          .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, body.playerId)));
        if (!member) throw new PluginError("not_a_member", 404);

        await tx.db.insert(gangPermissions)
          .values({ gangId, playerId: body.playerId, permission: body.permission })
          .onConflictDoNothing();
        await tx.gangLog({
          gangId, playerId: requester.id,
          message: `granted ${body.permission} to ${body.playerId}`,
        });
        return { status: 204, body: null };
      });
    } catch (error) {
      // body.playerId is only shape-validated (uuid), never checked for
      // existence. The membership check above intercepts a nonexistent player
      // id before it can reach gang_permissions.player_id's FK, but this
      // stays as a backstop so any future relaxation of that check still
      // returns a clean 4xx rather than an uncaught 500.
      if (isForeignKeyViolation(error)) throw new PluginError("player_not_found", 404);
      throw error;
    }
  },
});

const revokePermissionRoute = route({
  method: "DELETE",
  path: "/api/gangs/:gangId/permissions/:playerId/:permission",
  params: PermissionParamsSchema,
  handler: async (ctx, { params }) => {
    const requester = ctx.player;
    if (requester === null) throw new PluginError("unauthorized", 401);
    const { gangId, playerId: targetId, permission } = params;

    return ctx.transaction(async (tx) => {
      const [gangExists] = await tx.db.select({ id: gangs.id }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gangExists) throw new PluginError("gang_not_found", 404);

      if (!(await tx.gangs.hasPermission(gangId, requester.id, "grant_permissions"))) {
        throw new PluginError("forbidden", 403);
      }

      await tx.db.delete(gangPermissions).where(and(
        eq(gangPermissions.gangId, gangId),
        eq(gangPermissions.playerId, targetId),
        eq(gangPermissions.permission, permission),
      ));
      await tx.gangLog({
        gangId, playerId: requester.id,
        message: `revoked ${permission} from ${targetId}`,
      });
      return { status: 204, body: null };
    });
  },
});

const depositRoute = route({
  method: "POST",
  path: "/api/gangs/:gangId/bank/deposit",
  params: GangParamsSchema,
  body: AmountBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;
    const amount = BigInt(body.amount);
    if (amount <= 0n) throw new PluginError("amount_must_be_positive", 400);

    return ctx.transaction(async (tx) => {
      const [gangExists] = await tx.db.select({ id: gangs.id }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gangExists) throw new PluginError("gang_not_found", 404);

      const [membership] = await tx.db.select({ gangId: gangMembers.gangId }).from(gangMembers)
        .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, player.id)));
      if (!membership) throw new PluginError("not_a_member", 403);

      await tx.locks.gangAndPlayer(gangId, player.id);
      // Recheck under the lock: the unlocked membership check above can race
      // a concurrent kick/leave, which commits without contending for the
      // gang/player rows this transaction now holds. Lower stakes than
      // withdraw (money moving INTO the gang), but rechecked for consistency:
      // a route that is racy here and safe there is worse than either choice
      // made consistently.
      const [stillMember] = await tx.db.select({ gangId: gangMembers.gangId }).from(gangMembers)
        .where(and(eq(gangMembers.gangId, gangId), eq(gangMembers.playerId, player.id)));
      if (!stillMember) throw new PluginError("not_a_member", 403);

      try {
        await tx.economy.applyBalanceChange({
          playerId: player.id, amount: -amount, kind: "cash",
          reason: "gang.bank.deposit", refId: gangId,
        });
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          throw new PluginError("insufficient_cash", 400);
        }
        throw error;
      }
      const next = await tx.economy.applyGangBalanceChange({
        gangId, amount, kind: "bank", reason: "gang.bank.deposit", refId: player.id,
      });
      await tx.gangLog({
        gangId, playerId: player.id, message: `deposited ${amount} to the gang bank`,
      });

      return { status: 200, body: { bank: next.toString() } };
    });
  },
});

const withdrawRoute = route({
  method: "POST",
  path: "/api/gangs/:gangId/bank/withdraw",
  params: GangParamsSchema,
  body: AmountBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { gangId } = params;
    const amount = BigInt(body.amount);
    if (amount <= 0n) throw new PluginError("amount_must_be_positive", 400);

    return ctx.transaction(async (tx) => {
      // Existence before permission: hasPermission returns false for a
      // nonexistent gang, which would otherwise mask a 404 as a 403.
      const [gangExists] = await tx.db.select({ id: gangs.id }).from(gangs)
        .where(eq(gangs.id, gangId));
      if (!gangExists) throw new PluginError("gang_not_found", 404);

      if (!(await tx.gangs.hasPermission(gangId, player.id, "bank.withdraw"))) {
        throw new PluginError("forbidden", 403);
      }

      await tx.locks.gangAndPlayer(gangId, player.id);
      // The TOCTOU defence, and the reason tx.gangs.hasPermission exists: the
      // unlocked pre-check above can race a concurrent DELETE /permissions,
      // which touches only gang_permissions (and gang_logs) — neither of
      // which gangAndPlayer locks — so it commits freely in the gap and would
      // otherwise let money move for a player who had no permission at the
      // instant it moved. This call reads through `tx`, so it observes
      // post-lock, post-commit state.
      if (!(await tx.gangs.hasPermission(gangId, player.id, "bank.withdraw"))) {
        throw new PluginError("forbidden", 403);
      }

      let next: bigint;
      try {
        next = await tx.economy.applyGangBalanceChange({
          gangId, amount: -amount, kind: "bank",
          reason: "gang.bank.withdraw", refId: player.id,
        });
      } catch (error) {
        if (error instanceof InsufficientGangFundsError) {
          throw new PluginError("insufficient_gang_funds", 400);
        }
        throw error;
      }
      await tx.economy.applyBalanceChange({
        playerId: player.id, amount, kind: "cash",
        reason: "gang.bank.withdraw", refId: gangId,
      });
      await tx.gangLog({
        gangId, playerId: player.id, message: `withdrew ${amount} from the gang bank`,
      });

      return { status: 200, body: { bank: next.toString() } };
    });
  },
});
```

- [ ] **Step 8: Append the manifest export**

```ts
export default definePlugin({
  id: "gangs",
  version: "1.0.0",
  basePaths: ["/api/gangs"],
  routes: [
    // Reads
    getGangRoute, gangLogsRoute, gangMembersRoute, myInvitesRoute,
    // Membership + invites
    createGangRoute, inviteRoute, acceptInviteRoute, declineInviteRoute,
    leaveRoute, transferRoute, kickRoute,
    // Permissions
    grantPermissionRoute, revokePermissionRoute,
    // Money
    depositRoute, withdrawRoute,
  ],
  // No `menu`, `pages` or `events`: plugin-manifest-endpoint.test.ts:87
  // asserts a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. No `jobs`: buildApp throws at boot
  // if a core plugin declares any.
});
```

- [ ] **Step 9: Wire the six build/test registration sites**

**9a.** `apps/server/package.json` — insert into `dependencies`, keeping alphabetical order (between `@gl3/plugin-crimes` on line 15 and `@gl3/plugin-mail` on line 16):

```json
    "@gl3/plugin-gangs": "*",
```

Then:

```bash
npm install
```

**9b.** `apps/server/tsconfig.json` — append to `references`, after the `mail` entry:

```json
{ "path": "../../packages/plugins/gangs" }
```

**9c.** root `tsconfig.json` — append to `references`, after the `mail` entry:

```json
    { "path": "./packages/plugins/gangs" },
```

**9d.** `vitest.workspace.ts` — add to the `srcAliases` alias map, beside the other plugin entries:

```ts
      "@gl3/plugin-gangs": fileURLToPath(
        new URL("./packages/plugins/gangs/src/index.ts", import.meta.url),
      ),
```

**9e.** `Dockerfile.server` — five COPY lines, each immediately after the corresponding `mail` line (currently 60, 86, 87, 131, 149; add gangs after each, so `src` and `tsconfig` stay adjacent):

```dockerfile
COPY packages/plugins/gangs/package.json packages/plugins/gangs/
```
```dockerfile
COPY packages/plugins/gangs/tsconfig.json packages/plugins/gangs/tsconfig.json
COPY packages/plugins/gangs/src packages/plugins/gangs/src
```
```dockerfile
COPY packages/plugins/gangs/package.json packages/plugins/gangs/
```
```dockerfile
COPY --from=builder /app/packages/plugins/gangs/dist packages/plugins/gangs/dist
```

- [ ] **Step 10: Verify all five Dockerfile sites and the CI-only tsconfig path**

```bash
grep -c "packages/plugins/gangs" Dockerfile.server
```
Expected: `5`. Any other number means a COPY is missing — a failure that appears **only in CI**.

```bash
npm run typecheck
npx tsc --build --force apps/server/tsconfig.json
```
Expected: both exit 0. The second is the exact command the image build runs.

- [ ] **Step 11: Run the full suite — it must be unchanged**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`, with the **same** file/test totals as Task 1 Step 8. Core still serves `/api/gangs`; the plugin is built but not registered. A changed count here means something unintended was wired — investigate before committing.

- [ ] **Step 12: Commit**

```bash
git add packages/plugins/gangs apps/server/package.json apps/server/tsconfig.json \
        tsconfig.json vitest.workspace.ts Dockerfile.server package-lock.json
git commit -m "feat(plugins): add @gl3/plugin-gangs

All 15 gang routes ported from apps/server/src/game/gangs/routes.ts —
paths, status codes, error strings, response bodies and every gang.* /
notification.created event byte-identical. Seven core-owned table mirrors,
no migrations: core still owns and migrates all of them.

Wired into the build, tsconfig references, vitest srcAliases and the five
Dockerfile COPY sites. NOT yet registered in CORE_PLUGINS — core still
serves these routes and the suite is unchanged. The cutover lands next."
```

---

## Task 3: Cutover — serve gangs from the plugin, delete the core path

Register the plugin, prove it is actually live, then delete core's route file. The 8 gang test files are unchanged throughout and are the whole proof.

**Files:**
- Modify: `apps/server/src/plugins/core-plugins.ts` (import + `CORE_PLUGINS`)
- Modify: `apps/server/src/app.ts:7,58` (delete both)
- Delete: `apps/server/src/game/gangs/routes.ts`
- Modify: `docs/STATUS.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the `gangs` `PluginManifest` default-exported by Task 2.
- Produces: nothing further depends on this task.

---

- [ ] **Step 1: Register the plugin, leaving core's registration in place**

`apps/server/src/plugins/core-plugins.ts` — add the import after the `mailPlugin` line:

```ts
import gangsPlugin from "@gl3/plugin-gangs";
```

and add it to the array:

```ts
export const CORE_PLUGINS: readonly PluginManifest[] = [
  rankPlugin, notificationsPlugin, newsPlugin, bankPlugin, bulletsPlugin, travelPlugin, crimesPlugin,
  mailPlugin, gangsPlugin,
];
```

**Do not touch `app.ts` yet.**

- [ ] **Step 2: Run the red proof — the plugin must collide with core**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npx vitest run apps/server/test/gangs.test.ts
```

Expected: **FAIL at boot** with a Fastify duplicate-route error naming a gang path, e.g.

```
Method 'POST' already declared for route '/api/gangs'
```

This is the proof the plugin is genuinely serving. If the file goes **green**, stop: a dead plugin means core is still answering every request and the cutover would be false. Record the exact error text before proceeding.

- [ ] **Step 3: Delete core's registration**

`apps/server/src/app.ts` — delete line 7:

```ts
import { registerGangRoutes } from "./game/gangs/routes.js";
```

and delete line 58:

```ts
  registerGangRoutes(app, deps.db, deps.redis, requireAuth);
```

- [ ] **Step 4: Delete the core route file**

```bash
git rm apps/server/src/game/gangs/routes.ts
```

`permissions.ts` and `logs.ts` in the same directory **stay** — `apps/server/src/plugins/ctx.ts` imports both.

- [ ] **Step 5: Verify no reference to the deleted file survives**

```bash
grep -rn "game/gangs/routes\|registerGangRoutes" apps/server/src apps/server/test
```
Expected: **no output**.

```bash
grep -rn "game/gangs/permissions\|game/gangs/logs" apps/server/src | head
```
Expected: at least the two `apps/server/src/plugins/ctx.ts` imports — those must survive.

- [ ] **Step 6: Run the green proof across all 8 gang files**

```bash
npx vitest run apps/server/test/gangs.test.ts apps/server/test/gang-bank.test.ts \
  apps/server/test/gang-members.test.ts apps/server/test/gang-ledger.test.ts \
  apps/server/test/gang-lock-order.test.ts apps/server/test/gang-invites.test.ts \
  apps/server/test/gang-membership.test.ts apps/server/test/gang-transfer.test.ts
```

Expected: PASS, every file, with **no edit to any of them**. These were written against core and now pass against the plugin — that is the byte-identical-wire-contract proof.

- [ ] **Step 7: Typecheck, including the CI-only path**

```bash
npm run typecheck
npx tsc --build --force apps/server/tsconfig.json
```
Expected: both exit 0.

- [ ] **Step 8: Run the full suite**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. Read the exit code, not the summary. Record the final file/test totals from `/tmp/verify.log` — Step 9 writes them into `docs/STATUS.md`.

Then run it a second time back-to-back and confirm `exit=0` again. Flaky means broken; load-dependent failures in this repo have always had real causes.

- [ ] **Step 9: Update the docs**

`docs/STATUS.md`:
- Line 3 — stage becomes `M5 stage 10 (gangs port)`.
- M5 milestone row — **nine of nine** module ports shipped; remaining count → zero.
- Suite-count line — the verified figure from Step 8.
- Add a `The gangs port (Plan 10)` section after the mail section, recording: 15 routes ported; `permissions.ts` + `logs.ts` deliberately left in core because `ctx.ts` imports both; one `ctx.transaction` per route with the pre-check/recheck lock distinction preserved; `tx.gangs.hasPermission` added to the SDK; no new lock-order test (`gang-lock-order.test.ts` predates the port and is unchanged); no `economy-invariant.test.ts` edit (`gang-bank.test.ts`'s own 100-op sweep is the proof).
- **Close** the `InsufficientGangFundsError` watch item carried forward from the bank port — this port closes it. The `plugin_job_runs` PK and second-`ctx.transaction` watch items stay open (gangs declares no jobs).
- **Add** a watch item: create-gang's duck-typed unique-violation check tests only `code === "23505"`, not `constraint_name`. `gangs_name_unique` is the sole unique constraint reachable on that insert path today; narrow the check if a second one is ever added to `gangs`.
- **Add** a watch item: `GANG_PERMISSIONS` now exists in three places — `packages/shared/src/dto/gangs.ts`, core `game/gangs/permissions.ts`, and `packages/plugins/gangs/src/index.ts`. The enum-sync test (`gang-members.test.ts:52`) guards shared↔core only; shared↔plugin drift would surface as a `z.enum` mismatch on the PUT/DELETE permission param.

`CLAUDE.md` "Current state" — replace "eight of the twelve `game/*` module ports have shipped … the one remaining port (`gangs`) is unblocked" with: all nine module ports shipped (`ranks`, `notifications`, `news`, `bank`, `bullets`, `travel`, `crimes`, `mail`, `gangs`); M5's module-port track is complete; `profile`, `leaderboard`, `jail` remain deliberate non-ports. Update the suite count to the verified figure.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/plugins/core-plugins.ts apps/server/src/app.ts \
        apps/server/src/game/gangs/routes.ts docs/STATUS.md CLAUDE.md
git commit -m "feat(gangs): cutover — serve gangs from the plugin, delete the core path

CORE_PLUGINS gains gangsPlugin and app.ts loses registerGangRoutes, so all
15 gang routes now answer from @gl3/plugin-gangs. Proven by registering the
plugin first and watching gangs.test.ts fail at boot on a Fastify
duplicate-route error, then deleting core's registration and watching all 8
gang test files pass unedited.

permissions.ts and logs.ts stay in apps/server/src/game/gangs/ — plugins/ctx.ts
imports hasGangPermission and appendGangLog from them.

Completes M5's module-port track: nine of nine."
```

---

## Self-Review

**1. Spec coverage.** Every spec section maps to a task:

| Spec | Task |
|---|---|
| §2 three-commit shape | Tasks 1/2/3 |
| §3.1 `InsufficientGangFundsError` | Task 1 Step 3 |
| §3.2 `tx.gangs.hasPermission` | Task 1 Steps 4, 5c |
| §3.3 wrap `applyGangBalanceChange` | Task 1 Step 5b |
| §3.4 test | Task 1 Steps 1-2, 6 |
| §4.1 seven schema mirrors | Task 2 Step 3 |
| §4.2 restated schemas | Task 2 Step 4 |
| §4.3 translation map | applied throughout Task 2 Steps 5-7 |
| §4.4 one transaction per route | Task 2 Steps 5-7, documented in the file header |
| §4.5 read routes | Task 2 Step 5 |
| §4.6 membership mutations | Task 2 Step 6 |
| §4.7 permission routes | Task 2 Step 7 |
| §4.8 money routes | Task 2 Step 7 |
| §4.9 `tx.notify` collapse | Task 2 Step 6 (invite, transfer) |
| §4.10 postgres error guards | Task 2 Step 4 |
| §5 wire contract | Task 3 Step 6 (the 8 unchanged files) |
| §6 cutover proof | Task 3 Steps 2, 6 |
| §7 lock ordering | Task 2 Steps 6-7; no new test, per spec |
| §8 eight registration sites | Task 2 Step 9 (1-5, 8), Task 3 Steps 1, 3 (6-7) |
| §9 docs | Task 3 Step 9 |

**2. Three deviations from the spec, all deliberate, all recorded here:**

- **Route count is 15, not 14.** Counted from the source; Task 2 implements all 15 and the plan opens with the `grep -c` that proves it.
- **The postgres guards check `error.cause` as well as `error`.** The spec's snippet reads `code` off the thrown object only. Core (`routes.ts:149-161`) explicitly handles both the bare `PostgresError` and an `Error` wrapping one as `cause`. Dropping the `cause` branch would make `gangs.test.ts:46`'s `409 gang_name_taken` fail whenever drizzle wraps.
- **`tx.gangs.hasPermission` narrows with a type guard, not `as GangPermission`.** The spec proposed a cast at the SDK/core seam. `isGangPermission` is behaviour-identical for every valid input (an unknown permission answers `false`, exactly as the query would) and keeps `CLAUDE.md`'s "type guards over casts" intact.

**3. Type consistency.** `InsufficientGangFundsError(gangId, kind)` in Task 1 is caught as `error instanceof InsufficientGangFundsError` in Task 2's withdraw route. `tx.gangs.hasPermission(gangId, playerId, permission)` — three positional strings, `Promise<boolean>` — is defined in Task 1 Step 4 and called with that exact arity in Task 2's invite, kick, grant, revoke and withdraw routes. `removeMember(tx, gangId, playerId, message)` takes `PluginTx` (not `PluginDbTx`) because it calls `tx.gangLog`; `loadGangDto(db, gangId)` takes `PluginDbTx` because it only selects. Both are called with matching types at every site.

**4. No placeholders.** Every code step carries the actual code; every verification step carries the actual command and its expected output.
