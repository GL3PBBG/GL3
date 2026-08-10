# `@gl3/plugin-travel` Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/server/src/game/travel/` into `packages/plugins/travel/`, and in doing so close the location↔player lock-order defect that the `bullets` port recorded and deferred.

**Architecture:** Travel locks the source and destination `locations` rows (ascending UUID) before the player row, inverting core's player-first order so every path in the game agrees on *locations before players*. Because the source id must be known before it can be locked, an unlocked pre-read chooses which rows to lock and a re-read under the player lock validates the choice, retrying the transaction (max 3) if the player moved in between.

**Tech Stack:** TypeScript strict (ESM, `.js` import extensions), Fastify, drizzle-orm, Postgres 16, Redis 7, zod, vitest.

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include this section.

- **No `any` in `packages/*`** — none, not even a cast. `unknown` + zod in `apps/*`.
- ESM only; relative imports carry a `.js` extension despite `.ts` sources.
- Zod-validates every external boundary, **including route params**.
- Money is `bigint` in Postgres and TypeScript, crosses the wire as a **decimal string**. Never a JSON number.
- Bigint column defaults are written `` .default(sql`0`) ``, never `.default(0n)`.
- Every balance movement goes through `applyBalanceChange` / `tx.economy.applyBalanceChange`.
- Publish events only after commit — the ctx buffers, so use `tx.events.publishCore`.
- Tests asserting on `game:events` filter by their own `actorId` via `awaitOwnEvent()`.
- Integration tests run against **real** Postgres and Redis. No mocks for DB, queue or bus paths.
- **Never run `FLUSHALL` / `FLUSHDB`.** Targeted `DEL` only.
- **Never run two full test suites at once.**
- Verification is `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"` — **read the exit code, not the summary.**
- Conventional Commits.

Environment for every command:

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
```

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `packages/plugins/travel/package.json` | Workspace manifest for `@gl3/plugin-travel` |
| `packages/plugins/travel/tsconfig.json` | Project reference to `plugin-sdk` |
| `packages/plugins/travel/src/schema.ts` | Read/write mirrors of core's `locations` and `player_stats` columns this plugin touches |
| `packages/plugins/travel/src/index.ts` | Both routes, the lock protocol, the retry loop, the manifest |
| `apps/server/test/travel-lock-order.test.ts` | Deadlock regression (raw adversary vs real travel) + companion concurrency test |

**Modified**

| Path | Change |
|---|---|
| `apps/server/src/economy/ledger.ts` | Add `lockLocationsForUpdate`; rewrite `lockLocationForUpdate`'s doc comment |
| `packages/plugin-sdk/src/ctx.ts` | Add `locks.locations` to `PluginTx`; rewrite the lock-contract doc comment |
| `packages/plugin-sdk/src/errors.ts` | `PluginError` gains an optional `headers` argument |
| `apps/server/src/plugins/ctx.ts` | Wire `locks.locations` |
| `apps/server/src/plugins/routes.ts` | Apply `PluginError.headers` before `send` |
| `apps/server/src/plugins/core-plugins.ts` | Register `travelPlugin` |
| `apps/server/src/app.ts` | Delete the core travel registration (`:15`, `:70`) |
| `apps/server/package.json`, root + server `tsconfig.json`, `vitest.workspace.ts`, `Dockerfile.server` | Registration sites |
| `apps/server/test/travel.test.ts` | Drive the plugin instead of the deleted `performTravel` |
| `apps/server/test/economy-invariant.test.ts` | Same, plus a travel coverage assertion |
| `packages/plugins/bullets/src/index.ts` | Rewrite the deadlock comment at `:42-56` |
| `docs/STATUS.md`, `CLAUDE.md` | Record the closed watch items and the settled rule |

**Deleted**

| Path | Why |
|---|---|
| `apps/server/src/game/travel/service.ts`, `routes.ts` | Replaced by the plugin |

---

### Task 1: `locks.locations` — lock several location rows in a fixed order

**Files:**
- Modify: `apps/server/src/economy/ledger.ts` (add after `lockLocationForUpdate`, ~line 100)
- Modify: `packages/plugin-sdk/src/ctx.ts:157-161`
- Modify: `apps/server/src/plugins/ctx.ts:155-159`
- Test: `apps/server/test/plugin-ctx-port-prereqs.test.ts`

**Interfaces:**
- Produces: `lockLocationsForUpdate(tx: Tx, locationIds: readonly (string | null)[]): Promise<void>` in `economy/ledger.ts`, and `tx.locks.locations(locationIds: readonly (string | null)[]): Promise<void>` on `PluginTx`. Task 3 calls the latter. `null` entries are dropped (the player's first-ever travel has no source); duplicates are deduped; the rest are locked ascending by id.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/plugin-ctx-port-prereqs.test.ts`, following the `tx.locks.location` block at `:32`:

```ts
describe("tx.locks.locations", () => {
  it("locks several rows, drops nulls, dedupes, and is a no-op when nothing is left", async () => {
    const a = uuidv7();
    const b = uuidv7();
    await db.insert(locations).values([
      { id: a, name: "Alpha", bulletStock: 1, bulletCost: 1n },
      { id: b, name: "Beta", bulletStock: 1, bulletCost: 1n },
    ]);

    // Descending input: the helper must still lock ascending.
    const [hi, lo] = a < b ? [b, a] : [a, b];
    await db.transaction(async (tx) => {
      await lockLocationsForUpdate(tx, [hi, lo, hi, null]);
    });

    // A null-only call must not throw and must not emit a statement that
    // would lock the whole table.
    await db.transaction(async (tx) => {
      await lockLocationsForUpdate(tx, [null]);
    });

    // The rows are untouched and still readable afterwards.
    const rows = await db.select({ id: locations.id }).from(locations);
    expect(rows).toHaveLength(2);
  });

  it("actually blocks a competing FOR UPDATE on one of the rows", async () => {
    const id = uuidv7();
    await db.insert(locations).values({ id, name: "Contended", bulletStock: 1, bulletCost: 1n });

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    try {
      await t0`BEGIN`;
      await t0`SELECT id FROM locations WHERE id = ${id}::uuid FOR UPDATE`;

      let locked = false;
      const contender = db.transaction(async (tx) => {
        await lockLocationsForUpdate(tx, [id]);
        locked = true;
      });

      await new Promise((resolve) => { setTimeout(resolve, 200); });
      expect(locked).toBe(false); // still parked on t0's lock

      await t0`ROLLBACK`;
      await contender;
      expect(locked).toBe(true);
    } finally {
      t0.release();
      await blocker.end();
    }
  });
});
```

Add the imports this needs at the top of the file if absent: `import postgres from "postgres";`, `import { loadConfig } from "../src/config.js";`, and `lockLocationsForUpdate` from `../src/economy/ledger.js`.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project @gl3/server test/plugin-ctx-port-prereqs.test.ts
```
Expected: FAIL — `lockLocationsForUpdate` is not exported.

- [ ] **Step 3: Add the helper**

In `apps/server/src/economy/ledger.ts`, immediately after `lockLocationForUpdate`:

```ts
/**
 * Locks several `locations` rows in one fixed order — ascending id — so two
 * transactions that need overlapping sets can never take them in opposite
 * orders. `travel` needs this: it locks the source and destination rows
 * together (`packages/plugins/travel/src/index.ts`), and picking the order
 * per-call would reintroduce the location↔location half of SPEC §2.3's
 * deadlock class.
 *
 * `null` entries are dropped rather than rejected: a player's first-ever
 * travel has no source location. An empty result is a no-op — deliberately
 * NOT a `WHERE id = ANY('{}')`, which would still plan a scan.
 *
 * One statement per row, not a single `WHERE id IN (...) ORDER BY id FOR
 * UPDATE`. The single-statement form relies on the planner putting LockRows
 * above Sort to get the lock order right; a loop over sorted ids depends on
 * nothing. Two rows per travel makes the extra round trip irrelevant.
 */
export async function lockLocationsForUpdate(
  tx: Tx,
  locationIds: readonly (string | null)[],
): Promise<void> {
  const ids = [...new Set(locationIds.filter((id): id is string => id !== null))].sort();
  for (const id of ids) {
    await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, id)).for("update");
  }
}
```

- [ ] **Step 4: Declare it on the SDK and wire the ctx**

In `packages/plugin-sdk/src/ctx.ts`, add to the `locks` block (keeping `location`):

```ts
  readonly locks: {
    player(playerIds: string[]): Promise<void>;
    gangAndPlayer(gangId: string, playerId: string): Promise<void>;
    location(locationId: string): Promise<void>;
    locations(locationIds: readonly (string | null)[]): Promise<void>;
  };
```

In `apps/server/src/plugins/ctx.ts`, add to the `locks` object literal and to the import from `../economy/ledger.js`:

```ts
            locations: (locationIds) => lockLocationsForUpdate(tx, locationIds),
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server test/plugin-ctx-port-prereqs.test.ts
```
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add apps/server/src/economy/ledger.ts packages/plugin-sdk/src/ctx.ts \
        apps/server/src/plugins/ctx.ts apps/server/test/plugin-ctx-port-prereqs.test.ts
git commit -m "feat(plugin-sdk): add tx.locks.locations for multi-row location locking"
```

---

### Task 2: `PluginError` headers

**Files:**
- Modify: `packages/plugin-sdk/src/errors.ts:9-18`
- Modify: `apps/server/src/plugins/routes.ts:58-63`
- Test: `apps/server/test/plugin-routes.test.ts`

**Interfaces:**
- Produces: `new PluginError(code, status, extra?, headers?)`. `headers` defaults to `{}`. The loader applies each entry with `reply.header(name, value)` before `send`. Task 3 uses it for `retry-after` on 429.

- [ ] **Step 1: Write the failing test**

This file boots one app in `beforeAll` from the module-level `testPlugin`
(`:77`, `bootTestServer({ plugins: [testPlugin] })`), so add a route to that
manifest rather than booting a second app.

In the `routes: [...]` array of `testPlugin` (`apps/server/test/plugin-routes.test.ts:22`), add:

```ts
    route({
      method: "GET",
      path: "/api/rt/hdr",
      auth: "public",
      handler: async () => {
        throw new PluginError("on_cooldown", 429, { retryAfter: 42 }, { "retry-after": "42" });
      },
    }),
```

And append a test in the same style as the existing route-mapping ones:

```ts
it("applies PluginError headers to the response alongside the body", async () => {
  const res = await app.inject({ method: "GET", url: "/api/rt/hdr" });

  expect(res.statusCode).toBe(429);
  expect(res.json()).toEqual({ error: "on_cooldown", retryAfter: 42 });
  expect(res.headers["retry-after"]).toBe("42");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project @gl3/server test/plugin-routes.test.ts
```
Expected: FAIL — a 4-argument `PluginError` constructor does not exist (TypeScript error), or the header is `undefined`.

- [ ] **Step 3: Add the constructor argument**

In `packages/plugin-sdk/src/errors.ts`, extend `PluginError` and its doc comment:

```ts
/**
 * The only error type a plugin route handler is expected to throw. The loader
 * maps it to `reply.code(status).send({ error: code, ...extra })`, which is how
 * ported modules keep their existing status codes and error strings byte for
 * byte (spec: "M5 changes no HTTP response").
 *
 * `headers` exists because a status line is not always the whole response:
 * core's travel route answers 429 with a `retry-after` header alongside the
 * body (`game/travel/routes.ts` before the port). The loader sets the 423
 * jail header itself; everything else a handler needs goes here.
 */
export class PluginError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
    this.name = "PluginError";
  }
}
```

- [ ] **Step 4: Apply them in the loader**

In `apps/server/src/plugins/routes.ts`, replace the `catch` body:

```ts
          } catch (error) {
            if (error instanceof PluginError) {
              for (const [name, value] of Object.entries(error.headers)) {
                reply.header(name, value);
              }
              return reply.code(error.status).send({ error: error.code, ...error.extra });
            }
            throw error;
          }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server test/plugin-routes.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add packages/plugin-sdk/src/errors.ts apps/server/src/plugins/routes.ts \
        apps/server/test/plugin-routes.test.ts
git commit -m "feat(plugin-sdk): let PluginError carry response headers"
```

---

### Task 3: The `@gl3/plugin-travel` package

Not yet registered in `core-plugins.ts` — core still serves the HTTP routes, so nothing conflicts. Tests here drive the handlers through `callPluginRoute`, which needs no Fastify boot.

**Files:**
- Create: `packages/plugins/travel/package.json`, `packages/plugins/travel/tsconfig.json`, `packages/plugins/travel/src/schema.ts`, `packages/plugins/travel/src/index.ts`
- Modify: `apps/server/package.json:12-17`, `apps/server/tsconfig.json` (references), `tsconfig.json` (references), `vitest.workspace.ts:39-41` (after the `@gl3/plugin-bullets` alias), `Dockerfile.server:54,74,75,112,127`
- Test: `apps/server/test/travel-plugin.test.ts` (new, temporary home for handler-level tests; Task 4 folds it into `travel.test.ts`)

**Interfaces:**
- Consumes: `tx.locks.locations` (Task 1), `PluginError` headers (Task 2).
- Produces: default export `travelPlugin` (a `PluginManifest`, id `travel`) from `@gl3/plugin-travel`, with routes `GET /api/locations` and `POST /api/travel/:locationId`. Task 4 imports it in `core-plugins.ts`; Task 5 imports it in the lock-order test.

- [ ] **Step 1: Scaffold the package**

`packages/plugins/travel/package.json`:

```json
{
  "name": "@gl3/plugin-travel",
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

`packages/plugins/travel/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../plugin-sdk" }]
}
```

`packages/plugins/travel/src/schema.ts`:

```ts
import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of two core-owned tables, same pattern as
 * `packages/plugins/bullets/src/schema.ts`: column names and types match
 * `apps/server/src/db/schema/identity.ts` and `content.ts` exactly, neither
 * table is declared in this plugin's manifest, and neither gets a migration
 * here — core already owns and migrates both.
 *
 * `bullet_stock` and `bullet_cost` are listed because `GET /api/locations`
 * returns them (core's `game/travel/routes.ts` did), not because this plugin
 * writes them. It never does; `bullets` owns those columns.
 */
export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  cash: bigint("cash", { mode: "bigint" }).notNull(),
  locationId: uuid("location_id"),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  travelCost: bigint("travel_cost", { mode: "bigint" }).notNull(),
  travelCooldownSeconds: integer("travel_cooldown_seconds").notNull(),
  bulletStock: integer("bullet_stock").notNull(),
  bulletCost: bigint("bullet_cost", { mode: "bigint" }).notNull(),
});
```

Before writing this file, open `apps/server/src/db/schema/identity.ts` and `content.ts` and confirm each column name and type matches. A mismatch here fails at runtime, not at compile time.

- [ ] **Step 2: Write the failing test**

`apps/server/test/travel-plugin.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import travelPlugin from "@gl3/plugin-travel";
import { PluginError } from "@gl3/plugin-sdk";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";
import { callPluginRoute } from "./helpers/plugin-route.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
const leaderboardPrefix = `travel-test-${uuidv7()}`;

let playerId: string;
let chicagoId: string;
let miamiId: string;

const travel = (toLocationId: string) =>
  callPluginRoute(travelPlugin, "POST", "/api/travel/:locationId", {
    db, redis, leaderboardPrefix, playerId, params: { locationId: toLocationId },
  });

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n });

  chicagoId = uuidv7();
  miamiId = uuidv7();
  await db.insert(locations).values([
    { id: chicagoId, name: "Chicago", travelCost: 100n, travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n },
    { id: miamiId, name: "Miami", travelCost: 250n, travelCooldownSeconds: 120, bulletStock: 300, bulletCost: 8n },
  ]);
  await redis.del(cooldownKey(playerId, "travel"));
});

afterAll(async () => {
  await redis.del(`${leaderboardPrefix}:cash`, `${leaderboardPrefix}:bank`, `${leaderboardPrefix}:exp`);
  await conn.end();
  redis.disconnect();
  subscriber.disconnect();
});

describe("POST /api/travel/:locationId", () => {
  it("debits the fare, moves the player, and publishes player.travelled with a null fromLocationId the first time", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    // `game:events` is global across test files — filter on this test's actor
    // (CLAUDE.md rule 4).
    const received = awaitOwnEvent(subscriber, playerId);

    const result = await travel(chicagoId);
    expect(result).toEqual({ status: 200, body: { locationId: chicagoId, cash: "900" } });

    const event = await received;
    expect(event.type).toBe("player.travelled");
    if (event.type !== "player.travelled") throw new Error("unreachable");
    expect(event.fromLocationId).toBeNull();
    expect(event.toLocationId).toBe(chicagoId);
    expect(event.cost).toBe("100");
  });

  it("rejects travelling to the player's current location", async () => {
    await travel(chicagoId);
    await redis.del(cooldownKey(playerId, "travel"));
    await expect(travel(chicagoId)).rejects.toMatchObject({ code: "already_there", status: 409 });
  });

  it("rejects an unknown location", async () => {
    await expect(travel(uuidv7())).rejects.toMatchObject({ code: "location_not_found", status: 404 });
  });

  it("rejects a fare the player can't afford and leaves them in place", async () => {
    await db.update(playerStats).set({ cash: 50n }).where(eq(playerStats.playerId, playerId));
    await expect(travel(miamiId)).rejects.toMatchObject({ code: "insufficient_funds", status: 409 });

    const [row] = await db.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.locationId).toBeNull();
  });

  it("gates on the per-player travel cooldown and answers with a retry-after header", async () => {
    await travel(chicagoId);
    const err = await travel(miamiId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    if (!(err instanceof PluginError)) throw new Error("unreachable");
    expect(err.status).toBe(429);
    expect(err.code).toBe("on_cooldown");
    expect(Number(err.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("releases the cooldown when the travel itself fails, so a rejected trip does not strand the player", async () => {
    await db.update(playerStats).set({ cash: 0n }).where(eq(playerStats.playerId, playerId));
    await expect(travel(miamiId)).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(await redis.exists(cooldownKey(playerId, "travel"))).toBe(0);
  });
});

describe("GET /api/locations", () => {
  it("lists every location, marks the current one, and reports the live cooldown", async () => {
    const before = await callPluginRoute(travelPlugin, "GET", "/api/locations", {
      db, redis, leaderboardPrefix, playerId,
    });
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      locations: expect.arrayContaining([
        expect.objectContaining({ id: chicagoId, name: "Chicago", travelCost: "100", current: false, cooldownRemaining: 0 }),
      ]),
    });

    await travel(chicagoId);

    const after = await callPluginRoute(travelPlugin, "GET", "/api/locations", {
      db, redis, leaderboardPrefix, playerId,
    });
    const listed = (after.body as { locations: { id: string; current: boolean; cooldownRemaining: number }[] }).locations;
    expect(listed.find((l) => l.id === chicagoId)?.current).toBe(true);
    expect(listed.find((l) => l.id === chicagoId)?.cooldownRemaining).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run --project @gl3/server test/travel-plugin.test.ts
```
Expected: FAIL — `Cannot find module '@gl3/plugin-travel'`.

- [ ] **Step 4: Write the plugin**

`packages/plugins/travel/src/index.ts`:

```ts
import {
  definePlugin, InsufficientFundsError, PluginError, route,
  type PlayerSnapshot, type PluginCtx, type RouteResult,
} from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { locations, playerStats } from "./schema.js";

/**
 * Ported from `apps/server/src/game/travel/routes.ts` and `service.ts`. Paths,
 * status codes, error strings, response bodies and the `player.travelled`
 * event are unchanged. The lock order is NOT: see §4 below and design
 * `docs/superpowers/specs/2026-08-10-travel-plugin-port-design.md`.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `IdSchema` is restated.
 */
const IdSchema = z.string().uuid();
const TravelParamsSchema = z.object({ locationId: IdSchema });

/** Max attempts before a caller who keeps moving gets a clean 409. */
const MAX_ATTEMPTS = 3;

/**
 * Internal, never reaches the loader: the unlocked pre-read that chose which
 * `locations` rows to lock turned out to be stale, so the transaction is
 * abandoned and retried against the row the player is actually on.
 */
class LocationMovedRetry extends Error {
  constructor() {
    super("player location changed between the pre-read and the lock");
    this.name = "LocationMovedRetry";
  }
}

const listRoute = route({
  method: "GET",
  path: "/api/locations",
  // No jail gate: core's route had none. Listing is not an action.
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const cooldownRemaining = await ctx.cooldown.peek("travel", player.id);

    return ctx.transaction(async (tx) => {
      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const rows = await tx.db.select().from(locations);

      return {
        status: 200,
        body: {
          locations: rows.map((l) => ({
            id: l.id,
            name: l.name,
            travelCost: l.travelCost.toString(),
            travelCooldownSeconds: l.travelCooldownSeconds,
            bulletCost: l.bulletCost.toString(),
            bulletStock: l.bulletStock,
            current: l.id === stats?.locationId,
            cooldownRemaining,
          })),
        },
      };
    });
  },
});

const travelRoute = route({
  method: "POST",
  path: "/api/travel/:locationId",
  // Travelling is an action, so it gates on jail. The loader runs
  // releaseIfExpired and answers 423 + retry-after, exactly as core's route did.
  accessInJail: false,
  params: TravelParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const toLocationId = params.locationId;

    // (1) Look the destination up BEFORE claiming the cooldown, so a typo
    // costs the player nothing (core's ordering).
    const destination = await ctx.transaction(async (tx) => {
      const [row] = await tx.db
        .select({ travelCooldownSeconds: locations.travelCooldownSeconds })
        .from(locations)
        .where(eq(locations.id, toLocationId));
      return row ?? null;
    });
    if (destination === null) throw new PluginError("location_not_found", 404);

    // (2) One cooldown claim for the whole call. Retries below do not
    // re-acquire it, and only a failure that ENDS the call releases it.
    const won = await ctx.cooldown.acquire("travel", player.id, destination.travelCooldownSeconds);
    if (!won) {
      const retryAfter = await ctx.cooldown.peek("travel", player.id);
      throw new PluginError(
        "on_cooldown",
        429,
        { retryAfter },
        { "retry-after": String(Math.max(retryAfter, 1)) },
      );
    }

    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await attemptTravel(ctx, player, toLocationId);
        } catch (error) {
          if (!(error instanceof LocationMovedRetry)) throw error;
          // Reachable only by one player racing themselves — two concurrent
          // travels past the Redis cooldown. Bounded, then a clean 409.
          if (attempt >= MAX_ATTEMPTS) throw new PluginError("location_changed", 409);
        }
      }
    } catch (error) {
      try {
        // Don't strand the player behind a cooldown they never used.
        await ctx.cooldown.release("travel", player.id);
      } catch (releaseError) {
        ctx.log.error("failed to release travel cooldown after failure", {
          err: String(releaseError), playerId: player.id, locationId: toLocationId,
        });
      }
      throw error;
    }
  },
});

/**
 * §4 — the lock protocol, and the reason this port exists.
 *
 * Every path in this game that touches a `locations` row and a `player_stats`
 * row takes LOCATIONS BEFORE PLAYERS. `bullets` does
 * (`locks.location` then `applyBalanceChange`); core's `performTravel` did the
 * opposite, taking `player_stats` FOR UPDATE first and reaching `locations`
 * afterwards through the implicit FOR KEY SHARE on the `location_id` FK. That
 * inversion closed an ABBA cycle with a bullets purchase — `40P01`, surfacing
 * as a 500 on a well-formed request.
 *
 * Locking only the DESTINATION would close the deadlock but leave the other
 * half open: a travel OUT of L never touches `locations[L]`, so it can still
 * commit inside a buy's window and the buy charges at a location the player
 * has left. Both rows are locked here for that reason.
 *
 * The source id has to be read before it can be locked, which is why the
 * unlocked pre-read below exists. It is a HINT used to choose rows, never a
 * value acted on: the re-read under the player lock is what the transaction
 * trusts, and a mismatch abandons the attempt.
 */
async function attemptTravel(
  ctx: PluginCtx,
  player: PlayerSnapshot,
  toLocationId: string,
): Promise<RouteResult> {
  // (3) Unlocked pre-read — see the note above.
  const expectedFrom = await ctx.transaction(async (tx) => {
    const [stats] = await tx.db
      .select({ locationId: playerStats.locationId })
      .from(playerStats)
      .where(eq(playerStats.playerId, player.id));
    return stats?.locationId ?? null;
  });
  // Rejected outright rather than silently no-oped: the fare would be a bug,
  // and succeeding would hide a stale client re-submitting the current location.
  if (expectedFrom === toLocationId) throw new PluginError("already_there", 409);

  return await ctx.transaction(async (tx) => {
    // (4) LOCATIONS FIRST, both of them, ascending id inside the helper.
    await tx.locks.locations([expectedFrom, toLocationId]);
    // (5) Then the player. Explicit, because a zero-fare travel never calls
    // applyBalanceChange and would otherwise hold no player lock at all.
    await tx.locks.player([player.id]);

    // (6) The value the transaction actually trusts.
    const [current] = await tx.db
      .select({ locationId: playerStats.locationId })
      .from(playerStats)
      .where(eq(playerStats.playerId, player.id));
    const actualFrom = current?.locationId ?? null;
    if (actualFrom !== expectedFrom) throw new LocationMovedRetry();
    if (actualFrom === toLocationId) throw new PluginError("already_there", 409);

    // (7) Fare read under the lock. Absent = deleted since step 1.
    const [destination] = await tx.db
      .select({ id: locations.id, travelCost: locations.travelCost })
      .from(locations)
      .where(eq(locations.id, toLocationId));
    if (!destination) throw new PluginError("location_not_found", 404);

    if (destination.travelCost > 0n) {
      try {
        await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: -destination.travelCost,
          kind: "cash",
          reason: "travel.cost",
          refId: destination.id,
        });
      } catch (error) {
        // The loader maps no status for this by design (errors.ts) — bank,
        // travel and bullets answer 409 while gangs answers 400.
        if (error instanceof InsufficientFundsError) {
          throw new PluginError("insufficient_funds", 409);
        }
        throw error;
      }
    }

    // (8) The implicit FOR KEY SHARE this takes on the destination lands on a
    // row this transaction already holds FOR UPDATE — a no-op against
    // ourselves, not a lock-order hazard. `.returning()` replaces core's
    // post-commit re-read (the bullets precedent).
    const [fresh] = await tx.db
      .update(playerStats)
      .set({ locationId: destination.id })
      .where(eq(playerStats.playerId, player.id))
      .returning({ cash: playerStats.cash });
    if (!fresh) throw new PluginError("location_not_found", 404);

    // (9) Buffered here, published after commit, discarded on rollback.
    // Audience is PRIVATE, as core's was.
    await tx.events.publishCore({
      type: "player.travelled",
      actorId: player.id,
      actorName: player.username,
      audience: { kind: "player", playerId: player.id },
      fromLocationId: actualFrom,
      toLocationId: destination.id,
      cost: destination.travelCost.toString(),
    });

    return { status: 200, body: { locationId: destination.id, cash: fresh.cash.toString() } };
  });
}

export default definePlugin({
  id: "travel",
  version: "1.0.0",
  // First port claiming two base paths; plugins/validate.ts checks each route
  // path is contained in one of them and that no other plugin claims either.
  basePaths: ["/api/locations", "/api/travel"],
  routes: [listRoute, travelRoute],
  // No `menu`, `pages` or `events`: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. No `jobs`: buildApp throws at boot if
  // a core plugin declares any.
});
```

- [ ] **Step 5: Register the package everywhere except `core-plugins.ts`**

`apps/server/package.json` dependencies, alphabetically after `@gl3/plugin-sdk`:

```json
    "@gl3/plugin-travel": "*",
```

`apps/server/tsconfig.json` — append to `references`: `{ "path": "../../packages/plugins/travel" }`.

Root `tsconfig.json` — add `{ "path": "./packages/plugins/travel" }` after the `bullets` entry.

`vitest.workspace.ts` — add after the `@gl3/plugin-bullets` alias:

```ts
      "@gl3/plugin-travel": fileURLToPath(
        new URL("./packages/plugins/travel/src/index.ts", import.meta.url),
      ),
```

`vitest.workspace.ts` `@gl3/server` project `include` — add `"test/travel-plugin.test.ts"` (alphabetical, before `"test/travel.test.ts"`).

`Dockerfile.server` — five lines, each beside its `bullets` twin:

```dockerfile
COPY packages/plugins/travel/package.json packages/plugins/travel/
COPY packages/plugins/travel/tsconfig.json packages/plugins/travel/tsconfig.json
COPY packages/plugins/travel/src packages/plugins/travel/src
COPY packages/plugins/travel/package.json packages/plugins/travel/
COPY --from=builder /app/packages/plugins/travel/dist packages/plugins/travel/dist
```

Then install:

```bash
npm install
```

- [ ] **Step 6: Verify every registration site**

```bash
grep -c "packages/plugins/travel" Dockerfile.server        # expect: 5
npx tsc --build --force apps/server/tsconfig.json          # the exact command the image build runs
npm run typecheck
```
Expected: `5`, then both builds clean. A missing `apps/server/tsconfig.json` reference fails only the second command; a missing `srcAliases` entry fails nothing and silently grades against a stale `dist/`.

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server test/travel-plugin.test.ts
```
Expected: PASS, all tests.

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/travel apps/server/package.json apps/server/tsconfig.json \
        tsconfig.json vitest.workspace.ts Dockerfile.server package-lock.json \
        apps/server/test/travel-plugin.test.ts
git commit -m "feat(plugins): add @gl3/plugin-travel with locations-before-players locking"
```

---

### Task 4: Serve travel from the plugin and delete the core module

**Files:**
- Modify: `apps/server/src/plugins/core-plugins.ts:1-6,32-34`
- Modify: `apps/server/src/app.ts:15,70`
- Delete: `apps/server/src/game/travel/service.ts`, `apps/server/src/game/travel/routes.ts`
- Modify: `apps/server/test/travel.test.ts`
- Modify: `apps/server/test/economy-invariant.test.ts:12,112-113,139-152`
- Modify: `vitest.workspace.ts` (drop `test/travel-plugin.test.ts` again)

**Interfaces:**
- Consumes: `travelPlugin` from `@gl3/plugin-travel` (Task 3).
- Produces: nothing new. After this task `GET /api/locations` and `POST /api/travel/:locationId` are served by the plugin and `performTravel` no longer exists.

- [ ] **Step 1: Register the plugin and delete the core registration**

`apps/server/src/plugins/core-plugins.ts` — add the import and the array entry:

```ts
import travelPlugin from "@gl3/plugin-travel";
```
```ts
export const CORE_PLUGINS: readonly PluginManifest[] = [
  rankPlugin, notificationsPlugin, newsPlugin, bankPlugin, bulletsPlugin, travelPlugin,
];
```

`apps/server/src/app.ts` — delete line 15 (`import { registerTravelRoutes } ...`) and line 70 (`registerTravelRoutes(app, deps.db, deps.redis, requireAuth);`).

```bash
rm apps/server/src/game/travel/service.ts apps/server/src/game/travel/routes.ts
rmdir apps/server/src/game/travel
```

- [ ] **Step 2: Run the existing HTTP tests to verify they now exercise the plugin**

```bash
npx vitest run --project @gl3/server test/travel.test.ts
```
Expected: FAIL — `test/travel.test.ts:7` imports the deleted `performTravel`.

This failure is the point: it proves the file was still coupled to the core module.

- [ ] **Step 3: Move the handler-level tests into `travel.test.ts`**

Replace `apps/server/test/travel.test.ts` lines 1-70 (the imports and the whole `describe("performTravel")` block) with the contents of `test/travel-plugin.test.ts` written in Task 3 — its imports, its `beforeEach`/`afterAll`, and both `describe` blocks — then delete `test/travel-plugin.test.ts` and its `vitest.workspace.ts` include entry.

**Leave the existing `describe("GET /api/locations and POST /api/travel/:locationId")` block at lines 72-147 exactly as it is.** It boots the real app with `app.inject` and asserts paths, status codes, error strings and bodies. Unchanged and still green, it is the proof that the port changed no HTTP response — the same role `bullets.test.ts`'s inject block plays. If it needs edits to pass, stop: that means the port changed a response, which the spec forbids.

One addition to that block, after the 429 assertion at line 103, proving the header survived the move to `PluginError.headers`:

```ts
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
```

- [ ] **Step 4: Run it**

```bash
npx vitest run --project @gl3/server test/travel.test.ts
```
Expected: PASS, including the untouched inject block.

- [ ] **Step 5: Rewire the invariant sweep**

`apps/server/test/economy-invariant.test.ts`:

Delete the import at line 12. Add `import travelPlugin from "@gl3/plugin-travel";` beside the other plugin imports and `import { cooldownKey } from "../src/game/cooldown.js";`.

Replace the travel branch (lines 112-113):

```ts
        } else if (opName === "travel") {
          // travel is a plugin now; this drives its real route handler. Core's
          // performTravel had no cooldown gate — the route did — so clear the
          // key first, or nearly every op in this sweep would answer 429 and
          // travel coverage would silently collapse to almost nothing.
          // Targeted DEL, never FLUSHDB: Redis is shared with every other file.
          await redis.del(cooldownKey(playerId, "travel"));
          await callPluginRoute(travelPlugin, "POST", "/api/travel/:locationId", {
            db, redis, leaderboardPrefix, playerId, params: { locationId: pick(locationIds) },
          });
```

Extend the accept-list at lines 139-152 — travel's rejections now arrive as `PluginError`, and `AlreadyAtLocationError` / `LocationNotFoundError` no longer exist:

```ts
        if (
          err instanceof InsufficientFundsError ||
          // Every ported module's expected rejections arrive as the
          // PluginError its handler throws. Only crimes is still core.
          (err instanceof PluginError &&
            (err.code === "insufficient_funds" || err.code === "insufficient_stock" ||
             err.code === "no_location" || err.code === "already_there" ||
             err.code === "location_not_found" || err.code === "location_changed" ||
             err.code === "on_cooldown"))
        ) continue;
```

Remove `AlreadyAtLocationError` and `LocationNotFoundError` from the import at line 12 — they are gone with the service.

Add the coverage assertion beside the bullets one (`:161`), for the same reason:

```ts
    // The accept-list above swallows travel's expected rejections alongside
    // every other op kind's. A regression that made every travel fail would
    // still satisfy the other kinds and pass silently with zero travel
    // coverage — assert it moved at least once.
    expect(succeeded.travel).toBeGreaterThan(0);
```

- [ ] **Step 6: Run the sweep**

```bash
npx vitest run --project @gl3/server test/economy-invariant.test.ts
```
Expected: PASS, with `succeeded.travel > 0`. If travel succeeds zero times, the cooldown DEL is in the wrong place.

- [ ] **Step 7: Full local verification**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```
Expected: `exit=0`. **Read the exit code, not the summary** — an unhandled rejection makes vitest exit non-zero while still printing all-passed. Any non-zero exit is a failure even if every test passed.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(plugins): serve travel from @gl3/plugin-travel and delete the core module"
```

---

### Task 5: Deadlock regression test

**Files:**
- Create: `apps/server/test/travel-lock-order.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server` project `include`)

**Interfaces:**
- Consumes: `travelPlugin` and `bulletsPlugin` manifests; `bootTestServer` from `test/helpers/server.js`; the `waitForLockWaiters` / `fire` shapes from `test/gang-lock-order.test.ts:84-105`.

Read the spec's §7.1 before writing this. In particular, read *why* both participants cannot be real handlers — the construction below is not the obvious one, and the obvious one does not work.

- [ ] **Step 1: Write the regression test**

`apps/server/test/travel-lock-order.test.ts`:

```ts
import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Regression test for the location↔player lock-order inversion between
 * `travel` and `bullets`.
 *
 * Before the fix, core's performTravel took `player_stats` FOR UPDATE first
 * and reached `locations` afterwards — implicitly, as the FOR KEY SHARE
 * Postgres takes when `UPDATE player_stats SET location_id = …` checks its
 * foreign key. A bullets purchase locks the other way round: `locations` FOR
 * UPDATE first (tx.locks.location), then `player_stats` inside
 * applyBalanceChange. FOR KEY SHARE conflicts with FOR UPDATE, so a buy
 * holding locations[L] while a travel INTO L holds that player's row is a
 * genuine cycle: 40P01, uncaught, and a well-formed request answers 500.
 *
 * WHY THE ADVERSARY IS HAND-WRITTEN, not the real bullets handler.
 * The cycle needs a buy to hold locations[L] while the player sits somewhere
 * else — so that a travel's destination can be L. But the real handler derives
 * L from player_stats.location_id and locks it in the same uninterrupted
 * stretch of code; making that read stale means moving the player between the
 * read and the lock, a window internal to the handler with no hook. Every
 * blocker placement collapses: on player_stats the player cannot move, on
 * locations[L] the intervening travel needed to move them deadlocks the SETUP
 * against the fixed code, and doing that travel first makes the buy read C
 * instead of L. A test-only pause inside the shipped bullets transaction was
 * rejected — it would put scaffolding inside a verified port to expose the
 * very window this port removes.
 *
 * So t0 below stands in for a buy that read L before the move, in bullets'
 * exact lock shape: locations[L] FOR UPDATE, then player_stats[P] FOR UPDATE.
 * That still satisfies docs/STATUS.md's requirement that the two sides not
 * acquire their locks through the same helper — which matters because
 * gang-ledger.test.ts's deadlock test agreed on ordering by construction and
 * stayed green straight through the M3 deadlock it was meant to catch.
 *
 * Each step waits on observed lock state in pg_stat_activity, never a sleep.
 */

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;
let lId: string;
let cId: string;

function fire(opts: InjectOptions): Promise<LightMyRequestResponse> {
  // app.inject() is lazy — it dispatches only when something calls .then.
  // Promise.resolve schedules that immediately, which is what puts the
  // request genuinely in flight while this test waits on lock state.
  return Promise.resolve(app.inject(opts));
}

async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await conn<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
    `;
    const seen = row?.n ?? 0;
    if (seen >= n) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} lock-waiting backends (saw ${seen})`);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer } = await bootTestServer());

  lId = uuidv7();
  cId = uuidv7();
  await db.insert(locations).values([
    { id: lId, name: "Lockville", travelCost: 10n, travelCooldownSeconds: 60, bulletStock: 100, bulletCost: 5n },
    { id: cId, name: "Cooltown", travelCost: 10n, travelCooldownSeconds: 60, bulletStock: 100, bulletCost: 5n },
  ]);

  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: `LockOrder${Date.now()}`, password: "hunter2hunter2" },
  });
  ({ token, playerId } = reg.json());
  await db.update(playerStats).set({ cash: 10_000n, locationId: lId }).where(eq(playerStats.playerId, playerId));
});

afterAll(async () => {
  await redis.del(cooldownKey(playerId, "travel"));
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("travel lock ordering", () => {
  it("does not deadlock when a travel INTO a location races a purchase already holding it", async () => {
    const auth = { authorization: `Bearer ${token}` };

    // Move P off L first, so a travel back INTO L is legal (destination ==
    // current is rejected before any lock is taken). Cooldown cleared between
    // legs, as travel.test.ts does.
    const out = await app.inject({ method: "POST", url: `/api/travel/${cId}`, headers: auth });
    expect(out.statusCode).toBe(200);
    await redis.del(cooldownKey(playerId, "travel"));

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const inFlight: Promise<LightMyRequestResponse>[] = [];
    const t0 = await blocker.reserve();

    try {
      // t0 = a buy that read L before the move, in bullets' lock shape.
      await t0`BEGIN`;
      await t0`SELECT id FROM locations WHERE id = ${lId}::uuid FOR UPDATE`;

      // Real travel C→L. Pre-fix it takes player_stats[P] FOR UPDATE and then
      // parks on locations[L]. Post-fix it parks on locations[L] holding no
      // player row at all.
      const back = fire({ method: "POST", url: `/api/travel/${lId}`, headers: auth });
      inFlight.push(back);
      await waitForLockWaiters(1);

      // The second half of the buy's shape. Pre-fix this closes the cycle:
      // t0 holds L and wants P, travel holds P and wants L.
      await t0`SELECT player_id FROM player_stats WHERE player_id = ${playerId}::uuid FOR UPDATE`;
      await t0`COMMIT`;

      const backRes = await back;
      expect(backRes.statusCode, `travel body: ${backRes.body}`).toBeLessThan(500);
      expect(backRes.statusCode).toBe(200);

      const [row] = await db.select({ locationId: playerStats.locationId })
        .from(playerStats).where(eq(playerStats.playerId, playerId));
      expect(row?.locationId).toBe(lId);
    } finally {
      try { await t0`ROLLBACK`; } catch { /* already committed */ }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }
  }, 30_000);

  it("survives a real purchase and a real travel running concurrently", async () => {
    // NOT the regression proof. This cannot force the cycle — see the header
    // comment for why the stale-read window is unreachable from outside the
    // bullets handler. It covers the two shipped handlers coexisting under
    // concurrency, and nothing more. Do not read a green run here as evidence
    // about lock ordering.
    const auth = { authorization: `Bearer ${token}` };
    await redis.del(cooldownKey(playerId, "travel"));

    const [buyRes, travelRes] = await Promise.all([
      fire({ method: "POST", url: "/api/bullets/buy", headers: auth, payload: { quantity: 1 } }),
      fire({ method: "POST", url: `/api/travel/${cId}`, headers: auth }),
    ]);

    expect(buyRes.statusCode, `buy body: ${buyRes.body}`).toBeLessThan(500);
    expect(travelRes.statusCode, `travel body: ${travelRes.body}`).toBeLessThan(500);

    // Whatever the interleaving, the ledger balances.
    const rows = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    const sum = rows.reduce((acc, r) => acc + (r.balanceKind === "cash" ? r.amount : 0n), 0n);
    const [stats] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.cash).toBe(10_000n + sum);
  }, 30_000);
});
```

The reducer's column names match `apps/server/src/db/schema/economy.ts:14-24`
(`playerId`, `amount`, `balanceKind`) — verified, not assumed.

- [ ] **Step 2: Register the test file**

`vitest.workspace.ts`, `@gl3/server` project `include`, alphabetically after `"test/travel.test.ts"`:

```ts
        "test/travel-lock-order.test.ts",
```

- [ ] **Step 3: Run it — expect PASS on the fixed code**

```bash
npx vitest run --project @gl3/server test/travel-lock-order.test.ts
```
Expected: PASS.

- [ ] **Step 4: PROVE IT CAN FAIL — required, not optional**

A green test never shown red proves nothing (CLAUDE.md working method). Temporarily invert the order in `packages/plugins/travel/src/index.ts` `attemptTravel`, reproducing core's player-first order:

```ts
    // SCRATCH — revert immediately after capturing the failure.
    await tx.locks.player([player.id]);
    await tx.locks.locations([expectedFrom, toLocationId]);
```

Then:

```bash
npx vitest run --project @gl3/server test/travel-lock-order.test.ts 2>&1 | tee /tmp/travel-deadlock-proof.log
```

Expected: FAIL on the first test, with `40P01` / `deadlock detected` in the captured output and the travel request answering 500.

If it does **not** fail, the test is not exercising the cycle — stop and diagnose before going further. Do not proceed on a test that cannot fail.

- [ ] **Step 5: Restore the correct order**

```bash
git checkout packages/plugins/travel/src/index.ts
npx vitest run --project @gl3/server test/travel-lock-order.test.ts
```
Expected: PASS again.

- [ ] **Step 6: Commit, quoting the captured failure**

```bash
git add apps/server/test/travel-lock-order.test.ts vitest.workspace.ts
git commit -m "test(travel): prove the locations-before-players order closes the 40P01 cycle"
```

Include the exact `40P01` line from `/tmp/travel-deadlock-proof.log` in the commit body.

---

### Task 6: Correct the documentation the fix invalidates

Three doc comments currently state that this deadlock exists and is not theirs to fix. Once it is fixed they actively mislead.

**Files:**
- Modify: `apps/server/src/economy/ledger.ts:79-98`
- Modify: `packages/plugin-sdk/src/ctx.ts:145-156`
- Modify: `packages/plugins/bullets/src/index.ts:42-56`
- Modify: `docs/STATUS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `economy/ledger.ts` — `lockLocationForUpdate`**

Replace the second paragraph (everything from "This fixed direction does NOT rule out a deadlock…" to the end) with:

```
 * The direction is now global: every path that touches a location row and a
 * player row takes LOCATIONS FIRST. `travel` used to invert it — locking
 * `player_stats` FOR UPDATE and reaching `locations` afterwards through the
 * implicit FOR KEY SHARE on the `location_id` FK — which closed an ABBA cycle
 * with a bullets purchase. `packages/plugins/travel/src/index.ts` now takes
 * both its location rows through `lockLocationsForUpdate` before the player
 * row; regression test `apps/server/test/travel-lock-order.test.ts`.
 *
 * A path needing SEVERAL location rows must use `lockLocationsForUpdate`, not
 * repeated calls to this function: the order between them is the point.
```

- [ ] **Step 2: `plugin-sdk/src/ctx.ts` — the `locks` contract comment**

Replace the `location` bullet and add one for `locations`:

```
   * - A location alongside a player: `location` first, then the player.
   * - SEVERAL locations alongside a player: `locations` first (it sorts them),
   *   then the player — never repeated `location` calls, whose relative order
   *   is exactly what a deadlock needs. `travel` is the caller.
```

- [ ] **Step 3: `plugins/bullets/src/index.ts` — the comment at `:42-56`**

Keep the "LOCATION LOCK FIRST" instruction; replace the paragraph beginning "This order does NOT by itself rule out a deadlock" with:

```
      // Travel used to lock the other way round and closed an ABBA cycle with
      // this handler; it no longer does — `@gl3/plugin-travel` takes both of
      // its location rows before the player row
      // (`apps/server/test/travel-lock-order.test.ts` is the regression).
      // The unlocked read at (1) above is likewise no longer a staleness
      // window: a travel off this location must hold this row to commit.
```

- [ ] **Step 4: `docs/STATUS.md`**

- Update the M5 row: six of twelve ports shipped, three remaining (`crimes`, `mail`, `gangs`).
- Move the bullets watch item ("The bullets purchase reads `player_stats.location_id` unlocked", both halves) from the watch list into **"Resolved, but the reasoning matters if you touch these areas"**, stating: locking only the destination — the constraint STATUS originally recorded — would have closed the deadlock and left the staleness open; both rows are locked for that reason.
- Add a short note under the resolved item recording that the obvious real-buy-vs-real-travel regression test cannot be built, and why, so nobody re-attempts it.
- Update "What M3 established that later work must not undo": location↔player is now one direction, locations first, several locations via `lockLocationsForUpdate`.
- Refresh the suite counts from the actual verify output.

- [ ] **Step 5: `CLAUDE.md`**

- "Current state": six of twelve ports shipped; `crimes`, `mail`, `gangs` remain.
- Rule 6: add the travel case beside the M3 gang case — an FK lock is still a lock, and the location↔player pair is now settled as locations-first, `lockLocationsForUpdate` for several.
- Conventions, the eight-registration-sites bullet: `grep -c "packages/plugins/travel" Dockerfile.server` works the same as the bullets check.

- [ ] **Step 6: Full verification**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```
Expected: `exit=0`. Read the exit code, not the summary. Record the real file/test counts from this run into `docs/STATUS.md` — do not estimate them.

Then confirm the image-build path one more time, since it is the check CI runs and this machine cannot:

```bash
grep -c "packages/plugins/travel" Dockerfile.server   # expect: 5
npx tsc --build --force apps/server/tsconfig.json
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: record the travel port and the closed location-player lock-order defect"
```

---

## Verification Checklist

Before calling this done:

- [ ] `npm run verify` exits 0 — checked with `echo "exit=$?"`, not by reading the summary.
- [ ] `npx tsc --build --force apps/server/tsconfig.json` is clean (the CI-only failure mode).
- [ ] `grep -c "packages/plugins/travel" Dockerfile.server` returns 5.
- [ ] `grep -rn "performTravel\|game/travel" apps/server/src apps/server/test` returns nothing.
- [ ] `/tmp/travel-deadlock-proof.log` contains a real `40P01`, captured from the scratch-inverted order, and the commit body quotes it.
- [ ] `test/travel.test.ts`'s `app.inject` block is unchanged apart from the added `retry-after` assertion.
- [ ] `succeeded.travel > 0` in the invariant sweep output.
- [ ] The three doc comments no longer describe the deadlock as open.
