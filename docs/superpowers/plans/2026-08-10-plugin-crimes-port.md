# Crimes Plugin Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `apps/server/src/game/crimes/` (routes + BullMQ worker) to a new `@gl3/plugin-crimes` package — the seventh module port and the first with a worker.

**Architecture:** Two routes (`GET /api/crimes`, `POST /api/crimes/:crimeId/commit`) and one BullMQ job (`commit`) move into `packages/plugins/crimes/`. The job ports `processCrimeJob` into the plugin transaction model: the `plugin_job_runs` idempotency guard replaces `crime_log.job_id`'s role; leaderboard scores and event publishing are absorbed by the ctx. Core's `game/crimes/` and the `queue/` module are deleted.

**Tech Stack:** TypeScript (strict, ESM, `.js` import extensions), Drizzle ORM 0.45.2, Zod 3.23, BullMQ 5.x, Fastify 5, `@gl3/plugin-sdk`.

**Spec:** `docs/superpowers/specs/2026-08-10-plugin-crimes-port-design.md` (read it first).

## Global Constraints

- **TypeScript strict, no `any` in `packages/*`** — none, not even a cast. In `apps/*` prefer `unknown` + zod.
- **ESM only; relative imports carry `.js` extensions** despite `.ts` sources.
- **Money is `bigint`**, crosses the wire as a decimal string (`MoneySchema`). Never a JSON number.
- **Bigint column defaults** written `` .default(sql`0`) ``, never `.default(0n)`.
- **Zod-validates every external boundary** — route params, bodies.
- **Eight registration sites for a new plugin package**, three fail silently or only in CI (see Task 2).
- **Run `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"` and read the exit code**, not the summary. Treat any non-zero exit as failure even if every test passed.
- **Never run two full suites at once.** Never `FLUSHALL`/`FLUSHDB` Redis.
- Environment: PostgreSQL 16 + Redis 7 run natively (no Docker). `export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3` and `export REDIS_URL=redis://localhost:6379` first.

---

### Task 1: Restore `attempts: 3` on plugin queues

The plugin loader's `createPluginQueues` passes only `{ connection: redis }` to BullMQ, and BullMQ's default is `attempts: 1` (no retry). Core's crime queue uses `attempts: 3`. Without a fix, plugin jobs never retry — making the spec's replay gap (§2) unreachable at runtime AND turning transient failures into permanent event losses. This is a shared loader change (spec §2.5): every plugin job gains retries, which is the intent, because the at-least-once model and the `plugin_job_runs` guard assume retries can happen.

**Files:**
- Modify: `apps/server/src/plugins/jobs.ts:23-34` (`createPluginQueues`)
- Test: `apps/server/test/plugin-jobs.test.ts` (existing — add an assertion)

**Interfaces:**
- Consumes: nothing new.
- Produces: plugin queues with `defaultJobOptions` matching core's crime queue. No signature change.

- [ ] **Step 1: Read the current `createPluginQueues` and core's crime queue options**

Read `apps/server/src/plugins/jobs.ts:23-34` and `apps/server/src/queue/index.ts:18-28`. Core's `defaultJobOptions`:
```ts
defaultJobOptions: {
  attempts: 3,
  backoff: { type: "exponential", delay: 500 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
},
```

- [ ] **Step 2: Add a failing test asserting the queue carries retry options**

In `apps/server/test/plugin-jobs.test.ts`, add a test inside the existing `describe("plugin jobs", …)` block. The test needs to inspect the options a created queue would carry. `createPluginQueues` returns `Map<string, Queue>`; a BullMQ `Queue` exposes its opts via `.opts`. Add after the last existing `it(...)`:

```ts
it("creates plugin queues with attempts:3 retry options", async () => {
  const manifest = definePlugin({
    id: "retry-opts", version: "1.0.0", basePaths: ["/api/retry-opts"],
    jobs: { work: async () => {} },
  });
  const queues = createPluginQueues(redis, [manifest], "test-prefix-");
  const queue = queues.get("retry-opts:work");
  expect(queue).toBeDefined();
  // attempts:3 — without this, BullMQ defaults to 1 and plugin jobs never retry,
  // which defeats the plugin_job_runs idempotency guard (spec §2.5).
  expect(queue!.opts.defaultJobOptions?.attempts).toBe(3);
  expect(queue!.opts.defaultJobOptions?.backoff).toEqual({ type: "exponential", delay: 500 });
});
```

Add `createPluginQueues` to the existing import from `"../src/plugins/jobs.js"` at the top of the file (it currently imports only `runPluginJob`).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/server/test/plugin-jobs.test.ts -t "attempts:3"`
Expected: FAIL — `queue!.opts.defaultJobOptions?.attempts` is `undefined` (BullMQ defaults `attempts: 1`, and `defaultJobOptions` is not set).

- [ ] **Step 4: Add `defaultJobOptions` to `createPluginQueues`**

In `apps/server/src/plugins/jobs.ts`, edit the `new Queue(...)` call inside `createPluginQueues` (around line 29-31). Change:

```ts
      queues.set(`${manifest.id}:${jobName}`, new Queue(
        pluginQueueName(prefix, manifest.id, jobName), { connection: redis },
      ));
```

to:

```ts
      queues.set(`${manifest.id}:${jobName}`, new Queue(
        pluginQueueName(prefix, manifest.id, jobName),
        {
          connection: redis,
          // Match core's crime queue (`queue/index.ts:21-26`): BullMQ's default
          // is attempts:1 (no retry), which would defeat the plugin_job_runs
          // idempotency guard (spec §2.5) and turn transient failures into
          // permanent event losses. The guard makes a retry safe for any job.
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: "exponential", delay: 500 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        },
      ));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/server/test/plugin-jobs.test.ts -t "attempts:3"`
Expected: PASS.

- [ ] **Step 6: Run the full plugin-jobs test file to confirm no regression**

Run: `npx vitest run apps/server/test/plugin-jobs.test.ts`
Expected: all tests PASS (3 existing + 1 new).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/plugins/jobs.ts apps/server/test/plugin-jobs.test.ts
git commit -m "fix(plugins): restore attempts:3 retry options on plugin queues

BullMQ defaults to attempts:1; createPluginQueues passed only
{ connection }, so plugin jobs never retried. Copy core's crime queue
defaultJobOptions so the plugin_job_runs guard (at-least-once model)
is actually exercised. Spec §2.5."
```

---

### Task 2: Scaffold the `@gl3/plugin-crimes` package + registration sites

Create the plugin package skeleton with its schema mirrors and wire all the registration sites that fail silently or only in CI. The plugin compiles and is importable but is NOT yet loaded (adding it to `core-plugins.ts` happens at cutover in Task 5, because loading it then would double-register `/api/crimes` against the still-present core routes).

**Files:**
- Create: `packages/plugins/crimes/package.json`
- Create: `packages/plugins/crimes/tsconfig.json`
- Create: `packages/plugins/crimes/src/schema.ts`
- Create: `packages/plugins/crimes/src/index.ts` (minimal shell — routes/job added in Task 3)
- Modify: `apps/server/package.json` (dependencies block)
- Modify: `apps/server/tsconfig.json` (references)
- Modify: `tsconfig.json` (root references)
- Modify: `vitest.workspace.ts` (srcAliases)
- Modify: `Dockerfile.server` (5 COPY lines)

**Interfaces:**
- Consumes: `@gl3/plugin-sdk` (`definePlugin`, `route`, types).
- Produces: `@gl3/plugin-crimes` default export — a `PluginManifest` with id `crimes`. Task 3 fills in routes + job.

- [ ] **Step 1: Create `packages/plugins/crimes/package.json`**

Mirror `packages/plugins/bullets/package.json` exactly, changing only the name:

```json
{
  "name": "@gl3/plugin-crimes",
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

- [ ] **Step 2: Create `packages/plugins/crimes/tsconfig.json`**

Mirror `packages/plugins/bullets/tsconfig.json` exactly:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../plugin-sdk" }]
}
```

- [ ] **Step 3: Create `packages/plugins/crimes/src/schema.ts` — three table mirrors**

Mirrors of three core-owned tables. Column names and types match `apps/server/src/db/schema/` exactly — `crimes` and `crime_log` in `economy.ts`/`content.ts`, `player_crime_skill` in `identity.ts`. Read those three definitions first to confirm column names/types before writing. `crime_log` is written by the job; the other two are read-only here.

```ts
import { bigint, boolean, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read mirrors of three core-owned tables (spec §3.1), same pattern as
 * `packages/plugins/bullets/src/schema.ts`: column names and types match
 * `apps/server/src/db/schema/` exactly, none is declared in this plugin's
 * manifest, and none gets a migration here — core owns and migrates all
 * three. `crime_log` is written by the commit job; `crimes` and
 * `player_crime_skill` are read only.
 */
export const crimes = pgTable("crimes", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  cooldownSeconds: integer("cooldown_seconds").notNull(),
  minPayout: bigint("min_payout", { mode: "bigint" }).notNull(),
  maxPayout: bigint("max_payout", { mode: "bigint" }).notNull(),
  minBullets: integer("min_bullets").notNull(),
  maxBullets: integer("max_bullets").notNull(),
  expReward: bigint("exp_reward", { mode: "bigint" }).notNull(),
  jailChancePercent: integer("jail_chance_percent").notNull(),
  jailSeconds: integer("jail_seconds").notNull(),
  sort: integer("sort").notNull(),
});

export const playerCrimeSkill = pgTable("player_crime_skill", {
  playerId: uuid("player_id").notNull(),
  crimeId: uuid("crime_id").notNull(),
  chance: numeric("chance", { precision: 5, scale: 2 }).notNull(),
});

export const crimeLog = pgTable("crime_log", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull(),
  crimeId: uuid("crime_id").notNull(),
  success: boolean("success").notNull(),
  payout: bigint("payout", { mode: "bigint" }).notNull(),
  jobId: text("job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
```

**Verify the column list against the source schema before committing.** Read `apps/server/src/db/schema/content.ts` (the `crimes` table) and `apps/server/src/db/schema/economy.ts` (the `crimeLog` table) and `apps/server/src/db/schema/identity.ts` (the `playerCrimeSkill` table) and fix any name/type mismatch. `playerCrimeSkill`'s PK is composite `(player_id, crime_id)` — but a mirror used only for `select` does not need the PK declared; match `bullets/src/schema.ts`, which omits indexes on its mirrors.

- [ ] **Step 4: Create `packages/plugins/crimes/src/index.ts` — minimal shell**

A manifest that compiles and exports, with no routes or jobs yet (Task 3 adds them):

```ts
import { definePlugin } from "@gl3/plugin-sdk";

export default definePlugin({
  id: "crimes",
  version: "1.0.0",
  basePaths: ["/api/crimes"],
  routes: [],
  // No menu, pages or events: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. The job is added in Task 3.
});
```

- [ ] **Step 5: Register in `apps/server/package.json`**

In `apps/server/package.json`, add `"@gl3/plugin-crimes": "*",` to the `"dependencies"` block (alphabetical — it goes after `@gl3/plugin-bullets`, before `@gl3/plugin-notifications`). Then run `npm install` from the repo root:

```bash
cd /home/dlite/GL3 && npm install
```

- [ ] **Step 6: Register in `apps/server/tsconfig.json`**

In `apps/server/tsconfig.json`, the `"references"` array (line 9) is one long line of `{ "path": "..." }` entries. Add `{ "path": "../../packages/plugins/crimes" }` after the `bullets` entry. This site **fails only in CI** — catch locally next step.

- [ ] **Step 7: Register in root `tsconfig.json`**

In `tsconfig.json` (repo root), the `"references"` array lists project paths. Add `{ "path": "./packages/plugins/crimes" }` after the bullets entry.

- [ ] **Step 8: Add the `srcAliases` entry in `vitest.workspace.ts`**

In `vitest.workspace.ts`, the `srcAliases` object (starts line 17) maps plugin package names to source. Add after the `@gl3/plugin-bullets` entry (around line 42):

```ts
      "@gl3/plugin-crimes": fileURLToPath(
        new URL("./packages/plugins/crimes/src/index.ts", import.meta.url),
      ),
```

This site **fails nothing silently** — without it, a test importing `@gl3/plugin-crimes` resolves to a stale `dist/` and a src-only edit grades as a false green.

- [ ] **Step 9: Add the 5 COPY lines to `Dockerfile.server`**

There are 5 places each plugin appears as a COPY target. Read `Dockerfile.server` first to find the exact lines (they move as plugins are added). For `crimes`, add a line in each of these 5 spots, in the same position `travel` occupies relative to `bullets` (crimes goes after travel in each list):

1. Stage-1 package.json copies (around line 55, after the `travel` line): `COPY packages/plugins/crimes/package.json packages/plugins/crimes/`
2. Stage-1 tsconfig copy (around line 77, after travel): `COPY packages/plugins/crimes/tsconfig.json packages/plugins/crimes/tsconfig.json`
3. Stage-1 src copy (around line 78, after the tsconfig line you just added): `COPY packages/plugins/crimes/src packages/plugins/crimes/src`
4. Stage-2 package.json copy (around line 120, after travel): `COPY packages/plugins/crimes/package.json packages/plugins/crimes/`
5. Stage-2 dist copy (around line 136, after travel): `COPY --from=builder /app/packages/plugins/crimes/dist packages/plugins/crimes/dist`

After editing, verify the count: `grep -c "plugins/crimes" Dockerfile.server` must print `5`.

- [ ] **Step 10: Verify the typecheck builds (catches the CI-only tsconfig site)**

Run: `npx tsc --build --force apps/server/tsconfig.json`
Expected: completes with no errors. This is the exact command the CI image build runs.

- [ ] **Step 11: Run the root typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 12: Commit**

```bash
git add packages/plugins/crimes apps/server/package.json apps/server/tsconfig.json tsconfig.json vitest.workspace.ts Dockerfile.server package-lock.json
git commit -m "feat(crimes): scaffold @gl3/plugin-crimes package + registration sites

Package skeleton, schema mirrors (crimes, crime_log, player_crime_skill)
and all eight registration sites except core-plugins.ts (added at cutover
to avoid double-registering /api/crimes against core). Spec §3.1, §8."
```

---

### Task 3: Implement the routes and the commit job

Port `game/crimes/routes.ts` (two routes) and `game/crimes/worker.ts` (the `processCrimeJob` worker) into the plugin's `index.ts`. This is the core of the port. Read both source files in full before starting — they are being translated, not rewritten.

**Files:**
- Modify: `packages/plugins/crimes/src/index.ts` (replace the shell with the full plugin)

**Interfaces:**
- Consumes: `@gl3/plugin-sdk` (`definePlugin`, `route`, `PluginError`, types `PluginCtx`, `RouteResult`, `PlayerSnapshot`, `RankUpResult`); the schema mirrors from Task 2.
- Produces: the `crimes` manifest with `listRoute`, `commitRoute`, and a `commit` job. Loaded at cutover (Task 5); tested directly (Task 4).

- [ ] **Step 1: Read the source files being ported**

Read `apps/server/src/game/crimes/routes.ts` (94 lines) and `apps/server/src/game/crimes/worker.ts` (235 lines) in full. Also re-read `packages/plugins/travel/src/index.ts` (the closest precedent — it shows the route/transaction/`publishCore` shape) and `packages/plugins/bullets/src/index.ts` (the `accessInJail` + `ctx.transaction` shape).

- [ ] **Step 2: Write the full `packages/plugins/crimes/src/index.ts`**

Replace the shell from Task 2 with the complete plugin. The structure:

```ts
import {
  definePlugin, InsufficientFundsError, PluginError, route,
  type PluginCtx, type RankUpResult, type RouteResult,
} from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { crimeLog, crimes, playerCrimeSkill } from "./schema.js";
import { playerStats } from "./schema.js";
import { players } from "./schema.js";

/**
 * Ported from `apps/server/src/game/crimes/routes.ts` and `worker.ts`. Paths,
 * status codes, error strings and response bodies are unchanged. The
 * idempotency guard moves from `crime_log.job_id` to `plugin_job_runs`
 * (structural in ctx.transaction), and one behaviour changes on a retried
 * already-committed job: it emits zero events where core republished
 * `crime.resolved` (spec §2 — accepted deviation).
 *
 * `@gl3/shared` is off-limits to a plugin package, so `IdSchema` is restated.
 */
const IdSchema = z.string().uuid();
const CommitCrimeParamsSchema = z.object({ crimeId: IdSchema });

/** V2 shipped a default ladder starting at 35% (spec §1.2 US_crimes default). */
const DEFAULT_CRIME_CHANCE = "35.00";
```

Add a `playerStats` mirror and a `players` mirror to `src/schema.ts` first (the job needs `player_stats.jailedUntil` for the in-tx read per spec §4.4, and `players.username` for the actor name since `ctx.player` is null inside a job). Append to `packages/plugins/crimes/src/schema.ts`:

```ts
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  jailedUntil: timestamp("jailed_until", { withTimezone: true }),
});
```

(Adjust the import list at the top of `schema.ts` if `timestamp` is not yet imported — it is, from Task 2.)

Now the **list route** — port `routes.ts:26-47`. Read into one `ctx.transaction` (matching the ported-read pattern every prior port uses):

```ts
const listRoute = route({
  method: "GET",
  path: "/api/crimes",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const cooldownRemaining = await ctx.cooldown.peek("crime", player.id);

    return ctx.transaction(async (tx) => {
      const rows = await tx.db.select().from(crimes);
      const skills = await tx.db.select().from(playerCrimeSkill)
        .where(eq(playerCrimeSkill.playerId, player.id));
      const skillByCrime = new Map(skills.map((s) => [s.crimeId, s.chance]));

      return {
        status: 200,
        body: {
          crimes: rows.map((crime) => ({
            id: crime.id,
            name: crime.name,
            description: crime.description,
            cooldownSeconds: crime.cooldownSeconds,
            minPayout: crime.minPayout.toString(),
            maxPayout: crime.maxPayout.toString(),
            chance: skillByCrime.get(crime.id) ?? DEFAULT_CRIME_CHANCE,
            cooldownRemaining,
          })),
        },
      };
    });
  },
});
```

Note: core ordered crimes by `asc(crimes.sort)`. The mirror `select()` returns no guaranteed order. Add `.orderBy` — import `asc` from `drizzle-orm` and use `tx.db.select().from(crimes).orderBy(asc(crimes.sort))`. (Confirm `sort` is on the mirror — it is, from Task 2.)

The **commit route** — port `routes.ts:49-93`. `accessInJail: false` (the loader emits the 423 + retry-after). Look the crime up before the cooldown, claim the cooldown, enqueue, release on failure:

```ts
const commitRoute = route({
  method: "POST",
  path: "/api/crimes/:crimeId/commit",
  accessInJail: false,
  params: CommitCrimeParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { crimeId } = params;

    // Look the crime up BEFORE claiming the cooldown so a typo costs nothing.
    const crime = await ctx.transaction(async (tx) => {
      const [row] = await tx.db.select().from(crimes).where(eq(crimes.id, crimeId));
      return row ?? null;
    });
    if (crime === null) throw new PluginError("crime_not_found", 404);

    const won = await ctx.cooldown.acquire("crime", player.id, crime.cooldownSeconds);
    if (!won) {
      const retryAfter = await ctx.cooldown.peek("crime", player.id);
      throw new PluginError(
        "on_cooldown",
        429,
        { retryAfter },
        { "retry-after": String(Math.max(retryAfter, 1)) },
      );
    }

    try {
      const jobId = await ctx.jobs.enqueue("commit", { playerId: player.id, crimeId });
      return { status: 202, body: { jobId, accepted: true } };
    } catch (error) {
      try {
        await ctx.cooldown.release("crime", player.id);
      } catch (releaseError) {
        ctx.log.error("failed to release crime cooldown after enqueue failure", {
          err: String(releaseError), playerId: player.id, crimeId,
        });
      }
      throw error;
    }
  },
});
```

The **commit job** — port `processCrimeJob` (`worker.ts:50-225`) per spec §4. `ctx.job` is non-null inside a job; `ctx.player` is null. The handler signature is `(ctx, data)`:

```ts
async function commitJob(ctx: PluginCtx, data: Record<string, unknown>): Promise<void> {
  const playerId = String(data["playerId"]);
  const crimeId = String(data["crimeId"]);
  const rng = ctx.job?.rng;
  if (rng === undefined) throw new Error("commit job ran without a seeded rng");

  // Pre-tx reads (spec §4.1) — ctx.player is null inside a job.
  const crime = await ctx.transaction(async (tx) => {
    const [row] = await tx.db.select().from(crimes).where(eq(crimes.id, crimeId));
    return row ?? null;
  });
  if (crime === null) return; // crime deleted between enqueue and resolve

  const actorName = await ctx.transaction(async (tx) => {
    const [row] = await tx.db.select({ username: players.username })
      .from(players).where(eq(players.id, playerId));
    return row?.username ?? null;
  });
  if (actorName === null) return; // player deleted

  const skillChance = await ctx.transaction(async (tx) => {
    const [row] = await tx.db.select({ chance: playerCrimeSkill.chance })
      .from(playerCrimeSkill).where(eq(playerCrimeSkill.playerId, playerId));
    return row?.chance ?? null;
  });
  const chance = Number(skillChance ?? DEFAULT_CRIME_CHANCE);

  // The roll (spec §4.2) — seeded, identical draws to core.
  const roll = rng.int(0, 10_000);
  const success = roll < Math.round(chance * 100);
  const payout = success ? rng.bigint(crime.minPayout, crime.maxPayout) : 0n;
  const bullets = success ? BigInt(rng.int(crime.minBullets, crime.maxBullets + 1)) : 0n;
  const exp = success ? crime.expReward : 0n;
  const jailRoll = !success && crime.jailChancePercent > 0 ? rng.int(0, 100) : 100;
  const jailed = jailRoll < crime.jailChancePercent;

  // The one transaction (spec §4.3). plugin_job_runs insert is already first
  // (structural in ctx.transaction); a retry throws JobAlreadyAppliedError
  // before this closure body runs.
  let promotion: RankUpResult | null = null;
  await ctx.transaction(async (tx) => {
    await tx.db.insert(crimeLog).values({
      id: uuidv7(), playerId, crimeId, success, payout, jobId: ctx.job!.id,
    });
    if (payout > 0n) {
      await tx.economy.applyBalanceChange(
        { playerId, amount: payout, kind: "cash", reason: "crime.payout", refId: crimeId });
    }
    if (exp > 0n) promotion = await tx.economy.applyExpAndRankUp(playerId, exp);
    if (jailed) await tx.jail.sendToJail(playerId, crime.jailSeconds);

    // In-tx read for effectiveJailedUntil (spec §4.4) — same connection sees
    // its own write; the value crime.resolved reports on the fresh path.
    const [fresh] = await tx.db.select({ jailedUntil: playerStats.jailedUntil })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    const effectiveJailedUntil = fresh?.jailedUntil ?? null;

    // Buffered events, flushed after commit in this order (spec §4.3 step 6).
    // crime.resolved first, then player.jailed, then player.rankedUp.
    await tx.events.publishCore({
      type: "crime.resolved",
      actorId: playerId,
      actorName,
      audience: { kind: "player", playerId },
      crimeId,
      crimeName: crime.name,
      success,
      payout: payout.toString(),
      bullets: bullets.toString(),
      exp: exp.toString(),
      jailedUntil: effectiveJailedUntil ? effectiveJailedUntil.toISOString() : null,
    });
    if (jailed) {
      await tx.events.publishCore({
        type: "player.jailed",
        actorId: playerId,
        actorName,
        audience: { kind: "player", playerId },
        until: effectiveJailedUntil!.toISOString(),
        reason: "crime.failed",
      });
    }
    if (promotion) {
      await tx.events.publishCore({
        type: "player.rankedUp",
        actorId: playerId,
        actorName,
        audience: { kind: "player", playerId },
        rankId: promotion.rankId,
        rankName: promotion.rankName,
        cashReward: promotion.cashReward.toString(),
        bulletReward: promotion.bulletReward,
        maxHealth: promotion.maxHealth,
      });
    }
  });
  // No post-commit work: leaderboard scores and events are flushed by the ctx.
}
```

Finally the **manifest**, exporting the default plugin with both routes and the job:

```ts
export default definePlugin({
  id: "crimes",
  version: "1.0.0",
  basePaths: ["/api/crimes"],
  routes: [listRoute, commitRoute],
  jobs: { commit: commitJob },
  // No menu, pages or events: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }.
});
```

**Check the `GameEvent` field names.** The `publishCore` calls above use the field names from `worker.ts:170-224` (`crimeName`, `bullets`, `exp`, `jailedUntil`, `until`, `reason`, `rankId`, etc.). The SDK's `CoreEventInput` is derived from `GameEventSchema`, so a wrong field name is a compile error — if `tsc` rejects a field, read `packages/shared/src/dto/events.ts` for the exact name rather than guessing.

- [ ] **Step 3: Build the plugin package in isolation**

Run: `npx tsc --build --force packages/plugins/crimes/tsconfig.json`
Expected: no errors. If a field name on `publishCore` or a schema column is wrong, fix it from the source (the error names the field/column).

- [ ] **Step 4: Build the whole server (catches cross-package references)**

Run: `npx tsc --build --force apps/server/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Run the root typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/crimes/src/index.ts packages/plugins/crimes/src/schema.ts
git commit -m "feat(crimes): implement routes and commit job

Port game/crimes/routes.ts (list + commit routes) and worker.ts
(processCrimeJob) into the plugin. Idempotency moves to plugin_job_runs;
leaderboard + event publishing absorbed by the ctx. Spec §3-4."
```

---

### Task 4: Retarget the direct-call tests to the plugin job

The three test files that call `processCrimeJob` directly must drive the plugin's `commit` job via `runPluginJob` instead. The job is not loaded yet (cutover is Task 5), but `runPluginJob` exercises the real handler in-process. This task also satisfies the proof-it-can-fail discipline on idempotency.

**Files:**
- Modify: `apps/server/test/crime-worker-idempotency.test.ts`
- Modify: `apps/server/test/crimes.test.ts:137-210` (the `processCrimeJob` describe block)
- Modify: `apps/server/test/economy-invariant.test.ts` (imports + the crime op)

**Interfaces:**
- Consumes: `runPluginJob` from `apps/server/src/plugins/jobs.ts`; `crimesPlugin` from `@gl3/plugin-crimes`.
- Produces: three test files that pass against the plugin job, independent of cutover.

- [ ] **Step 1: Retarget `crime-worker-idempotency.test.ts`**

This file calls `processCrimeJob(db, publisher, job)` and (in the rank test) `processCrimeJob(db, publisher, job)` twice. Replace:

1. Change the import `import { processCrimeJob } from "../src/game/crimes/worker.js";` to:
   ```ts
   import { runPluginJob } from "../src/plugins/jobs.js";
   import crimesPlugin from "@gl3/plugin-crimes";
   ```
2. Build the deps object once (the plugin ctx needs `db`, `redis`, an empty queues map, empty settings, and the file's existing `leaderboardPrefix`). Near the other top-level consts, add:
   ```ts
   // runPluginJob drives the real plugin handler in-process (no HTTP, no
   // boot) with the real plugin_job_runs guard — the same shape a BullMQ
   // retry takes.
   const deps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: "idempotency-test" });
   ```
   Note: the existing `publisher` and `subscriber` consts stay — the plugin publishes through `redis` (the ctx uses `deps.redis` as its publisher internally), and the test still subscribes to `GAME_EVENTS_CHANNEL` to observe events.
3. Replace each `processCrimeJob(db, publisher, job)` call with:
   ```ts
   await runPluginJob(deps(), crimesPlugin, "commit", job);
   ```
   where `job` is the existing `{ id, data: { playerId, crimeId, seed } }` object — `runPluginJob` reads `job.id` and `job.data`, matching.

4. **The event-count assertion (spec §2).** In the first test (`"does not double-pay..."`), the line:
   ```ts
   expect(events).toHaveLength(2);
   ```
   becomes:
   ```ts
   // Spec §2: a retried already-committed job emits ONE event, not two.
   // Core republished crime.resolved on replay (worker.ts Decision 1); the
   // plugin framework swallows the replay (JobAlreadyAppliedError aborts the
   // handler before any publishCore), so only the first run's event arrives.
   expect(events).toHaveLength(1);
   ```

The DB-state assertions (`logs.toHaveLength(1)`, `ledger.toHaveLength(1)`, `stats.cash` matched once, jail not extended, rank not doubled) are unchanged — `plugin_job_runs` still guards them.

- [ ] **Step 2: Run the idempotency test to verify it passes**

Run: `npx vitest run apps/server/test/crime-worker-idempotency.test.ts`
Expected: PASS. All three describes (double-pay, jail, rank-up) pass with the plugin job.

- [ ] **Step 3: Proof-it-can-fail — demonstrate the idempotency test red**

Temporarily break the guard so the test goes red, proving it actually tests the guard. In `apps/server/src/plugins/ctx.ts:86-99`, comment out the `plugin_job_runs` insert + the `JobAlreadyAppliedError` throw (the `if (options.job !== null) { … }` block). Then:

Run: `npx vitest run apps/server/test/crime-worker-idempotency.test.ts -t "does not double-pay"`
Expected: FAIL — `ledger.toHaveLength(1)` sees 2 rows (double-pay), proving the test catches a missing guard.

**Restore the guard** (uncomment the block) immediately. Re-run to confirm green:
Run: `npx vitest run apps/server/test/crime-worker-idempotency.test.ts`
Expected: PASS.

- [ ] **Step 4: Retarget the `processCrimeJob` describe block in `crimes.test.ts`**

The block at `crimes.test.ts:137-210` (`describe("processCrimeJob — jail and rank-up wiring")`) imports `processCrimeJob` lazily inside each `it` (`const { processCrimeJob } = await import("../src/game/crimes/worker.js")`) and calls `processCrimeJob(db, redis, { id, data })`.

1. Add to the top-of-file imports:
   ```ts
   import { runPluginJob } from "../src/plugins/jobs.js";
   import crimesPlugin from "@gl3/plugin-crimes";
   ```
2. Replace each `const { processCrimeJob } = await import("../src/game/crimes/worker.js");` line (inside the two `it` blocks) — delete it.
3. Add a deps helper near the top-of-file consts (after `const redis = …`):
   ```ts
   const jobDeps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: "crimes-test" });
   ```
4. Replace each `await processCrimeJob(db, redis, { id: …, data: { playerId, crimeId, seed } });` with:
   ```ts
   await runPluginJob(jobDeps(), crimesPlugin, "commit", { id: …, data: { playerId, crimeId, seed } });
   ```
   keeping the same `id`/`data` values.

The assertions in that block (jaledUntil set, exp applied) are unchanged.

- [ ] **Step 5: Retarget `economy-invariant.test.ts`**

1. Change the import `import { processCrimeJob } from "../src/game/crimes/worker.js";` to:
   ```ts
   import { runPluginJob } from "../src/plugins/jobs.js";
   import crimesPlugin from "@gl3/plugin-crimes";
   ```
2. At the top, near the existing `leaderboardPrefix` const, add a deps helper:
   ```ts
   const pluginJobDeps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix });
   ```
3. Replace the crime op (around line 102):
   ```ts
   await processCrimeJob(
     db, redis, { id: `invariant-crime-${i}`, data: { playerId, crimeId: pick(crimeIds), seed: `invariant-seed-${i}` } },
     leaderboardPrefix,
   );
   ```
   with:
   ```ts
   await runPluginJob(
     pluginJobDeps(),
     crimesPlugin,
     "commit",
     { id: `invariant-crime-${i}`, data: { playerId, crimeId: pick(crimeIds), seed: `invariant-seed-${i}` } },
   );
   ```
   The `leaderboardPrefix` is now carried by `pluginJobDeps()` rather than a trailing arg.

- [ ] **Step 6: Run the retargeted test files**

Run: `npx vitest run apps/server/test/crimes.test.ts apps/server/test/economy-invariant.test.ts`
Expected: PASS. (The `crimes.test.ts` `app.inject` blocks still hit core routes — those pass unchanged; only the retargeted `describe("processCrimeJob…")` block now uses the plugin. `economy-invariant`'s 1000-op sweep now covers the plugin crime path.)

- [ ] **Step 7: Commit**

```bash
git add apps/server/test/crime-worker-idempotency.test.ts apps/server/test/crimes.test.ts apps/server/test/economy-invariant.test.ts
git commit -m "test(crimes): retarget direct-call tests to the plugin commit job

crime-worker-idempotency, crimes.test.ts unit block and
economy-invariant now drive runPluginJob(@gl3/plugin-crimes, commit)
instead of processCrimeJob. Idempotency proven failing (guard removed
→ double-pay) then restored. Event count on retry is 1 not 2 (spec §2)."
```

---

### Task 5: Cutover — load the plugin, delete the core path

Flip `core-plugins.ts` to load crimes, delete `game/crimes/` and the `queue/` module, drop `crimeQueue` from `AppDeps` and its callers. The unchanged `app.inject` blocks in `crimes.test.ts` now hit the plugin routes and are the byte-identity proof.

**Files:**
- Modify: `apps/server/src/plugins/core-plugins.ts`
- Delete: `apps/server/src/game/crimes/routes.ts`, `apps/server/src/game/crimes/worker.ts` (and the `game/crimes/` directory)
- Delete: `apps/server/src/queue/index.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/test/helpers/server.ts`
- Modify: `apps/server/test/bank.test.ts`, `apps/server/test/bullets.test.ts`, `apps/server/test/jail.test.ts`, `apps/server/test/leaderboard.test.ts`, `apps/server/test/ranks.test.ts`, `apps/server/test/travel.test.ts`

**Interfaces:**
- Consumes: the complete `@gl3/plugin-crimes` from Task 3.
- Produces: a server that serves crimes entirely from the plugin; no `game/crimes/`, no `queue/`, no `crimeQueue`.

- [ ] **Step 1: Add crimes to `core-plugins.ts`**

In `apps/server/src/plugins/core-plugins.ts`:
1. Add the import after the `travelPlugin` import: `import crimesPlugin from "@gl3/plugin-crimes";`
2. Add `crimesPlugin,` to the `CORE_PLUGINS` array (after `travelPlugin`).

- [ ] **Step 2: Delete the core crimes path and the queue module**

```bash
git rm apps/server/src/game/crimes/routes.ts apps/server/src/game/crimes/worker.ts
rmdir apps/server/src/game/crimes 2>/dev/null || true
git rm apps/server/src/queue/index.ts
```
If `game/crimes/` has other files, `git rm` them too. Confirm `apps/server/src/queue/` is empty after (crimes was its only consumer); if so, `rmdir apps/server/src/queue`.

- [ ] **Step 3: Remove `crimeQueue` from `app.ts`**

In `apps/server/src/app.ts`:
1. Delete `import type { CrimeJobData } from "./queue/index.js";`
2. Delete `import { registerCrimeRoutes } from "./game/crimes/routes.js";`
3. In `AppDeps`, delete the line `crimeQueue: Queue<CrimeJobData>;`.
4. Delete the line `registerCrimeRoutes(app, deps.db, deps.redis, deps.crimeQueue, requireAuth);`.
5. If `Queue` from `bullmq` is now unused in the imports (it was imported for the `crimeQueue` type), check the top of the file — `import type { Queue } from "bullmq";` — and remove it if nothing else uses it. Search the file for other `Queue` uses first.

- [ ] **Step 4: Remove the crime worker/queue setup from `index.ts`**

In `apps/server/src/index.ts`:
1. Delete `import { startCrimeWorker } from "./game/crimes/worker.js";`
2. Delete `import { createCrimeQueue } from "./queue/index.js";`
3. Delete the line `const crimeQueue = createCrimeQueue(createRedis(config.redisUrl));`
4. Delete the line `startCrimeWorker({ db, connection: createRedis(config.redisUrl), publisher: createRedis(config.redisUrl) });`
5. In the `buildApp` call, remove `crimeQueue,` from the deps object (it becomes `{ db, redis, plugins: loadedPlugins }`).

The crimes worker now comes from `createPluginWorkers` via the loader (Task 1's `loadPlugins` already starts plugin workers).

- [ ] **Step 5: Remove the crime queue/worker from `helpers/server.ts`**

In `apps/server/test/helpers/server.ts`:
1. Delete `import { startCrimeWorker } from "../../src/game/crimes/worker.js";`
2. Delete `import { createCrimeQueue } from "../../src/queue/index.js";`
3. Delete the `const crimeQueue = createCrimeQueue(createRedis(config.redisUrl), queueName);` line.
4. Delete the `const worker = startCrimeWorker({ db: workerDb.db, connection: workerConnection, publisher, queueName, leaderboardPrefix });` line — but read the surrounding code first: this `worker` and its `workerDb`/`workerConnection` may be closed in the `close` function. If the crimes worker was the only thing using `workerDb`/`workerConnection`/`publisher`, those consts and their cleanup (`await worker.close()`, `await workerDb.sql.end()`, `publisher.disconnect()`) also go. Trace each before deleting — the crimes worker was the test server's only BullMQ worker, so its supporting infrastructure likely becomes dead. If `bootTestServer` still needs a `publisher` for leaderboard/event publishing, keep it; otherwise remove.
5. In the `buildApp` call (around line 79), remove `crimeQueue,` from the deps object.

**This step needs care** — `helpers/server.ts` is shared by every integration test. Read it fully, trace the `worker`/`workerDb`/`workerConnection`/`publisher` lifecycle, and delete only what becomes dead. The plugin worker is started by `loadPlugins` (called via `withCorePlugins` in this same file around line 72) and closed in the `close` function's `loadedPlugins.workers` loop.

- [ ] **Step 6: Drop `crimeQueue` from the six test files that pass it**

Each constructs a throwaway queue to satisfy the now-removed required field. In each, delete the `crimeQueue: createCrimeQueue(createRedis(config.redisUrl))` (or similar) property from the `buildApp` deps object, and delete the now-unused `const { createCrimeQueue } = await import("../src/queue/index.js");` dynamic import:

- `apps/server/test/bank.test.ts` (~line 111-114)
- `apps/server/test/bullets.test.ts` (~line 123-127)
- `apps/server/test/jail.test.ts` (~line 86-88)
- `apps/server/test/leaderboard.test.ts` (~line 74-78)
- `apps/server/test/ranks.test.ts` (~line 74-91)
- `apps/server/test/travel.test.ts` (~line 271-275 and ~line 331-334)

In each file the `buildApp(config, { db, redis, crimeQueue: createCrimeQueue(...), … })` becomes `buildApp(config, { db, redis, … })`. Verify each still typechecks (the dynamic import removal must not leave an unused binding — if `createCrimeQueue` was the only thing imported, remove the whole `const { createCrimeQueue } = await import(...)` line).

- [ ] **Step 7: Typecheck the whole server**

Run: `npx tsc --build --force apps/server/tsconfig.json`
Expected: no errors. Any remaining reference to `crimeQueue`, `processCrimeJob`, `registerCrimeRoutes`, `createCrimeQueue`, or `CrimeJobData` is a compile error pointing at a site you missed.

- [ ] **Step 8: Run the crimes test — the byte-identity proof**

Run: `npx vitest run apps/server/test/crimes.test.ts`
Expected: PASS. The `app.inject` blocks (GET list, POST commit, two-concurrent-commits-exactly-one-accepted, 404, 429, 423, 401) now hit the plugin routes via `bootTestServer` → `withCorePlugins` → `loadPlugins`, and must be byte-identical to core. This is the proof the routes ported correctly.

- [ ] **Step 9: Run the m1 acceptance test — the end-to-end proof**

Run: `npx vitest run apps/server/test/acceptance/m1-vertical-slice.test.ts`
Expected: PASS. It commits a crime through the full HTTP path (route → enqueue → plugin worker → event) and asserts `crime_log` row counts. The plugin still writes `crime_log`.

- [ ] **Step 10: Run the full suite**

Run: `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"`
Expected: `exit=0` and all tests pass. **Read the exit code, not the summary.** If any test fails, the likely causes are: a missed `crimeQueue` reference (compile error would have caught it, but a runtime reference won't), a `helpers/server.ts` cleanup regression, or the plugin worker not starting under `bootTestServer`.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(crimes): cutover — serve crimes from the plugin, delete core path

core-plugins.ts loads @gl3/plugin-crimes; game/crimes/ and queue/ are
deleted; crimeQueue drops from AppDeps and its callers. The unchanged
crimes.test.ts app.inject blocks are the byte-identity proof; m1
acceptance proves the full HTTP → plugin worker → event path. Spec §7."
```

---

### Task 6: Update STATUS.md

Record the port outcome, the accepted deviation, and the loader change.

**Files:**
- Modify: `docs/STATUS.md`

- [ ] **Step 1: Update the milestones table and counts**

In `docs/STATUS.md`:
1. In the M5 row, change "six of twelve module ports shipped" to "seven of twelve" and update the shipped list to include `crimes`; change "three ports remain" to "two ports remain (`mail`, `gangs`)".
2. Update the suite count in "**Suite: 71 files / 586 tests**" to match the actual post-port count (run `grep -rc "it(\|test(" apps/server/test packages/*/test 2>/dev/null | awk -F: '{s+=$2} END {print s}'` for a rough count, or read vitest's final tally from `/tmp/verify.log`). Update the file count similarly if it changed.
3. Update the "Last updated" line and the branch note to `feat/plugin-crimes-port`.

- [ ] **Step 2: Add a "The `crimes` port" section**

After the "### The `travel` port" section, add a new subsection recording: crimes ported to `packages/plugins/crimes`; first port with a worker; `plugin_job_runs` replaced `crime_log.job_id` as the idempotency guard; the accepted replay-events deviation (spec §2); the loader `attempts:3` change (spec §2.5) and that it applies to all plugin jobs; two ports remain (`mail`, `gangs`).

- [ ] **Step 3: Update the "Known issues / watch items" if relevant**

The spec's §10 notes this port gives `applyExpAndRankUp`'s zero-gain path a neighboring caller. If the carried-forward Minor 1 (the untested zero-gain early return) is still listed, leave it — this port does not close it, only neighbors it. No new watch item is needed unless the suite surfaced one.

- [ ] **Step 4: Commit**

```bash
git add docs/STATUS.md
git commit -m "docs: record the crimes port outcome and the loader retry change"
```

---

## Self-Review (run after writing, before handoff)

**Spec coverage:**
- §2 (replay gap) → Task 4 Step 3 changes the event-count assertion; Task 1 makes it reachable. ✓
- §2.5 (attempts:3) → Task 1. ✓
- §3 (package shape, schema mirrors) → Task 2. ✓
- §3.2 routes (list + commit) → Task 3 Step 2. ✓
- §4 (commit job: roll, transaction, in-tx read, ctx absorption) → Task 3 Step 2. ✓
- §5 (wire contract) → proven by Task 5 Step 8 (unchanged app.inject). ✓
- §6 (no lock-order test) → intentionally none. ✓
- §7 (cutover) → Task 5. ✓
- §8 (eight registration sites) → Task 2 (5 sites) + Task 5 (core-plugins, app.ts deletion). ✓
- §9 (testing) → Task 4 (direct-call retarget) + Task 5 (app.inject proof). ✓

**Placeholder scan:** none — all code blocks are complete.

**Type consistency:** `runPluginJob(deps, manifest, name, job)` signature consistent across Task 4's three files. `deps` shape `{ db, redis, queues: new Map(), settings: {}, leaderboardPrefix }` matches `plugin-jobs.test.ts:35`. `commitJob(ctx, data)` signature matches `JobHandler` in `jobs.ts:14`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-10-plugin-crimes-port.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
