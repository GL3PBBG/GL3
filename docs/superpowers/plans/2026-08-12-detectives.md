# Detectives Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `detectives` plugin — V2's cross-location hunting layer: pay to search for a player, seeded roll in a worker, time-gated reveal of their live location — plus a `/detectives` web page.

**Architecture:** New plugin package `packages/plugins/detectives` shaped like `bounties` (routes, schema mirrors, no migrations — it uses the existing core `detective_searches` table) plus one BullMQ job shaped like `crimes` (`resolve`, seeded rng, `plugin_job_runs` idempotency). The combat plugin is untouched. Spec: `docs/superpowers/specs/2026-08-12-detectives-design.md`.

**Tech Stack:** TypeScript strict ESM, Fastify 5 (via plugin SDK routes), Drizzle ORM, PostgreSQL 16, Redis 7 + BullMQ, zod, vitest integration tests against real Postgres/Redis, React 18 + TanStack Query v5.

## Global Constraints

- Environment for every test run: `export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3` and `export REDIS_URL=redis://localhost:6379`.
- Read exit codes, not summaries: `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"` — any non-zero exit is a failure even if every test printed green.
- Never run two full test suites at once. Single-file runs (`npx vitest run --project @gl3/server detectives`) are fine.
- Never run `FLUSHALL`/`FLUSHDB`. Targeted `redis.del` only.
- No `any` in `packages/*`. ESM only; relative imports carry `.js`.
- Money is `bigint` in TS/Postgres, decimal string on the wire. Never a JSON number.
- Every balance movement goes through `tx.economy.applyBalanceChange`. Events (none in this plugin) only after commit.
- `@gl3/shared` is off-limits inside `packages/plugins/*` — zod schemas are restated there (bounties pattern).
- Settings are namespaced by the ctx: plugin asks `ctx.settings.get("cost")`, the DB row / test settings key is `"detectives.cost"` (`apps/server/src/plugins/ctx.ts:289`). **Deviation from spec §1 recorded here:** spec says V2 key names (`detectiveCost`…); with the `${pluginId}.` prefix that would stutter as `detectives.detectiveCost`, so the plugin-side keys are bare `cost`, `duration`, `expire` → DB rows `detectives.cost`, `detectives.duration`, `detectives.expire`. Defaults: cost `125000`, duration `3600` (seconds per hour-unit), expire `600`.
- Deliberately **no lock-order test** and no `tx.locks.player` call in the hire route (spec §2 Locks): `applyBalanceChange` locks only the hirer's own `player_stats` row; the INSERT's FKs take KEY SHARE on `players` rows, which nothing locks FOR UPDATE. Do not "fix" this by adding a pair lock.
- Error convention (spec §4): 400 for zod bounds, `cannot_search_self`, `target_not_found` (note: this differs from bounties' 404 `target_not_found` — the spec pins 400 here); 409 `insufficient_funds`; 404 `not_found` on removing a foreign/nonexistent row (no existence leak).
- Conventional Commits.

## File Structure

- `packages/plugins/detectives/package.json`, `tsconfig.json` — package scaffold.
- `packages/plugins/detectives/src/schema.ts` — read/write mirrors of core tables (`detective_searches`, `players`, `player_stats`, `locations`), only touched columns.
- `packages/plugins/detectives/src/index.ts` — settings readers, three routes (hire/list/remove), `resolve` job, manifest.
- Registration sites: `apps/server/package.json`, `apps/server/tsconfig.json`, root `tsconfig.json`, `vitest.workspace.ts` (srcAliases **and** test include list), `apps/server/src/plugins/core-plugins.ts`, `Dockerfile.server` (5 COPY lines).
- `apps/server/test/detectives-worker.test.ts` — job determinism + idempotency.
- `apps/server/test/detectives.test.ts` — HTTP contract: hire, reveal gating, live tracking, remove.
- `apps/server/test/economy-invariant.test.ts` — gains a `detectiveHire` op.
- `packages/shared/src/dto/detectives.ts` (+ `packages/shared/src/index.ts` export) — wire DTOs.
- `apps/web/src/api/keys.ts`, `apps/web/src/api/queries.ts`, `apps/web/src/pages/Detectives.tsx`, `apps/web/src/App.tsx`, `apps/web/src/components/Shell.tsx` — web page.
- `docs/STATUS.md`, `CLAUDE.md` — record the shipped feature.

---

### Task 1: Package scaffold + all eight registration sites

**Files:**
- Create: `packages/plugins/detectives/package.json`
- Create: `packages/plugins/detectives/tsconfig.json`
- Create: `packages/plugins/detectives/src/schema.ts`
- Create: `packages/plugins/detectives/src/index.ts` (minimal manifest; routes/job arrive in Tasks 2–5)
- Modify: `apps/server/package.json` (dependencies block, after `"@gl3/plugin-crimes"`)
- Modify: `apps/server/tsconfig.json:9` (references array)
- Modify: root `tsconfig.json` (references, after the bounties line at `tsconfig.json:17`)
- Modify: `vitest.workspace.ts` srcAliases (next to the `@gl3/plugin-bounties` entry at `vitest.workspace.ts:60-61`)
- Modify: `apps/server/src/plugins/core-plugins.ts`
- Modify: `Dockerfile.server` (5 COPY lines mirroring the bounties lines at 64, 98, 99, 147, 169)

**Interfaces:**
- Produces: package `@gl3/plugin-detectives` whose default export is the plugin manifest; `src/schema.ts` exports `players`, `playerStats`, `locations`, `detectiveSearches` drizzle tables consumed by Tasks 2–5.

- [ ] **Step 1: Create the package files**

`packages/plugins/detectives/package.json`:

```json
{
  "name": "@gl3/plugin-detectives",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": { "@gl3/plugin-sdk": "*", "drizzle-orm": "^0.45.2", "uuidv7": "^1.0.2", "zod": "^3.23.8" }
}
```

`packages/plugins/detectives/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../plugin-sdk" }]
}
```

`packages/plugins/detectives/src/schema.ts`:

```ts
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read/write mirrors of core-owned tables — the pattern
 * `packages/plugins/bounties/src/schema.ts` documents. Core owns and migrates
 * all four; `detective_searches` ships in core migration `0000`
 * (`apps/server/src/db/schema/social.ts:63`). Only touched columns listed.
 */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  locationId: uuid("location_id"),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});

export const detectiveSearches = pgTable("detective_searches", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  targetPlayerId: uuid("target_player_id").notNull(),
  detectives: integer("detectives").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  succeeded: boolean("succeeded"),
});
```

`packages/plugins/detectives/src/index.ts` (minimal — later tasks replace this file's contents incrementally, each task shows its full additions):

```ts
import { definePlugin } from "@gl3/plugin-sdk";

/**
 * V2's detectives module, GL3-shaped: the cross-location hunting layer.
 * Spec: docs/superpowers/specs/2026-08-12-detectives-design.md.
 * Uses core's `detective_searches` table (no plugin migrations); no combat
 * coupling; no events, menu or pages (plugin-manifest-endpoint.test.ts pins
 * the no-arg boot payload).
 */
export default definePlugin({
  id: "detectives",
  version: "1.0.0",
  basePaths: ["/api/detectives"],
  routes: [],
});
```

- [ ] **Step 2: Register in `apps/server/package.json` and install**

Add to the `dependencies` block, keeping alphabetical order (after `"@gl3/plugin-crimes": "*",`):

```json
    "@gl3/plugin-detectives": "*",
```

Run: `npm install`
Expected: exits 0, workspace symlink created (`ls node_modules/@gl3/plugin-detectives` shows the package).

- [ ] **Step 3: Register in the three tsconfigs and vitest srcAliases**

`apps/server/tsconfig.json` references array — insert after the crimes reference:

```json
{ "path": "../../packages/plugins/detectives" },
```

Root `tsconfig.json` — insert after the bounties line (`tsconfig.json:17`):

```json
    { "path": "./packages/plugins/detectives" },
```

`vitest.workspace.ts` — in the `srcAliases` object, next to the `@gl3/plugin-bounties` entry (lines 60-61), add:

```ts
      "@gl3/plugin-detectives": fileURLToPath(
        new URL("./packages/plugins/detectives/src/index.ts", import.meta.url),
      ),
```

(Missing this entry fails **nothing** — it silently grades later `tsc --build` runs against a stale `dist/`. Do not skip it.)

- [ ] **Step 4: Register in `core-plugins.ts`**

`apps/server/src/plugins/core-plugins.ts` — add the import alongside the others:

```ts
import detectivesPlugin from "@gl3/plugin-detectives";
```

and append `detectivesPlugin` to the `CORE_PLUGINS` array (after `bountiesPlugin`).

- [ ] **Step 5: Five Dockerfile.server COPY lines**

Mirror each bounties line exactly, immediately after it:

- After line 64 (`COPY packages/plugins/bounties/package.json packages/plugins/bounties/`):
  `COPY packages/plugins/detectives/package.json packages/plugins/detectives/`
- After line 98: `COPY packages/plugins/detectives/tsconfig.json packages/plugins/detectives/tsconfig.json`
- After line 99: `COPY packages/plugins/detectives/src packages/plugins/detectives/src`
- After line 147: `COPY packages/plugins/detectives/package.json packages/plugins/detectives/`
- After line 169: `COPY --from=builder /app/packages/plugins/detectives/dist packages/plugins/detectives/dist`

Run: `grep -c "packages/plugins/detectives" Dockerfile.server`
Expected: `5`

- [ ] **Step 6: Verify the server tsconfig builds (the exact command CI's image build runs)**

Run: `npx tsc --build --force apps/server/tsconfig.json`
Expected: exits 0. Then `npm run typecheck` — exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/detectives apps/server/package.json apps/server/tsconfig.json tsconfig.json vitest.workspace.ts apps/server/src/plugins/core-plugins.ts Dockerfile.server package-lock.json
git commit -m "chore(detectives): scaffold plugin package and all eight registration sites"
```

---

### Task 2: The `resolve` job — seeded roll, idempotent

**Files:**
- Modify: `packages/plugins/detectives/src/index.ts`
- Create: `apps/server/test/detectives-worker.test.ts`
- Modify: `vitest.workspace.ts` `@gl3/server` project include list (after `"test/crimes.test.ts",` — see lines around 226)

**Interfaces:**
- Consumes: `detectiveSearches` from `./schema.js` (Task 1).
- Produces: job `resolve` in the manifest (`jobs: { resolve: resolveJob }`), payload `{ searchId: string, detectives: number, hours: number }` (plus the ctx-injected `seed`). Success chance is `detectives × 4 × hours` percent via `rng.int(0, 100) < chancePercent`. Task 3's hire route enqueues exactly this payload.

- [ ] **Step 1: Register the test file in `vitest.workspace.ts`**

In the `@gl3/server` project's `include` array, after `"test/crimes.test.ts",` add:

```ts
        "test/detectives-worker.test.ts",
        "test/detectives.test.ts",
```

(Both files now, so Task 4 can't forget the second. A test file missing from this list silently never runs.)

- [ ] **Step 2: Write the failing worker test**

`apps/server/test/detectives-worker.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import detectivesPlugin from "@gl3/plugin-detectives";
import { loadConfig } from "../src/config.js";
import { detectiveSearches, players, playerStats, pluginJobRuns } from "../src/db/schema/index.js";
import { createRng } from "../src/game/rng.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

// runPluginJob drives the real handler in-process (no HTTP, no boot) with the
// real plugin_job_runs guard — the same shape a BullMQ retry takes
// (crime-worker-idempotency.test.ts is the template).
const deps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: "detectives-worker-test" });

let hirerId: string;
let targetId: string;

/** Insert a pending search row directly — the worker doesn't care who hired. */
async function insertSearch(): Promise<string> {
  const id = uuidv7();
  await db.insert(detectiveSearches).values({
    id, playerId: hirerId, targetPlayerId: targetId,
    detectives: 1, endsAt: new Date(Date.now() + 60_000),
  });
  return id;
}

/**
 * Brute-force a seed whose 1×4×1 roll (4%) lands on `want`. Deterministic —
 * createRng is the same sha256 counter stream the worker draws from — and
 * cheap: P(miss 20 times) is negligible for either side of a 4% split.
 */
function findSeed(want: boolean): string {
  for (let i = 0; i < 10_000; i += 1) {
    const seed = `detectives-worker-seed-${i}`;
    if ((createRng(seed).int(0, 100) < 4) === want) return seed;
  }
  throw new Error(`no seed found for want=${want}`);
}

beforeEach(async () => {
  await resetDb(db);
  hirerId = uuidv7();
  targetId = uuidv7();
  await db.insert(players).values([
    { id: hirerId, username: `det-w-h-${hirerId.slice(-8)}` },
    { id: targetId, username: `det-w-t-${targetId.slice(-8)}` },
  ]);
  await db.insert(playerStats).values([{ playerId: hirerId }, { playerId: targetId }]);
});

afterAll(async () => {
  await conn.end();
  redis.disconnect();
});

describe("detectives resolve job", () => {
  it("5 detectives x 5 hours = 100% always succeeds", async () => {
    const searchId = await insertSearch();
    await runPluginJob(deps(), detectivesPlugin, "resolve", {
      id: `det-job-100-${searchId}`,
      // rng.int(0, 100) draws 0..99, so a 100 chance cannot lose — the spec's
      // boundary case (§5).
      data: { searchId, detectives: 5, hours: 5, seed: uuidv7() },
    });
    const [row] = await db.select().from(detectiveSearches).where(eq(detectiveSearches.id, searchId));
    expect(row!.succeeded).toBe(true);
  });

  it("1x1 = 4% roll is the seed's own deterministic draw", async () => {
    for (const want of [true, false]) {
      const seed = findSeed(want);
      const searchId = await insertSearch();
      await runPluginJob(deps(), detectivesPlugin, "resolve", {
        id: `det-job-4pct-${searchId}`,
        data: { searchId, detectives: 1, hours: 1, seed },
      });
      const [row] = await db.select().from(detectiveSearches).where(eq(detectiveSearches.id, searchId));
      expect(row!.succeeded).toBe(want);
    }
  });

  it("a BullMQ retry with the same job id cannot re-roll", async () => {
    // First run resolves to FAILED; the retry carries a seed that WOULD
    // succeed. If the retry re-rolled, the row would flip to true.
    const failSeed = findSeed(false);
    const winSeed = findSeed(true);
    const searchId = await insertSearch();
    const jobId = `det-job-retry-${searchId}`;

    await runPluginJob(deps(), detectivesPlugin, "resolve", {
      id: jobId, data: { searchId, detectives: 1, hours: 1, seed: failSeed },
    });
    // Same job id, different seed — the plugin_job_runs claim must win.
    await runPluginJob(deps(), detectivesPlugin, "resolve", {
      id: jobId, data: { searchId, detectives: 1, hours: 1, seed: winSeed },
    });

    const [row] = await db.select().from(detectiveSearches).where(eq(detectiveSearches.id, searchId));
    expect(row!.succeeded).toBe(false);
    const runs = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, jobId));
    expect(runs).toHaveLength(1);
  });

  it("a search removed between enqueue and resolve is a no-op, not a crash", async () => {
    await expect(runPluginJob(deps(), detectivesPlugin, "resolve", {
      id: "det-job-orphan-1",
      data: { searchId: uuidv7(), detectives: 1, hours: 1, seed: uuidv7() },
    })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/server detectives-worker`
Expected: FAIL — `plugin "detectives" has no job "resolve"`.

- [ ] **Step 4: Implement the job**

In `packages/plugins/detectives/src/index.ts`, replace the file contents with:

```ts
import { definePlugin, type PluginCtx } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { detectiveSearches } from "./schema.js";

/**
 * V2's detectives module, GL3-shaped: the cross-location hunting layer.
 * Spec: docs/superpowers/specs/2026-08-12-detectives-design.md.
 * Uses core's `detective_searches` table (no plugin migrations); no combat
 * coupling; no events, menu or pages (plugin-manifest-endpoint.test.ts pins
 * the no-arg boot payload).
 */

// ---------------------------------------------------------------------------
// Resolve job — the roll happens HERE, seeded, not at hire time (spec §2):
// a BullMQ retry replays the same seed and the plugin_job_runs claim aborts
// it anyway. The outcome sits hidden in the row until ends_at (time-gated
// reveal) — no delayed job needed.
// ---------------------------------------------------------------------------

async function resolveJob(ctx: PluginCtx, data: Record<string, unknown>): Promise<void> {
  const searchId = String(data["searchId"]);
  const detectives = Number(data["detectives"]);
  const hours = Number(data["hours"]);
  const rng = ctx.job?.rng;
  if (rng === undefined) throw new Error("resolve job ran without a seeded rng");

  // One ctx.transaction per handler: the plugin_job_runs claim is structural
  // (first insert inside it), so a retry throws JobAlreadyAppliedError before
  // this callback runs.
  await ctx.transaction(async (tx) => {
    const [row] = await tx.db.select({ id: detectiveSearches.id })
      .from(detectiveSearches).where(eq(detectiveSearches.id, searchId));
    if (!row) return; // removed between enqueue and resolve

    // V2's formula: dets × 4 × hours percent (1–5 × 1–5 → 4%..100%).
    // rng.int is max-exclusive, so a draw of 0..99 against 100 always wins.
    const chancePercent = detectives * 4 * hours;
    const succeeded = rng.int(0, 100) < chancePercent;
    await tx.db.update(detectiveSearches).set({ succeeded })
      .where(eq(detectiveSearches.id, searchId));
  });
}

export default definePlugin({
  id: "detectives",
  version: "1.0.0",
  basePaths: ["/api/detectives"],
  routes: [],
  jobs: { resolve: resolveJob },
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/server detectives-worker`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/detectives/src/index.ts apps/server/test/detectives-worker.test.ts vitest.workspace.ts
git commit -m "feat(detectives): seeded resolve job with plugin_job_runs idempotency"
```

---

### Task 3: Hire route — `POST /api/detectives`

**Files:**
- Modify: `packages/plugins/detectives/src/index.ts`
- Create: `apps/server/test/detectives.test.ts` (already in the vitest include list from Task 2)

**Interfaces:**
- Consumes: `resolveJob` payload shape from Task 2; `players`, `detectiveSearches` from `./schema.js`.
- Produces: `POST /api/detectives`, body `{ targetUsername: string, detectives: 1–5, hours: 1–5 }` → 201 `{ searchId: string, cash: string }`. Ledger reason `"detectives.hire"`. Settings read: `cost` (bigint string, default 125000), `duration` (seconds per hour-unit, default 3600). Task 7's DTOs restate these shapes.

- [ ] **Step 1: Write the failing hire tests**

`apps/server/test/detectives.test.ts`:

```ts
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { loadConfig } from "../src/config.js";
import {
  detectiveSearches, locations, playerStats, settings, transactions,
} from "../src/db/schema/index.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let hirerToken: string;
let hirerId: string;
let targetId: string;
let chicagoId: string;
let miamiId: string;

const hire = (token: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/api/detectives",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

const list = (token: string) =>
  app.inject({
    method: "GET",
    url: "/api/detectives",
    headers: { authorization: `Bearer ${token}` },
  });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  const hirer = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Gumshoe", password: "hunter2hunter2" },
  });
  ({ token: hirerToken, playerId: hirerId } = hirer.json());

  const target = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Fugitive", password: "hunter2hunter2" },
  });
  ({ playerId: targetId } = target.json());

  chicagoId = uuidv7();
  miamiId = uuidv7();
  await db.insert(locations).values([
    { id: chicagoId, name: "Chicago", travelCost: 100n, travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n },
    { id: miamiId, name: "Miami", travelCost: 250n, travelCooldownSeconds: 120, bulletStock: 300, bulletCost: 8n },
  ]);
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("POST /api/detectives — hire", () => {
  it("debits cost x detectives x hours, inserts the search row, ledgers detectives.hire", async () => {
    await db.update(playerStats).set({ cash: 10_000_000n })
      .where(eq(playerStats.playerId, hirerId));

    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 2, hours: 3 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // 125000 (default cost) x 2 x 3 = 750000
    expect(body.cash).toBe("9250000");

    const [row] = await db.select().from(detectiveSearches)
      .where(eq(detectiveSearches.id, body.searchId));
    expect(row).toMatchObject({ playerId: hirerId, targetPlayerId: targetId, detectives: 2 });
    // ends_at = started_at + duration(3600s) x hours(3). started_at is the DB
    // clock, ends_at the app clock — allow 5s of skew, not equality.
    // `succeeded` is NOT asserted: bootTestServer runs real workers and the
    // resolve job may have already landed.
    const spanMs = row!.endsAt.getTime() - row!.startedAt.getTime();
    expect(Math.abs(spanMs - 3 * 3600 * 1000)).toBeLessThan(5_000);

    const [ledgerRow] = await db.select().from(transactions)
      .where(eq(transactions.reason, "detectives.hire"));
    expect(ledgerRow!.amount).toBe(-750_000n);
    expect(ledgerRow!.playerId).toBe(hirerId);
  });

  it("honours a detectives.cost settings override", async () => {
    // Settings are snapshotted at boot — insert before starting a fresh server.
    await db.insert(settings).values({ key: "detectives.cost", value: "10" });
    const { app: freshApp, close } = await bootTestServer();
    try {
      await db.update(playerStats).set({ cash: 1_000n })
        .where(eq(playerStats.playerId, hirerId));
      const res = await freshApp.inject({
        method: "POST", url: "/api/detectives",
        headers: { authorization: `Bearer ${hirerToken}` },
        payload: { targetUsername: "Fugitive", detectives: 1, hours: 1 },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().cash).toBe("990");
    } finally {
      await close();
    }
  });

  it("rejects a self-search with 400 cannot_search_self", async () => {
    const res = await hire(hirerToken, { targetUsername: "Gumshoe", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot_search_self");
  });

  it("rejects an unknown username with 400 target_not_found", async () => {
    const res = await hire(hirerToken, { targetUsername: "Nobody", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("target_not_found");
  });

  it("rejects detectives/hours outside 1-5 at the zod boundary", async () => {
    for (const payload of [
      { targetUsername: "Fugitive", detectives: 0, hours: 1 },
      { targetUsername: "Fugitive", detectives: 6, hours: 1 },
      { targetUsername: "Fugitive", detectives: 1, hours: 0 },
      { targetUsername: "Fugitive", detectives: 1, hours: 6 },
      { targetUsername: "Fugitive", detectives: 1.5, hours: 1 },
    ]) {
      expect((await hire(hirerToken, payload)).statusCode).toBe(400);
    }
  });

  it("409s insufficient_funds leaving no row", async () => {
    await db.update(playerStats).set({ cash: 100n })
      .where(eq(playerStats.playerId, hirerId));
    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_funds");
    expect(await db.select().from(detectiveSearches)).toHaveLength(0);
  });

  it("is allowed from jail (V2 gated only on login)", async () => {
    await db.update(playerStats)
      .set({ cash: 10_000_000n, jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, hirerId));
    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(201);
  });

  it("401s without auth", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/detectives",
      payload: { targetUsername: "Fugitive", detectives: 1, hours: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

(The `list` helper and `chicagoId`/`miamiId` are used by Task 4's describe blocks in this same file.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project @gl3/server "detectives\.test"`
Expected: FAIL — 404s (route not registered).

- [ ] **Step 3: Implement the hire route**

In `packages/plugins/detectives/src/index.ts`, extend the imports to:

```ts
import { definePlugin, InsufficientFundsError, PluginError, route, type PluginCtx } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { detectiveSearches, players } from "./schema.js";
```

Add above the resolve job:

```ts
/**
 * Settings, read at boot (restart to retune — system-wide limitation).
 * Plugin-side keys are bare; the ctx prepends "detectives." (ctx.ts:289).
 * Spec deviation recorded there: V2's shipped detectiveDuration default of
 * `1` second is treated as a bug — GL3 defaults to a real hour.
 */
const DEFAULT_COST = 125_000n;
const DEFAULT_DURATION_SECONDS = 3600;
const DEFAULT_EXPIRE_SECONDS = 600;

type Settings = { get(key: string): string | null };

function readCost(settings: Settings): bigint {
  const raw = settings.get("cost");
  if (raw === null) return DEFAULT_COST;
  return /^\d+$/.test(raw) ? BigInt(raw) : DEFAULT_COST;
}

function readSeconds(settings: Settings, key: string, fallback: number): number {
  const raw = settings.get(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const HireBodySchema = z.object({
  targetUsername: z.string().min(1).max(30),
  detectives: z.number().int().min(1).max(5),
  hours: z.number().int().min(1).max(5),
});

const hireRoute = route({
  method: "POST",
  path: "/api/detectives",
  // Explicit, though it is the SDK default: hiring from jail is allowed —
  // V2 gated only on login (spec §4).
  accessInJail: true,
  body: HireBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const cost = readCost(ctx.settings) * BigInt(body.detectives) * BigInt(body.hours);
    const durationSeconds = readSeconds(ctx.settings, "duration", DEFAULT_DURATION_SECONDS);

    const result = await ctx.transaction(async (tx) => {
      // Plain SELECT, no lock: the username -> id mapping is immutable.
      const [target] = await tx.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.username, body.targetUsername));
      // 400s, not bounties' 404: the spec (§4) pins hire-input problems to 400.
      if (!target) throw new PluginError("target_not_found", 400);
      if (target.id === player.id) throw new PluginError("cannot_search_self", 400);

      // No pair lock, deliberately (spec §2 Locks): this debit locks only the
      // hirer's own player_stats row, and the INSERT's FKs take KEY SHARE on
      // `players` rows, which nothing in the codebase locks FOR UPDATE.
      let cash: bigint;
      try {
        cash = await tx.economy.applyBalanceChange({
          playerId: player.id, amount: -cost, kind: "cash", reason: "detectives.hire",
        });
      } catch (err) {
        if (err instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
        throw err;
      }

      const id = uuidv7();
      const endsAt = new Date(Date.now() + durationSeconds * body.hours * 1000);
      await tx.db.insert(detectiveSearches).values({
        id, playerId: player.id, targetPlayerId: target.id,
        detectives: body.detectives, endsAt,
      });
      return { id, cash };
    });

    // Enqueue AFTER commit: inside the transaction a fast worker could claim
    // the job, find no row, and burn the idempotency slot before the commit
    // lands. If the enqueue itself fails the money stays gambled — the read
    // path treats NULL past ends_at as failed, so the row can never hang as
    // pending forever (spec §2).
    try {
      await ctx.jobs.enqueue("resolve", {
        searchId: result.id, detectives: body.detectives, hours: body.hours,
      });
    } catch (error) {
      ctx.log.error("failed to enqueue detectives resolve; search resolves as failed at ends_at", {
        err: String(error), searchId: result.id,
      });
    }

    return { status: 201, body: { searchId: result.id, cash: result.cash.toString() } };
  },
});
```

Change the manifest line to `routes: [hireRoute],`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project @gl3/server "detectives\.test"`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/detectives/src/index.ts apps/server/test/detectives.test.ts
git commit -m "feat(detectives): hire route with V2 gamble cost model"
```

---

### Task 4: List route — reveal gating and live tracking

**Files:**
- Modify: `packages/plugins/detectives/src/index.ts`
- Modify: `apps/server/test/detectives.test.ts` (append describe block)

**Interfaces:**
- Consumes: `hire`/`list` helpers and `chicagoId`/`miamiId` from Task 3's test file; settings readers from Task 3.
- Produces: `GET /api/detectives` → 200 `{ cost: string, searches: DetectiveSearchRow[] }` where each row is `{ id, targetId, targetUsername, detectives, startedAt, endsAt, expiresAt (all ISO strings), succeeded: boolean | null, targetLocationId: string | null, targetLocationName: string | null }`. Reveal rules: `succeeded` is `null` until `now ≥ endsAt` (then `succeeded ?? false` — a lost job reads as failed); location fields are non-null only while `succeeded === true && now < endsAt + expire`. Task 7's DTOs mirror this exactly.

- [ ] **Step 1: Write the failing reveal-gating tests**

Append to `apps/server/test/detectives.test.ts`:

```ts
describe("GET /api/detectives — reveal gating and live tracking", () => {
  /** Insert a search row directly so no resolve job races the assertions. */
  const insertSearch = async (over: {
    endsAt: Date; succeeded?: boolean | null; playerId?: string;
  }): Promise<string> => {
    const id = uuidv7();
    await db.insert(detectiveSearches).values({
      id,
      playerId: over.playerId ?? hirerId,
      targetPlayerId: targetId,
      detectives: 3,
      endsAt: over.endsAt,
      succeeded: over.succeeded ?? null,
    });
    return id;
  };

  it("hides `succeeded` while pending, even when the roll is already recorded", async () => {
    // The worker resolves minutes early by design (time-gated reveal, spec
    // §2): the row knows, the API must not say.
    await insertSearch({ endsAt: new Date(Date.now() + 60_000), succeeded: true });
    await db.update(playerStats).set({ locationId: chicagoId })
      .where(eq(playerStats.playerId, targetId));

    const res = await list(hirerToken);
    expect(res.statusCode).toBe(200);
    const { searches } = res.json();
    expect(searches).toHaveLength(1);
    expect(searches[0].succeeded).toBeNull();
    expect(searches[0].targetLocationId).toBeNull();
    expect(searches[0].targetLocationName).toBeNull();
  });

  it("reveals success and the target's CURRENT location after ends_at", async () => {
    await insertSearch({ endsAt: new Date(Date.now() - 10_000), succeeded: true });
    await db.update(playerStats).set({ locationId: chicagoId })
      .where(eq(playerStats.playerId, targetId));

    const first = list(hirerToken);
    expect((await first).json().searches[0]).toMatchObject({
      succeeded: true, targetLocationId: chicagoId, targetLocationName: "Chicago",
    });

    // Live tracking: the target travels; the next read shows the new place.
    await db.update(playerStats).set({ locationId: miamiId })
      .where(eq(playerStats.playerId, targetId));
    const second = await list(hirerToken);
    expect(second.json().searches[0]).toMatchObject({
      targetLocationId: miamiId, targetLocationName: "Miami",
    });
  });

  it("reveals a failure after ends_at, with no location", async () => {
    await insertSearch({ endsAt: new Date(Date.now() - 10_000), succeeded: false });
    const { searches } = (await list(hirerToken)).json();
    expect(searches[0].succeeded).toBe(false);
    expect(searches[0].targetLocationName).toBeNull();
  });

  it("reads a lost resolve (NULL past ends_at) as failed, never pending forever", async () => {
    await insertSearch({ endsAt: new Date(Date.now() - 10_000), succeeded: null });
    const { searches } = (await list(hirerToken)).json();
    expect(searches[0].succeeded).toBe(false);
  });

  it("hides the location once the report expires (ends_at + expire)", async () => {
    // Default expire is 600s; 700s past ends_at is expired.
    await insertSearch({ endsAt: new Date(Date.now() - 700_000), succeeded: true });
    await db.update(playerStats).set({ locationId: chicagoId })
      .where(eq(playerStats.playerId, targetId));
    const { searches } = (await list(hirerToken)).json();
    expect(searches[0].succeeded).toBe(true);
    expect(searches[0].targetLocationId).toBeNull();
    expect(searches[0].targetLocationName).toBeNull();
  });

  it("lists only the caller's own searches, newest first, with cost", async () => {
    const older = await insertSearch({ endsAt: new Date(Date.now() + 30_000) });
    const newer = await insertSearch({ endsAt: new Date(Date.now() + 60_000) });
    // A foreign row must not appear — silent to everyone but the hirer.
    await insertSearch({ endsAt: new Date(Date.now() + 60_000), playerId: targetId });

    const body = (await list(hirerToken)).json();
    expect(body.cost).toBe("125000");
    expect(body.searches).toHaveLength(2);
    expect(body.searches.map((s: { id: string }) => s.id)).toEqual([newer, older]);
    expect(body.searches[0].targetUsername).toBe("Fugitive");
    expect(typeof body.searches[0].startedAt).toBe("string");
    expect(typeof body.searches[0].endsAt).toBe("string");
    expect(typeof body.searches[0].expiresAt).toBe("string");
  });

  it("401s without auth", async () => {
    expect((await app.inject({ method: "GET", url: "/api/detectives" })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project @gl3/server "detectives\.test"`
Expected: FAIL — GET route 404s.

- [ ] **Step 3: Implement the list route**

In `packages/plugins/detectives/src/index.ts`, extend imports: `desc` from `drizzle-orm`; `locations`, `playerStats` from `./schema.js`. Add:

```ts
const listRoute = route({
  method: "GET",
  path: "/api/detectives",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const unitCost = readCost(ctx.settings);
    const expireSeconds = readSeconds(ctx.settings, "expire", DEFAULT_EXPIRE_SECONDS);

    return ctx.transaction(async (tx) => {
      // Live tracking is this un-cached join (spec §2): the target's CURRENT
      // player_stats.location_id, resolved on every read. No state to keep.
      const rows = await tx.db
        .select({
          id: detectiveSearches.id,
          targetId: detectiveSearches.targetPlayerId,
          targetUsername: players.username,
          detectives: detectiveSearches.detectives,
          startedAt: detectiveSearches.startedAt,
          endsAt: detectiveSearches.endsAt,
          succeeded: detectiveSearches.succeeded,
          targetLocationId: playerStats.locationId,
          targetLocationName: locations.name,
        })
        .from(detectiveSearches)
        .innerJoin(players, eq(players.id, detectiveSearches.targetPlayerId))
        .leftJoin(playerStats, eq(playerStats.playerId, detectiveSearches.targetPlayerId))
        .leftJoin(locations, eq(locations.id, playerStats.locationId))
        .where(eq(detectiveSearches.playerId, player.id))
        // Bounded at 100 and NOT paginated — bounties' deliberate limitation.
        .orderBy(desc(detectiveSearches.startedAt), desc(detectiveSearches.id))
        .limit(100);

      const now = Date.now();
      return {
        status: 200,
        body: {
          // Unit cost so the client can preview cost x dets x hours.
          cost: unitCost.toString(),
          searches: rows.map((r) => {
            const ended = now >= r.endsAt.getTime();
            const expiresAtMs = r.endsAt.getTime() + expireSeconds * 1000;
            // Time-gated reveal (spec §2): before ends_at the recorded roll
            // is never exposed. Past ends_at, NULL means the resolve job was
            // lost — the gamble reads as failed, never as pending forever.
            const succeeded = ended ? (r.succeeded ?? false) : null;
            const active = succeeded === true && now < expiresAtMs;
            return {
              id: r.id,
              targetId: r.targetId,
              targetUsername: r.targetUsername,
              detectives: r.detectives,
              startedAt: r.startedAt.toISOString(),
              endsAt: r.endsAt.toISOString(),
              expiresAt: new Date(expiresAtMs).toISOString(),
              succeeded,
              targetLocationId: active ? r.targetLocationId : null,
              targetLocationName: active ? r.targetLocationName : null,
            };
          }),
        },
      };
    });
  },
});
```

Change the manifest line to `routes: [hireRoute, listRoute],`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project @gl3/server "detectives\.test"`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/detectives/src/index.ts apps/server/test/detectives.test.ts
git commit -m "feat(detectives): list route with time-gated reveal and live location tracking"
```

---

### Task 5: Remove route — `DELETE /api/detectives/:searchId`

**Files:**
- Modify: `packages/plugins/detectives/src/index.ts`
- Modify: `apps/server/test/detectives.test.ts` (append describe block)

**Interfaces:**
- Consumes: test helpers from Task 3/4.
- Produces: `DELETE /api/detectives/:searchId` → 200 `{ removed: true }`; 404 `not_found` for foreign AND nonexistent rows (identical answers — no existence leak); 400 on a non-UUID param.

- [ ] **Step 1: Write the failing remove tests**

Append to `apps/server/test/detectives.test.ts`:

```ts
describe("DELETE /api/detectives/:searchId — remove", () => {
  const remove = (token: string, id: string) =>
    app.inject({
      method: "DELETE",
      url: `/api/detectives/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });

  const insertOwn = async (playerId: string): Promise<string> => {
    const id = uuidv7();
    await db.insert(detectiveSearches).values({
      id, playerId, targetPlayerId: playerId === hirerId ? targetId : hirerId,
      detectives: 1, endsAt: new Date(Date.now() - 1_000), succeeded: false,
    });
    return id;
  };

  it("removes the caller's own row", async () => {
    const id = await insertOwn(hirerId);
    const res = await remove(hirerToken, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
    expect(await db.select().from(detectiveSearches)
      .where(eq(detectiveSearches.id, id))).toHaveLength(0);
  });

  it("404s a foreign row identically to a nonexistent one — no existence leak", async () => {
    const foreign = await insertOwn(targetId);
    const onForeign = await remove(hirerToken, foreign);
    const onMissing = await remove(hirerToken, uuidv7());
    expect(onForeign.statusCode).toBe(404);
    expect(onMissing.statusCode).toBe(404);
    expect(onForeign.json().error).toBe("not_found");
    expect(onForeign.json().error).toBe(onMissing.json().error);
    // The foreign row survives.
    expect(await db.select().from(detectiveSearches)
      .where(eq(detectiveSearches.id, foreign))).toHaveLength(1);
  });

  it("400s a non-UUID param at the zod boundary", async () => {
    expect((await remove(hirerToken, "not-a-uuid")).statusCode).toBe(400);
  });

  it("401s without auth", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/detectives/${uuidv7()}` });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project @gl3/server "detectives\.test"`
Expected: FAIL — DELETE route 404s (route-level, all four cases fail).

- [ ] **Step 3: Implement the remove route**

In `packages/plugins/detectives/src/index.ts`, extend the drizzle import with `and`. Add:

```ts
const RemoveParamsSchema = z.object({ searchId: z.string().uuid() });

const removeRoute = route({
  method: "DELETE",
  path: "/api/detectives/:searchId",
  params: RemoveParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const removed = await tx.db.delete(detectiveSearches)
        .where(and(
          eq(detectiveSearches.id, params.searchId),
          eq(detectiveSearches.playerId, player.id),
        ))
        .returning({ id: detectiveSearches.id });
      // Foreign and nonexistent answer identically (spec §4): the ownership
      // predicate is in the DELETE itself, so there is no existence probe.
      if (removed.length === 0) throw new PluginError("not_found", 404);
      return { status: 200, body: { removed: true } };
    });
  },
});
```

Change the manifest line to `routes: [hireRoute, listRoute, removeRoute],`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project @gl3/server "detectives\.test"`
Expected: PASS (19 tests). Also run: `npx vitest run --project @gl3/server detectives-worker` — still PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/detectives/src/index.ts apps/server/test/detectives.test.ts
git commit -m "feat(detectives): remove route with leak-free 404"
```

---

### Task 6: `detectiveHire` op in the economy invariant sweep

**Files:**
- Modify: `apps/server/test/economy-invariant.test.ts`

**Interfaces:**
- Consumes: `POST /api/detectives` route (Task 3) via `callPluginRoute`; the plugin's default export.
- Produces: nothing downstream — this hardens `sum(ledger) == balance` over the new money path.

- [ ] **Step 1: Wire the new op (test-only change; the "failing" state is the current file not covering the path)**

In `apps/server/test/economy-invariant.test.ts`:

1. Add the import alongside the other plugin imports:

```ts
import detectivesPlugin from "@gl3/plugin-detectives";
```

2. In the `beforeAll` player-seeding loop, capture usernames. Declare next to `playerIds`:

```ts
const usernameById = new Map<string, string>();
```

and change the loop body to:

```ts
    const id = uuidv7();
    const username = `invariant${i}-${Date.now()}`;
    await db.insert(players).values({ id, username });
    usernameById.set(id, username);
```

(keeping the existing `playerStats` insert and `playerIds.push(id)` lines).

3. Extend the three op tallies (`OP_NAMES` at line 146 and both counter objects):

```ts
    const OP_NAMES = ["crime", "bank", "travel", "bullets", "points", "kill", "shopBuy", "detectiveHire"] as const;
    const attempted = { crime: 0, bank: 0, travel: 0, bullets: 0, points: 0, kill: 0, shopBuy: 0, detectiveHire: 0 };
    const succeeded = { crime: 0, bank: 0, travel: 0, bullets: 0, points: 0, kill: 0, shopBuy: 0, detectiveHire: 0 };
```

4. Add the op branch before the final `else` (the `points` branch):

```ts
        } else if (opName === "detectiveHire") {
          // Pure money sink to the house, same class as the travel fare. Cost
          // pinned low (settings written PREFIXED, as the settings table
          // stores them; the plugin asks for bare `cost`) so the sweep mostly
          // succeeds instead of mostly 409ing. The post-commit enqueue fails
          // by construction — deps.queues is an empty Map — and the route
          // logs-and-swallows that, which is exactly the "lost resolve" path
          // the list route reads as failed. The DEBIT is the invariant's
          // whole interest here; expect one logged enqueue error per op.
          const detTargetId = pick(playerIds.filter((id) => id !== playerId));
          await callPluginRoute(detectivesPlugin, "POST", "/api/detectives", {
            db, redis, leaderboardPrefix, playerId,
            body: {
              targetUsername: usernameById.get(detTargetId)!,
              detectives: 1 + Math.floor(rand() * 5),
              hours: 1 + Math.floor(rand() * 5),
            },
            settings: { "detectives.cost": "50" },
          });
```

5. Add the coverage assertion next to the existing per-op ones (after `expect(succeeded.shopBuy).toBeGreaterThan(0);`):

```ts
    // Same reasoning as bullets/travel/shopBuy: detectiveHire's expected
    // rejection (insufficient_funds late in the run) is in the accept-list,
    // so a regression that made every hire fail would otherwise pass silently
    // on the aggregate ratio alone.
    expect(succeeded.detectiveHire).toBeGreaterThan(0);
```

(No accept-list change needed: `insufficient_funds` is already accepted, and `cannot_search_self`/`target_not_found` are unreachable — the target is always a real, different player.)

- [ ] **Step 2: Run the invariant file**

Run: `npx vitest run --project @gl3/server economy-invariant`
Expected: PASS. The logged `economy-invariant op mix` line shows a non-zero `detectiveHire` tally; per-op enqueue-failure log lines are expected (see the comment in the op).

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/economy-invariant.test.ts
git commit -m "test(economy): cover detectives.hire in the ledger invariant sweep"
```

---

### Task 7: Shared DTOs + `/detectives` web page

**Files:**
- Create: `packages/shared/src/dto/detectives.ts`
- Modify: `packages/shared/src/index.ts` (export line, after `./dto/crime.js`)
- Modify: `apps/web/src/api/keys.ts` (after the `bounties` key)
- Modify: `apps/web/src/api/queries.ts` (hooks + imports)
- Create: `apps/web/src/pages/Detectives.tsx`
- Modify: `apps/web/src/App.tsx` (import + route after `bounties`)
- Modify: `apps/web/src/components/Shell.tsx` (nav entry after `Bounties`)

**Interfaces:**
- Consumes: the exact wire shapes from Tasks 3–5: `POST /api/detectives` → `{ searchId, cash }`; `GET /api/detectives` → `{ cost, searches: [{ id, targetId, targetUsername, detectives, startedAt, endsAt, expiresAt, succeeded, targetLocationId, targetLocationName }] }`; `DELETE /api/detectives/:id` → `{ removed: true }`.
- Produces: `useDetectives()`, `useHireDetectives()`, `useRemoveDetectiveSearch()` hooks; `/detectives` route.

No WS events exist for detectives (silent by design, spec §3) — **no** `invalidation.ts` entries; the page polls.

- [ ] **Step 1: Shared DTOs**

`packages/shared/src/dto/detectives.ts`:

```ts
import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

/**
 * Mirrors POST/GET/DELETE /api/detectives (packages/plugins/detectives).
 * Timestamps are ISO strings, same convention as the bounties DTO.
 */
export const HireDetectivesRequestSchema = z.object({
  targetUsername: z.string().min(1).max(30),
  detectives: z.number().int().min(1).max(5),
  hours: z.number().int().min(1).max(5),
});
export type HireDetectivesRequest = z.infer<typeof HireDetectivesRequestSchema>;

export const HireDetectivesResponseSchema = z.object({
  searchId: IdSchema,
  cash: MoneySchema,
});
export type HireDetectivesResponse = z.infer<typeof HireDetectivesResponseSchema>;

export const DetectiveSearchRowSchema = z.object({
  id: IdSchema,
  targetId: IdSchema,
  targetUsername: z.string(),
  detectives: z.number().int(),
  startedAt: z.string(),
  endsAt: z.string(),
  expiresAt: z.string(),
  /** null while pending — the server never reveals the roll before endsAt. */
  succeeded: z.boolean().nullable(),
  targetLocationId: IdSchema.nullable(),
  targetLocationName: z.string().nullable(),
});
export type DetectiveSearchRow = z.infer<typeof DetectiveSearchRowSchema>;

export const DetectiveListResponseSchema = z.object({
  /** Unit cost — the client previews cost x detectives x hours. */
  cost: MoneySchema,
  searches: z.array(DetectiveSearchRowSchema),
});
export type DetectiveListResponse = z.infer<typeof DetectiveListResponseSchema>;

export const RemoveDetectiveSearchResponseSchema = z.object({ removed: z.boolean() });
export type RemoveDetectiveSearchResponse = z.infer<typeof RemoveDetectiveSearchResponseSchema>;
```

`packages/shared/src/index.ts` — after `export * from "./dto/crime.js";` add:

```ts
export * from "./dto/detectives.js";
```

- [ ] **Step 2: Query key and hooks**

`apps/web/src/api/keys.ts` — after `bounties: () => ["bounties"] as const,`:

```ts
  detectives: () => ["detectives"] as const,
```

`apps/web/src/api/queries.ts` — add to the `@gl3/shared` import block: `DetectiveListResponseSchema`, `HireDetectivesResponseSchema`, `RemoveDetectiveSearchResponseSchema`, `type DetectiveListResponse`, `type HireDetectivesRequest`, `type HireDetectivesResponse`, `type RemoveDetectiveSearchResponse` (keeping the block's alphabetical order). Then add after `usePlaceBounty`:

```ts
export function useDetectives() {
  return useQuery<DetectiveListResponse>({
    queryKey: keys.detectives(),
    queryFn: async () => DetectiveListResponseSchema.parse(await api("/api/detectives")),
    // Reveal and live tracking are pure reads of server time (no WS event —
    // silent to the target rules out broadcast, spec §3): poll while any row
    // is pending or actively tracking, go quiet when all are settled.
    refetchInterval: (query) => {
      const rows = query.state.data?.searches ?? [];
      const now = Date.now();
      const live = rows.some(
        (s) => s.succeeded === null || (s.succeeded === true && now < Date.parse(s.expiresAt)),
      );
      return live ? 5_000 : false;
    },
  });
}

export function useHireDetectives() {
  const queryClient = useQueryClient();
  return useMutation<HireDetectivesResponse, Error, HireDetectivesRequest>({
    mutationFn: async (input) =>
      HireDetectivesResponseSchema.parse(await api("/api/detectives", {
        method: "POST", body: JSON.stringify(input),
      })),
    onSuccess: () => {
      // The hirer's cash moved and the list gained a row.
      void queryClient.invalidateQueries({ queryKey: keys.me() });
      void queryClient.invalidateQueries({ queryKey: keys.detectives() });
    },
  });
}

export function useRemoveDetectiveSearch() {
  const queryClient = useQueryClient();
  return useMutation<RemoveDetectiveSearchResponse, Error, string>({
    mutationFn: async (searchId) =>
      RemoveDetectiveSearchResponseSchema.parse(await api(`/api/detectives/${searchId}`, {
        method: "DELETE",
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.detectives() });
    },
  });
}
```

- [ ] **Step 3: The page**

`apps/web/src/pages/Detectives.tsx`:

```tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import type { DetectiveSearchRow } from "@gl3/shared";
import { useDetectives, useHireDetectives, useRemoveDetectiveSearch } from "../api/queries.js";
import { ErrorText, Loading, Money, Panel, When } from "../components/ui.js";
import styles from "./pages.module.css";

const UNITS = [1, 2, 3, 4, 5] as const;

/** pending | failed | succeeded-expired | succeeded-active — spec §3's states. */
function rowState(row: DetectiveSearchRow, nowMs: number): "pending" | "failed" | "expired" | "active" {
  if (row.succeeded === null) return "pending";
  if (row.succeeded === false) return "failed";
  return nowMs < Date.parse(row.expiresAt) ? "active" : "expired";
}

function SearchRow({ row }: { row: DetectiveSearchRow }): JSX.Element {
  const removeSearch = useRemoveDetectiveSearch();
  const state = rowState(row, Date.now());
  return (
    <li className={styles.row}>
      <span>
        {row.detectives} detective{row.detectives === 1 ? "" : "s"} on {row.targetUsername}
      </span>
      {state === "pending" ? (
        <span className={styles.meta}>
          searching — report due <When iso={row.endsAt} />
        </span>
      ) : null}
      {state === "failed" ? (
        <span className={styles.bad}>came back empty-handed</span>
      ) : null}
      {state === "expired" ? (
        <span className={styles.meta}>found them, but the trail went cold</span>
      ) : null}
      {state === "active" ? (
        <span>
          spotted in <strong>{row.targetLocationName}</strong> (live, until{" "}
          <When iso={row.expiresAt} />) <Link to="/travel">Travel there</Link>
        </span>
      ) : null}
      {state !== "pending" ? (
        <button
          type="button"
          disabled={removeSearch.isPending}
          onClick={() => removeSearch.mutate(row.id)}
        >
          Remove
        </button>
      ) : null}
      <ErrorText error={removeSearch.error} />
    </li>
  );
}

export function Detectives(): JSX.Element {
  const detectives = useDetectives();
  const hire = useHireDetectives();
  const [targetUsername, setTargetUsername] = useState("");
  const [dets, setDets] = useState(1);
  const [hours, setHours] = useState(1);

  if (detectives.isLoading) return <Loading what="detectives" />;
  if (detectives.error) return <ErrorText error={detectives.error} />;

  const rows = detectives.data?.searches ?? [];
  // Money stays a decimal string end to end — bigint math, never a JSON number.
  const totalCost = (BigInt(detectives.data?.cost ?? "0") * BigInt(dets) * BigInt(hours)).toString();
  const valid = targetUsername.length >= 1;

  return (
    <Panel title="Detectives">
      <div className={styles.form}>
        <label>
          <span className={styles.meta}>Target username </span>
          <input
            maxLength={30}
            value={targetUsername}
            onChange={(e) => setTargetUsername(e.target.value.trim())}
            aria-label="Target username"
          />
        </label>
        <label>
          <span className={styles.meta}>Detectives </span>
          <select value={dets} onChange={(e) => setDets(Number(e.target.value))} aria-label="Detectives">
            {UNITS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>
          <span className={styles.meta}>Hours </span>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Hours">
            {UNITS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span className={styles.meta}>
          Cost: <Money value={totalCost} /> — success chance {dets * 4 * hours}%
        </span>
        <button
          type="button"
          disabled={!valid || hire.isPending}
          onClick={() => {
            if (!valid) return;
            hire.mutate({ targetUsername, detectives: dets, hours }, {
              onSuccess: () => setTargetUsername(""),
            });
          }}
        >
          Hire
        </button>
      </div>
      <ErrorText error={hire.error} />

      <h3 className={styles.meta}>Your searches</h3>
      {rows.length === 0 ? (
        <p className={styles.meta}>No searches yet. Hire detectives to hunt a player down.</p>
      ) : (
        <ul className={styles.rows}>
          {rows.map((row) => <SearchRow key={row.id} row={row} />)}
        </ul>
      )}
    </Panel>
  );
}
```

(Class names `form`, `meta`, `bad`, `rows`, `row` all exist in `pages.module.css` — Bounties.tsx uses the same set. Do not add new CSS.)

- [ ] **Step 4: Route and nav**

`apps/web/src/App.tsx` — add the import next to `Bounties`:

```ts
import { Detectives } from "./pages/Detectives.js";
```

and after `<Route path="bounties" element={<Bounties />} />`:

```tsx
          <Route path="detectives" element={<Detectives />} />
```

`apps/web/src/components/Shell.tsx` — after `["/bounties", "Bounties"],`:

```ts
  ["/detectives", "Detectives"],
```

- [ ] **Step 5: Typecheck and web tests**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npx vitest run --project @gl3/web`
Expected: PASS (no detectives-specific web tests — the suite here is unit-level; this run proves the imports/keys changes broke nothing).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/dto/detectives.ts packages/shared/src/index.ts apps/web/src/api/keys.ts apps/web/src/api/queries.ts apps/web/src/pages/Detectives.tsx apps/web/src/App.tsx apps/web/src/components/Shell.tsx
git commit -m "feat(web): detectives page with hire form, reveal states and live tracking"
```

---

### Task 8: Docs + full verification

**Files:**
- Modify: `docs/STATUS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full local suite (the check CI cannot run)**

Run: `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"`
Expected: `exit=0`. Read the log tail for the totals; the pre-plan baseline was 91 files / 767 tests — this plan adds 2 files and ~24 tests. Any non-zero exit is a failure even if every test printed green. Do not run this while any other suite is running.

- [ ] **Step 2: Registration-site spot checks**

Run: `grep -c "packages/plugins/detectives" Dockerfile.server` → `5`.
Run: `npx tsc --build --force apps/server/tsconfig.json` → exit 0.

- [ ] **Step 3: Update the docs**

`docs/STATUS.md`: add a short section alongside the bounties entry recording: detectives plugin shipped (hire/list/remove routes, `resolve` job — second real user of the plugin job system, so the `plugin_job_runs (plugin_id, job_id)` PK gap stays a watch item, now with two single-job plugins); time-gated reveal in place of delayed jobs; settings `detectives.cost` / `detectives.duration` / `detectives.expire` (bare keys plugin-side — the spec's V2 names adapted to the ctx prefix); the deliberate absences (no lock-order test, no combat coupling, no WS events, no target notification); test locations.

`CLAUDE.md`: in the "Current state" section, extend the bounties sentence's neighborhood with one sentence: the **detectives** plugin has since shipped (cross-location hunting: paid seeded search, time-gated reveal, live-location tracking; spec + tests are its behaviour record).

- [ ] **Step 4: Commit**

```bash
git add docs/STATUS.md CLAUDE.md
git commit -m "docs: record the detectives plugin in STATUS and CLAUDE"
```

---

## Spec coverage map (self-review record)

| Spec section | Task |
|---|---|
| §1 package, schema mirrors, one job, settings, 8 registration sites, no combat coupling | 1, 2 (settings adapted: bare keys — Global Constraints) |
| §2 hire flow (debit → insert → enqueue-after-commit) | 3 |
| §2 roll in worker, seeded, idempotent | 2 |
| §2 time-gated reveal, live-tracking join, silent to target | 4 |
| §2 remove, no existence leak | 5 |
| §2 locks paragraph (no pair lock, recorded) | Global Constraints + Task 3 comment |
| §3 web page, states, polling, no WS | 7 |
| §4 error codes, jail access | 3, 5 |
| §5 tests: hire/reveal/live-join/remove | 3, 4, 5 |
| §5 tests: worker determinism, idempotency, 4%/100% boundaries | 2 |
| §5 economy-invariant `detectiveHire` op | 6 |
| §5 no lock-order test (deliberate) | Global Constraints |
| §5 vitest include + srcAliases (silent failure modes) | 1, 2 |
| §6 out of scope | untouched everywhere |
