# Bullets Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/server/src/game/bullets/` into `packages/plugins/bullets/` (`@gl3/plugin-bullets`) so `POST /api/bullets/buy` answers from a plugin, with every status code, error string, response body and event unchanged.

**Architecture:** One route, one transaction. The plugin mirrors two core-owned tables (`player_stats`, `locations`) in its own `schema.ts` and writes them through `tx.db`; money moves through `tx.economy.applyBalanceChange`; the location row is locked through `tx.locks.location` **before** any player lock. This is the first caller of `tx.locks.location` in the codebase and the first plugin to write a core-owned column no ctx capability covers.

**Tech Stack:** TypeScript strict ESM, Fastify, Drizzle ORM, Postgres, Redis, zod, vitest.

**Design:** `docs/superpowers/specs/2026-08-10-plugin-bullets-port-design.md`. Read it before Task 2.

## Global Constraints

- **No `any` in `packages/*`** — none, not even a cast. Type guards over casts.
- **ESM only.** Every relative import carries a `.js` extension despite `.ts` sources.
- **Money is `bigint`** in Postgres and TypeScript, and crosses the wire as a **decimal string**. Never a JSON number.
- **A plugin package may import only `@gl3/plugin-sdk`, `zod` and `drizzle-orm`.** Never `@gl3/shared`, never anything under `apps/server`. This is the dependency direction M5 exists to enforce.
- **Lock order for a location alongside a player is location first, then player** (`packages/plugin-sdk/src/ctx.ts:150-153`). `tx.economy.applyBalanceChange` takes the player lock *internally*, so no call touching a player row may be hoisted above `tx.locks.location`.
- **Publish events only after the transaction commits.** `tx.events.publishCore` buffers; the loader flushes post-commit and discards on rollback. Never publish inside `db.transaction(...)` by hand.
- **Every balance movement goes through `applyBalanceChange`** — one transaction, one ledger row.
- **Never run `FLUSHALL` / `FLUSHDB`.** Redis is shared across every test file and every concurrent agent.
- **Bigint column defaults are written `` .default(sql`0`) ``**, never `.default(0n)`.
- **Run the full suite with `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"` and treat any non-zero exit as failure even when every test passed.** Piping through `grep`/`tail` discards npm's exit status, and an unhandled rejection makes vitest exit non-zero while still printing a green summary.
- **Never run two full test suites at once.**
- Conventional Commits.

**Environment for every test command:**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
```

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `packages/plugins/bullets/package.json` | Package manifest — `@gl3/plugin-bullets`, deps `@gl3/plugin-sdk`, `zod`, `drizzle-orm` |
| `packages/plugins/bullets/tsconfig.json` | Project reference to `plugin-sdk` |
| `packages/plugins/bullets/src/schema.ts` | Drizzle mirrors of the two core-owned tables. No migration, no manifest `tables` entry |
| `packages/plugins/bullets/src/index.ts` | The manifest and the single route handler |

**Modified:**

| Path | Change | Task |
|---|---|---|
| `apps/server/src/plugins/routes.ts:28-33` | Send `retry-after` on the 423 | 1 |
| `apps/server/test/plugin-routes.test.ts:109-121` | Assert the header | 1 |
| `apps/server/package.json:13` area | `"@gl3/plugin-bullets": "*"` | 2 |
| `apps/server/tsconfig.json:9` | `references` entry. **Fails only in CI** | 2 |
| `tsconfig.json:9` area | `references` entry | 2 |
| `vitest.workspace.ts:36` area | `srcAliases` entry. **Fails nothing** — silently grades src edits against stale `dist/` | 2 |
| `apps/server/test/bullets.test.ts:1-96` | Service block → `callPluginRoute` | 2 |
| `apps/server/src/plugins/core-plugins.ts` | Import + `CORE_PLUGINS` entry | 3 |
| `apps/server/src/app.ts:8,65` | Delete `registerBulletsRoutes` | 3 |
| `apps/server/test/bullets.test.ts:98-154` | `leaderboardPrefix`, `retry-after` and leaderboard assertions | 3 |
| `apps/server/test/economy-invariant.test.ts:12,116,131-139` | → `callPluginRoute` | 3 |
| `Dockerfile.server` | Four COPY sites + comments. **Fails only in CI** | 3 |
| `docs/STATUS.md`, `CLAUDE.md` | Record the port | 4 |

**Deleted (Task 3):** `apps/server/src/game/bullets/routes.ts`, `apps/server/src/game/bullets/service.ts`, and the directory.

---

### Task 1: The loader sends `retry-after` on a 423

Core's bullets route sets `reply.header("retry-after", String(jail.remainingSeconds))` (`apps/server/src/game/bullets/routes.ts:19`) before its 423. The plugin loader's jail gate sends the body but no header, so porting `bullets` would silently drop it. `travel` and `crimes` set the same header and will hit the same gap.

This task lands **before** the port so the loss can never be attributed to the port.

**Files:**
- Modify: `apps/server/src/plugins/routes.ts:28-33`
- Test: `apps/server/test/plugin-routes.test.ts:109-121`

**Interfaces:**
- Consumes: nothing.
- Produces: every plugin route with `accessInJail: false` now answers 423 with a `retry-after` header whose value is `String(jail.remainingSeconds)`. Task 3's `bullets.test.ts` 423 assertion depends on this.

- [ ] **Step 1: Add the failing assertion**

`apps/server/test/plugin-routes.test.ts` already has a test named *"returns the exact core jail response on `accessInJail: false`"* — which is not currently exact. Add one line to it, after line 120:

```ts
  it("returns the exact core jail response on accessInJail: false", async () => {
    const { token, playerId } = await register(app);
    const future = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ jailedUntil: future }).where(eq(playerStats.playerId, playerId));
    const res = await app.inject({
      method: "POST",
      url: "/api/rt/act",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ error: "jailed" });
    expect(typeof res.json().remainingSeconds).toBe("number");
    // Core's own jail-gated routes set this (game/bullets/routes.ts:19,
    // game/travel/routes.ts:42, game/crimes/routes.ts:55). "Exact core jail
    // response" is not exact without it.
    expect(res.headers["retry-after"]).toBe(String(res.json().remainingSeconds));
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/server/test/plugin-routes.test.ts -t "exact core jail response"
```

Expected: FAIL — `expected undefined to be "60"` (or whatever the remaining seconds are). If it passes, stop: the header is already being sent and this task is void.

- [ ] **Step 3: Send the header**

In `apps/server/src/plugins/routes.ts`, inside the `if (jail.jailed)` branch at line 30:

```ts
            if (jail.jailed) {
              // Core's jail-gated routes set this alongside the body
              // (game/bullets/routes.ts:19). A ported module must not lose it.
              reply.header("retry-after", String(jail.remainingSeconds));
              return reply.code(423).send({ error: "jailed", remainingSeconds: jail.remainingSeconds });
            }
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run apps/server/test/plugin-routes.test.ts
```

Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/plugins/routes.ts apps/server/test/plugin-routes.test.ts
git commit -m "fix(plugins): send retry-after on the loader's 423 jail response

Core's jail-gated routes set the header alongside the body; the plugin
loader sent only the body, so porting bullets, travel or crimes would have
silently dropped it. No plugin sets accessInJail: false today, so nothing
else changes behaviour."
```

---

### Task 2: The plugin package, proven against the real handler

Creates `@gl3/plugin-bullets` and converts `bullets.test.ts`'s service-level block to drive it. Core still serves the HTTP route at the end of this task — `callPluginRoute` takes a manifest directly and needs no registration, so the plugin can be fully proven before the cutover. Nothing is deleted here.

**Read first:** `docs/superpowers/specs/2026-08-10-plugin-bullets-port-design.md` §3 (the transaction, step by step) and §3.1 (why lock order is the defining constraint).

**Files:**
- Create: `packages/plugins/bullets/package.json`, `packages/plugins/bullets/tsconfig.json`, `packages/plugins/bullets/src/schema.ts`, `packages/plugins/bullets/src/index.ts`
- Modify: `apps/server/package.json`, `apps/server/tsconfig.json`, `tsconfig.json`, `vitest.workspace.ts`, `apps/server/test/bullets.test.ts:1-96`

**Interfaces:**
- Consumes: `definePlugin`, `route`, `PluginError`, `InsufficientFundsError` from `@gl3/plugin-sdk`; `tx.locks.location(locationId: string): Promise<void>`, `tx.economy.applyBalanceChange(change): Promise<bigint>`, `tx.events.publishCore(event): Promise<void>`, `ctx.player: PlayerSnapshot | null`, `ctx.transaction<T>(fn)`; `callPluginRoute(manifest, method, path, { db, redis, leaderboardPrefix, playerId, body })` from `apps/server/test/helpers/plugin-route.ts`.
- Produces: default export `bulletsPlugin: PluginManifest` from `@gl3/plugin-bullets`, id `"bullets"`, with exactly one route `POST /api/bullets/buy`. Task 3 imports it in `core-plugins.ts` and `economy-invariant.test.ts`.

- [ ] **Step 1: Create the package manifest**

`packages/plugins/bullets/package.json` — note `drizzle-orm` is a dependency here, which `bank`'s package.json does not have (bank has no `schema.ts`); `ranks` and `news` do.

```json
{
  "name": "@gl3/plugin-bullets",
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

Confirm the `drizzle-orm` version matches `packages/plugins/ranks/package.json` exactly; if it differs there, copy that value instead.

- [ ] **Step 2: Create the tsconfig**

`packages/plugins/bullets/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../plugin-sdk" }]
}
```

- [ ] **Step 3: Write the schema mirrors**

`packages/plugins/bullets/src/schema.ts`. Types must match `apps/server/src/db/schema/identity.ts:56` and `content.ts:27` exactly: `bullets` and `bullet_cost` are `bigint`, `bullet_stock` is `integer`. A wrong type here is a serialisation bug, not a compile error.

```ts
import { bigint, integer, pgTable, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of two core-owned tables. Column names and types match
 * `apps/server/src/db/schema/identity.ts` and `content.ts` exactly, which is
 * what lets `tx.db.select` / `tx.db.update` type and serialise correctly.
 * Neither is listed in this plugin's manifest `tables` map and neither gets a
 * migration here: core already owns and migrates both (the pattern
 * `packages/plugins/ranks/src/schema.ts` established — the loader enforces
 * naming and prefix rules only on tables a manifest *declares*).
 *
 * Only the columns this plugin touches are listed. `player_stats` has ~15
 * more; naming them here would be a maintenance burden with no consumer.
 */
export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  bullets: bigint("bullets", { mode: "bigint" }).notNull(),
  locationId: uuid("location_id"),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  bulletStock: integer("bullet_stock").notNull(),
  bulletCost: bigint("bullet_cost", { mode: "bigint" }).notNull(),
});
```

- [ ] **Step 4: Write the plugin**

`packages/plugins/bullets/src/index.ts`. The step numbers in the comments map to design §3's table.

```ts
import { definePlugin, InsufficientFundsError, PluginError, route } from "@gl3/plugin-sdk";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { locations, playerStats } from "./schema.js";

/**
 * Ported from `apps/server/src/game/bullets/routes.ts` and `service.ts`:
 * paths, status codes, error strings, response bodies and the
 * `bullets.purchased` event are byte-identical. `apps/server/test/bullets.test.ts`'s
 * `app.inject` block is the proof.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `BuyBulletsRequestSchema`
 * is restated rather than imported.
 */
const BuyBulletsSchema = z.object({ quantity: z.number().int().positive() });

const buyRoute = route({
  method: "POST",
  path: "/api/bullets/buy",
  // Buying is an action, so it gates on jail — unlike bank, news, ranks and
  // notifications, which all take the `true` default. The loader runs
  // releaseIfExpired and answers 423 + retry-after, exactly as core's route did.
  accessInJail: false,
  body: BuyBulletsSchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { quantity } = body;

    return ctx.transaction(async (tx) => {
      // (1) Unlocked read, preserved verbatim from core (`service.ts:32`). A
      // concurrent travel committing in this window means buying at a location
      // already left. Closing it here would either invert the lock order or
      // smuggle a behaviour change into a port whose proof depends on there
      // being none — see design §6.
      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const locationId = stats?.locationId;
      if (!locationId) throw new PluginError("no_location", 409);

      // (3) LOCATION LOCK FIRST. `tx.economy.applyBalanceChange` below takes
      // the player lock internally, so this line is what keeps the pair in the
      // one order every location↔player path agrees on. Moving any player-row
      // access above it reintroduces SPEC §2.3's deadlock class, and no
      // explicit player lock appears below to hint at it.
      await tx.locks.location(locationId);

      const [location] = await tx.db.select().from(locations).where(eq(locations.id, locationId));
      // (4) The location was deleted out from under a stale reference.
      if (!location) throw new PluginError("no_location", 409);
      // (5) Read under the lock, so two concurrent buyers cannot both pass.
      if (location.bulletStock < quantity) {
        throw new PluginError("insufficient_stock", 409, { available: location.bulletStock });
      }

      // (6) bigint throughout — quantity is an integer, cost is money.
      const cost = location.bulletCost * BigInt(quantity);

      // (7) Takes the player lock. (8) Core's InsufficientFundsError is
      // translated to the SDK's by the ctx; the loader maps only PluginError,
      // so without this catch an overdraft would be a 500.
      let cash: bigint;
      try {
        cash = await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: -cost,
          kind: "cash",
          reason: "bullets.purchase",
          refId: location.id,
        });
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          throw new PluginError("insufficient_funds", 409);
        }
        throw error;
      }

      // (9) The stock value read under the lock at step 4, minus the purchase.
      const bulletStock = location.bulletStock - quantity;
      await tx.db.update(locations).set({ bulletStock }).where(eq(locations.id, location.id));

      // (10) `.returning()` replaces core's post-commit re-read: cash came
      // back from step 7, bullets comes back from here.
      const [fresh] = await tx.db
        .update(playerStats)
        .set({ bullets: sql`${playerStats.bullets} + ${quantity}` })
        .where(eq(playerStats.playerId, player.id))
        .returning({ bullets: playerStats.bullets });
      if (!fresh) throw new PluginError("no_location", 409);

      // (11) Buffered here, published after commit and discarded on rollback.
      // Audience is PRIVATE: a purchase is not broadcast.
      await tx.events.publishCore({
        type: "bullets.purchased",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        locationId,
        quantity,
        cost: cost.toString(),
        cash: cash.toString(),
        bullets: fresh.bullets.toString(),
      });

      // (12) Money crosses the wire as a decimal string, never a JSON number.
      return {
        status: 200,
        body: { cash: cash.toString(), bullets: fresh.bullets.toString(), bulletStock },
      };
    });
  },
});

export default definePlugin({
  id: "bullets",
  version: "1.0.0",
  basePaths: ["/api/bullets"],
  routes: [buyRoute],
  // No `menu`, `pages` or `events`: plugin-manifest-endpoint.test.ts:87
  // asserts a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. No `jobs`: buildApp throws at boot
  // if a core plugin declares any (that path has no queue-name prefix).
});
```

- [ ] **Step 5: Register the package in the four build/test sites**

All four, in one pass. Two of them fail in ways you will not see locally.

1. `apps/server/package.json` — add to `dependencies`, keeping alphabetical order beside `"@gl3/plugin-bank": "*"`:

```json
    "@gl3/plugin-bullets": "*",
```

2. `apps/server/tsconfig.json` — append to `references` (**this one fails only in CI**):

```json
{ "path": "../../packages/plugins/bullets" }
```

3. root `tsconfig.json` — append after the `bank` entry:

```json
    { "path": "./packages/plugins/bullets" },
```

4. `vitest.workspace.ts` — append to `srcAliases` after the `@gl3/plugin-bank` entry (**this one fails nothing**; without it, the specifier resolves to the gitignored `dist/` and a src-only edit is graded against a stale `tsc --build`):

```ts
      "@gl3/plugin-bullets": fileURLToPath(
        new URL("./packages/plugins/bullets/src/index.ts", import.meta.url),
      ),
```

Then install:

```bash
npm install
```

- [ ] **Step 6: Verify both silent failure modes are actually closed**

```bash
npx tsc --build --force apps/server/tsconfig.json
```

Expected: exits 0. This is the exact command the image build runs and the only local way to catch a missing `apps/server/tsconfig.json` reference.

- [ ] **Step 7: Convert `bullets.test.ts`'s service block to the plugin**

Replace `apps/server/test/bullets.test.ts` lines 1-96 — the imports and the whole `describe("performBulletsPurchase")` block. Lines 98-154 (`describe("POST /api/bullets/buy")`) are **untouched in this task**; Task 3 handles them.

Two things change in every test: the call becomes `callPluginRoute`, and `instanceof` assertions become code assertions on the `PluginError` the handler throws.

```ts
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import bulletsPlugin from "@gl3/plugin-bullets";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats, transactions } from "../src/db/schema/index.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { callPluginRoute } from "./helpers/plugin-route.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let playerId: string;
let locationId: string;

// Required, never defaulted: an omitted prefix means the production
// `leaderboard:*` keys, which every concurrent test file and agent shares.
// The ctx buffers a cash leaderboard write on every applyBalanceChange
// (design §4.2), so this file now writes them where core's service did not.
const leaderboardPrefix = `bullets-test-${uuidv7()}`;

const buy = (forPlayerId: string, quantity: number) =>
  callPluginRoute(bulletsPlugin, "POST", "/api/bullets/buy", {
    db, redis, leaderboardPrefix, playerId: forPlayerId, body: { quantity },
  });

beforeEach(async () => {
  await resetDb(db);
  locationId = uuidv7();
  await db.insert(locations).values({ id: locationId, name: "Testville", bulletStock: 10, bulletCost: 5n });
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n, locationId });
});
afterAll(async () => {
  // Targeted DELs, never FLUSHDB — Redis is shared with every other test file.
  await redis.del(`${leaderboardPrefix}:cash`);
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("the bullets plugin handler", () => {
  it("debits cash, credits bullets, decrements shared stock, and publishes bullets.purchased", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    // `game:events` is a global channel shared by every test file running in
    // parallel (e.g. travel.test.ts also publishes on it) — a bare
    // `once("message")` resolves on whichever file's event lands first and
    // can grab someone else's payload. Filter on this test's own actor.
    const received = awaitOwnEvent(subscriber, playerId);

    const result = await buy(playerId, 4);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ cash: "980", bullets: "4", bulletStock: 6 });

    const event = await received;
    expect(event.type).toBe("bullets.purchased");
    if (event.type !== "bullets.purchased") throw new Error("unreachable");
    expect(event.quantity).toBe(4);
    expect(event.cost).toBe("20");
  });

  it("rejects a player with no location", async () => {
    await db.update(playerStats).set({ locationId: null }).where(eq(playerStats.playerId, playerId));
    // The wire contract, not an internal class name: NoLocationError was
    // deleted with game/bullets/ and `no_location` is what a client sees.
    await expect(buy(playerId, 1)).rejects.toMatchObject({ code: "no_location", status: 409 });
  });

  it("rejects buying more than the location has in stock, and reports what is available", async () => {
    await expect(buy(playerId, 11)).rejects.toMatchObject({
      code: "insufficient_stock", status: 409, extra: { available: 10 },
    });
  });

  it("rejects a purchase the player can't afford", async () => {
    await db.update(playerStats).set({ cash: 1n }).where(eq(playerStats.playerId, playerId));
    await expect(buy(playerId, 1)).rejects.toMatchObject({ code: "insufficient_funds", status: 409 });

    // No ledger row and no stock change — a rejected purchase must leave no trace.
    const rows = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    expect(rows).toHaveLength(0);
    const [loc] = await db.select({ bulletStock: locations.bulletStock }).from(locations).where(eq(locations.id, locationId));
    expect(loc?.bulletStock).toBe(10);
  });

  // --- The defining risk of this task: two players buying simultaneously
  // against a shared stock of 1 must never both succeed (lost update /
  // oversell). This is the ONLY proof that tx.locks.location does its job,
  // and it has no HTTP equivalent.
  it("under concurrent purchase against a stock of 1, lets exactly one buyer succeed and never goes negative", async () => {
    await db.update(locations).set({ bulletStock: 1 }).where(eq(locations.id, locationId));

    const otherPlayerId = uuidv7();
    await db.insert(players).values({ id: otherPlayerId, username: `q${Date.now()}` });
    await db.insert(playerStats).values({ playerId: otherPlayerId, cash: 1000n, locationId });

    const results = await Promise.allSettled([buy(playerId, 1), buy(otherPlayerId, 1)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "insufficient_stock", status: 409 });
    expect(fulfilled[0]).toMatchObject({ value: { body: { bulletStock: 0 } } });

    const [loc] = await db.select({ bulletStock: locations.bulletStock }).from(locations).where(eq(locations.id, locationId));
    expect(loc?.bulletStock).toBe(0); // never negative

    const rows = await db.select().from(transactions).where(eq(transactions.reason, "bullets.purchase"));
    expect(rows).toHaveLength(1); // exactly one ledger row across both attempts
  });
});
```

- [ ] **Step 8: Run the file**

```bash
npx vitest run apps/server/test/bullets.test.ts
```

Expected: PASS, all six tests — the five converted plus the untouched HTTP block, which still exercises core's route at this point.

- [ ] **Step 9: Prove the concurrency test can fail**

A green concurrency test that has never been shown red proves nothing. Temporarily comment out the `await tx.locks.location(locationId);` line in `packages/plugins/bullets/src/index.ts` and re-run:

```bash
npx vitest run apps/server/test/bullets.test.ts -t "under concurrent purchase"
```

Expected: FAIL — both buyers succeed, or the final stock is `-1` (`expected 2 to have length 1`, or `expected -1 to be 0`). If it still passes, the test is not exercising the lock and must be fixed before proceeding.

**Restore the line.** Re-run and confirm PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/plugins/bullets apps/server/package.json apps/server/tsconfig.json \
  tsconfig.json vitest.workspace.ts package-lock.json apps/server/test/bullets.test.ts
git commit -m "feat(plugins): add @gl3/plugin-bullets

Ports game/bullets' purchase transaction to the SDK: location lock through
tx.locks.location (its first caller) before the player lock applyBalanceChange
takes internally, mirrored schemas for the two core-owned tables it writes,
and bullets.purchased through publishCore. bullets.test.ts's service-level
block now drives the real handler via callPluginRoute.

Core still serves POST /api/bullets/buy; the cutover is the next commit."
```

---

### Task 3: Cut over — the plugin serves the route, core's module is deleted

**Files:**
- Modify: `apps/server/src/plugins/core-plugins.ts`, `apps/server/src/app.ts:8,65`, `apps/server/test/bullets.test.ts:98-154`, `apps/server/test/economy-invariant.test.ts`, `Dockerfile.server`
- Delete: `apps/server/src/game/bullets/routes.ts`, `apps/server/src/game/bullets/service.ts`

**Interfaces:**
- Consumes: `bulletsPlugin` (default export of `@gl3/plugin-bullets`) from Task 2; the `retry-after` header from Task 1.
- Produces: `POST /api/bullets/buy` served by the plugin. `NoLocationError` and `InsufficientStockError` no longer exist anywhere.

- [ ] **Step 1: Register the plugin as a core plugin**

`apps/server/src/plugins/core-plugins.ts` — add the import beside the others and extend the array:

```ts
import bankPlugin from "@gl3/plugin-bank";
import bulletsPlugin from "@gl3/plugin-bullets";
import newsPlugin from "@gl3/plugin-news";
import notificationsPlugin from "@gl3/plugin-notifications";
import rankPlugin from "@gl3/plugin-ranks";
```

```ts
export const CORE_PLUGINS: readonly PluginManifest[] = [
  rankPlugin, notificationsPlugin, newsPlugin, bankPlugin, bulletsPlugin,
];
```

- [ ] **Step 2: Unregister core's route**

`apps/server/src/app.ts` — delete line 8 (`import { registerBulletsRoutes } from "./game/bullets/routes.js";`) and line 65 (`registerBulletsRoutes(app, deps.db, deps.redis, requireAuth);`). Leaving either in place produces a Fastify duplicate-route error at boot, so this is not optional.

- [ ] **Step 3: Delete core's module**

```bash
git rm apps/server/src/game/bullets/routes.ts apps/server/src/game/bullets/service.ts
```

- [ ] **Step 4: Update the HTTP block's boot and add the two new assertions**

In `apps/server/test/bullets.test.ts`, inside `describe("POST /api/bullets/buy")`:

**(a)** The `buildApp` call at line 114 currently passes no `leaderboardPrefix`, so it uses `DEFAULT_LEADERBOARD_PREFIX` — the production global `leaderboard:*` keys every concurrent agent shares. Harmless while core's service never recorded a score; **not** harmless now that the ctx buffers one. Pass the file's prefix:

```ts
    const app = await buildApp(config, {
      db, redis, crimeQueue: createCrimeQueue(createRedis(config.redisUrl)), leaderboardPrefix,
    });
```

**(b)** After the happy-path assertion at line 112, prove the leaderboard effect from design §4.2 rather than leaving it incidental:

```ts
    const buy = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 3 } });
    expect(buy.statusCode).toBe(200);
    expect(buy.json()).toEqual({ cash: "985", bullets: "3", bulletStock: 7 });

    // Design §4.2: core's bullets service never called recordScore, but the
    // ctx buffers one leaderboard write per changed kind and flushes it after
    // commit. A deliberate divergence, asserted so it stays proven.
    expect(await redis.zscore(`${leaderboardPrefix}:cash`, registeredId)).toBe("985");
```

**(c)** At the 423 assertion (line 146), add the header Task 1 made possible:

```ts
    const jailed = await app.inject({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 1 } });
    expect(jailed.statusCode).toBe(423);
    expect(jailed.json()).toMatchObject({ error: "jailed" });
    expect(jailed.headers["retry-after"]).toBe(String(jailed.json().remainingSeconds));
```

Everything else in the block — the three 400 shapes, `no_location`, `insufficient_stock`, `insufficient_funds`, the 401 — stays **byte-for-byte unchanged**. That is what makes it proof.

- [ ] **Step 5: Run the file against the plugin-served route**

```bash
npx vitest run apps/server/test/bullets.test.ts
```

Expected: PASS. This is the moment the port is proven: the HTTP block was written against core and now passes against the plugin.

- [ ] **Step 6: Convert `economy-invariant.test.ts`**

Three edits. First, line 12 — delete the import of the two deleted classes and add the plugin:

```ts
import bankPlugin from "@gl3/plugin-bank";
import bulletsPlugin from "@gl3/plugin-bullets";
```

Second, the `bullets` branch at lines 114-116:

```ts
        } else if (opName === "bullets") {
          const quantity = 1 + Math.floor(rand() * 5);
          // bullets is a plugin now; this drives its real route handler, so
          // the 1000-op sum(ledger) == balance sweep still covers its actual
          // code path.
          await callPluginRoute(bulletsPlugin, "POST", "/api/bullets/buy", {
            db, redis, leaderboardPrefix, playerId, body: { quantity },
          });
```

Third, the expected-rejection filter at lines 131-139. `InsufficientStockError` and `NoLocationError` are gone; both arrive as `PluginError` now:

```ts
        if (
          err instanceof InsufficientFundsError || err instanceof AlreadyAtLocationError ||
          err instanceof LocationNotFoundError ||
          // bank and bullets are plugins now: their expected rejections arrive
          // as the PluginError their handlers throw, not as core classes.
          // travel and crimes are still core and still throw core classes.
          (err instanceof PluginError &&
            (err.code === "insufficient_funds" || err.code === "insufficient_stock" ||
             err.code === "no_location"))
        ) continue;
```

- [ ] **Step 7: Run the invariant sweep**

```bash
npx vitest run apps/server/test/economy-invariant.test.ts
```

Expected: PASS. If `succeeded.bullets` is 0, the conversion silently broke the op — the filter is swallowing a real error. Check the counters the file already tracks before accepting a green run.

- [ ] **Step 8: Update `Dockerfile.server` — four COPY sites and the comments**

**This fails only in CI**, and each Dockerfile change costs a full CI round trip. Get all four in one pass, each immediately after its `bank` neighbour:

```dockerfile
# after :51
COPY packages/plugins/bullets/package.json packages/plugins/bullets/
```
```dockerfile
# after :70
COPY packages/plugins/bullets/tsconfig.json packages/plugins/bullets/tsconfig.json
COPY packages/plugins/bullets/src packages/plugins/bullets/src
```
```dockerfile
# after :106
COPY packages/plugins/bullets/package.json packages/plugins/bullets/
```
```dockerfile
# after :120
COPY --from=builder /app/packages/plugins/bullets/dist packages/plugins/bullets/dist
```

Then add `@gl3/plugin-bullets` to the four comment blocks that enumerate the plugin packages, at lines 7, 15-16, 19 and 98.

Verify the count before committing — four `COPY` lines mentioning `packages/plugins/bullets` must exist:

```bash
grep -c "packages/plugins/bullets" Dockerfile.server
```

Expected: `5` (four COPY lines plus one `--from=builder`, matching whatever `grep -c "packages/plugins/bank" Dockerfile.server` reports).

- [ ] **Step 9: Full verification**

```bash
npx tsc --build --force apps/server/tsconfig.json
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. **Read the exit code, not the summary** — an unhandled rejection makes vitest exit non-zero while still printing a green test count. If non-zero, treat it as failure even if every test passed, and find the rejection in `/tmp/verify.log`.

Test count should be 574 or higher; note the actual figure for Task 4.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(plugins): serve POST /api/bullets/buy from @gl3/plugin-bullets

Registers bullets in CORE_PLUGINS, unregisters core's route and deletes
apps/server/src/game/bullets/. bullets.test.ts's app.inject block is unchanged
except for two additions it now proves: the retry-after header on the 423, and
the cash leaderboard write the ctx buffers where core's service recorded none.
economy-invariant.test.ts's 1000-op sweep drives the plugin handler."
```

---

### Task 4: Record what shipped

**Files:**
- Modify: `docs/STATUS.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the verified test count from Task 3 Step 9.
- Produces: nothing code depends on.

- [ ] **Step 1: Fix the stale branch line in `docs/STATUS.md`**

Line 4 reads `Branch: feat/plugin-core-events (forked from main at 102079c)`, which no longer describes the tree — the bank port landed on `main`. Replace with the current branch, and update line 3's date and stage.

- [ ] **Step 2: Add a `bullets` port section to `docs/STATUS.md`**

After the "The `bank` port (Plan 5)" section, mirroring its shape. Cover:

- `bullets` ported to `packages/plugins/bullets`; `apps/server/src/game/bullets/` no longer exists; `bullets.test.ts`'s `app.inject` block is the proof and is unchanged bar two additions.
- **First caller of `tx.locks.location`** — the location→player order is now exercised, not just documented. The concurrency test (stock of 1, two buyers) was demonstrated failing with the lock removed.
- **First plugin to write a core-owned column no ctx capability covers** (`player_stats.bullets`, `locations.bullet_stock`), via mirrored schemas. State the consequence plainly: schema isolation is compiler-enforced for relational queries (`PluginDbTx` omits `query`) and for money (`applyBalanceChange`), and is convention for everything else.
- **The loader now sends `retry-after` on its 423** — core's jail-gated routes always did; the loader did not. `travel` and `crimes` inherit the fix.
- **The cash leaderboard now updates on a purchase**, where core's service recorded no score. No opt-out, deliberately: a suppression flag would exist only to preserve a core inconsistency.
- Update the milestone table row for M5 and the suite count.
- Four ports remain: `travel`, `crimes`, `mail`, `gangs`. `travel` is next and owns the other side of the §6 race.

- [ ] **Step 3: Add two watch items to `docs/STATUS.md`**

Under "Known issues and watch items → Open, deliberately deferred":

- **The bullets purchase reads `player_stats.location_id` unlocked.** A `travel` committing between that read and the location lock means buying at a location already left. Inherited verbatim from core (`game/bullets/service.ts:32` before the port). `travel` owns the other half and is the natural place to close it.
- **`bank.test.ts`'s `app.inject` block boots `buildApp` with no `leaderboardPrefix`**, so its ctx-buffered leaderboard writes land in the production global `leaderboard:*` keys that every concurrent test file and agent shares. Nothing reads those keys in tests, so it is dirty rather than broken. `bullets.test.ts` passes a prefix; `bank.test.ts` should too.

- [ ] **Step 4: Update `CLAUDE.md`'s "Current state"**

Change "four of the twelve `game/*` module ports have shipped (`ranks`, `notifications`, `news`, `bank`)" to five including `bullets`, list the four remaining as `travel`, `crimes`, `mail`, `gangs`, and update the suite count to the verified figure.

- [ ] **Step 5: Commit**

```bash
git add docs/STATUS.md CLAUDE.md
git commit -m "docs: record the bullets port, the loader retry-after fix and two watch items"
```

---

## Notes for the reviewer

Three things worth checking that a passing suite does not prove:

1. **The location lock precedes every player-row access.** `tx.economy.applyBalanceChange` takes the player lock internally, so the ordering constraint is invisible at the call site. Read Task 2 Step 4's handler top to bottom and confirm nothing touching a player row sits above `await tx.locks.location(...)`.
2. **The concurrency test was shown red.** Task 2 Step 9 requires it. A green oversell test that has never failed proves nothing about the lock.
3. **`grep -c "packages/plugins/bullets" Dockerfile.server` matches the `bank` count.** A missing COPY fails only in CI, one round trip per attempt.
