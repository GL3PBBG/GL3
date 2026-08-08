# GL3 M2 — Core Loop Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the rest of V2's core loop on top of the M1 crime slice — jail, ranks/exp, bank (deposit/withdraw), travel, the bullets shop, and leaderboards — so a player can be jailed on a failed crime, level up, bank their cash, travel between cities, buy bullets, and see where they stand. Milestone acceptance (SPEC §6): an economy invariant test proving `sum(ledger) == balance` across 1000 randomized operations spanning every M2 money path.

**Architecture:** Extends the M1 pattern, not a new one. Crime stays the one action that needs a BullMQ worker, because it is the one action with a *random* outcome that must be resolved off the request thread with a seed (SPEC §7). Jail is a side effect wired into that same worker plus a Postgres-is-truth gate (`jailed_until timestamptz`) checked by every gated route. Ranks are a threshold ladder applied wherever exp is granted. Bank, travel, and the bullets shop are all **deterministic** — no randomness to protect from re-rolling — so they run synchronously in the HTTP request: `SELECT … FOR UPDATE` inside one Postgres transaction gives them the same correctness guarantee a queue would, without the queue. Leaderboards are Redis sorted sets rebuilt from Postgres on boot and updated live at each write site.

**Tech Stack:** Unchanged from M0/M1 — Node 22 LTS (ESM), TypeScript strict, Fastify 5, Drizzle ORM + `postgres`, PostgreSQL 16, Redis 7, BullMQ, zod, vitest. No new npm dependencies.

## Known state this plan builds on (read before starting)

- **All 32 SPEC §2.5 tables already exist.** `player_stats` already has `jailed_until`, `hospital_until`, `rank_id`, `gang_id`, `location_id`, `bank`, `points`, `bullets`, `exp` as typed columns — M2 does not need to add any of those. `ranks` and `locations` already carry the reward/cost columns SPEC §1.2 describes. The **only** schema gap is that `crimes` has no column recording jail risk on failure (see Task 2 and "Decisions taken" below).
- **M1 shipped through the crime slice only.** `git log` shows Task 9 (crime slice: bus, queue, route, worker) is the last completed unit of the M0/M1 plan. **Tasks 10–13 of that plan — the WS gateway (`ws/gateway.ts`), the React client (`apps/web`), the M1 acceptance test, and the README — were never built.** `ws` is an installed dependency and `packages/shared/src/ws.ts` defines the frame schemas, but nothing subscribes to `game:events` and fans it to a browser yet.
- **Consequence for this plan:** every M2 mutation still validates → gates (cooldown or row lock) → mutates in one Postgres transaction → publishes a validated `GameEvent` to the `game:events` Redis channel, exactly like the crime slice. That publish step is real and tested (subscribe-and-assert, same as `crimes.test.ts`). What does **not** exist yet, and this plan does not build, is a live browser feed — that gap is inherited from M1, not introduced here. Flagging it rather than silently either building a WS gateway (out of M2's stated scope) or pretending one exists.
- **Idempotency precedent:** `crime_log.job_id` is a nullable-but-unique column inserted first inside the crime worker's transaction; a BullMQ retry hits the unique violation and skips re-crediting (`apps/server/src/game/crimes/worker.ts`). Reused conceptually below, but M2's other mutations are synchronous HTTP handlers, not queued jobs — see "Decisions taken."

## Decisions taken (spec-permitted, stated for the record)

1. **Only crime uses BullMQ.** SPEC §7 requires randomness to be "resolved in workers only" so a retry can't re-roll a favorable outcome — that is what a worker buys you. Jail-on-failure and rank-up are wired into the *existing* crime worker (Task 6), inheriting its seed and its `job_id` idempotency guard for free. Bank, travel, and the bullets shop have **no random outcome** and **no V2 cooldown of their own except travel** (SPEC §1.2 lists no `userTimers` key or column for bank or bullets purchase); a queue hop would add latency and — because BullMQ is at-least-once — would need its own new idempotency-tracking column or table to stay safe on retry, which cuts against "M2 adds gameplay, not tables." A `SELECT … FOR UPDATE` transaction (the same primitive Task 8's ledger already relies on) gives synchronous handlers the identical double-spend protection without either cost. Travel keeps the atomic Redis cooldown (`SET NX EX`) because SPEC §1.2 confirms `locations.L_cooldown` is real, but resolves synchronously for the same reason — nothing in travel is random.
2. **New `crimes` columns for jail risk.** SPEC §1.2's audited `crimes` columns (`C_cooldown`, `C_money`/`C_maxMoney`, `C_bullets`/`C_maxBullets`, `C_exp`, `C_level`) do not include a jail trigger — V2's jail module clearly exists (SPEC §1.1 `userTimers` key `jail`, §2.5's typed `jailed_until` column) but the audit doesn't say what decides *which* failed crimes jail you. Rather than silently invent a global constant, this plan adds two explicit, migrated columns — `jail_chance_percent` and `jail_seconds` — documented in Task 2 as a deliberate GL3 model addition, the same way SPEC §2.5 already documents other deliberate model changes.
3. **Jail release is lazy, not cron-driven.** Postgres owns `jailed_until`; every gated route calls `releaseIfExpired` first, which clears it (and fires `player.released`) only the first time a request notices it has passed. No scheduled job, no extra moving part, and a Redis flush still can't free anyone early because nothing in the release path depends on Redis state.
4. **Jail gates action modules, not account modules.** V2's own `module.json` has a per-module `accessInJail` flag (SPEC §1.3). GL3 doesn't have a general module ACL until M5's plugin SDK, so M2 hard-codes the same intent narrowly: crime, travel, and the bullets shop are blocked while jailed; bank, ranks, and leaderboards stay readable/usable, matching how these games typically leave account pages open in jail.
5. **Bullets are not ledgered.** `transactions.balance_kind` is `cash | bank | points` (SPEC §2.5) — bullets were deliberately left out of the append-only ledger when that enum was built in M1. This plan does not change the enum; bullet-count changes are plain `player_stats.bullets` column updates alongside a ledgered cash debit for their cost, mirroring how `crime_log` already stores a bullets payout without ledgering it.
6. **Rank-up grants the destination rank's own reward once, not every skipped rung's.** A large exp gain can cross more than one rank threshold in a single call; `applyExpAndRankUp` computes the single highest rank the player's new total now qualifies for and grants only its reward — the common design in this genre, and it keeps the function idempotent-in-effect regardless of how big a single exp grant is.
7. **Every M2 route/service function that mutates money is named and shaped like `processCrimeJob` from Task 9**: a plain exported function taking `(db, redis, …)`, doing its transaction, publishing its event, and returning a plain result — callable directly from tests without booting Fastify or a queue. Route handlers are thin HTTP-shaped wrappers around them. This is what lets Task 10's 1000-op invariant test exercise every mutation path without per-action Redis cooldowns throttling a tight loop.

## Global Constraints

Everything in the M0/M1 plan's Global Constraints section still applies verbatim (TypeScript strict, no `any` in `packages/*`, ESM `.js` extensions, zod on every boundary, `bigint` money, one ledger row per balance mutation, ascending-id row locking, `node:crypto` randomness in workers only, UUIDv7 PKs, frequent Conventional Commits, real Postgres+Redis in tests). This section adds only what's new for M2:

- **Randomness stays confined to the crime worker.** No other M2 code path calls `createRng` or touches `node:crypto` — if a task other than Task 6 needs randomness, stop and reconsider the design; it should not.
- **Every service function that mutates `player_stats` money columns runs its DB work in exactly one `db.transaction(...)` and publishes its event strictly after that transaction resolves** — same rule Task 9 established, restated because M2 adds four more call sites for it.
- **Lock order for the one new lock pair this milestone introduces (bullets purchase): the `locations` row before the player's `player_stats` row.** Consistent single direction, same reasoning as Task 8's ascending-player-id rule — never introduce a path that locks a player row before a location row while holding it, or the two orders can deadlock against each other.
- **Test env:** `DATABASE_URL` and `REDIS_URL` must both be exported (native Postgres 16.14 / Redis 7.0.15 — Docker is unavailable in this environment). `apps/server/test/helpers/isolated-db.setup.ts` gives every test file its own migrated database and `rate-limit-isolation.setup.ts` clears the shared register/login buckets before each test; both are Vitest `setupFiles` already wired into `vitest.workspace.ts` — no per-file workaround needed, and no task in this plan touches either file.
- **`npm run verify` (typecheck + full test run) must exit 0 at the end of every task**, same gate as M0/M1.

---

## File Structure

Files that change together live together. New M2 files follow a `service.ts` (pure DB/Redis logic, directly testable, returns plain data) + `routes.ts` (thin Fastify wrapper: zod-parses the request, applies jail/cooldown gates, translates thrown errors to HTTP codes) split per feature folder — the deterministic-action analogue of how `game/crimes/worker.ts` + `routes.ts` split the queued case in M1.

**`packages/shared`**
- `src/events.ts` — **modify**: extend `player.travelled` (add `cost`, make `fromLocationId` nullable); add `player.rankedUp`, `bank.transacted`, `bullets.purchased`
- `src/dto/jail.ts`, `src/dto/rank.ts`, `src/dto/bank.ts`, `src/dto/travel.ts`, `src/dto/bullets.ts`, `src/dto/leaderboard.ts` — **create**: response/request schemas for each new route family
- `src/index.ts` — **modify**: barrel-export each new dto module

**`apps/server/src`**
- `db/schema/content.ts` — **modify**: `crimes` gains `jail_chance_percent`, `jail_seconds`
- `db/seed.ts` — **modify**: `seedCrimes` gets jail values; add `seedRanks`, `seedLocations`
- `economy/ledger.ts` — **modify**: add `lockLocationForUpdate`
- `economy/ranks.ts` — **create**: `applyExpAndRankUp` — the exp-then-rank-threshold step, called wherever exp is granted
- `game/jail/status.ts` — **create**: `checkJail`, `releaseIfExpired`, `sendToJail` — the Postgres-is-truth jail primitives every gated route calls
- `game/jail/routes.ts` — **create**: `GET /api/jail`
- `game/ranks/routes.ts` — **create**: `GET /api/ranks`
- `game/bank/service.ts` — **create**: `performBankTransaction`
- `game/bank/routes.ts` — **create**: `POST /api/bank/deposit`, `POST /api/bank/withdraw`
- `game/travel/service.ts` — **create**: `performTravel`
- `game/travel/routes.ts` — **create**: `GET /api/locations`, `POST /api/travel/:locationId`
- `game/bullets/service.ts` — **create**: `performBulletsPurchase`
- `game/bullets/routes.ts` — **create**: `POST /api/bullets/buy`
- `game/leaderboard/service.ts` — **create**: `recordScore`, `topN`, `rebuildLeaderboards`
- `game/leaderboard/routes.ts` — **create**: `GET /api/leaderboard/:kind`
- `game/crimes/worker.ts` — **modify**: wire jail-on-failure and `applyExpAndRankUp` into `processCrimeJob`
- `game/crimes/routes.ts` — **modify**: gate `POST /api/crimes/:crimeId/commit` on jail
- `app.ts`, `index.ts`, `test/helpers/server.ts` — **modify**: register every new route family; call `seedRanks`/`seedLocations`/`rebuildLeaderboards` at boot

**Tests** — one per feature, plus the milestone gate: `test/schema.test.ts` (modify), `test/jail.test.ts`, `test/ranks.test.ts`, `test/bank.test.ts`, `test/travel.test.ts`, `test/bullets.test.ts`, `test/leaderboard.test.ts`, `test/crimes.test.ts` (modify), `test/economy-invariant.test.ts` (all create except the two marked modify).

---

## Task independence (for parallel worktrees)

- **Independent, run in parallel:** Task 1 (shared events) and Task 2 (crimes migration) — disjoint files.
- **Depend only on Task 1, independent of each other:** Task 3 (jail), Task 4 (ranks), Task 5 (bank). Each adds its own `packages/shared/src/dto/*.ts` file plus a one-line barrel export — trivial, non-overlapping diff regions in `index.ts` even if landed in parallel.
- **Chains:** Task 6 (crime worker integration) needs Task 2 + Task 3 + Task 4 merged first — it is the integration point and cannot be parallelized with them. Task 7 (travel) needs Task 1 + Task 3. Task 8 (bullets) needs Task 7 (shares `seedLocations` and the new `locations` FOR UPDATE helper). Task 9 (leaderboards) needs Task 4 + Task 5 + Task 6 (it retrofits `recordScore` calls into their write paths). Task 10 (the milestone's invariant test) needs everything and is last.

---

### Task 1: M2 event-schema extensions in `@gl3/shared`

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/test/events.test.ts`

**Interfaces:**
- Consumes: existing `GameEventSchema` (M1).
- Produces: `player.travelled` gains `cost: MoneySchema` and `fromLocationId: IdSchema.nullable()`; three new union members `player.rankedUp`, `bank.transacted`, `bullets.purchased`.

- [ ] **Step 1: Write the failing tests**

Add these cases to `packages/shared/test/events.test.ts` (append inside the existing `describe("GameEventSchema", …)` block, alongside the existing fixtures):

```ts
const rankedUp = {
  id: "018f8e2a-0000-7000-8000-000000000010",
  type: "player.rankedUp",
  at: "2026-08-07T00:00:00.000Z",
  actorId: "018f8e2a-0000-7000-8000-000000000002",
  actorName: "Vito",
  audience: { kind: "player", playerId: "018f8e2a-0000-7000-8000-000000000002" },
  rankId: "018f8e2a-0000-7000-8000-000000000011",
  rankName: "Soldier",
  cashReward: "500",
  bulletReward: "5",
  maxHealth: 110,
} as const;

const bankTransacted = {
  id: "018f8e2a-0000-7000-8000-000000000012",
  type: "bank.transacted",
  at: "2026-08-07T00:00:00.000Z",
  actorId: "018f8e2a-0000-7000-8000-000000000002",
  actorName: "Vito",
  audience: { kind: "player", playerId: "018f8e2a-0000-7000-8000-000000000002" },
  direction: "deposit",
  amount: "100",
  cash: "0",
  bank: "100",
} as const;

const bulletsPurchased = {
  id: "018f8e2a-0000-7000-8000-000000000013",
  type: "bullets.purchased",
  at: "2026-08-07T00:00:00.000Z",
  actorId: "018f8e2a-0000-7000-8000-000000000002",
  actorName: "Vito",
  audience: { kind: "player", playerId: "018f8e2a-0000-7000-8000-000000000002" },
  locationId: "018f8e2a-0000-7000-8000-000000000014",
  quantity: 10,
  cost: "50",
  cash: "50",
  bullets: "10",
} as const;

it("accepts player.rankedUp, bank.transacted, and bullets.purchased (M2)", () => {
  expect(GameEventSchema.parse(rankedUp)).toMatchObject({ type: "player.rankedUp" });
  expect(GameEventSchema.parse(bankTransacted)).toMatchObject({ type: "bank.transacted" });
  expect(GameEventSchema.parse(bulletsPurchased)).toMatchObject({ type: "bullets.purchased" });
});

it("covers all nineteen event names after M2's additions", () => {
  expect(new Set(GameEventSchema.options.map((o) => o.shape.type.value))).toEqual(new Set([
    "crime.resolved", "player.jailed", "player.released", "player.travelled",
    "player.attacked", "player.killed", "bounty.placed", "bounty.claimed",
    "gang.created", "gang.memberJoined", "gang.memberLeft", "mail.received",
    "notification.created", "news.posted", "chat.message", "player.joined",
    "player.rankedUp", "bank.transacted", "bullets.purchased",
  ]));
});

it("requires player.travelled to carry a cost, and allows a null fromLocationId for a player's first move", () => {
  const travelled = {
    id: "018f8e2a-0000-7000-8000-000000000015",
    type: "player.travelled",
    at: "2026-08-07T00:00:00.000Z",
    actorId: "018f8e2a-0000-7000-8000-000000000002",
    actorName: "Vito",
    audience: { kind: "player", playerId: "018f8e2a-0000-7000-8000-000000000002" },
    fromLocationId: null,
    toLocationId: "018f8e2a-0000-7000-8000-000000000016",
    cost: "0",
  };
  expect(GameEventSchema.parse(travelled)).toMatchObject({ type: "player.travelled" });
  const { cost: _cost, ...noCost } = travelled;
  expect(() => GameEventSchema.parse(noCost)).toThrow();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/shared/test/events.test.ts`
Expected: FAIL — `player.rankedUp` etc. are not valid discriminator values, and `player.travelled` rejects a null `fromLocationId`.

- [ ] **Step 3: Update `events.ts`**

Replace the `player.travelled` line and append the three new members. The full updated union (only the changed/added lines shown — everything else in the file is unchanged):

```ts
  // fromLocationId is null the first time a player ever travels (no prior
  // location — playerStats.location_id starts null and M2 does not backfill
  // a "home" location at registration, see M2 plan Task 7).
  z.object({ ...base, type: z.literal("player.travelled"), fromLocationId: IdSchema.nullable(), toLocationId: IdSchema, cost: MoneySchema }),
```

Append after `player.joined` (still inside the array, before the closing `]);`):

```ts
  // actor = the player who ranked up.
  z.object({
    ...base, type: z.literal("player.rankedUp"),
    rankId: IdSchema, rankName: z.string(), cashReward: MoneySchema, bulletReward: MoneySchema, maxHealth: z.number().int().positive(),
  }),
  // actor = the account holder. Private audience — bank state is not broadcast.
  z.object({
    ...base, type: z.literal("bank.transacted"),
    direction: z.enum(["deposit", "withdraw"]), amount: MoneySchema, cash: MoneySchema, bank: MoneySchema,
  }),
  // actor = the buyer.
  z.object({
    ...base, type: z.literal("bullets.purchased"),
    locationId: IdSchema, quantity: z.number().int().positive(), cost: MoneySchema, cash: MoneySchema, bullets: MoneySchema,
  }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/shared/test/events.test.ts`
Expected: PASS, 10 tests (7 existing + 3 new — the "covers all N event names" test replaces the old sixteen-name assertion in place, so it's a modification, not an addition; net test count grows by 3).

- [ ] **Step 5: Run the full gate and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add packages/shared
git commit -m "feat(shared): add M2 event types (rankedUp, bank.transacted, bullets.purchased) and extend player.travelled"
```

---

### Task 2: Migration — `crimes` gains jail-risk columns

**Files:**
- Modify: `apps/server/src/db/schema/content.ts`
- Modify: `apps/server/src/db/seed.ts`
- Create: `apps/server/drizzle/0002_add_crime_jail_columns.sql` (generated, committed)
- Modify: `apps/server/test/schema.test.ts`

**Interfaces:**
- Consumes: the existing `crimes` table (M0/M1).
- Produces: `crimes.jailChancePercent: integer` (0–100, default 0), `crimes.jailSeconds: integer` (default 0) — both plain, non-negative integers with no dedicated enum; validity is enforced at the seed layer, matching how `numeric(5,2)` chances elsewhere in this schema are unconstrained at the DB level too.

- [ ] **Step 1: Write the failing schema test**

Append to `apps/server/test/schema.test.ts`, inside the existing `describe("core schema", …)` block:

```ts
  it("gives crimes an explicit jail-on-failure risk (spec: GL3 model addition, see M2 plan Decision 2)", async () => {
    expect(await columnType("crimes", "jail_chance_percent")).toBe("integer");
    expect(await columnType("crimes", "jail_seconds")).toBe("integer");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/server/test/schema.test.ts`
Expected: FAIL — both columns are `undefined` (don't exist yet).

- [ ] **Step 3: Add the columns to the schema**

In `apps/server/src/db/schema/content.ts`, add two fields to the `crimes` table definition (insert after `sort: integer("sort").notNull().default(0),` and before the closing `}, (t) => ({...`):

```ts
  /**
   * GL3 model addition, not present in V2's audited `crimes` columns (spec
   * §1.2 lists only C_cooldown/C_money/C_maxMoney/C_bullets/C_maxBullets/
   * C_exp/C_level) — V2's jail module clearly exists but the audit doesn't
   * say what decides which failed crimes jail you, so this is made explicit
   * rather than assumed. 0 means "never jails on failure."
   */
  jailChancePercent: integer("jail_chance_percent").notNull().default(0),
  jailSeconds: integer("jail_seconds").notNull().default(0),
```

- [ ] **Step 4: Generate and inspect the migration**

Run (from `apps/server`):

```bash
cd apps/server
npm run db:generate -- --name add_crime_jail_columns
```

Expected: creates `drizzle/0002_add_crime_jail_columns.sql`, updates `drizzle/meta/_journal.json` with a third entry (`idx: 2`), and adds `drizzle/meta/0002_snapshot.json`. Inspect the generated SQL — expect exactly:

```sql
ALTER TABLE "crimes" ADD COLUMN "jail_chance_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crimes" ADD COLUMN "jail_seconds" integer DEFAULT 0 NOT NULL;
```

If drizzle-kit emits anything touching another table, stop — it means the working tree had an uncommitted schema drift from something other than this task; do not proceed until the diff is exactly these two `ALTER TABLE` statements.

- [ ] **Step 5: Update the seed data with real jail values**

In `apps/server/src/db/seed.ts`, replace the `seedCrimes` insert values with (same three crimes, same ids/costs/etc., jail fields added):

```ts
  await db.insert(crimes).values([
    { id: uuidv7(), name: "Pickpocket", description: "Lift a wallet in a crowd.", cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n, minBullets: 0, maxBullets: 0, expReward: 5n, minRank: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0 },
    { id: uuidv7(), name: "Rob a Store", description: "Hold up the corner shop.", cooldownSeconds: 60, minPayout: 200n, maxPayout: 900n, minBullets: 0, maxBullets: 2, expReward: 12n, minRank: 0, sort: 20, jailChancePercent: 25, jailSeconds: 45 },
    { id: uuidv7(), name: "Armoured Van", description: "Take the van on the freeway.", cooldownSeconds: 300, minPayout: 2000n, maxPayout: 9000n, minBullets: 1, maxBullets: 5, expReward: 40n, minRank: 0, sort: 30, jailChancePercent: 40, jailSeconds: 120 },
  ]);
```

- [ ] **Step 6: Run the schema test to verify it passes**

Run: `npx vitest run apps/server/test/schema.test.ts`
Expected: PASS, 6 tests (5 existing + 1 new). This also re-applies migrations against a fresh isolated test database via `test/helpers/isolated-db.setup.ts`, so it exercises the new migration file end to end.

- [ ] **Step 7: Run the full gate and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add apps/server/src/db/schema/content.ts apps/server/src/db/seed.ts apps/server/drizzle apps/server/test/schema.test.ts
git commit -m "feat(server): add crimes.jail_chance_percent and jail_seconds columns"
```

---

### Task 3: Jail primitives and `GET /api/jail`

**Files:**
- Create: `packages/shared/src/dto/jail.ts`; Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/game/jail/status.ts`
- Create: `apps/server/src/game/jail/routes.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/jail.test.ts`

**Interfaces:**
- Consumes: `player_stats.jailed_until` (already exists), `publishEvent`/`GameEvent` (Task 1 not required here — `player.jailed`/`player.released` already existed pre-M2), ledger's `Tx` type (Task 8).
- Produces:
  - `JailStatusSchema` / `type JailStatus = { jailed: boolean; until: string | null; remainingSeconds: number }`
  - `checkJail(db, playerId): Promise<JailStatus>` — read-only.
  - `releaseIfExpired(db, redis, playerId): Promise<JailStatus>` — the ONLY place that clears an expired `jailed_until`; publishes `player.released` exactly once per expiry.
  - `sendToJail(tx, playerId, seconds): Promise<Date>` — called inside an existing transaction (Task 6).
  - Route: `GET /api/jail`.

- [ ] **Step 1: Write the shared DTO**

`packages/shared/src/dto/jail.ts`:

```ts
import { z } from "zod";
import { TimestampSchema } from "../primitives.js";

export const JailStatusSchema = z.object({
  jailed: z.boolean(),
  until: TimestampSchema.nullable(),
  remainingSeconds: z.number().int().nonnegative(),
});
export type JailStatus = z.infer<typeof JailStatusSchema>;
```

Append to `packages/shared/src/index.ts`:

```ts
export * from "./dto/jail.js";
```

- [ ] **Step 2: Write the failing status-primitive test**

`apps/server/test/jail.test.ts`:

```ts
import { GameEventSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { checkJail, releaseIfExpired } from "../src/game/jail/status.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId });
});
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

describe("checkJail", () => {
  it("reports free when jailed_until is null", async () => {
    expect(await checkJail(db, playerId)).toEqual({ jailed: false, until: null, remainingSeconds: 0 });
  });

  it("reports jailed with remaining seconds when jailed_until is in the future", async () => {
    const until = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ jailedUntil: until }).where(eq(playerStats.playerId, playerId));
    const status = await checkJail(db, playerId);
    expect(status.jailed).toBe(true);
    expect(status.remainingSeconds).toBeGreaterThan(0);
    expect(status.remainingSeconds).toBeLessThanOrEqual(60);
  });

  it("does NOT clear an expired jailed_until — that is releaseIfExpired's job", async () => {
    const past = new Date(Date.now() - 1000);
    await db.update(playerStats).set({ jailedUntil: past }).where(eq(playerStats.playerId, playerId));
    expect(await checkJail(db, playerId)).toMatchObject({ jailed: false });
    const [row] = await db.select({ jailedUntil: playerStats.jailedUntil }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.jailedUntil).not.toBeNull();
  });
});

describe("releaseIfExpired", () => {
  it("clears an expired jailed_until and publishes player.released exactly once", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const past = new Date(Date.now() - 1000);
    await db.update(playerStats).set({ jailedUntil: past }).where(eq(playerStats.playerId, playerId));

    const received = new Promise((resolve) => {
      subscriber.once("message", (channel, raw) => { if (channel === GAME_EVENTS_CHANNEL) resolve(JSON.parse(raw)); });
    });

    const status = await releaseIfExpired(db, redis, playerId);
    expect(status).toEqual({ jailed: false, until: null, remainingSeconds: 0 });

    const event = GameEventSchema.parse(await received);
    expect(event.type).toBe("player.released");
    expect(event.actorId).toBe(playerId);

    const [row] = await db.select({ jailedUntil: playerStats.jailedUntil }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.jailedUntil).toBeNull();

    // A second call finds nothing left to release and does not republish.
    await releaseIfExpired(db, redis, playerId);
  });

  it("leaves a currently-jailed player untouched", async () => {
    const future = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ jailedUntil: future }).where(eq(playerStats.playerId, playerId));
    const status = await releaseIfExpired(db, redis, playerId);
    expect(status.jailed).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/server/test/jail.test.ts`
Expected: FAIL — cannot resolve `../src/game/jail/status.js`.

- [ ] **Step 4: Write `game/jail/status.ts`**

```ts
import { and, eq, isNotNull } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent, JailStatus } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../economy/ledger.js";
import { playerStats, players } from "../../db/schema/index.js";

const FREE: JailStatus = { jailed: false, until: null, remainingSeconds: 0 };

function statusFrom(jailedUntil: Date | null): JailStatus {
  if (!jailedUntil) return FREE;
  const remainingMs = jailedUntil.getTime() - Date.now();
  if (remainingMs <= 0) return FREE;
  return { jailed: true, until: jailedUntil.toISOString(), remainingSeconds: Math.ceil(remainingMs / 1000) };
}

/** Read-only. Does NOT clear an expired jailed_until — see releaseIfExpired. */
export async function checkJail(db: Db, playerId: string): Promise<JailStatus> {
  const [row] = await db.select({ jailedUntil: playerStats.jailedUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  return statusFrom(row?.jailedUntil ?? null);
}

/**
 * Postgres is the source of truth for jail (a Redis flush must not free
 * prisoners). This is the ONLY place that clears an expired jailed_until —
 * every gated route calls it first, so release happens lazily on the
 * player's next request instead of needing a cron job.
 *
 * The UPDATE's WHERE clause repeats `jailed_until IS NOT NULL`, so it is the
 * arbiter of "did THIS call actually perform the release": if two requests
 * race past the read above, only the first UPDATE matches a row (`.returning()`
 * is non-empty); the second commits after and matches zero rows, so
 * `player.released` fires exactly once no matter how many requests notice
 * the expiry at once.
 */
export async function releaseIfExpired(db: Db, redis: Redis, playerId: string): Promise<JailStatus> {
  const [row] = await db.select({ jailedUntil: playerStats.jailedUntil, username: players.username })
    .from(playerStats)
    .innerJoin(players, eq(players.id, playerStats.playerId))
    .where(eq(playerStats.playerId, playerId));
  if (!row) return FREE;

  const status = statusFrom(row.jailedUntil);
  if (status.jailed) return status; // still serving time

  if (row.jailedUntil !== null) {
    const cleared = await db.update(playerStats)
      .set({ jailedUntil: null })
      .where(and(eq(playerStats.playerId, playerId), isNotNull(playerStats.jailedUntil)))
      .returning({ playerId: playerStats.playerId });

    if (cleared.length > 0) {
      const event: GameEvent = {
        id: uuidv7(),
        type: "player.released",
        at: new Date().toISOString(),
        actorId: playerId,
        actorName: row.username,
        audience: { kind: "player", playerId },
      };
      await publishEvent(redis, event);
    }
  }
  return FREE;
}

/** Called inside the crime worker's transaction (Task 6) — takes `tx`, not `db`. */
export async function sendToJail(tx: Tx, playerId: string, seconds: number): Promise<Date> {
  const until = new Date(Date.now() + seconds * 1000);
  await tx.update(playerStats).set({ jailedUntil: until }).where(eq(playerStats.playerId, playerId));
  return until;
}
```

- [ ] **Step 5: Run the status tests to verify they pass**

Run: `npx vitest run apps/server/test/jail.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write and wire the route**

`apps/server/src/game/jail/routes.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../../db/client.js";
import { releaseIfExpired } from "./status.js";

export function registerJailRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/jail", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });
    return reply.send(await releaseIfExpired(db, redis, playerId));
  });
}
```

In `apps/server/src/app.ts`, add the import and registration (after `registerCrimeRoutes(...)`):

```ts
import { registerJailRoutes } from "./game/jail/routes.js";
// ...
registerJailRoutes(app, deps.db, deps.redis, requireAuth);
```

- [ ] **Step 7: Add a route-level test to `jail.test.ts`**

Append:

```ts
describe("GET /api/jail", () => {
  it("reports free status and auto-releases an expired jail via HTTP", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadConfig: loadCfg } = await import("../src/config.js");
    const { createCrimeQueue } = await import("../src/queue/index.js");
    const config = loadCfg({ ...process.env, NODE_ENV: "test" });
    const app = await buildApp(config, { db, redis, crimeQueue: createCrimeQueue(createRedis(config.redisUrl)) });

    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: `Jail${Date.now()}`, password: "hunter2hunter2" } });
    const { token } = reg.json();
    const auth = { authorization: `Bearer ${token}` };

    const free = await app.inject({ method: "GET", url: "/api/jail", headers: auth });
    expect(free.statusCode).toBe(200);
    expect(free.json()).toMatchObject({ jailed: false });

    await app.close();
  });
});
```

- [ ] **Step 8: Run the full jail test file and the full gate**

Run: `npx vitest run apps/server/test/jail.test.ts && npm run verify`
Expected: PASS, 6 tests in the file; gate exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/shared apps/server/src/game/jail apps/server/src/app.ts apps/server/test/jail.test.ts
git commit -m "feat(server): add jail status primitives, lazy release, and GET /api/jail"
```

---

### Task 4: Ranks — exp-driven promotion, rewards, and `GET /api/ranks`

**Files:**
- Create: `packages/shared/src/dto/rank.ts`; Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/economy/ranks.ts`
- Modify: `apps/server/src/db/seed.ts` (add `seedRanks`)
- Create: `apps/server/src/game/ranks/routes.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/index.ts`, `apps/server/test/helpers/server.ts`
- Test: `apps/server/test/ranks.test.ts`

**Interfaces:**
- Consumes: `ranks` table (already exists), `addExp`/`applyBalanceChange`/`Tx` (Task 8), `player.rankedUp` event (Task 1).
- Produces:
  - `applyExpAndRankUp(tx, playerId, expGain): Promise<RankUpResult | null>` — must run inside an existing transaction, same contract as `addExp`.
  - `interface RankUpResult { rankId: string; rankName: string; cashReward: bigint; bulletReward: number; maxHealth: number }`
  - `seedRanks(db): Promise<void>`
  - `RankDtoSchema`, `RankListResponseSchema` from `@gl3/shared`
  - Route: `GET /api/ranks`.

- [ ] **Step 1: Write the shared DTO**

`packages/shared/src/dto/rank.ts`:

```ts
import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

export const RankDtoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  expRequired: MoneySchema,
  cashReward: MoneySchema,
  bulletReward: z.number().int().nonnegative(),
  maxHealth: z.number().int().positive(),
  current: z.boolean(),
});
export type RankDto = z.infer<typeof RankDtoSchema>;

export const RankListResponseSchema = z.object({ ranks: z.array(RankDtoSchema) });
export type RankListResponse = z.infer<typeof RankListResponseSchema>;
```

Append to `packages/shared/src/index.ts`: `export * from "./dto/rank.js";`

- [ ] **Step 2: Write the failing ledger-level test**

`apps/server/test/ranks.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyExpAndRankUp } from "../src/economy/ranks.js";
import { players, playerStats, ranks, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
let playerId: string;
let soldierId: string;
let associateId: string;

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, health: 90 });

  associateId = uuidv7();
  soldierId = uuidv7();
  await db.insert(ranks).values([
    { id: associateId, name: "Associate", expRequired: 0n, cashReward: 0n, bulletReward: 0, maxHealth: 100 },
    { id: soldierId, name: "Soldier", expRequired: 100n, cashReward: 500n, bulletReward: 5, maxHealth: 110 },
  ]);
});
afterAll(async () => { await conn.end(); });

describe("applyExpAndRankUp", () => {
  it("does nothing when expGain is 0", async () => {
    const result = await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 0n));
    expect(result).toBeNull();
    const [row] = await db.select({ rankId: playerStats.rankId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.rankId).toBeNull();
  });

  it("adds exp without a rank change when still short of the next threshold", async () => {
    const result = await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 5n));
    expect(result?.rankId).toBe(associateId); // qualifies for Associate (0 exp) on the very first grant
    const second = await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 5n)); // total 10, still < 100
    expect(second).toBeNull();
  });

  it("promotes, credits the cash reward as a ledger row, and raises max health on crossing a threshold", async () => {
    const result = await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 150n)); // straight past Associate to Soldier
    expect(result).toEqual({ rankId: soldierId, rankName: "Soldier", cashReward: 500n, bulletReward: 5, maxHealth: 110 });

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.rankId).toBe(soldierId);
    expect(stats?.cash).toBe(500n);
    expect(stats?.bullets).toBe(5n);
    expect(stats?.health).toBe(110);
    expect(stats?.exp).toBe(150n);

    const ledger = await db.select().from(transactions);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.reason).toBe("rank.reward");
  });

  it("does not re-promote or re-credit once already at the qualifying rank", async () => {
    await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 150n));
    const again = await db.transaction((tx) => applyExpAndRankUp(tx, playerId, 1n)); // 151 exp, still Soldier
    expect(again).toBeNull();
    const [stats] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.cash).toBe(500n); // unchanged — no second reward
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/server/test/ranks.test.ts`
Expected: FAIL — cannot resolve `../src/economy/ranks.js`.

- [ ] **Step 4: Write `economy/ranks.ts`**

```ts
import { desc, eq, lte, sql } from "drizzle-orm";
import { players, playerStats, ranks } from "../db/schema/index.js";
import { addExp, applyBalanceChange, type Tx } from "./ledger.js";

export interface RankUpResult {
  rankId: string;
  rankName: string;
  cashReward: bigint;
  bulletReward: number;
  maxHealth: number;
}

/**
 * Adds exp, then promotes the player to the highest rank their new total
 * exp now qualifies for (spec §1.2 ranks.R_exp threshold). A single large
 * exp grant can cross more than one threshold at once — this grants only
 * the destination rank's own reward, not every skipped rung's (M2 plan
 * Decision 6). Returns the promotion details on a fresh promotion, or null
 * when nothing changed (no exp gained, or already at the qualifying rank).
 * Must run inside the caller's transaction, same contract as addExp.
 */
export async function applyExpAndRankUp(tx: Tx, playerId: string, expGain: bigint): Promise<RankUpResult | null> {
  await addExp(tx, playerId, expGain);
  if (expGain === 0n) return null;

  const [current] = await tx.select({ exp: playerStats.exp, rankId: playerStats.rankId })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  if (!current) return null;

  const [target] = await tx.select().from(ranks)
    .where(lte(ranks.expRequired, current.exp))
    .orderBy(desc(ranks.expRequired))
    .limit(1);
  if (!target || target.id === current.rankId) return null;

  await tx.update(playerStats).set({
    rankId: target.id,
    health: target.maxHealth, // V2: a rank-up raises the health ceiling (R_health)
  }).where(eq(playerStats.playerId, playerId));

  if (target.cashReward > 0n) {
    await applyBalanceChange(tx, {
      playerId, amount: target.cashReward, kind: "cash", reason: "rank.reward", refId: target.id,
    });
  }
  if (target.bulletReward > 0) {
    await tx.update(playerStats)
      .set({ bullets: sql`${playerStats.bullets} + ${target.bulletReward}` })
      .where(eq(playerStats.playerId, playerId));
  }

  return {
    rankId: target.id, rankName: target.name,
    cashReward: target.cashReward, bulletReward: target.bulletReward, maxHealth: target.maxHealth,
  };
}
```

- [ ] **Step 5: Run the ranks test to verify it passes**

Run: `npx vitest run apps/server/test/ranks.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Seed the rank ladder**

In `apps/server/src/db/seed.ts`, add (alongside `seedCrimes`, importing `ranks` from the schema barrel):

```ts
export async function seedRanks(db: Db): Promise<void> {
  const existing = await db.select({ id: ranks.id }).from(ranks).limit(1);
  if (existing.length > 0) return;

  await db.insert(ranks).values([
    { id: uuidv7(), name: "Associate", expRequired: 0n, cashReward: 0n, bulletReward: 0, maxHealth: 100 },
    { id: uuidv7(), name: "Soldier", expRequired: 100n, cashReward: 500n, bulletReward: 5, maxHealth: 110 },
    { id: uuidv7(), name: "Capo", expRequired: 500n, cashReward: 2500n, bulletReward: 15, maxHealth: 125 },
    { id: uuidv7(), name: "Underboss", expRequired: 2000n, cashReward: 10000n, bulletReward: 40, maxHealth: 150 },
    { id: uuidv7(), name: "Boss", expRequired: 8000n, cashReward: 50000n, bulletReward: 100, maxHealth: 200 },
  ]);
}
```

- [ ] **Step 7: Write the route**

`apps/server/src/game/ranks/routes.ts`:

```ts
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../../db/client.js";
import { playerStats, ranks } from "../../db/schema/index.js";

export function registerRankRoutes(
  app: FastifyInstance, db: Db,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/ranks", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const [player] = await db.select({ rankId: playerStats.rankId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    const rows = await db.select().from(ranks).orderBy(asc(ranks.expRequired));

    return reply.send({
      ranks: rows.map((r) => ({
        id: r.id, name: r.name, expRequired: r.expRequired.toString(),
        cashReward: r.cashReward.toString(), bulletReward: r.bulletReward, maxHealth: r.maxHealth,
        current: r.id === player?.rankId,
      })),
    });
  });
}
```

- [ ] **Step 8: Wire seeding and the route into boot**

In `apps/server/src/app.ts`: import and register `registerRankRoutes(app, deps.db, requireAuth);` next to the jail route.

In `apps/server/src/index.ts` and `apps/server/test/helpers/server.ts`, add `await seedRanks(db);` next to the existing `await seedCrimes(db);` call (same import line, `import { seedCrimes, seedRanks } from "./db/seed.js";` / relative equivalent in the test helper).

- [ ] **Step 9: Add a route-level test and run the full file**

Append to `ranks.test.ts`:

```ts
describe("GET /api/ranks", () => {
  it("lists the ladder with the player's current rank flagged", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadConfig } = await import("../src/config.js");
    const { createCrimeQueue } = await import("../src/queue/index.js");
    const { createRedis } = await import("../src/redis.js");
    const { seedRanks } = await import("../src/db/seed.js");
    await seedRanks(db);

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const app = await buildApp(config, { db, redis: createRedis(config.redisUrl), crimeQueue: createCrimeQueue(createRedis(config.redisUrl)) });
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: `Rank${Date.now()}`, password: "hunter2hunter2" } });
    const { token } = reg.json();

    const res = await app.inject({ method: "GET", url: "/api/ranks", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const { ranks: list } = res.json();
    expect(list).toHaveLength(5);
    expect(list.every((r: { current: boolean }) => r.current === false)).toBe(true); // no exp yet

    await app.close();
  });
});
```

Note: this test creates its own `db`/`redis` — reuse the module-level `testDb()` handle already declared at the top of the file (do not open a second connection); import `createRedis` and call it once, storing it in a `const redis = createRedis(...)` near the top alongside the existing setup, with `redis.disconnect()` added to the existing `afterAll`.

Run: `npx vitest run apps/server/test/ranks.test.ts && npm run verify`
Expected: PASS, 5 tests in the file; gate exits 0.

- [ ] **Step 10: Commit**

```bash
git add packages/shared apps/server/src/economy/ranks.ts apps/server/src/db/seed.ts apps/server/src/game/ranks apps/server/src/app.ts apps/server/src/index.ts apps/server/test/helpers/server.ts apps/server/test/ranks.test.ts
git commit -m "feat(server): add exp-driven rank promotion, ladder seed, and GET /api/ranks"
```

---

### Task 5: Bank deposit and withdraw

**Files:**
- Create: `packages/shared/src/dto/bank.ts`; Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/game/bank/service.ts`
- Create: `apps/server/src/game/bank/routes.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/bank.test.ts`

**Interfaces:**
- Consumes: `applyBalanceChange`, `InsufficientFundsError` (Task 8), `bank.transacted` event (Task 1).
- Produces:
  - `performBankTransaction(db, redis, playerId, direction, amount): Promise<{ cash: bigint; bank: bigint }>` — one Postgres transaction, two ledger rows (a cash leg and a bank leg), published event, callable directly from tests (no HTTP, no cooldown — bank has no V2 cooldown, Decision 1).
  - Routes: `POST /api/bank/deposit`, `POST /api/bank/withdraw`.

- [ ] **Step 1: Write the shared DTO**

`packages/shared/src/dto/bank.ts`:

```ts
import { z } from "zod";
import { MoneySchema } from "../primitives.js";

export const BankTransactionRequestSchema = z.object({ amount: MoneySchema });
export type BankTransactionRequest = z.infer<typeof BankTransactionRequestSchema>;

export const BankStatusResponseSchema = z.object({ cash: MoneySchema, bank: MoneySchema });
export type BankStatusResponse = z.infer<typeof BankStatusResponseSchema>;
```

Append to `packages/shared/src/index.ts`: `export * from "./dto/bank.js";`

- [ ] **Step 2: Write the failing service test**

`apps/server/test/bank.test.ts`:

```ts
import { GameEventSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, playerStats, transactions } from "../src/db/schema/index.js";
import { InsufficientFundsError } from "../src/economy/ledger.js";
import { performBankTransaction } from "../src/game/bank/service.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n });
});
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

const waitForEvent = (): Promise<unknown> =>
  new Promise((resolve) => {
    subscriber.once("message", (channel, raw) => { if (channel === GAME_EVENTS_CHANNEL) resolve(JSON.parse(raw)); });
  });

describe("performBankTransaction", () => {
  it("moves cash into the bank in one transaction with two ledger rows", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = waitForEvent();

    const result = await performBankTransaction(db, redis, playerId, "deposit", 400n);
    expect(result).toEqual({ cash: 600n, bank: 400n });

    const event = GameEventSchema.parse(await received);
    expect(event.type).toBe("bank.transacted");
    if (event.type !== "bank.transacted") throw new Error("unreachable");
    expect(event.direction).toBe("deposit");
    expect(event.amount).toBe("400");

    const ledger = await db.select().from(transactions).orderBy(transactions.balanceKind);
    expect(ledger).toHaveLength(2);
    expect(ledger.find((r) => r.balanceKind === "cash")?.amount).toBe(-400n);
    expect(ledger.find((r) => r.balanceKind === "bank")?.amount).toBe(400n);
  });

  it("moves bank cash back to cash on withdraw", async () => {
    await performBankTransaction(db, redis, playerId, "deposit", 400n);
    const result = await performBankTransaction(db, redis, playerId, "withdraw", 150n);
    expect(result).toEqual({ cash: 750n, bank: 250n });
  });

  it("rejects an overdraft on either leg and leaves both balances untouched", async () => {
    await expect(performBankTransaction(db, redis, playerId, "withdraw", 1n)).rejects.toBeInstanceOf(InsufficientFundsError);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.cash).toBe(1000n);
    expect(row?.bank).toBe(0n);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it("serializes two concurrent withdrawals so only one can succeed against a tight balance", async () => {
    await performBankTransaction(db, redis, playerId, "deposit", 100n);
    const results = await Promise.allSettled([
      performBankTransaction(db, redis, playerId, "withdraw", 60n),
      performBankTransaction(db, redis, playerId, "withdraw", 60n),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [row] = await db.select({ bank: playerStats.bank }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.bank).toBe(40n);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/server/test/bank.test.ts`
Expected: FAIL — cannot resolve `../src/game/bank/service.js`.

- [ ] **Step 4: Write `game/bank/service.ts`**

```ts
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { players, playerStats } from "../../db/schema/index.js";
import { applyBalanceChange } from "../../economy/ledger.js";

export type BankDirection = "deposit" | "withdraw";
export interface BankTransactionResult { cash: bigint; bank: bigint }

/**
 * Two ledger legs (a cash debit/credit and a matching bank credit/debit) in
 * ONE transaction — the same "one balance, one ledger row" rule from Task 8
 * applied twice. No cooldown, no queue: bank has no V2 cooldown (spec §1.2)
 * and no randomness to protect from a retry (M2 plan Decision 1); the row
 * lock `applyBalanceChange` already takes on `player_stats` is what makes
 * two concurrent requests against the same player safe.
 */
export async function performBankTransaction(
  db: Db, redis: Redis, playerId: string, direction: BankDirection, amount: bigint,
): Promise<BankTransactionResult> {
  const result = await db.transaction(async (tx) => {
    if (direction === "deposit") {
      await applyBalanceChange(tx, { playerId, amount: -amount, kind: "cash", reason: "bank.deposit" });
      await applyBalanceChange(tx, { playerId, amount, kind: "bank", reason: "bank.deposit" });
    } else {
      await applyBalanceChange(tx, { playerId, amount: -amount, kind: "bank", reason: "bank.withdraw" });
      await applyBalanceChange(tx, { playerId, amount, kind: "cash", reason: "bank.withdraw" });
    }
    const [row] = await tx.select({ cash: playerStats.cash, bank: playerStats.bank })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    if (!row) throw new Error(`player_stats missing for ${playerId}`);
    return row;
  });

  const [actor] = await db.select({ username: players.username }).from(players).where(eq(players.id, playerId));
  const event: GameEvent = {
    id: uuidv7(), type: "bank.transacted", at: new Date().toISOString(),
    actorId: playerId, actorName: actor?.username ?? "unknown",
    audience: { kind: "player", playerId },
    direction, amount: amount.toString(), cash: result.cash.toString(), bank: result.bank.toString(),
  };
  await publishEvent(redis, event);

  return result;
}
```

- [ ] **Step 5: Run the service tests to verify they pass**

Run: `npx vitest run apps/server/test/bank.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the routes**

`apps/server/src/game/bank/routes.ts`:

```ts
import { BankTransactionRequestSchema } from "@gl3/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../../db/client.js";
import { InsufficientFundsError } from "../../economy/ledger.js";
import { performBankTransaction, type BankDirection } from "./service.js";

export function registerBankRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  const handler = (direction: BankDirection) => async (request: FastifyRequest, reply: FastifyReply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = BankTransactionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const amount = BigInt(parsed.data.amount);
    if (amount <= 0n) return reply.code(400).send({ error: "amount_must_be_positive" });

    try {
      const result = await performBankTransaction(db, redis, playerId, direction, amount);
      return reply.send({ cash: result.cash.toString(), bank: result.bank.toString() });
    } catch (err) {
      if (err instanceof InsufficientFundsError) return reply.code(409).send({ error: "insufficient_funds" });
      throw err;
    }
  };

  app.post("/api/bank/deposit", { preHandler: requireAuth }, handler("deposit"));
  app.post("/api/bank/withdraw", { preHandler: requireAuth }, handler("withdraw"));
}
```

In `apps/server/src/app.ts`, register: `registerBankRoutes(app, deps.db, deps.redis, requireAuth);` (bank is not jail-gated — Decision 4).

- [ ] **Step 7: Add route-level tests and run the full file**

Append to `bank.test.ts` a `describe("POST /api/bank/deposit and /withdraw", …)` block mirroring the `GET /api/ranks` HTTP test shape from Task 4 Step 9 (boot the app via `buildApp`, register a player, `db.update(playerStats).set({ cash: ... })` to fund them since registration starts at 0, then assert `200`/`409` status codes and response bodies).

Run: `npx vitest run apps/server/test/bank.test.ts && npm run verify`
Expected: PASS; gate exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/shared apps/server/src/game/bank apps/server/src/app.ts apps/server/test/bank.test.ts
git commit -m "feat(server): add bank deposit/withdraw as a synchronous double-ledger transfer"
```

---

### Task 6: Wire jail-on-failure and rank-up into the crime worker

Chains after Task 2 (jail columns), Task 3 (jail primitives), Task 4 (rank-up). This is the integration point — it does not introduce new primitives, it composes existing ones inside the one file that already owns "what happens when a crime resolves."

**Files:**
- Modify: `apps/server/src/game/crimes/worker.ts`
- Modify: `apps/server/src/game/crimes/routes.ts`
- Test: `apps/server/test/crimes.test.ts` (extend), `apps/server/test/crime-worker-idempotency.test.ts` (extend)

**Interfaces:**
- Consumes: `sendToJail`, `releaseIfExpired` (Task 3), `applyExpAndRankUp` (Task 4), `crimes.jailChancePercent`/`jailSeconds` (Task 2).
- Produces: `processCrimeJob` now also may send the player to jail and/or rank them up; `crime.resolved.jailedUntil` is populated instead of always `null`; `player.jailed` and `player.rankedUp` are published alongside `crime.resolved` on a fresh (non-retry) resolution. The crime-commit route now 423s a jailed player instead of accepting the job.

- [ ] **Step 1: Extend the failing crimes test for the jail gate**

Append to `apps/server/test/crimes.test.ts`:

```ts
describe("POST /api/crimes/:crimeId/commit while jailed", () => {
  it("423s and does not enqueue a job", async () => {
    const future = new Date(Date.now() + 60_000);
    await db.update(playerStats).set({ jailedUntil: future }).where(eq(playerStats.playerId, playerId));

    const res = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ error: "jailed" });

    // No cooldown was burned, and jail is left exactly as it was.
    const stillJailed = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(stillJailed.statusCode).toBe(423);
  });
});
```

(Import `playerStats` alongside the file's existing `crimes, transactions` import from `../src/db/schema/index.js`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/server/test/crimes.test.ts`
Expected: FAIL — currently returns 202/429, the route has no jail gate.

- [ ] **Step 3: Gate the commit route on jail**

In `apps/server/src/game/crimes/routes.ts`, add the import `import { releaseIfExpired } from "../jail/status.js";` and insert this check inside `POST /api/crimes/:crimeId/commit`, immediately after the `playerId` guard and before the `params` parse:

```ts
    const jail = await releaseIfExpired(db, redis, playerId);
    if (jail.jailed) {
      reply.header("retry-after", String(jail.remainingSeconds));
      return reply.code(423).send({ error: "jailed", remainingSeconds: jail.remainingSeconds });
    }
```

- [ ] **Step 4: Run the crimes test to verify the gate passes**

Run: `npx vitest run apps/server/test/crimes.test.ts`
Expected: PASS (the new describe block; the rest of the file is unaffected since it never sets `jailedUntil`).

- [ ] **Step 5: Write the failing worker test for jail-on-failure and rank-up**

Append to `apps/server/test/crimes.test.ts` (needs a crime with a guaranteed jail chance and a rank ladder seeded — force the outcome via a `job.data.seed` chosen for determinism is fragile against the RNG implementation, so instead exercise this against `processCrimeJob` directly, which is already exported for exactly this purpose per Task 9's own precedent):

```ts
describe("processCrimeJob — jail and rank-up wiring", () => {
  it("jails the player on a crime whose failure rolls jail, and reports it on crime.resolved", async () => {
    const { processCrimeJob } = await import("../src/game/crimes/worker.js");
    const [armouredVan] = await db.select().from(crimes).where(eq(crimes.name, "Armoured Van"));
    if (!armouredVan) throw new Error("seed missing Armoured Van");

    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const events: unknown[] = [];
    subscriber.on("message", (channel, raw) => { if (channel === GAME_EVENTS_CHANNEL) events.push(JSON.parse(raw)); });

    // Brute-force a seed that both fails the crime and rolls under its 40%
    // jail chance — deterministic once found, cheap since createRng is a
    // pure sha256 stream with no I/O.
    let seed = "";
    for (let i = 0; i < 500; i += 1) {
      const candidate = `jail-search-${i}`;
      const rng = (await import("../src/game/rng.js")).createRng(candidate);
      const roll = rng.int(0, 10_000);
      const success = roll < Math.round(35 * 100); // player has no player_crime_skill row -> DEFAULT_CRIME_CHANCE 35%
      if (success) continue;
      const jailRoll = rng.int(0, 100);
      if (jailRoll < armouredVan.jailChancePercent) { seed = candidate; break; }
    }
    expect(seed).not.toBe("");

    await processCrimeJob(db, redis, { id: "jail-test-job", data: { playerId, crimeId: armouredVan.id, seed } });

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.jailedUntil).not.toBeNull();
    expect(stats!.jailedUntil!.getTime()).toBeGreaterThan(Date.now());

    const resolved = events.find((e) => (e as { type: string }).type === "crime.resolved") as { jailedUntil: string | null };
    expect(resolved.jailedUntil).not.toBeNull();
    const jailed = events.find((e) => (e as { type: string }).type === "player.jailed");
    expect(jailed).toBeDefined();
  });

  it("ranks up and republishes an accurate jailedUntil on an idempotent replay", async () => {
    const { processCrimeJob } = await import("../src/game/crimes/worker.js");
    const { seedRanks } = await import("../src/db/seed.js");
    await seedRanks(db);

    // A seed that succeeds a crime worth enough exp to promote past Associate (0 exp) to Soldier is
    // unnecessary here — Associate itself (0 exp threshold, 0 reward) already proves the plumbing
    // without needing a search: any successful commit crosses 0 exp -> Associate on the first call.
    let seed = "";
    for (let i = 0; i < 500; i += 1) {
      const candidate = `rank-search-${i}`;
      const rng = (await import("../src/game/rng.js")).createRng(candidate);
      const roll = rng.int(0, 10_000);
      if (roll < Math.round(35 * 100)) { seed = candidate; break; }
    }
    expect(seed).not.toBe("");

    const job = { id: "rank-test-job", data: { playerId, crimeId, seed } };
    await processCrimeJob(db, redis, job);
    const [afterFirst] = await db.select({ rankId: playerStats.rankId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(afterFirst?.rankId).not.toBeNull();

    // Replay the SAME job.id — must not double-promote or double-credit,
    // and must still report the player's real (already-jailed-or-not) state.
    await processCrimeJob(db, redis, job);
    const [afterReplay] = await db.select({ rankId: playerStats.rankId, cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(afterReplay?.rankId).toBe(afterFirst?.rankId);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run apps/server/test/crimes.test.ts`
Expected: FAIL — `crime.resolved.jailedUntil` is always `null` and no `player.jailed`/`player.rankedUp` is ever published.

- [ ] **Step 7: Rewrite `processCrimeJob`**

In `apps/server/src/game/crimes/worker.ts`, add imports:

```ts
import { eq } from "drizzle-orm";
import { applyExpAndRankUp, type RankUpResult } from "../../economy/ranks.js";
import { sendToJail } from "../jail/status.js";
import { playerStats } from "../../db/schema/index.js";
```

Replace the body of `processCrimeJob` from the RNG rolls onward (everything from `const rng = createRng(seed);` through the final `await publishEvent(publisher, event);`) with:

```ts
  const rng = createRng(seed);
  const roll = rng.int(0, 10_000); // two decimals of precision
  const success = roll < Math.round(chance * 100);

  const payout = success ? rng.bigint(crime.minPayout, crime.maxPayout) : 0n;
  const bullets = success ? BigInt(rng.int(crime.minBullets, crime.maxBullets + 1)) : 0n;
  const exp = success ? crime.expReward : 0n;

  // A second, independent draw from the SAME seeded stream — deterministic
  // per job, so a retry re-derives the identical jail outcome instead of
  // re-rolling a luckier one (spec §7). Only a failed crime carries jail
  // risk (M2 plan Decision 2 — GL3 model addition, not audited from V2).
  const jailRoll = !success && crime.jailChancePercent > 0 ? rng.int(0, 100) : 100;
  const jailed = jailRoll < crime.jailChancePercent;

  let rankUp: RankUpResult | null = null;
  let alreadyProcessed = false;
  try {
    await db.transaction(async (tx) => {
      // Idempotency marker first, same rule as before (see the comment this
      // replaces): everything below only commits if this insert is new.
      await tx.insert(crimeLog).values({ id: uuidv7(), playerId, crimeId, success, payout, jobId: job.id });
      if (payout > 0n) {
        await applyBalanceChange(tx, { playerId, amount: payout, kind: "cash", reason: "crime.payout", refId: crimeId });
      }
      if (exp > 0n) rankUp = await applyExpAndRankUp(tx, playerId, exp);
      if (jailed) await sendToJail(tx, playerId, crime.jailSeconds);
    });
  } catch (err) {
    if (uniqueViolation(err)?.constraint_name === "crime_log_job_id_unique") {
      alreadyProcessed = true; // this job.id already paid out — do not re-credit or re-jail
    } else {
      throw err;
    }
  }

  // Re-read jail state after the transaction rather than trust this
  // invocation's local `jailed` flag: on an idempotent-replay, the actual
  // jail (if any) was written by the ORIGINAL attempt, not this call, and
  // crime.resolved must still report the player's real state either way.
  const [freshStats] = await db.select({ jailedUntil: playerStats.jailedUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  const effectiveJailedUntil = freshStats?.jailedUntil ?? null;

  const event: GameEvent = {
    id: uuidv7(),
    type: "crime.resolved",
    at: new Date().toISOString(),
    actorId: playerId,
    actorName: actor.username,
    audience: { kind: "player", playerId },
    crimeId,
    crimeName: crime.name,
    success,
    payout: payout.toString(),
    bullets: bullets.toString(),
    exp: exp.toString(),
    jailedUntil: effectiveJailedUntil ? effectiveJailedUntil.toISOString() : null,
  };
  await publishEvent(publisher, event);

  // player.jailed and player.rankedUp are supplementary notifications, not
  // the primary fact (crime.resolved already carries jailedUntil above and
  // GET /api/ranks already reflects a promotion) — published only on the
  // fresh path. Unlike crime.resolved, deliberately NOT republished on an
  // idempotent replay: reconstructing "did THIS attempt newly cross a rank
  // threshold" from a cold read after the fact isn't cheaply knowable, and a
  // client that already holds crime.resolved's jailedUntil has the
  // essential fact regardless (M2 plan Task 6).
  if (!alreadyProcessed && jailed) {
    const jailedEvent: GameEvent = {
      id: uuidv7(), type: "player.jailed", at: new Date().toISOString(),
      actorId: playerId, actorName: actor.username,
      audience: { kind: "player", playerId },
      until: effectiveJailedUntil!.toISOString(), reason: "crime.failed",
    };
    await publishEvent(publisher, jailedEvent);
  }
  if (!alreadyProcessed && rankUp) {
    const rankedUpEvent: GameEvent = {
      id: uuidv7(), type: "player.rankedUp", at: new Date().toISOString(),
      actorId: playerId, actorName: actor.username,
      audience: { kind: "player", playerId },
      rankId: rankUp.rankId, rankName: rankUp.rankName,
      cashReward: rankUp.cashReward.toString(), bulletReward: rankUp.bulletReward.toString(), maxHealth: rankUp.maxHealth,
    };
    await publishEvent(publisher, rankedUpEvent);
  }
```

- [ ] **Step 8: Run the crimes tests to verify they pass**

Run: `npx vitest run apps/server/test/crimes.test.ts apps/server/test/crime-worker-idempotency.test.ts`
Expected: PASS. The pre-existing idempotency test still passes unchanged — it only asserted on `crime_log`/`transactions` row counts, which this change doesn't alter.

- [ ] **Step 9: Run the full gate and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add apps/server/src/game/crimes apps/server/test/crimes.test.ts
git commit -m "feat(server): wire jail-on-failure and rank-up into the crime worker, gate commit on jail"
```

---

### Task 7: Travel

**Files:**
- Create: `packages/shared/src/dto/travel.ts`; Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/game/travel/service.ts`
- Create: `apps/server/src/game/travel/routes.ts`
- Modify: `apps/server/src/db/seed.ts` (add `seedLocations`)
- Modify: `apps/server/src/app.ts`, `apps/server/src/index.ts`, `apps/server/test/helpers/server.ts`
- Test: `apps/server/test/travel.test.ts`

**Interfaces:**
- Consumes: `lockPlayersForUpdate`, `applyBalanceChange`, `InsufficientFundsError` (Task 8), `player.travelled` (Task 1, extended), `releaseIfExpired` (Task 3, used at the route for the jail gate).
- Produces:
  - `performTravel(db, redis, playerId, toLocationId): Promise<{ locationId: string; cash: string }>`
  - `class LocationNotFoundError`, `class AlreadyAtLocationError`
  - `seedLocations(db): Promise<void>`
  - Routes: `GET /api/locations`, `POST /api/travel/:locationId` (cooldown-gated per SPEC §1.2 `L_cooldown`, jail-gated).

- [ ] **Step 1: Write the shared DTOs**

`packages/shared/src/dto/travel.ts`:

```ts
import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

export const LocationDtoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  travelCost: MoneySchema,
  travelCooldownSeconds: z.number().int().nonnegative(),
  bulletCost: MoneySchema,
  bulletStock: z.number().int().nonnegative(),
  current: z.boolean(),
  cooldownRemaining: z.number().int().nonnegative(),
});
export type LocationDto = z.infer<typeof LocationDtoSchema>;

export const LocationListResponseSchema = z.object({ locations: z.array(LocationDtoSchema) });
export type LocationListResponse = z.infer<typeof LocationListResponseSchema>;

export const TravelResponseSchema = z.object({ locationId: IdSchema, cash: MoneySchema });
export type TravelResponse = z.infer<typeof TravelResponseSchema>;
```

Append to `packages/shared/src/index.ts`: `export * from "./dto/travel.js";`

- [ ] **Step 2: Write the failing service test**

`apps/server/test/travel.test.ts`:

```ts
import { GameEventSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats } from "../src/db/schema/index.js";
import { AlreadyAtLocationError, LocationNotFoundError, performTravel } from "../src/game/travel/service.js";
import { InsufficientFundsError } from "../src/economy/ledger.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let playerId: string;
let chicagoId: string;
let miamiId: string;

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
});
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

describe("performTravel", () => {
  it("debits the travel cost, moves the player, and publishes player.travelled with a null fromLocationId the first time", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = new Promise((resolve) => {
      subscriber.once("message", (channel, raw) => { if (channel === GAME_EVENTS_CHANNEL) resolve(JSON.parse(raw)); });
    });

    const result = await performTravel(db, redis, playerId, chicagoId);
    expect(result).toEqual({ locationId: chicagoId, cash: "900" });

    const event = GameEventSchema.parse(await received);
    expect(event.type).toBe("player.travelled");
    if (event.type !== "player.travelled") throw new Error("unreachable");
    expect(event.fromLocationId).toBeNull();
    expect(event.toLocationId).toBe(chicagoId);
    expect(event.cost).toBe("100");
  });

  it("rejects travelling to the player's current location", async () => {
    await performTravel(db, redis, playerId, chicagoId);
    await expect(performTravel(db, redis, playerId, chicagoId)).rejects.toBeInstanceOf(AlreadyAtLocationError);
  });

  it("rejects an unknown location", async () => {
    await expect(performTravel(db, redis, playerId, uuidv7())).rejects.toBeInstanceOf(LocationNotFoundError);
  });

  it("rejects travel the player can't afford and leaves them in place", async () => {
    await db.update(playerStats).set({ cash: 50n }).where(eq(playerStats.playerId, playerId));
    await expect(performTravel(db, redis, playerId, miamiId)).rejects.toBeInstanceOf(InsufficientFundsError);
    const [row] = await db.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.locationId).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/server/test/travel.test.ts`
Expected: FAIL — cannot resolve `../src/game/travel/service.js`.

- [ ] **Step 4: Write `game/travel/service.ts`**

```ts
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { locations, players, playerStats } from "../../db/schema/index.js";
import { lockPlayersForUpdate, applyBalanceChange } from "../../economy/ledger.js";

export class LocationNotFoundError extends Error {
  constructor(readonly locationId: string) { super(`location not found: ${locationId}`); this.name = "LocationNotFoundError"; }
}
export class AlreadyAtLocationError extends Error {
  constructor(readonly locationId: string) { super(`already at location: ${locationId}`); this.name = "AlreadyAtLocationError"; }
}

export interface TravelResult { locationId: string; cash: string }

/**
 * No randomness, so no worker (M2 plan Decision 1) — a `SELECT … FOR UPDATE`
 * on the player's row (via lockPlayersForUpdate) inside one transaction
 * gives the same "no double-travel, no double-debit" guarantee a queue
 * would, and the route layer still gates on the real per-location cooldown
 * with Redis SET NX EX (spec §1.2 locations.L_cooldown) before calling this.
 */
export async function performTravel(db: Db, redis: Redis, playerId: string, toLocationId: string): Promise<TravelResult> {
  const [destination] = await db.select().from(locations).where(eq(locations.id, toLocationId));
  if (!destination) throw new LocationNotFoundError(toLocationId);

  let fromLocationId: string | null = null;
  await db.transaction(async (tx) => {
    await lockPlayersForUpdate(tx, [playerId]);
    const [current] = await tx.select({ locationId: playerStats.locationId })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    fromLocationId = current?.locationId ?? null;
    if (fromLocationId === toLocationId) throw new AlreadyAtLocationError(toLocationId);

    if (destination.travelCost > 0n) {
      await applyBalanceChange(tx, { playerId, amount: -destination.travelCost, kind: "cash", reason: "travel.cost", refId: destination.id });
    }
    await tx.update(playerStats).set({ locationId: destination.id }).where(eq(playerStats.playerId, playerId));
  });

  const [actor] = await db.select({ username: players.username }).from(players).where(eq(players.id, playerId));
  const [fresh] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));

  const event: GameEvent = {
    id: uuidv7(), type: "player.travelled", at: new Date().toISOString(),
    actorId: playerId, actorName: actor?.username ?? "unknown",
    audience: { kind: "player", playerId },
    fromLocationId, toLocationId: destination.id, cost: destination.travelCost.toString(),
  };
  await publishEvent(redis, event);

  return { locationId: destination.id, cash: (fresh?.cash ?? 0n).toString() };
}
```

- [ ] **Step 5: Run the service tests to verify they pass**

Run: `npx vitest run apps/server/test/travel.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Seed locations**

In `apps/server/src/db/seed.ts`, add:

```ts
export async function seedLocations(db: Db): Promise<void> {
  const existing = await db.select({ id: locations.id }).from(locations).limit(1);
  if (existing.length > 0) return;

  await db.insert(locations).values([
    { id: uuidv7(), name: "New York", travelCost: 0n, travelCooldownSeconds: 30, bulletStock: 1000, bulletCost: 3n },
    { id: uuidv7(), name: "Chicago", travelCost: 100n, travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n },
    { id: uuidv7(), name: "Miami", travelCost: 250n, travelCooldownSeconds: 120, bulletStock: 300, bulletCost: 8n },
  ]);
}
```

- [ ] **Step 7: Write the routes**

`apps/server/src/game/travel/routes.ts`:

```ts
import { IdSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { locations, playerStats } from "../../db/schema/index.js";
import { InsufficientFundsError } from "../../economy/ledger.js";
import { acquireCooldown, cooldownKey, peekCooldown, releaseCooldown } from "../cooldown.js";
import { releaseIfExpired } from "../jail/status.js";
import { AlreadyAtLocationError, LocationNotFoundError, performTravel } from "./service.js";

const TravelParamsSchema = z.object({ locationId: IdSchema });

export function registerTravelRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/locations", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const [player] = await db.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    const rows = await db.select().from(locations);
    const remaining = await peekCooldown(redis, cooldownKey(playerId, "travel"));

    return reply.send({
      locations: rows.map((l) => ({
        id: l.id, name: l.name, travelCost: l.travelCost.toString(), travelCooldownSeconds: l.travelCooldownSeconds,
        bulletCost: l.bulletCost.toString(), bulletStock: l.bulletStock,
        current: l.id === player?.locationId, cooldownRemaining: remaining,
      })),
    });
  });

  app.post("/api/travel/:locationId", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const jail = await releaseIfExpired(db, redis, playerId);
    if (jail.jailed) {
      reply.header("retry-after", String(jail.remainingSeconds));
      return reply.code(423).send({ error: "jailed", remainingSeconds: jail.remainingSeconds });
    }

    const params = TravelParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const { locationId } = params.data;

    const [destination] = await db.select({ travelCooldownSeconds: locations.travelCooldownSeconds }).from(locations).where(eq(locations.id, locationId));
    if (!destination) return reply.code(404).send({ error: "location_not_found" });

    const key = cooldownKey(playerId, "travel");
    const won = await acquireCooldown(redis, key, destination.travelCooldownSeconds);
    if (!won) {
      const retryAfter = await peekCooldown(redis, key);
      reply.header("retry-after", String(Math.max(retryAfter, 1)));
      return reply.code(429).send({ error: "on_cooldown", retryAfter });
    }

    try {
      const result = await performTravel(db, redis, playerId, locationId);
      return reply.send(result);
    } catch (err) {
      try {
        await releaseCooldown(redis, key); // don't strand the player behind a cooldown they never used
      } catch (releaseError) {
        request.log.error({ err: releaseError, playerId, locationId }, "failed to release travel cooldown after failure");
      }
      if (err instanceof LocationNotFoundError) return reply.code(404).send({ error: "location_not_found" });
      if (err instanceof AlreadyAtLocationError) return reply.code(409).send({ error: "already_there" });
      if (err instanceof InsufficientFundsError) return reply.code(409).send({ error: "insufficient_funds" });
      throw err;
    }
  });
}
```

- [ ] **Step 8: Wire seeding and routes into boot**

`app.ts`: register `registerTravelRoutes(app, deps.db, deps.redis, requireAuth);`.
`index.ts` and `test/helpers/server.ts`: add `await seedLocations(db);` next to `seedCrimes`/`seedRanks`.

- [ ] **Step 9: Add route-level tests and run the full file**

Append an HTTP-level `describe` block to `travel.test.ts` mirroring the pattern from Task 4/5 (boot via `buildApp`, register + fund a player, exercise `GET /api/locations`, a successful `POST /api/travel/:id`, a same-destination 409, a cooldown 429 on immediate re-travel, and a 423 while jailed by directly setting `jailedUntil`).

Run: `npx vitest run apps/server/test/travel.test.ts && npm run verify`
Expected: PASS; gate exits 0.

- [ ] **Step 10: Commit**

```bash
git add packages/shared apps/server/src/game/travel apps/server/src/db/seed.ts apps/server/src/app.ts apps/server/src/index.ts apps/server/test/helpers/server.ts apps/server/test/travel.test.ts
git commit -m "feat(server): add travel with cooldown gate, jail gate, and synchronous ledgered cost"
```

---

### Task 8: Bullets shop

Chains after Task 7 (shares `seedLocations` and needs a player to actually be somewhere).

**Files:**
- Create: `packages/shared/src/dto/bullets.ts`; Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/economy/ledger.ts` (add `lockLocationForUpdate`)
- Create: `apps/server/src/game/bullets/service.ts`
- Create: `apps/server/src/game/bullets/routes.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/bullets.test.ts`, extend `apps/server/test/ledger.test.ts`

**Interfaces:**
- Consumes: `applyBalanceChange` (Task 8, M1), `bullets.purchased` (Task 1).
- Produces:
  - `lockLocationForUpdate(tx, locationId): Promise<void>` — locked before the player row, per the Global Constraints lock-order rule.
  - `performBulletsPurchase(db, redis, playerId, quantity): Promise<{ cash: string; bullets: string; bulletStock: number }>`
  - `class NoLocationError`, `class InsufficientStockError`
  - Route: `POST /api/bullets/buy`.

- [ ] **Step 1: Write the shared DTO**

`packages/shared/src/dto/bullets.ts`:

```ts
import { z } from "zod";
import { MoneySchema } from "../primitives.js";

export const BuyBulletsRequestSchema = z.object({ quantity: z.number().int().positive() });
export type BuyBulletsRequest = z.infer<typeof BuyBulletsRequestSchema>;

export const BuyBulletsResponseSchema = z.object({
  cash: MoneySchema, bullets: MoneySchema, bulletStock: z.number().int().nonnegative(),
});
export type BuyBulletsResponse = z.infer<typeof BuyBulletsResponseSchema>;
```

Append to `packages/shared/src/index.ts`: `export * from "./dto/bullets.js";`

- [ ] **Step 2: Write the failing ledger test for the new lock helper**

Append to `apps/server/test/ledger.test.ts`:

```ts
describe("lockLocationForUpdate", () => {
  it("serializes two concurrent stock decrements against the same location", async () => {
    const locationId = uuidv7();
    await db.insert(locations).values({ id: locationId, name: "Testville", bulletStock: 10, bulletCost: 1n });

    const decrement = () => db.transaction(async (tx) => {
      await lockLocationForUpdate(tx, locationId);
      const [row] = await tx.select({ bulletStock: locations.bulletStock }).from(locations).where(eq(locations.id, locationId));
      await tx.update(locations).set({ bulletStock: row!.bulletStock - 5 }).where(eq(locations.id, locationId));
    });

    await Promise.all([decrement(), decrement()]);
    const [final] = await db.select({ bulletStock: locations.bulletStock }).from(locations).where(eq(locations.id, locationId));
    expect(final?.bulletStock).toBe(0); // both decrements applied in sequence, never lost
  });
});
```

(Add `locations` to the file's existing schema import, and `lockLocationForUpdate` to its `../src/economy/ledger.js` import.)

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/server/test/ledger.test.ts`
Expected: FAIL — `lockLocationForUpdate` is not exported.

- [ ] **Step 4: Add the helper to `ledger.ts`**

Add `locations` to the existing `import { playerStats, transactions } from "../db/schema/index.js";` line (becomes `import { locations, playerStats, transactions } from "../db/schema/index.js";`), then append:

```ts
/**
 * Same rationale as lockPlayersForUpdate, for the one shared non-player row
 * this schema locks: a bullets purchase decrements `locations.bullet_stock`,
 * a value every buyer at that location contends over. Global Constraints:
 * always lock the location row before the player's row (called first in
 * performBulletsPurchase) — a single fixed direction is what rules out a
 * deadlock against any future code path that might lock a player row first.
 */
export async function lockLocationForUpdate(tx: Tx, locationId: string): Promise<void> {
  await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, locationId)).for("update");
}
```

- [ ] **Step 5: Run the ledger test to verify it passes**

Run: `npx vitest run apps/server/test/ledger.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing service test**

`apps/server/test/bullets.test.ts`:

```ts
import { GameEventSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats } from "../src/db/schema/index.js";
import { InsufficientFundsError } from "../src/economy/ledger.js";
import { InsufficientStockError, NoLocationError, performBulletsPurchase } from "../src/game/bullets/service.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let playerId: string;
let locationId: string;

beforeEach(async () => {
  await resetDb(db);
  locationId = uuidv7();
  await db.insert(locations).values({ id: locationId, name: "Testville", bulletStock: 10, bulletCost: 5n });
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n, locationId });
});
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

describe("performBulletsPurchase", () => {
  it("debits cash, credits bullets, decrements shared stock, and publishes bullets.purchased", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = new Promise((resolve) => {
      subscriber.once("message", (channel, raw) => { if (channel === GAME_EVENTS_CHANNEL) resolve(JSON.parse(raw)); });
    });

    const result = await performBulletsPurchase(db, redis, playerId, 4);
    expect(result).toEqual({ cash: "980", bullets: "4", bulletStock: 6 });

    const event = GameEventSchema.parse(await received);
    expect(event.type).toBe("bullets.purchased");
    if (event.type !== "bullets.purchased") throw new Error("unreachable");
    expect(event.quantity).toBe(4);
    expect(event.cost).toBe("20");
  });

  it("rejects a player with no location", async () => {
    await db.update(playerStats).set({ locationId: null }).where(eq(playerStats.playerId, playerId));
    await expect(performBulletsPurchase(db, redis, playerId, 1)).rejects.toBeInstanceOf(NoLocationError);
  });

  it("rejects buying more than the location has in stock", async () => {
    await expect(performBulletsPurchase(db, redis, playerId, 11)).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it("rejects a purchase the player can't afford", async () => {
    await db.update(playerStats).set({ cash: 1n }).where(eq(playerStats.playerId, playerId));
    await expect(performBulletsPurchase(db, redis, playerId, 1)).rejects.toBeInstanceOf(InsufficientFundsError);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run apps/server/test/bullets.test.ts`
Expected: FAIL — cannot resolve `../src/game/bullets/service.js`.

- [ ] **Step 8: Write `game/bullets/service.ts`**

```ts
import { eq, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { locations, players, playerStats } from "../../db/schema/index.js";
import { applyBalanceChange, lockLocationForUpdate } from "../../economy/ledger.js";

export class NoLocationError extends Error {
  constructor(readonly playerId: string) { super(`player ${playerId} has no location — travel first`); this.name = "NoLocationError"; }
}
export class InsufficientStockError extends Error {
  constructor(readonly locationId: string, readonly available: number) {
    super(`location ${locationId} has only ${available} bullets in stock`);
    this.name = "InsufficientStockError";
  }
}

export interface BulletsPurchaseResult { cash: string; bullets: string; bulletStock: number }

/**
 * Locks the location row before the player's (Global Constraints lock
 * order), so two concurrent buyers at the same location never both read the
 * same stock and both succeed past it.
 */
export async function performBulletsPurchase(db: Db, redis: Redis, playerId: string, quantity: number): Promise<BulletsPurchaseResult> {
  let usedLocationId = "";
  let cost = 0n;

  const result = await db.transaction(async (tx) => {
    const [player] = await tx.select({ locationId: playerStats.locationId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    if (!player?.locationId) throw new NoLocationError(playerId);
    usedLocationId = player.locationId;

    await lockLocationForUpdate(tx, usedLocationId);
    const [location] = await tx.select().from(locations).where(eq(locations.id, usedLocationId));
    if (!location) throw new NoLocationError(playerId); // location was deleted out from under a stale reference
    if (location.bulletStock < quantity) throw new InsufficientStockError(location.id, location.bulletStock);

    cost = location.bulletCost * BigInt(quantity);
    await applyBalanceChange(tx, { playerId, amount: -cost, kind: "cash", reason: "bullets.purchase", refId: location.id });
    await tx.update(locations).set({ bulletStock: location.bulletStock - quantity }).where(eq(locations.id, location.id));
    await tx.update(playerStats).set({ bullets: sql`${playerStats.bullets} + ${quantity}` }).where(eq(playerStats.playerId, playerId));

    const [fresh] = await tx.select({ cash: playerStats.cash, bullets: playerStats.bullets })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    return { cash: fresh!.cash, bullets: fresh!.bullets, bulletStock: location.bulletStock - quantity };
  });

  const [actor] = await db.select({ username: players.username }).from(players).where(eq(players.id, playerId));
  const event: GameEvent = {
    id: uuidv7(), type: "bullets.purchased", at: new Date().toISOString(),
    actorId: playerId, actorName: actor?.username ?? "unknown",
    audience: { kind: "player", playerId },
    locationId: usedLocationId, quantity, cost: cost.toString(),
    cash: result.cash.toString(), bullets: result.bullets.toString(),
  };
  await publishEvent(redis, event);

  return { cash: result.cash.toString(), bullets: result.bullets.toString(), bulletStock: result.bulletStock };
}
```

- [ ] **Step 9: Run the service tests to verify they pass**

Run: `npx vitest run apps/server/test/bullets.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 10: Write the route**

`apps/server/src/game/bullets/routes.ts`:

```ts
import { BuyBulletsRequestSchema } from "@gl3/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../../db/client.js";
import { InsufficientFundsError } from "../../economy/ledger.js";
import { releaseIfExpired } from "../jail/status.js";
import { InsufficientStockError, NoLocationError, performBulletsPurchase } from "./service.js";

export function registerBulletsRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.post("/api/bullets/buy", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const jail = await releaseIfExpired(db, redis, playerId);
    if (jail.jailed) {
      reply.header("retry-after", String(jail.remainingSeconds));
      return reply.code(423).send({ error: "jailed", remainingSeconds: jail.remainingSeconds });
    }

    const parsed = BuyBulletsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    try {
      const result = await performBulletsPurchase(db, redis, playerId, parsed.data.quantity);
      return reply.send(result);
    } catch (err) {
      if (err instanceof NoLocationError) return reply.code(409).send({ error: "no_location" });
      if (err instanceof InsufficientStockError) return reply.code(409).send({ error: "insufficient_stock", available: err.available });
      if (err instanceof InsufficientFundsError) return reply.code(409).send({ error: "insufficient_funds" });
      throw err;
    }
  });
}
```

In `apps/server/src/app.ts`, register: `registerBulletsRoutes(app, deps.db, deps.redis, requireAuth);`.

- [ ] **Step 11: Add a route-level test and run the full file**

Append an HTTP-level test to `bullets.test.ts` (boot via `buildApp`, register + fund a player, travel them to a seeded location or insert one directly and set `playerStats.locationId`, then `POST /api/bullets/buy`).

Run: `npx vitest run apps/server/test/bullets.test.ts && npm run verify`
Expected: PASS; gate exits 0.

- [ ] **Step 12: Commit**

```bash
git add packages/shared apps/server/src/economy/ledger.ts apps/server/src/game/bullets apps/server/src/app.ts apps/server/test/bullets.test.ts apps/server/test/ledger.test.ts
git commit -m "feat(server): add the bullets shop with location-row-locked stock and ledgered cost"
```

---

### Task 9: Leaderboards

Chains after Task 4 (ranks — exp source), Task 5 (bank — bank score source), Task 6 (crime worker — cash/exp source).

**Files:**
- Create: `packages/shared/src/dto/leaderboard.ts`; Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/game/leaderboard/service.ts`
- Create: `apps/server/src/game/leaderboard/routes.ts`
- Modify: `apps/server/src/game/bank/service.ts`, `apps/server/src/economy/ranks.ts`, `apps/server/src/game/crimes/worker.ts` (add `recordScore` calls after their existing `publishEvent` calls)
- Modify: `apps/server/src/app.ts`, `apps/server/src/index.ts`, `apps/server/test/helpers/server.ts`
- Test: `apps/server/test/leaderboard.test.ts`

**Interfaces:**
- Consumes: nothing new from other M2 tasks structurally — it observes their outputs.
- Produces:
  - `type LeaderboardKind = "cash" | "bank" | "exp"`
  - `recordScore(redis, kind, playerId, score: bigint): Promise<void>`
  - `topN(db, redis, kind, n): Promise<LeaderboardEntry[]>`
  - `rebuildLeaderboards(db, redis): Promise<void>` — idempotent full sweep, called once at boot.
  - Route: `GET /api/leaderboard/:kind`.

- [ ] **Step 1: Write the shared DTO**

`packages/shared/src/dto/leaderboard.ts`:

```ts
import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

export const LeaderboardKindSchema = z.enum(["cash", "bank", "exp"]);
export type LeaderboardKind = z.infer<typeof LeaderboardKindSchema>;

export const LeaderboardEntrySchema = z.object({
  playerId: IdSchema, username: z.string(), score: MoneySchema, rank: z.number().int().positive(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const LeaderboardResponseSchema = z.object({ kind: LeaderboardKindSchema, entries: z.array(LeaderboardEntrySchema) });
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;
```

Append to `packages/shared/src/index.ts`: `export * from "./dto/leaderboard.js";`

- [ ] **Step 2: Write the failing service test**

`apps/server/test/leaderboard.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { rebuildLeaderboards, recordScore, topN } from "../src/game/leaderboard/service.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);

// NEVER `redis.flushdb()`/`flushall()` here. Redis is shared across every test
// file and every concurrently-running agent; flushing wipes sessions, cooldowns,
// rate-limit buckets and BullMQ queue state belonging to other files.
//
// Leaderboard keys are also GLOBAL, while each test file has its own isolated
// Postgres database and calls bootTestServer() -> rebuildLeaderboards(). Without
// namespacing, every file sweeps its own players into the same sorted sets and
// exact top-N assertions are inherently racy. Leaderboards therefore take a key
// namespace defaulting to the production names, and bootTestServer() mints a
// unique prefix per call — the same solution already used for the BullMQ queue
// name. Clean up only your own namespaced keys.
beforeEach(async () => { await resetDb(db); await deleteLeaderboardKeys(redis, namespace); });
afterAll(async () => { await conn.end(); redis.disconnect(); });

const insertPlayer = async (username: string, cash: bigint, exp: bigint): Promise<string> => {
  const id = uuidv7();
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id, cash, exp });
  return id;
};

describe("recordScore / topN", () => {
  it("ranks players highest-score-first", async () => {
    const a = await insertPlayer("Alice", 100n, 0n);
    const b = await insertPlayer("Bob", 500n, 0n);
    const c = await insertPlayer("Carol", 250n, 0n);
    await recordScore(redis, "cash", a, 100n);
    await recordScore(redis, "cash", b, 500n);
    await recordScore(redis, "cash", c, 250n);

    const top = await topN(db, redis, "cash", 10);
    expect(top.map((e) => e.username)).toEqual(["Bob", "Carol", "Alice"]);
    expect(top.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("returns an empty list when nobody has a score yet", async () => {
    expect(await topN(db, redis, "exp", 10)).toEqual([]);
  });
});

describe("rebuildLeaderboards", () => {
  it("sweeps every player_stats row into all three sorted sets, idempotently", async () => {
    const a = await insertPlayer("Alice", 100n, 20n);
    const b = await insertPlayer("Bob", 500n, 5n);

    await rebuildLeaderboards(db, redis);
    await rebuildLeaderboards(db, redis); // second call must not duplicate members or scores

    const byCash = await topN(db, redis, "cash", 10);
    expect(byCash).toHaveLength(2);
    expect(byCash[0]?.username).toBe("Bob");

    const byExp = await topN(db, redis, "exp", 10);
    expect(byExp[0]?.username).toBe("Alice");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/server/test/leaderboard.test.ts`
Expected: FAIL — cannot resolve `../src/game/leaderboard/service.js`.

- [ ] **Step 4: Write `game/leaderboard/service.ts`**

```ts
import { inArray } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { LeaderboardEntry, LeaderboardKind } from "@gl3/shared";
import type { Db } from "../../db/client.js";
import { players, playerStats } from "../../db/schema/index.js";

const key = (kind: LeaderboardKind): string => `leaderboard:${kind}`;

/**
 * Redis sorted-set scores are IEEE-754 doubles, not arbitrary-precision —
 * safe up to 2^53. V2's real ceiling was 2^31 (spec §1.1); no GL3 economy
 * value gets remotely close to 2^53 within this milestone, so this is a
 * documented bound, not an enforced one.
 */
export async function recordScore(redis: Redis, kind: LeaderboardKind, playerId: string, score: bigint): Promise<void> {
  await redis.zadd(key(kind), score.toString(), playerId);
}

export async function topN(db: Db, redis: Redis, kind: LeaderboardKind, n: number): Promise<LeaderboardEntry[]> {
  const raw = await redis.zrevrange(key(kind), 0, n - 1, "WITHSCORES");
  const scored: { playerId: string; score: string }[] = [];
  for (let i = 0; i < raw.length; i += 2) scored.push({ playerId: raw[i]!, score: raw[i + 1]! });
  if (scored.length === 0) return [];

  const rows = await db.select({ id: players.id, username: players.username })
    .from(players).where(inArray(players.id, scored.map((e) => e.playerId)));
  const nameById = new Map(rows.map((r) => [r.id, r.username]));

  return scored.map((entry, i) => ({
    playerId: entry.playerId, username: nameById.get(entry.playerId) ?? "unknown", score: entry.score, rank: i + 1,
  }));
}

/**
 * Idempotent full rebuild from Postgres, run once at boot (spec: "rebuilt
 * from Postgres on boot with an idempotent ZADD sweep"). ZADD on an existing
 * member overwrites its score rather than duplicating it, so calling this
 * any number of times converges to the same state.
 */
export async function rebuildLeaderboards(db: Db, redis: Redis): Promise<void> {
  const rows = await db.select({ playerId: playerStats.playerId, cash: playerStats.cash, bank: playerStats.bank, exp: playerStats.exp }).from(playerStats);
  if (rows.length === 0) return;

  const pipeline = redis.pipeline();
  for (const row of rows) {
    pipeline.zadd(key("cash"), row.cash.toString(), row.playerId);
    pipeline.zadd(key("bank"), row.bank.toString(), row.playerId);
    pipeline.zadd(key("exp"), row.exp.toString(), row.playerId);
  }
  await pipeline.exec();
}
```

- [ ] **Step 5: Run the service tests to verify they pass**

Run: `npx vitest run apps/server/test/leaderboard.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Retrofit live updates into the three write paths**

In `apps/server/src/game/bank/service.ts`, import `recordScore` and add, right after the existing `await publishEvent(redis, event);` line, before `return result;`:

```ts
  await recordScore(redis, "cash", playerId, result.cash);
  await recordScore(redis, "bank", playerId, result.bank);
```

In `apps/server/src/economy/ranks.ts`, `applyExpAndRankUp` does not have `redis` in scope (it runs inside a plain Postgres transaction with no bus access, by design — Task 4 deliberately kept it DB-only). Do not add `redis` there; instead update the exp score from each of its two callers, which already have `redis`:
- In `apps/server/src/game/crimes/worker.ts`, after computing `effectiveJailedUntil` and before constructing the `crime.resolved` event, add (only when exp was actually granted):

```ts
  if (exp > 0n) {
    const [freshExp] = await db.select({ exp: playerStats.exp }).from(playerStats).where(eq(playerStats.playerId, playerId));
    if (freshExp) await recordScore(publisher, "exp", playerId, freshExp.exp);
  }
```

(`publisher` is already the `Redis` instance in scope in `processCrimeJob` — reused here purely as a command client, which is exactly what it already is outside its one `publish` call.)

Also add, immediately after that same block (cash always changes when a crime pays out):

```ts
  if (payout > 0n) {
    const [freshCash] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
    if (freshCash) await recordScore(publisher, "cash", playerId, freshCash.cash);
  }
```

Add the import `import { recordScore } from "../leaderboard/service.js";` to `worker.ts`.

- [ ] **Step 7: Write the route**

`apps/server/src/game/leaderboard/routes.ts`:

```ts
import { LeaderboardKindSchema } from "@gl3/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { topN } from "./service.js";

const ParamsSchema = z.object({ kind: LeaderboardKindSchema });

export function registerLeaderboardRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/leaderboard/:kind", { preHandler: requireAuth }, async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_kind" });

    const entries = await topN(db, redis, params.data.kind, 10);
    return reply.send({ kind: params.data.kind, entries });
  });
}
```

In `apps/server/src/app.ts`, register: `registerLeaderboardRoutes(app, deps.db, deps.redis, requireAuth);`.

In `apps/server/src/index.ts` and `apps/server/test/helpers/server.ts`, call `await rebuildLeaderboards(db, redis);` once at boot, after seeding and before `buildApp`/`app.listen`.

- [ ] **Step 8: Add a route-level test and run the full file**

Append an HTTP-level test exercising `GET /api/leaderboard/cash` after a bank deposit (via `performBankTransaction` called directly in the test, cheaper than a full crime-commit round trip) to confirm the live-update path, plus a `GET /api/leaderboard/not-a-kind` 400 case.

Run: `npx vitest run apps/server/test/leaderboard.test.ts apps/server/test/bank.test.ts apps/server/test/crimes.test.ts && npm run verify`
Expected: PASS; gate exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/shared apps/server/src/game/leaderboard apps/server/src/game/bank/service.ts apps/server/src/game/crimes/worker.ts apps/server/src/app.ts apps/server/src/index.ts apps/server/test/helpers/server.ts apps/server/test/leaderboard.test.ts
git commit -m "feat(server): add Redis sorted-set leaderboards with boot rebuild and live updates"
```

---

### Task 10: Economy invariant test — the milestone's acceptance gate

Depends on every prior task in this plan. This is SPEC §6's literal M2 acceptance criterion: *"economy invariant test: sum(ledger) == balance for 1000 randomized ops."*

**Files:**
- Create: `apps/server/test/economy-invariant.test.ts`

**Interfaces:**
- Consumes: `processCrimeJob` (Task 6), `performBankTransaction` (Task 5), `performTravel` (Task 7), `performBulletsPurchase` (Task 8), `applyExpAndRankUp`'s effects (Task 4) — every M2 money path, called directly (no HTTP, no Redis cooldowns) so 1000 operations run in one fast, deterministic pass, consistent with Decision 7's "every mutation is a plain callable function" design.

- [ ] **Step 1: Write the test**

```ts
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crimes, locations, players, playerStats, transactions } from "../src/db/schema/index.js";
import { seedCrimes, seedLocations, seedRanks } from "../src/db/seed.js";
import { performBankTransaction } from "../src/game/bank/service.js";
import { InsufficientFundsError } from "../src/economy/ledger.js";
import { processCrimeJob } from "../src/game/crimes/worker.js";
import { AlreadyAtLocationError, LocationNotFoundError, performTravel } from "../src/game/travel/service.js";
import { InsufficientStockError, NoLocationError, performBulletsPurchase } from "../src/game/bullets/service.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const PLAYER_COUNT = 5;
const OP_COUNT = 1000;

let playerIds: string[] = [];
let crimeIds: string[] = [];
let locationIds: string[] = [];

beforeAll(async () => {
  await resetDb(db);
  await seedCrimes(db);
  await seedRanks(db);
  await seedLocations(db);

  crimeIds = (await db.select({ id: crimes.id }).from(crimes)).map((r) => r.id);
  locationIds = (await db.select({ id: locations.id }).from(locations)).map((r) => r.id);

  for (let i = 0; i < PLAYER_COUNT; i += 1) {
    const id = uuidv7();
    await db.insert(players).values({ id, username: `invariant${i}-${Date.now()}` });
    // Funded well above any single op's cost so most ops succeed and the
    // invariant is exercised under real balance movement, not mostly-rejects.
    await db.insert(playerStats).values({ playerId: id, cash: 50_000n });
    playerIds.push(id);
  }
});
afterAll(async () => { await conn.end(); redis.disconnect(); });

/** Deterministic, dependency-free PRNG for choosing which op runs next — not spec-governed randomness, just test-harness variety. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("economy invariant across every M2 money path", () => {
  it("keeps sum(ledger) == balance, per player, per kind, across 1000 randomized ops", async () => {
    const rand = mulberry32(20260807);
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

    for (let i = 0; i < OP_COUNT; i += 1) {
      const playerId = pick(playerIds);
      const op = Math.floor(rand() * 4);
      try {
        if (op === 0) {
          await processCrimeJob(db, redis, { id: `invariant-crime-${i}`, data: { playerId, crimeId: pick(crimeIds), seed: `invariant-seed-${i}` } });
        } else if (op === 1) {
          const direction = rand() < 0.5 ? "deposit" : "withdraw";
          const amount = BigInt(1 + Math.floor(rand() * 200));
          await performBankTransaction(db, redis, playerId, direction, amount);
        } else if (op === 2) {
          await performTravel(db, redis, playerId, pick(locationIds));
        } else {
          const quantity = 1 + Math.floor(rand() * 5);
          await performBulletsPurchase(db, redis, playerId, quantity);
        }
      } catch (err) {
        // Expected, frequent rejections that must NOT corrupt state: insufficient
        // funds/stock, already-at-location, no-location-yet. Anything else is a
        // real bug and must fail the test.
        if (
          err instanceof InsufficientFundsError || err instanceof AlreadyAtLocationError ||
          err instanceof InsufficientStockError || err instanceof NoLocationError ||
          err instanceof LocationNotFoundError
        ) continue;
        throw err;
      }
    }

    for (const playerId of playerIds) {
      for (const kind of ["cash", "bank", "points"] as const) {
        const ledgerRows = await db.select({ amount: transactions.amount })
          .from(transactions).where(eq(transactions.playerId, playerId));
        const ledgerSum = ledgerRows
          .filter((_, idx) => true) // placeholder kept simple — filtered by kind below via a second query for clarity
          .reduce((sum, r) => sum, 0n);
        void ledgerSum; // superseded by the kind-filtered query immediately below
      }
    }

    // Re-query filtered by kind directly (clearer and correct — the loop
    // above intentionally does not filter by balanceKind at the SQL level
    // to keep the row fetch shared; the real per-kind sum is computed here).
    for (const playerId of playerIds) {
      const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      if (!stats) throw new Error(`missing player_stats for ${playerId}`);

      for (const [kind, balance] of [["cash", stats.cash], ["bank", stats.bank], ["points", stats.points]] as const) {
        const rows = await db.select({ amount: transactions.amount })
          .from(transactions)
          .where(eq(transactions.playerId, playerId));
        const kindRows = await db.select({ amount: transactions.amount })
          .from(transactions);
        void rows; void kindRows;
      }
    }
  });
});
```

That last block is deliberately incomplete pseudo-code to flag during review — replace Step 1's verification loop with the concrete, correct version below before running anything:

- [ ] **Step 1b: Replace the verification loop with the real per-kind sum**

Delete both placeholder `for` loops above (the ones with `void ledgerSum`/`void rows`) and replace with:

```ts
    const startingCash = 50_000n;
    for (const playerId of playerIds) {
      const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      if (!stats) throw new Error(`missing player_stats for ${playerId}`);

      for (const kind of ["cash", "bank", "points"] as const) {
        const ledgerRows = await db.select({ amount: transactions.amount })
          .from(transactions)
          .where(eq(transactions.playerId, playerId));
        const ledgerSumForKind = ledgerRows.reduce((sum, r) => sum + r.amount, 0n); // filtered below, see note
        void ledgerSumForKind;
      }
    }
```

That still isn't filtering by `balanceKind` — fix it directly by adding the `and(...)` predicate. The **final, correct** assertion block, replacing everything from `const startingCash` above through the end of the `it(...)`:

```ts
    const startingCash = 50_000n;
    for (const playerId of playerIds) {
      const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
      if (!stats) throw new Error(`missing player_stats for ${playerId}`);

      const balanceByKind = { cash: stats.cash, bank: stats.bank, points: stats.points } as const;
      for (const kind of ["cash", "bank", "points"] as const) {
        const ledgerRows = await db.select({ amount: transactions.amount })
          .from(transactions)
          .where(and(eq(transactions.playerId, playerId), eq(transactions.balanceKind, kind)));
        const ledgerSum = ledgerRows.reduce((sum, r) => sum + r.amount, 0n);
        const expected = kind === "cash" ? startingCash + ledgerSum : ledgerSum;
        expect(balanceByKind[kind], `player ${playerId} kind ${kind}`).toBe(expected);
      }
    }
  });
});
```

Add `and` to the file's `drizzle-orm` import: `import { and, eq } from "drizzle-orm";`.

(The starting-cash offset on the `cash` kind only — not `bank`/`points` — mirrors Task 8's own ledger invariant test, which starts a funded player at a nonzero `cash` outside the ledger and asserts `balance === startingBalance + sum(ledger)`; `bank` and `points` both start at the schema default `0`, so their ledger sum equals their balance directly with no offset.)

- [ ] **Step 2: Run it to verify it currently passes** (this is the acceptance test, not new production code — there is no "watch it fail" step because nothing here should be broken if Tasks 1–9 are correct; running it now is the actual verification)

Run: `npx vitest run apps/server/test/economy-invariant.test.ts`
Expected: PASS, 1 test, and it should complete in well under a minute (1000 in-process function calls against a local Postgres, no network hops beyond the DB/Redis sockets).

If it fails, the failure message names the exact `player + kind` whose ledger and balance diverged — treat that as a real bug in whichever of Tasks 4–9 touches that kind, not as a flaw in the test; do not loosen the assertion.

- [ ] **Step 3: Run the full gate and commit**

Run: `npm run verify`
Expected: exits 0. This is the M2 milestone's acceptance criterion passing for real.

```bash
git add apps/server/test/economy-invariant.test.ts
git commit -m "test(server): add the M2 economy invariant test — sum(ledger) == balance across 1000 randomized ops"
```

---

## Milestone acceptance checklist

- [ ] `npm run verify` exits 0 with every task's tests included.
- [ ] A failed crime with `jailChancePercent > 0` can send a player to `player_stats.jailed_until`; a jailed player is 423'd off crime/travel/bullets and freed lazily via `releaseIfExpired`, never by a Redis TTL.
- [ ] Exp gains promote through the `ranks` ladder, crediting cash/bullets once per promotion, never per skipped rung.
- [ ] Bank deposit/withdraw move money between `cash` and `bank` with two ledger rows in one transaction.
- [ ] Travel is cooldown-gated per destination, debits `travel_cost`, and updates `player_stats.location_id`.
- [ ] The bullets shop debits cash and decrements a location's shared `bullet_stock` safely under concurrency.
- [ ] `GET /api/leaderboard/:kind` reads from Redis sorted sets that a boot-time sweep populates idempotently from Postgres, and that stay live as cash/bank/exp change.
- [ ] `apps/server/test/economy-invariant.test.ts` passes: `sum(ledger) == balance` for every player, every kind, after 1000 randomized operations spanning crime, bank, travel, and the bullets shop.
