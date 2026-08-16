# Rounds (Seasonal Scoring Window) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add rounds — a soft season that scores progress made *inside* a scheduled window — to GL3 core, with lazy-at-read rollover, per-round boards, a points payout, and admin scheduling.

**Architecture:** A round is a scoring window, never a wipe. Each player gets one `round_entries` row per round holding their opening `exp`/`cash`/`bank`; standing is `(final_m ?? current_m) − m_at_start`, computed at read and never stored. Rollover (finalize the ended round, activate the next) happens lazily inside whichever request notices, guarded by `pg_advisory_xact_lock(7461002)` plus `WHERE finalized_at IS NULL` / `WHERE snapshotted_at IS NULL` — two independent defences, one against concurrency, one against repetition. No cron, no worker, no BullMQ queue.

**Tech Stack:** TypeScript strict/ESM, Fastify, drizzle-orm, PostgreSQL 16, Redis 7 (pub/sub only here), zod, vitest, React + TanStack Query (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-08-16-rounds-seasonal-design.md` — read it alongside this plan; every task cites its sections.

## Global Constraints

- **The spec contradicts itself once, and the user has ruled on it.** §3.3 says `registerLeaderboardRoutes`' signature "does not change"; §2.2 and §4.1 say it gains `settings: Record<string, string>` and call it "the one signature in core that widens". **It widens — §3.3 is wrong.** Implement the widened signature (Task 10).
- Rounds are **core**, not a plugin (§1.8). No plugin-owned table is created, dropped, altered or written. The plugin migration count stays **seven of sixteen**. No `packages/plugins/*` file is touched by this feature except where a *test* drives an existing plugin route as a lock-order counterparty (Task 9).
- TypeScript strict. **No `any` in `packages/*`** — not even a cast. In `apps/*` prefer `unknown` + a zod parse.
- ESM only; relative imports carry a `.js` extension despite `.ts` sources.
- Zod-validates **every** external boundary — HTTP bodies, **route params**, querystrings.
- Money is `bigint` in Postgres/TypeScript and a **decimal string** on the wire (`MoneySchema`). Never a JSON number. `delta` arrives from postgres.js as a JS string — pass it straight through; never `Number()` it.
- Bigint column defaults are written `` .default(sql`0`) ``, never `.default(0n)` — drizzle-kit's serialiser crashes on `BigInt`.
- Advisory lock constant is **`7461002`** (single-argument, transaction-scoped). `7461001` is taken by the first-admin claim; do not reuse it, do not pick outside the `74610xx` block.
- **CLAUDE.md rule 3:** every balance movement goes through `applyBalanceChange` (`apps/server/src/economy/ledger.ts:50`).
- **CLAUDE.md rule 5:** publish events only *after* the transaction commits — never inside `db.transaction(...)`.
- **CLAUDE.md rule 6:** a foreign key is a lock. The rounds↔player rule is **advisory lock first, then `player_stats` ascending** via one `lockPlayersForUpdate(tx, winnerIds)` call before the first `applyBalanceChange`.
- **CLAUDE.md rule 4:** any test asserting on `game:events` filters by its own actor id. For rounds the actor id is the **round's own id** (§4.4).
- **Every new `apps/server/test/*.test.ts` file needs an explicit entry in `vitest.workspace.ts`** (§5.1). A missing entry fails **silently**: the file never runs and `npm run verify` stays green. Projects: `@gl3/server:unit` (no Postgres/Redis), `@gl3/server:db-only` (`testDb()` only), `@gl3/server` (`bootTestServer()` or both services). Files under `apps/web/test/` are glob-included and need no entry.
- **A test that drives code without `bootTestServer()` still gets core tables** — the template DB is built from core migrations. Only *plugin* tables need `runPluginMigrations`. This feature adds no plugin tables, so no test here needs that call.
- Run the suite as `npm run verify`, **bare**. Do not append `; echo "exit=$?"` — that makes the shell's status the status of `echo`. If you need the log: `npm run verify > /tmp/verify.log 2>&1` then read `$?` before running anything else. A non-zero exit is a failure even when the summary says every test passed.
- Never run two full suites at once on this box; never `FLUSHALL`/`FLUSHDB`.
- Environment: `export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3` and `export REDIS_URL=redis://localhost:6379`.
- Conventional Commits. Commit at the end of every task.

---

## File Structure

**Created — server**

| File | Responsibility |
| --- | --- |
| `apps/server/drizzle/0011_round_entries.sql` | Eight statements: two `rounds` columns, `round_entries` + FKs + index, `rounds_open_idx`, and the settle-the-past `UPDATE`. |
| `apps/server/src/game/rounds/settings.ts` | `payoutPoints(settings)` — parses `rounds.payout_points`, never throws. |
| `apps/server/src/game/rounds/standings.ts` | `roundStandings(...)` — the single ranking statement, live and frozen variants. |
| `apps/server/src/game/rounds/service.ts` | `ensureCurrentRound(...)` — probe, activation, finalize, the settle loop, post-commit publishes. |
| `apps/server/src/game/rounds/routes.ts` | `registerRoundsRoutes(...)` — `GET /api/rounds`, `GET /api/rounds/:id/standings`. |
| `apps/server/src/admin/rounds-page.ts` | `roundsPage: PageSchema` — the admin section's declarative view. |

**Created — shared / web**

| File | Responsibility |
| --- | --- |
| `packages/shared/src/dto/rounds.ts` | `RoundDtoSchema`, `RoundListResponseSchema`, `RoundStandingsResponseSchema`. |
| `apps/web/src/pages/Rounds.tsx` | Hand-written core page: active round + countdown, three boards, hall of fame. Exports its pure helpers for test. |

**Created — tests** (8 server + 1 web; the 8 need `vitest.workspace.ts` entries)

| File | Project |
| --- | --- |
| `apps/server/test/rounds-settings.test.ts` | `@gl3/server:unit` |
| `apps/server/test/rounds-standings.test.ts` | `@gl3/server:db-only` |
| `apps/server/test/rounds-finalize.test.ts` | `@gl3/server` |
| `apps/server/test/rounds-snapshot.test.ts` | `@gl3/server` |
| `apps/server/test/rounds-ledger.test.ts` | `@gl3/server` |
| `apps/server/test/rounds-rollover.test.ts` | `@gl3/server` |
| `apps/server/test/rounds-lock-order.test.ts` | `@gl3/server` |
| `apps/server/test/rounds-routes.test.ts` | `@gl3/server` |
| `apps/server/test/admin-rounds.test.ts` | `@gl3/server` |
| `apps/web/test/rounds-page.test.ts` | `@gl3/web` (glob — no entry) |

> `rounds-settings.test.ts` is a ninth server file, additive to the spec's eight. §5.2 explicitly sanctions extracting a pure piece into `@gl3/server:unit` with its own workspace entry; §3.6's parser is exactly that. The §5.6 acceptance criterion ("all eight … exist and appear as explicit entries") is unaffected. A file named `rounds-absent.test.ts` is **deliberately not created** (§5.2) — risk 3 is proved inside `rounds-snapshot.test.ts` and `rounds-routes.test.ts`.

**Modified**

| File | Change |
| --- | --- |
| `apps/server/src/db/schema/identity.ts` | Two columns on `rounds`; new `roundEntries` table after `playerStats`. |
| `apps/server/drizzle/meta/_journal.json` | Hand-written eleventh entry. |
| `apps/server/src/auth/routes.ts` | Registration's three-statement snapshot block (§2.5). |
| `apps/server/src/index.ts` | Boot call site for `ensureCurrentRound`. |
| `apps/server/src/app.ts` | Import + call `registerRoundsRoutes`; pass `loadedSettings` to `registerLeaderboardRoutes`. |
| `apps/server/src/game/leaderboard/routes.ts` | Widened signature, head-of-handler `ensureCurrentRound`, `scope` querystring, `scope=round` branch. |
| `apps/server/src/plugins/validate.ts` | `"/api/admin/rounds"` reserved; plugin-id-equals-core-module-key boot failure. |
| `apps/server/src/admin/routes.ts` | `rounds` module key; four admin routes; `roundsPage` in the sections payload. |
| `packages/shared/src/events.ts` | Two new `GameEvent` variants; fix the stale "twenty-two" comment. |
| `packages/shared/src/index.ts` | `export * from "./dto/rounds.js";` |
| `packages/shared/package.json` | `0.1.3` → `0.1.4`. |
| `apps/web/src/lib/eventCopy.ts`, `apps/web/src/ws/invalidation.ts` | Arms for both new variants. |
| `apps/web/src/lib/errors.ts` | Five new error-code messages. |
| `apps/web/src/api/keys.ts`, `apps/web/src/api/queries.ts` | `rounds`, `roundStandings`, `leaderboards`; `leaderboard(kind, scope)`; `useRounds`, `useRoundStandings`, `useLeaderboard(kind, scope)`. |
| `apps/web/src/App.tsx`, `apps/web/src/components/Shell.tsx`, `apps/web/src/pages/Leaderboards.tsx` | Route, nav entry, scope toggle. |
| `apps/server/test/plugin-ctx-core-events.test.ts` | `CORPUS` 23 → 25. |
| `apps/server/test/admin-ids-hidden.test.ts` | Rounds section added; floor raised to the true count (11). |
| `apps/server/test/leaderboard.test.ts` | Explicit `?scope=all` case. |
| `apps/web/test/event-copy.test.ts`, `apps/web/test/invalidation.test.ts` | Cases for both variants. |
| `vitest.workspace.ts` | Nine new `include` entries. |

---

### Task 1: Schema and migration `0011_round_entries`

**Spec:** §1.5.1, §1.5.2, §1.5.3.

**Files:**
- Create: `apps/server/drizzle/0011_round_entries.sql`
- Modify: `apps/server/src/db/schema/identity.ts:26-31` (rounds columns), after the `playerStats` block ending at line 87 (new table)
- Modify: `apps/server/drizzle/meta/_journal.json` (append eleventh entry)
- Modify: `vitest.workspace.ts` (`@gl3/server:db-only` include)
- Test: `apps/server/test/rounds-standings.test.ts` (created here with its schema case; Task 3 adds the math cases)

**Interfaces:**
- Consumes: nothing.
- Produces: `roundEntries` table export from `apps/server/src/db/schema/identity.ts` (re-exported by `apps/server/src/db/schema/index.ts`) with columns `roundId, playerId, joinedAt, expAtStart, cashAtStart, bankAtStart, finalExp, finalCash, finalBank`; `rounds.finalizedAt` and `rounds.snapshottedAt`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/rounds-standings.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { beforeEach, describe, expect, it } from "vitest";
import { players, playerStats, roundEntries, rounds } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db } = testDb();

async function seedPlayer(username: string): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return id;
}

async function seedRound(name: string): Promise<string> {
  const id = uuidv7();
  await db.insert(rounds).values({
    id, name,
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 3_600_000),
  });
  return id;
}

beforeEach(async () => { await resetDb(db); });

describe("round_entries schema", () => {
  it("stores an entry with zero defaults and null final_* columns", async () => {
    const roundId = await seedRound("Schema Round");
    const playerId = await seedPlayer("schema_one");

    await db.insert(roundEntries).values({ roundId, playerId });

    const [row] = await db.select().from(roundEntries).where(eq(roundEntries.playerId, playerId));
    expect(row).toBeDefined();
    expect(row!.expAtStart).toBe(0n);
    expect(row!.cashAtStart).toBe(0n);
    expect(row!.bankAtStart).toBe(0n);
    expect(row!.finalExp).toBeNull();
    expect(row!.finalCash).toBeNull();
    expect(row!.finalBank).toBeNull();
    expect(row!.joinedAt).toBeInstanceOf(Date);
  });

  it("rejects a duplicate (round_id, player_id) pair", async () => {
    const roundId = await seedRound("Dup Round");
    const playerId = await seedPlayer("schema_two");
    await db.insert(roundEntries).values({ roundId, playerId });
    await expect(db.insert(roundEntries).values({ roundId, playerId })).rejects.toThrow();
  });

  it("carries the two new rounds stamps, both null on insert", async () => {
    const roundId = await seedRound("Stamp Round");
    const [row] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(row!.finalizedAt).toBeNull();
    expect(row!.snapshottedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Register the file in `vitest.workspace.ts`**

Add to the `@gl3/server:db-only` project's `include` array (one element, path relative to `./apps/server`, no leading `./`, trailing comma):

```ts
        "test/rounds-standings.test.ts",
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run apps/server/test/rounds-standings.test.ts
```

Expected: FAIL — TypeScript cannot resolve `roundEntries`, and/or Postgres answers `42P01 relation "round_entries" does not exist`. (If it instead exits 1 with "No test files found", Step 2 was not done.)

- [ ] **Step 4: Add the two `rounds` columns to the drizzle schema**

In `apps/server/src/db/schema/identity.ts`, append inside the `rounds` table declaration after `endsAt`:

```ts
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  snapshottedAt: timestamp("snapshotted_at", { withTimezone: true }),
```

- [ ] **Step 5: Add the `roundEntries` table**

In the same file, immediately **after** the `playerStats` block and **before** `playerTimers`:

```ts
/**
 * A round is a scoring window, not a wipe. This row is the snapshot taken when
 * a player entered the round; standing = (final ?? current) - start. The
 * `final_*` columns are NULL until the round is finalized, at which point they
 * freeze the board forever. This is also the hall of fame — there is no second
 * table of winners.
 */
export const roundEntries = pgTable("round_entries", {
  roundId: uuid("round_id").notNull().references(() => rounds.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  expAtStart: bigint("exp_at_start", { mode: "bigint" }).notNull().default(sql`0`),
  cashAtStart: bigint("cash_at_start", { mode: "bigint" }).notNull().default(sql`0`),
  bankAtStart: bigint("bank_at_start", { mode: "bigint" }).notNull().default(sql`0`),
  finalExp: bigint("final_exp", { mode: "bigint" }),
  finalCash: bigint("final_cash", { mode: "bigint" }),
  finalBank: bigint("final_bank", { mode: "bigint" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.roundId, t.playerId] }),
  playerIdx: index("round_entries_player_idx").on(t.playerId),
}));
```

Every identifier used is already imported at `identity.ts:1-5`. Add no imports.

- [ ] **Step 6: Write the migration**

Create `apps/server/drizzle/0011_round_entries.sql`:

```sql
-- Rounds become a scoring window. `rounds` gains two independent stamps:
-- `snapshotted_at` (the round's opening whole-population snapshot has been
-- taken) and `finalized_at` (the freeze-and-pay has run). `round_entries` holds
-- one row per player per round: the opening figures, and — once finalized —
-- the frozen final figures. It is also the hall of fame; there is no separate
-- winners table.
--
-- Statement 8 is DML and it is NOT a stray backfill. A V2-migrated install is
-- the only kind that has `rounds` rows before this migration: `apps/migrate`
-- copies EVERY historical V2 round, all long expired. Without this UPDATE every
-- one of them lands `finalized_at = NULL`, which `ensureCurrentRound`'s probe
-- reads as "expired and unsettled" — so the first request after deploy would
-- cascade-finalize the entire V2 history in one transaction, and above the
-- 50-round cap it throws instead, making every rounds and leaderboard request
-- 500 from then on. It touches only rows that are unambiguously over, is a
-- no-op on a fresh install, and leaves the one open-ended migrated round alone
-- so it becomes the install's live round.
ALTER TABLE "rounds" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rounds" ADD COLUMN "snapshotted_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "round_entries" (
	"round_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exp_at_start" bigint DEFAULT 0 NOT NULL,
	"cash_at_start" bigint DEFAULT 0 NOT NULL,
	"bank_at_start" bigint DEFAULT 0 NOT NULL,
	"final_exp" bigint,
	"final_cash" bigint,
	"final_bank" bigint,
	CONSTRAINT "round_entries_round_id_player_id_pk" PRIMARY KEY("round_id","player_id")
);
--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "round_entries_player_idx" ON "round_entries" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "rounds_open_idx" ON "rounds" USING btree ("starts_at") WHERE "finalized_at" IS NULL;--> statement-breakpoint
UPDATE "rounds"
   SET "finalized_at" = now(), "snapshotted_at" = now()
 WHERE "ends_at" IS NOT NULL AND "ends_at" < now();
```

- [ ] **Step 7: Add the journal entry**

In `apps/server/drizzle/meta/_journal.json`, append after the `0010_relinquish_properties` entry (comma before it):

```json
    {
      "idx": 11,
      "version": "7",
      "when": 1787002800000,
      "tag": "0011_round_entries",
      "breakpoints": true
    }
```

No `meta/0011_*.json` snapshot is written — `0005`, `0006`, `0009` and `0010` have none either.

- [ ] **Step 8: Run the test to verify it passes**

```bash
npx vitest run apps/server/test/rounds-standings.test.ts
```

Expected: PASS, 3 tests. (The template database is rebuilt from core migrations by `test/helpers/global-setup.ts`, so the new migration is picked up automatically.)

- [ ] **Step 9: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add apps/server/drizzle/0011_round_entries.sql apps/server/drizzle/meta/_journal.json \
        apps/server/src/db/schema/identity.ts apps/server/test/rounds-standings.test.ts vitest.workspace.ts
git commit -m "feat(rounds): add round_entries and the two rounds stamps"
```

---

### Task 2: `payoutPoints` — the award-table parser

**Spec:** §3.6 ("The setting").

**Files:**
- Create: `apps/server/src/game/rounds/settings.ts`
- Create test: `apps/server/test/rounds-settings.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server:unit` include)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function payoutPoints(settings: Record<string, string>): bigint[]` from `apps/server/src/game/rounds/settings.ts`. Setting key literal is `rounds.payout_points`. Default is `[1000n, 500n, 250n]`; cap is 100 entries. Never throws.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/rounds-settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { payoutPoints } from "../src/game/rounds/settings.js";

const DEFAULT = [1000n, 500n, 250n];

describe("payoutPoints", () => {
  it("falls back to the default when the key is missing", () => {
    expect(payoutPoints({})).toEqual(DEFAULT);
  });

  it("falls back when the value is blank or whitespace", () => {
    expect(payoutPoints({ "rounds.payout_points": "" })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": "   " })).toEqual(DEFAULT);
  });

  it("falls back on unparseable JSON", () => {
    expect(payoutPoints({ "rounds.payout_points": "[1000, 500" })).toEqual(DEFAULT);
  });

  it("falls back when the JSON is not an array", () => {
    expect(payoutPoints({ "rounds.payout_points": '{"first":1000}' })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": "1000" })).toEqual(DEFAULT);
  });

  it("accepts number elements", () => {
    expect(payoutPoints({ "rounds.payout_points": "[5000, 2500]" })).toEqual([5000n, 2500n]);
  });

  it("accepts digit-string elements", () => {
    expect(payoutPoints({ "rounds.payout_points": '["5000","2500"]' })).toEqual([5000n, 2500n]);
  });

  it("accepts zero awards", () => {
    expect(payoutPoints({ "rounds.payout_points": "[0, 0]" })).toEqual([0n, 0n]);
  });

  it("rejects the whole array when any element is bad", () => {
    expect(payoutPoints({ "rounds.payout_points": "[1000, -5]" })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": "[1000, 1.5]" })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": '[1000, "5x"]' })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": "[1000, null]" })).toEqual(DEFAULT);
    expect(payoutPoints({ "rounds.payout_points": "[1000, 1e30]" })).toEqual(DEFAULT);
  });

  it("returns an empty award table for [] rather than falling back", () => {
    expect(payoutPoints({ "rounds.payout_points": "[]" })).toEqual([]);
  });

  it("truncates to 100 places", () => {
    const many = JSON.stringify(Array.from({ length: 150 }, (_, i) => i + 1));
    const parsed = payoutPoints({ "rounds.payout_points": many });
    expect(parsed).toHaveLength(100);
    expect(parsed[99]).toBe(100n);
  });
});
```

- [ ] **Step 2: Register the file in `vitest.workspace.ts`**

Add to the `@gl3/server:unit` project's `include` array:

```ts
        "test/rounds-settings.test.ts",
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run apps/server/test/rounds-settings.test.ts
```

Expected: FAIL — cannot resolve `../src/game/rounds/settings.js`.

- [ ] **Step 4: Write the implementation**

Create `apps/server/src/game/rounds/settings.ts`:

```ts
/**
 * The round payout award table, read from the boot-loaded settings record.
 *
 * `settings` is admin-edited free text written with SQL out of band (there is
 * no settings admin route in GL3, by design), so a typo here must not take a
 * request down: every failure mode degrades to DEFAULT_PAYOUT_POINTS and this
 * function never throws. A change to the row takes effect at the next restart,
 * like every other setting in the game — `loadSettings` reads the table once.
 */
const SETTING_KEY = "rounds.payout_points";
const DEFAULT_PAYOUT_POINTS: readonly bigint[] = [1000n, 500n, 250n];
/** Finalize runs inside one player's request; the award count must be bounded. */
const MAX_PAYOUT_PLACES = 100;

const DIGITS = /^\d+$/;

function element(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === "string" && DIGITS.test(value)) return BigInt(value);
  return null;
}

export function payoutPoints(settings: Record<string, string>): bigint[] {
  const raw = settings[SETTING_KEY];
  // Explicit and first: "the admin cleared the field" must land on the default
  // deliberately, not by accident inside the catch below.
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_PAYOUT_POINTS];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_PAYOUT_POINTS];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_PAYOUT_POINTS];

  const awards: bigint[] = [];
  for (const item of parsed) {
    const value = element(item);
    // A partially-parsed award table is worse than the default: it silently
    // reorders the prizes.
    if (value === null) return [...DEFAULT_PAYOUT_POINTS];
    awards.push(value);
  }
  // An empty array is a legitimate configuration — "run rounds, pay nothing" —
  // and must NOT fall back.
  return awards.slice(0, MAX_PAYOUT_PLACES);
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run apps/server/test/rounds-settings.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/game/rounds/settings.ts apps/server/test/rounds-settings.test.ts vitest.workspace.ts
git commit -m "feat(rounds): parse the rounds.payout_points award table"
```

---

### Task 3: `roundStandings` — the one ranking statement

**Spec:** §1.7, §3.2, §3.4, §3.5.

**Files:**
- Create: `apps/server/src/game/rounds/standings.ts`
- Modify: `apps/server/test/rounds-standings.test.ts` (add the math cases beside Task 1's schema cases)

**Interfaces:**
- Consumes: `roundEntries` (Task 1); `Tx` from `apps/server/src/economy/ledger.ts`; `LeaderboardEntry`/`LeaderboardKind` from `@gl3/shared`.
- Produces:
  ```ts
  export async function roundStandings(
    exec: Db | Tx,
    roundId: string,
    kind: LeaderboardKind,
    n: number,
    finalized: boolean,
    minDelta?: bigint,
  ): Promise<LeaderboardEntry[]>
  ```
  Entries are `{ playerId, username, score, rank }`; `score` is the delta as a **decimal string** (may carry a leading `-`); `rank` is `i + 1` over the returned slice.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/rounds-standings.test.ts` (keep Task 1's `describe` block; add these imports at the top: `import { roundStandings } from "../src/game/rounds/standings.js";` and `import { LeaderboardResponseSchema } from "@gl3/shared";`):

```ts
async function seedEntry(
  roundId: string, playerId: string,
  start: { exp: bigint; cash: bigint; bank: bigint },
  final?: { exp: bigint; cash: bigint; bank: bigint },
): Promise<void> {
  await db.insert(roundEntries).values({
    roundId, playerId,
    expAtStart: start.exp, cashAtStart: start.cash, bankAtStart: start.bank,
    finalExp: final?.exp ?? null, finalCash: final?.cash ?? null, finalBank: final?.bank ?? null,
  });
}

async function setStats(playerId: string, v: { exp: bigint; cash: bigint; bank: bigint }): Promise<void> {
  await db.update(playerStats).set({ exp: v.exp, cash: v.cash, bank: v.bank })
    .where(eq(playerStats.playerId, playerId));
}

describe("roundStandings", () => {
  it("ranks a live board on current minus start", async () => {
    const roundId = await seedRound("Live");
    const a = await seedPlayer("live_a");
    const b = await seedPlayer("live_b");
    await seedEntry(roundId, a, { exp: 100n, cash: 0n, bank: 0n });
    await seedEntry(roundId, b, { exp: 0n, cash: 0n, bank: 0n });
    await setStats(a, { exp: 150n, cash: 0n, bank: 0n });   // +50
    await setStats(b, { exp: 400n, cash: 0n, bank: 0n });   // +400

    const board = await roundStandings(db, roundId, "exp", 10, false);
    expect(board.map((e) => [e.playerId, e.score, e.rank])).toEqual([
      [b, "400", 1],
      [a, "50", 2],
    ]);
    expect(board[0]!.username).toBe("live_b");
  });

  it("freezes a finalized board against later player_stats movement", async () => {
    const roundId = await seedRound("Frozen");
    const a = await seedPlayer("frozen_a");
    const b = await seedPlayer("frozen_b");
    await seedEntry(roundId, a, { exp: 0n, cash: 10n, bank: 5n }, { exp: 90n, cash: 40n, bank: 25n });
    await seedEntry(roundId, b, { exp: 0n, cash: 0n, bank: 0n }, { exp: 10n, cash: 0n, bank: 0n });

    const before = await roundStandings(db, roundId, "exp", 10, true);
    await setStats(a, { exp: 999_999n, cash: 999_999n, bank: 999_999n });
    await setStats(b, { exp: 999_999n, cash: 999_999n, bank: 999_999n });

    for (const kind of ["exp", "cash", "bank"] as const) {
      const board = await roundStandings(db, roundId, kind, 10, true);
      expect(board).toEqual(await roundStandings(db, roundId, kind, 10, true));
    }
    expect(await roundStandings(db, roundId, "exp", 10, true)).toEqual(before);
    const cash = await roundStandings(db, roundId, "cash", 10, true);
    expect(cash[0]).toMatchObject({ playerId: a, score: "30", rank: 1 });
  });

  it("scores a final_*-NULL entry in a finalized round as zero, not NULL", async () => {
    const roundId = await seedRound("Raced");
    const raced = await seedPlayer("raced_one");
    await seedEntry(roundId, raced, { exp: 77n, cash: 5n, bank: 5n });   // no final_*
    const board = await roundStandings(db, roundId, "exp", 10, true);
    expect(board).toHaveLength(1);
    expect(board[0]!.score).toBe("0");
  });

  it("renders negative cash deltas and sorts them below every positive one", async () => {
    const roundId = await seedRound("Spender");
    const spender = await seedPlayer("spender");
    const saver = await seedPlayer("saver");
    await seedEntry(roundId, spender, { exp: 0n, cash: 500n, bank: 0n });
    await seedEntry(roundId, saver, { exp: 0n, cash: 0n, bank: 0n });
    await setStats(spender, { exp: 0n, cash: 450n, bank: 0n });   // -50
    await setStats(saver, { exp: 0n, cash: 20n, bank: 0n });      // +20

    const entries = await roundStandings(db, roundId, "cash", 10, false);
    expect(entries.map((e) => e.score)).toEqual(["20", "-50"]);
    expect(LeaderboardResponseSchema.parse({ kind: "cash", entries })).toBeTruthy();
  });

  it("keeps exp non-negative given only exp credits", async () => {
    const roundId = await seedRound("Monotonic");
    const p = await seedPlayer("monotonic");
    await seedEntry(roundId, p, { exp: 10n, cash: 0n, bank: 0n });
    await setStats(p, { exp: 60n, cash: 0n, bank: 0n });
    const board = await roundStandings(db, roundId, "exp", 10, false);
    expect(BigInt(board[0]!.score) >= 0n).toBe(true);
  });

  it("breaks ties deterministically across ten identical queries", async () => {
    const roundId = await seedRound("Tied");
    const a = await seedPlayer("tie_a");
    const b = await seedPlayer("tie_b");
    const c = await seedPlayer("tie_c");
    for (const id of [a, b, c]) {
      await seedEntry(roundId, id, { exp: 0n, cash: 0n, bank: 0n });
      await setStats(id, { exp: 42n, cash: 0n, bank: 0n });
    }
    const first = await roundStandings(db, roundId, "exp", 10, false);
    for (let i = 0; i < 9; i += 1) {
      expect(await roundStandings(db, roundId, "exp", 10, false)).toEqual(first);
    }
    expect(first.map((e) => e.playerId)).toEqual([a, b, c].sort());
  });

  it("respects the limit and does not pad a short population", async () => {
    const roundId = await seedRound("Short");
    const a = await seedPlayer("short_a");
    const b = await seedPlayer("short_b");
    await seedEntry(roundId, a, { exp: 0n, cash: 0n, bank: 0n });
    await seedEntry(roundId, b, { exp: 0n, cash: 0n, bank: 0n });
    await setStats(a, { exp: 9n, cash: 0n, bank: 0n });
    await setStats(b, { exp: 3n, cash: 0n, bank: 0n });

    expect(await roundStandings(db, roundId, "exp", 10, false)).toHaveLength(2);
    const capped = await roundStandings(db, roundId, "exp", 1, false);
    expect(capped.map((e) => e.rank)).toEqual([1]);
    expect(capped[0]!.playerId).toBe(a);
  });

  it("returns [] for a round with no entries", async () => {
    const roundId = await seedRound("Empty");
    expect(await roundStandings(db, roundId, "exp", 10, false)).toEqual([]);
    expect(await roundStandings(db, roundId, "exp", 10, true)).toEqual([]);
  });

  it("drops non-positive deltas when minDelta is supplied", async () => {
    const roundId = await seedRound("Filtered");
    const mover = await seedPlayer("filtered_mover");
    const idler = await seedPlayer("filtered_idler");
    await seedEntry(roundId, mover, { exp: 0n, cash: 0n, bank: 0n }, { exp: 5n, cash: 0n, bank: 0n });
    await seedEntry(roundId, idler, { exp: 0n, cash: 0n, bank: 0n }, { exp: 0n, cash: 0n, bank: 0n });

    const paid = await roundStandings(db, roundId, "exp", 10, true, 0n);
    expect(paid.map((e) => e.playerId)).toEqual([mover]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run apps/server/test/rounds-standings.test.ts
```

Expected: FAIL — cannot resolve `../src/game/rounds/standings.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/game/rounds/standings.ts`:

```ts
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { LeaderboardEntry, LeaderboardKind } from "@gl3/shared";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../economy/ledger.js";
import { players, playerStats, roundEntries } from "../../db/schema/index.js";

const CURRENT = { cash: playerStats.cash, bank: playerStats.bank, exp: playerStats.exp } as const;
const START = { cash: roundEntries.cashAtStart, bank: roundEntries.bankAtStart, exp: roundEntries.expAtStart } as const;
const FINAL = { cash: roundEntries.finalCash, bank: roundEntries.finalBank, exp: roundEntries.finalExp } as const;

/**
 * The ONE ranking statement in this design. No other site writes its own.
 *
 * `exec` is `Db | Tx` because the payout (§2.3 step 2) must rank on the
 * `final_*` values its own transaction froze one statement earlier — under READ
 * COMMITTED a pooled `db` handle cannot see them. `minDelta` appends the
 * `delta > $minDelta` filter the payout needs so a round nobody played pays
 * nobody; both read routes omit it.
 *
 * `ORDER BY delta DESC, player_id ASC` is load-bearing, not cosmetic: the
 * payout ranks with this same statement, so without a total order two players
 * on an identical delta can swap places between the board a player saw and the
 * transaction that paid out.
 *
 * The delta arrives from postgres.js as a JavaScript string (int8 minus int8 is
 * int8, handed back as a string), which is already the wire format MoneySchema
 * wants. Never call Number() on it.
 */
export async function roundStandings(
  exec: Db | Tx,
  roundId: string,
  kind: LeaderboardKind,
  n: number,
  finalized: boolean,
  minDelta?: bigint,
): Promise<LeaderboardEntry[]> {
  // A finalized board reads both operands out of round_entries and therefore
  // does not join player_stats at all — that is what makes it unable to move
  // again. COALESCE covers the one registration that raced the freeze (§2.5):
  // it scores 0 rather than sorting to the top as a NULL would.
  const delta = finalized
    ? sql<string>`(coalesce(${FINAL[kind]}, ${START[kind]}) - ${START[kind]})`
    : sql<string>`(${CURRENT[kind]} - ${START[kind]})`;

  const where = minDelta === undefined
    ? eq(roundEntries.roundId, roundId)
    : and(eq(roundEntries.roundId, roundId), sql`${delta} > ${minDelta.toString()}::bigint`);

  const base = exec.select({ playerId: roundEntries.playerId, delta }).from(roundEntries);
  const scored = finalized
    ? await base.where(where).orderBy(desc(delta), asc(roundEntries.playerId)).limit(n)
    : await base.innerJoin(playerStats, eq(playerStats.playerId, roundEntries.playerId))
        .where(where).orderBy(desc(delta), asc(roundEntries.playerId)).limit(n);

  if (scored.length === 0) return [];

  // Second query, byte-identical to what topN already does, so the "unknown"
  // fallback behaves the same on a round board and the all-time board.
  const rows = await exec.select({ id: players.id, username: players.username })
    .from(players).where(inArray(players.id, scored.map((e) => e.playerId)));
  const nameById = new Map(rows.map((r) => [r.id, r.username]));

  return scored.map((entry, i) => ({
    playerId: entry.playerId,
    username: nameById.get(entry.playerId) ?? "unknown",
    score: entry.delta,
    rank: i + 1,
  }));
}
```

If drizzle's builder objects to `.innerJoin` after `.where` typing, build the two branches as two complete statements rather than sharing `base` — do **not** reach for a cast, and do **not** switch to `.execute(sql...)`: core never reads rows through `execute`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run apps/server/test/rounds-standings.test.ts
```

Expected: PASS, 12 tests (3 schema + 9 standings).

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/game/rounds/standings.ts apps/server/test/rounds-standings.test.ts
git commit -m "feat(rounds): add the round standings query"
```

---

### Task 4: The two `GameEvent` variants and their three consumers

**Spec:** §4.4, §5.3 items 1-2.

**Files:**
- Modify: `packages/shared/src/events.ts` (two variants before the `plugin.event` envelope; fix the stale "twenty-two" comment at line 95)
- Modify: `apps/web/src/lib/eventCopy.ts`, `apps/web/src/ws/invalidation.ts`
- Modify: `apps/web/src/api/keys.ts` (`rounds`, `roundStandings`, `leaderboards`)
- Modify: `apps/server/test/plugin-ctx-core-events.test.ts` (`CORPUS` 23 → 25)
- Modify: `apps/web/test/event-copy.test.ts`, `apps/web/test/invalidation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GameEvent` variants
  ```ts
  { ...base, type: "round.started",  roundId: string; roundName: string; endsAt: string | null }
  { ...base, type: "round.finished", roundId: string; roundName: string;
    winners: { playerId: string; username: string; placing: number; points: string }[] }
  ```
  and query keys `keys.rounds()`, `keys.roundStandings(roundId, kind)`, `keys.leaderboards()`.

> **This union widens, so the whole of `npm run verify` must run before the task is called done.** Two of the three consumers fail loudly at `npm run typecheck` (TS2366); the third — `CORPUS` — is a *runtime* assertion that needs Postgres and Redis, so typecheck, the `@gl3/web` project and CI's `verify:ci` all pass without it. `player.backfired` shipped past two task reviews on exactly this gap.

- [ ] **Step 1: Add the two variants**

In `packages/shared/src/events.ts`, immediately **before** the `plugin.event` envelope object:

```ts
  // actor = the round itself: `actorId` is the round's id and `actorName` its
  // name. Rollover has no acting player — it is triggered by whichever request
  // happened to notice — and naming that player would tell everyone that Bob
  // ended the season. `base.actorId` is a non-nullable IdSchema, so a null is
  // not available; a round id is a real uuid, is stable, and gives tests a
  // per-round discriminator on a globally-audienced event.
  z.object({
    ...base,
    type: z.literal("round.started"),
    roundId: IdSchema,
    roundName: z.string(),
    endsAt: TimestampSchema.nullable(),
  }),
  z.object({
    ...base,
    type: z.literal("round.finished"),
    roundId: IdSchema,
    roundName: z.string(),
    winners: z.array(z.object({
      playerId: IdSchema,
      username: z.string(),
      placing: z.number().int().positive(),
      points: MoneySchema,
    })),
  }),
```

`TimestampSchema`, `IdSchema` and `MoneySchema` are already imported at `events.ts:2`. Add no imports.

- [ ] **Step 2: Fix the stale count comment**

In the same file, the comment at line 95 says "The twenty-two core variants above stay closed and unchanged". The true count is already 23 and becomes **25** here. Replace "twenty-two" with "twenty-five".

- [ ] **Step 3: Run typecheck to see the two web switches fail**

```bash
npm run typecheck
```

Expected: FAIL with TS2366 ("Function lacks ending return statement") in both `apps/web/src/lib/eventCopy.ts` and `apps/web/src/ws/invalidation.ts`.

- [ ] **Step 4: Add the query keys**

In `apps/web/src/api/keys.ts`, add beside the existing entries:

```ts
  rounds: () => ["rounds"] as const,
  roundStandings: (roundId: string, kind: LeaderboardKind) =>
    ["rounds", roundId, "standings", kind] as const,
  /** The prefix over every kind and scope — for invalidation, not for a query. */
  leaderboards: () => ["leaderboard"] as const,
```

`LeaderboardKind` is already imported at the top of the file.

- [ ] **Step 5: Add the `eventCopy` arms**

In `apps/web/src/lib/eventCopy.ts`, inside `describeEvent`'s switch:

```ts
    case "round.started":
      return `Round ${event.roundName} has started`;
    case "round.finished": {
      const winner = event.winners.find((w) => w.placing === 1);
      return winner === undefined
        ? `Round ${event.roundName} has finished`
        : `Round ${event.roundName} has finished — ${winner.username} took first`;
    }
```

- [ ] **Step 6: Add the `invalidation` arms**

In `apps/web/src/ws/invalidation.ts`, inside `invalidationKeys`'s switch:

```ts
    case "round.started":
      return [keys.rounds(), keys.leaderboards(), keys.me()];
    case "round.finished":
      return [keys.rounds(), keys.leaderboards(), keys.notifications(), keys.me()];
```

`keys.me()` is in both because a payout moves `points`, which `/api/auth/me` reports.

- [ ] **Step 7: Extend the web tests**

In `apps/web/test/event-copy.test.ts`, add cases following the file's existing shape — one asserting `round.started` renders `Round Summer 2026 has started`, one asserting `round.finished` with a `placing: 1` winner renders `… — alice took first`, and one asserting `round.finished` with an empty `winners` array renders `Round Summer 2026 has finished`.

In `apps/web/test/invalidation.test.ts`, add cases asserting `invalidationKeys` returns `[keys.rounds(), keys.leaderboards(), keys.me()]` for `round.started` and `[keys.rounds(), keys.leaderboards(), keys.notifications(), keys.me()]` for `round.finished`.

- [ ] **Step 8: Extend the `CORPUS` drift guard**

In `apps/server/test/plugin-ctx-core-events.test.ts`, add two entries to `CORPUS` (lines 74-100), matching the file's existing entry style:

```ts
  { type: "round.started", audience: { kind: "global" }, roundId: UUID_A, roundName: "Season 1", endsAt: "2026-09-01T00:00:00.000Z" },
  { type: "round.finished", audience: { kind: "global" }, roundId: UUID_A, roundName: "Season 1", winners: [{ playerId: UUID_B, username: "alice", placing: 1, points: "1000" }] },
```

Use whatever uuid constants the file already defines; if it defines only one, reuse it for both fields. The length assertion at lines 109-115 must now pass at **25**.

- [ ] **Step 9: Run typecheck and the affected suites**

```bash
npm run typecheck
npx vitest run --project @gl3/web
npx vitest run apps/server/test/plugin-ctx-core-events.test.ts
```

Expected: typecheck exit 0; both suites PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/events.ts apps/web/src/lib/eventCopy.ts apps/web/src/ws/invalidation.ts \
        apps/web/src/api/keys.ts apps/web/test/event-copy.test.ts apps/web/test/invalidation.test.ts \
        apps/server/test/plugin-ctx-core-events.test.ts
git commit -m "feat(rounds): add round.started and round.finished events"
```

---

### Task 5: `ensureCurrentRound` — probe, activation, finalize, settle loop

**Spec:** §2.2, §2.2a, §2.3, §2.4, §2.6, §3.6 ("The call shape"), §4.4 (notifications), §5.2 (`rounds-finalize.test.ts`, `rounds-snapshot.test.ts` cases 1 and 5).

**Files:**
- Create: `apps/server/src/game/rounds/service.ts`
- Create tests: `apps/server/test/rounds-finalize.test.ts`, `apps/server/test/rounds-snapshot.test.ts`
- Modify: `vitest.workspace.ts` (two `@gl3/server` includes)

**Interfaces:**
- Consumes: `roundStandings` (Task 3), `payoutPoints` (Task 2), the two `GameEvent` variants (Task 4), `applyBalanceChange` / `lockPlayersForUpdate` / `Tx` (`apps/server/src/economy/ledger.ts`), `insertNotification` (`apps/server/src/game/notifications/service.ts`, signature `insertNotification(tx, { id, playerId, body })`), `publishEvent` (`apps/server/src/bus/publish.ts`).
- Produces:
  ```ts
  export interface ActiveRound { id: string; name: string; startsAt: Date | null; endsAt: Date | null }
  export async function ensureCurrentRound(
    db: Db, redis: Redis, settings: Record<string, string>,
  ): Promise<ActiveRound | null>
  ```
  All three parameters required at every call site, no defaults. Opens its own transaction — never call it from inside one. Must not throw on the common path; the only sanctioned throw is the 50-round settle cap.

**One deliberate consolidation of the spec's structure, and why it is safe.** §2.2a step 2 specifies a recheck keyed on `id = $1`, and §2.3 specifies its own recheck plus a step-4 re-probe. The implementation below runs **one** statement for all three: inside the transaction, immediately after the advisory lock, it re-runs §2.2's probe (which §2.3 step 4 already specifies verbatim) and dispatches on the result in a loop. That statement *is* the recheck under the lock, it is strictly more current than an `id = $1` recheck (an earlier round created in the meantime is picked up rather than missed), and both `WHERE`-guarded stamps (`snapshotted_at IS NULL`, `finalized_at IS NULL`) are kept exactly as specified, so the second, across-time defence is untouched. Do not "restore" a separate per-round recheck; it would be dead code under the lock.

- [ ] **Step 1: Write the failing finalize test**

Create `apps/server/test/rounds-finalize.test.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, playerStats, roundEntries, rounds, settings as settingsTable, transactions }
  from "../src/db/schema/index.js";
import { ensureCurrentRound } from "../src/game/rounds/service.js";
import { createRedis } from "../src/redis.js";
import { loadConfig } from "../src/config.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const SETTINGS = { "rounds.payout_points": "[1000,500,250]" };

afterAll(async () => { await redis.quit(); });
beforeEach(async () => { await resetDb(db); });

async function seedPlayer(username: string, exp: bigint): Promise<string> {
  const id = uuidv7();
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id, exp });
  return id;
}

async function seedRound(
  name: string, startsAt: Date | null, endsAt: Date | null,
  stamps?: { snapshottedAt?: Date },
): Promise<string> {
  const id = uuidv7();
  await db.insert(rounds).values({ id, name, startsAt, endsAt, snapshottedAt: stamps?.snapshottedAt ?? null });
  return id;
}

const ago = (ms: number): Date => new Date(Date.now() - ms);
const ahead = (ms: number): Date => new Date(Date.now() + ms);

describe("ensureCurrentRound finalize", () => {
  it("settles exactly once across three sequential calls", async () => {
    const ended = await seedRound("Ended", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const next = await seedRound("Next", ago(60_000), ahead(3_600_000));
    const a = await seedPlayer("fin_a", 500n);
    const b = await seedPlayer("fin_b", 300n);
    const c = await seedPlayer("fin_c", 100n);
    const d = await seedPlayer("fin_d", 0n);
    for (const [id, exp] of [[a, 0n], [b, 0n], [c, 0n], [d, 0n]] as const) {
      await db.insert(roundEntries).values({ roundId: ended, playerId: id, expAtStart: exp });
    }

    const active = await ensureCurrentRound(db, redis, SETTINGS);
    expect(active?.id).toBe(next);

    const [settled] = await db.select().from(rounds).where(eq(rounds.id, ended));
    const stamp = settled!.finalizedAt;
    expect(stamp).not.toBeNull();

    const frozen = await db.select().from(roundEntries).where(eq(roundEntries.roundId, ended));
    const frozenExp = new Map(frozen.map((r) => [r.playerId, r.finalExp]));
    expect(frozenExp.get(a)).toBe(500n);

    const payouts = () => db.select().from(transactions)
      .where(and(eq(transactions.reason, "round.payout"), eq(transactions.refId, ended)));
    expect(await payouts()).toHaveLength(3);

    // Move the live numbers so a re-freeze would be visible.
    await db.update(playerStats).set({ exp: 99_999n }).where(eq(playerStats.playerId, a));

    await ensureCurrentRound(db, redis, SETTINGS);
    await ensureCurrentRound(db, redis, SETTINGS);

    const [again] = await db.select().from(rounds).where(eq(rounds.id, ended));
    expect(again!.finalizedAt?.toISOString()).toBe(stamp?.toISOString());
    const frozenAgain = await db.select().from(roundEntries).where(eq(roundEntries.roundId, ended));
    expect(new Map(frozenAgain.map((r) => [r.playerId, r.finalExp])).get(a)).toBe(500n);
    expect(await payouts()).toHaveLength(3);
  });

  it("pays the awards in placing order, highest delta first", async () => {
    const ended = await seedRound("Placings", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const first = await seedPlayer("place_first", 900n);
    const second = await seedPlayer("place_second", 400n);
    for (const id of [first, second]) {
      await db.insert(roundEntries).values({ roundId: ended, playerId: id, expAtStart: 0n });
    }
    await ensureCurrentRound(db, redis, SETTINGS);

    const rows = await db.select().from(transactions)
      .where(and(eq(transactions.reason, "round.payout"), eq(transactions.refId, ended)));
    const byPlayer = new Map(rows.map((r) => [r.playerId, r.amount]));
    expect(byPlayer.get(first)).toBe(1000n);
    expect(byPlayer.get(second)).toBe(500n);
    expect(rows).toHaveLength(2);   // only two scorers, three awards
  });

  it("pays nobody when no entry scored a positive delta", async () => {
    const ended = await seedRound("Skipped", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const idle = await seedPlayer("idle_one", 50n);
    await db.insert(roundEntries).values({ roundId: ended, playerId: idle, expAtStart: 50n });
    await ensureCurrentRound(db, redis, SETTINGS);
    const rows = await db.select().from(transactions).where(eq(transactions.reason, "round.payout"));
    expect(rows).toEqual([]);
  });

  it("writes nothing at all for a live, already-snapshotted round", async () => {
    const live = await seedRound("Live", ago(60_000), ahead(3_600_000), { snapshottedAt: ago(60_000) });
    await seedPlayer("live_untouched", 10n);

    const active = await ensureCurrentRound(db, redis, SETTINGS);
    expect(active?.id).toBe(live);

    const [row] = await db.select().from(rounds).where(eq(rounds.id, live));
    expect(row!.finalizedAt).toBeNull();
    expect(await db.select().from(roundEntries)).toEqual([]);
    expect(await db.select().from(transactions)).toEqual([]);
  });

  it("returns null and writes nothing when there are no rounds", async () => {
    await seedPlayer("no_rounds", 0n);
    expect(await ensureCurrentRound(db, redis, SETTINGS)).toBeNull();
    expect(await db.select().from(roundEntries)).toEqual([]);
  });

  it("settles a chain of ended rounds in one call, oldest first", async () => {
    const first = await seedRound("Chain 1", ago(10_800_000), ago(7_200_000), { snapshottedAt: ago(10_800_000) });
    const second = await seedRound("Chain 2", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const live = await seedRound("Chain 3", ago(3_600_000), ahead(3_600_000));
    await seedPlayer("chain_player", 10n);

    const active = await ensureCurrentRound(db, redis, SETTINGS);
    expect(active?.id).toBe(live);
    for (const id of [first, second]) {
      const [row] = await db.select().from(rounds).where(eq(rounds.id, id));
      expect(row!.finalizedAt).not.toBeNull();
    }
    const [liveRow] = await db.select().from(rounds).where(eq(rounds.id, live));
    expect(liveRow!.snapshottedAt).not.toBeNull();
  });

  it("falls back to the default award table when the setting is unparseable", async () => {
    const ended = await seedRound("Bad Setting", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const winner = await seedPlayer("bad_setting_winner", 100n);
    await db.insert(roundEntries).values({ roundId: ended, playerId: winner, expAtStart: 0n });

    await ensureCurrentRound(db, redis, { "rounds.payout_points": "not json" });

    const [paid] = await db.select().from(transactions).where(eq(transactions.reason, "round.payout"));
    expect(paid!.amount).toBe(1000n);
  });

  it("notifies each winner without publishing a per-winner event", async () => {
    const ended = await seedRound("Notified", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const winner = await seedPlayer("notified_winner", 100n);
    await db.insert(roundEntries).values({ roundId: ended, playerId: winner, expAtStart: 0n });
    await ensureCurrentRound(db, redis, SETTINGS);

    const notes = await db.select().from(notifications).where(eq(notifications.playerId, winner));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("Notified");
    expect(notes[0]!.body).toContain("1000");
  });
});
```

Add `notifications` to the schema import list at the top. `settingsTable` is imported for symmetry with Task 7's ledger test; drop it if unused rather than leaving an unused import.

- [ ] **Step 2: Write the failing snapshot test (cases 1 and 5)**

Create `apps/server/test/rounds-snapshot.test.ts` with the same `testDb()` / `createRedis()` / `resetDb` scaffolding as Step 1, plus:

```ts
describe("round activation snapshot", () => {
  it("gives every player an entry at their own values, including players who never made a request", async () => {
    const passiveA = await seedPlayer("passive_a", 10n);
    const passiveB = await seedPlayer("passive_b", 20n);
    const passiveC = await seedPlayer("passive_c", 30n);
    await db.update(playerStats).set({ cash: 111n, bank: 222n }).where(eq(playerStats.playerId, passiveA));

    const ended = await seedRound("Prev", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const next = await seedRound("Next", ago(60_000), ahead(3_600_000));

    await ensureCurrentRound(db, redis, SETTINGS);

    const entries = await db.select().from(roundEntries).where(eq(roundEntries.roundId, next));
    expect(entries).toHaveLength(3);
    const a = entries.find((e) => e.playerId === passiveA)!;
    expect([a.expAtStart, a.cashAtStart, a.bankAtStart]).toEqual([10n, 111n, 222n]);
    for (const id of [passiveA, passiveB, passiveC]) {
      const [row] = await db.select().from(players).where(eq(players.id, id));
      expect(row!.roundId).toBe(next);
    }
    expect(ended).toBeTruthy();
  });

  it("activates the very first round with no predecessor, exactly once", async () => {
    const one = await seedPlayer("first_a", 1n);
    const two = await seedPlayer("first_b", 2n);
    const three = await seedPlayer("first_c", 3n);
    expect(await db.select().from(roundEntries)).toEqual([]);

    const only = await seedRound("Round One", ago(60_000), ahead(3_600_000));
    const active = await ensureCurrentRound(db, redis, SETTINGS);
    expect(active?.id).toBe(only);

    const [row] = await db.select().from(rounds).where(eq(rounds.id, only));
    const stamp = row!.snapshottedAt;
    expect(stamp).not.toBeNull();
    expect(await db.select().from(roundEntries)).toHaveLength(3);
    for (const id of [one, two, three]) {
      const [p] = await db.select().from(players).where(eq(players.id, id));
      expect(p!.roundId).toBe(only);
    }

    await ensureCurrentRound(db, redis, SETTINGS);
    const [again] = await db.select().from(rounds).where(eq(rounds.id, only));
    expect(again!.snapshottedAt?.toISOString()).toBe(stamp?.toISOString());
    expect(await db.select().from(roundEntries)).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Register both files in `vitest.workspace.ts`**

Add to the default `@gl3/server` project's `include` array:

```ts
        "test/rounds-finalize.test.ts",
        "test/rounds-snapshot.test.ts",
```

- [ ] **Step 4: Run both files to verify they fail**

```bash
npx vitest run apps/server/test/rounds-finalize.test.ts apps/server/test/rounds-snapshot.test.ts
```

Expected: FAIL — cannot resolve `../src/game/rounds/service.js`.

- [ ] **Step 5: Write the implementation**

Create `apps/server/src/game/rounds/service.ts`:

```ts
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { players, rounds } from "../../db/schema/index.js";
import { applyBalanceChange, lockPlayersForUpdate, type Tx } from "../../economy/ledger.js";
import { insertNotification } from "../notifications/service.js";
import { payoutPoints } from "./settings.js";
import { roundStandings } from "./standings.js";

export interface ActiveRound {
  id: string;
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
}

/**
 * A misconfigured schedule (thousands of one-second rounds) must fail loudly
 * rather than hold the advisory lock while it grinds.
 */
const MAX_SETTLE_PASSES = 50;
/** Shared with the two admin write routes; 7461001 is the first-admin claim. */
const ROUNDS_LOCK = 7461002;

interface ProbeRow {
  id: string;
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
  snapshottedAt: Date | null;
  /** Evaluated against the DATABASE clock, never the app's. */
  ended: boolean;
}

const toActive = (row: ProbeRow): ActiveRound => ({
  id: row.id, name: row.name, startsAt: row.startsAt, endsAt: row.endsAt,
});

/**
 * The earliest unfinalized round that has started. `ORDER BY starts_at ASC,
 * id ASC` is the deterministic tie-break §5.5 risk 2 requires: overlap is
 * rejected at admin write time, but that check is application-level, so the
 * read path picks one round rather than trusting uniqueness. Rows with a NULL
 * `starts_at` are inert and excluded by the predicate. This is the read
 * `rounds_open_idx` exists for.
 */
async function probe(exec: Db | Tx): Promise<ProbeRow | undefined> {
  const [row] = await exec.select({
    id: rounds.id,
    name: rounds.name,
    startsAt: rounds.startsAt,
    endsAt: rounds.endsAt,
    snapshottedAt: rounds.snapshottedAt,
    ended: sql<boolean>`(${rounds.endsAt} is not null and ${rounds.endsAt} <= now())`,
  }).from(rounds)
    .where(sql`${rounds.finalizedAt} is null and ${rounds.startsAt} is not null and ${rounds.startsAt} <= now()`)
    .orderBy(asc(rounds.startsAt), asc(rounds.id))
    .limit(1);
  return row;
}

/**
 * Activation steps 3-5 (§2.2a): the whole-population snapshot, the stamp, and
 * pointing every player at the round. Written once, reached twice — from the
 * standalone activation branch and from the settle loop after a finalize.
 * Returns whether THIS call activated the round; the caller publishes
 * `round.started` only then.
 *
 * Step 5's `UPDATE players` takes FOR NO KEY UPDATE on every row it touches, so
 * for the life of this transaction the two other single-row `UPDATE players`
 * statements in the game (the lazy argon2id upgrade, admin role assignment)
 * wait. Neither can deadlock against it: both hold one `players` row and then
 * want nothing else.
 */
async function activate(tx: Tx, round: ProbeRow): Promise<boolean> {
  // ON CONFLICT DO NOTHING because a player who registered between starts_at
  // and now already inserted their own entry (§2.5), and theirs is the more
  // accurate one — it was taken when they actually joined.
  await tx.execute(sql`
    insert into round_entries (round_id, player_id, joined_at, exp_at_start, cash_at_start, bank_at_start)
    select ${round.id}, ps.player_id, now(), ps.exp, ps.cash, ps.bank
    from player_stats ps
    on conflict (round_id, player_id) do nothing`);

  // The WHERE makes this statement the arbiter of "did THIS call activate it".
  const stamped = await tx.update(rounds)
    .set({ snapshottedAt: sql`now()` })
    .where(and(eq(rounds.id, round.id), isNull(rounds.snapshottedAt)))
    .returning({ id: rounds.id });
  if (stamped.length === 0) return false;

  // IS DISTINCT FROM makes the statement re-runnable and a no-op on rows that
  // already point at the round. First server code ever to write players.round_id.
  await tx.execute(sql`update players set round_id = ${round.id} where round_id is distinct from ${round.id}`);
  return true;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/**
 * Finalize steps 1-3 (§2.3). Returns the `round.finished` event when THIS call
 * settled the round, or null when the stamp matched nothing.
 */
async function finalize(tx: Tx, round: ProbeRow, settings: Record<string, string>): Promise<GameEvent | null> {
  // Step 1 — freeze. Runs before the payout so the numbers the board shows are
  // the numbers the placings were computed from.
  await tx.execute(sql`
    update round_entries as re
       set final_exp = ps.exp, final_cash = ps.cash, final_bank = ps.bank
      from player_stats as ps
     where ps.player_id = re.player_id and re.round_id = ${round.id}`);

  // Step 2 — pay. `tx`, not `db`: ranking must see the freeze this transaction
  // just wrote. `finalized: true` so a concurrent crime payout cannot shift a
  // placing. `minDelta: 0n` so a round nobody played pays nobody.
  const awards = payoutPoints(settings);
  const winners = awards.length === 0
    ? []
    : await roundStandings(tx, round.id, "exp", awards.length, true, 0n);

  if (winners.length > 0) {
    // Once, with the whole winner set, so player_stats locks are taken
    // ascending in one statement rather than in board (delta) order — §2.7.
    await lockPlayersForUpdate(tx, winners.map((w) => w.playerId));
    for (const [i, winner] of winners.entries()) {
      await applyBalanceChange(tx, {
        playerId: winner.playerId,
        amount: awards[i]!,
        kind: "points",
        reason: "round.payout",
        refId: round.id,
        // No jobId: finalize is not a BullMQ job. Its idempotency is the
        // advisory lock plus the finalized_at guard, and job_id is UNIQUE.
      });
      await insertNotification(tx, {
        id: uuidv7(),
        playerId: winner.playerId,
        body: `Round "${round.name}" finished — you placed ${ordinal(winner.rank)} and were paid ${awards[i]!.toString()} points.`,
      });
    }
  }

  // Step 3 — stamp. The WHERE is the arbiter of "did THIS call settle it".
  const stamped = await tx.update(rounds)
    .set({ finalizedAt: sql`now()` })
    .where(and(eq(rounds.id, round.id), isNull(rounds.finalizedAt)))
    .returning({ id: rounds.id });
  if (stamped.length === 0) return null;

  return {
    id: uuidv7(),
    type: "round.finished",
    at: new Date().toISOString(),
    actorId: round.id,
    actorName: round.name,
    audience: { kind: "global" },
    roundId: round.id,
    roundName: round.name,
    winners: winners.map((w, i) => ({
      playerId: w.playerId,
      username: w.username,
      placing: w.rank,
      // The award paid, deliberately not `score` — score is the delta that
      // earned the placing.
      points: awards[i]!.toString(),
    })),
  };
}

function startedEvent(round: ProbeRow): GameEvent {
  return {
    id: uuidv7(),
    type: "round.started",
    at: new Date().toISOString(),
    actorId: round.id,
    actorName: round.name,
    audience: { kind: "global" },
    roundId: round.id,
    roundName: round.name,
    endsAt: round.endsAt === null ? null : round.endsAt.toISOString(),
  };
}

/**
 * The transactional half: settle every ended round in one pass and activate
 * whatever becomes current. The advisory lock is the FIRST statement; the probe
 * that follows it is the recheck under the lock (§2.2a step 2 / §2.3's recheck /
 * §2.3 step 4's re-evaluation are the same statement, run once here).
 */
async function settle(
  db: Db, redis: Redis, settings: Record<string, string>,
): Promise<ActiveRound | null> {
  const pending: GameEvent[] = [];

  const active = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROUNDS_LOCK})`);

    for (let pass = 0; pass < MAX_SETTLE_PASSES; pass += 1) {
      const current = await probe(tx);
      if (current === undefined) return null;

      if (!current.ended) {
        if (current.snapshottedAt === null && await activate(tx, current)) {
          pending.push(startedEvent(current));
        }
        return toActive(current);
      }

      const finished = await finalize(tx, current, settings);
      if (finished !== null) pending.push(finished);
    }
    throw new Error("too many rounds to settle in one pass");
  });

  // Rule 5: facts, published after the commit, never inside it. Oldest
  // round.finished first, then round.started if one was activated — which is
  // the order they were pushed.
  for (const event of pending) await publishEvent(redis, event);
  return active;
}

/**
 * The round that is active when this returns, or null.
 *
 * The fast path opens NO transaction: one unlocked, indexed SELECT ... LIMIT 1.
 * A round that is both unsnapshotted and already over is settled, not activated
 * — finalize is checked first, and that precedence is a genuine rule.
 *
 * Opens its own transaction, so it must never be called from inside one, and it
 * is never reached from a plugin. It must not throw on the common path: it sits
 * at the head of GET /api/leaderboard/:kind, a route that works today.
 */
export async function ensureCurrentRound(
  db: Db, redis: Redis, settings: Record<string, string>,
): Promise<ActiveRound | null> {
  const row = await probe(db);
  if (row === undefined) return null;
  if (!row.ended && row.snapshottedAt !== null) return toActive(row);
  return settle(db, redis, settings);
}
```

- [ ] **Step 6: Run both files to verify they pass**

```bash
npx vitest run apps/server/test/rounds-finalize.test.ts apps/server/test/rounds-snapshot.test.ts
```

Expected: PASS — 8 tests in `rounds-finalize`, 2 in `rounds-snapshot`.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/game/rounds/service.ts apps/server/test/rounds-finalize.test.ts \
        apps/server/test/rounds-snapshot.test.ts vitest.workspace.ts
git commit -m "feat(rounds): lazy rollover — activate, finalize, pay, publish"
```

---

### Task 6: Mid-round registration snapshot

**Spec:** §2.5, §5.2 (`rounds-snapshot.test.ts` cases 2, 3, 4).

**Files:**
- Modify: `apps/server/src/auth/routes.ts` — after `await tx.insert(playerStats).values({ playerId });` (line 71) and **before** the first-player probe (line 81)
- Modify: `apps/server/test/rounds-snapshot.test.ts` (add cases 2, 3, 4)

**Interfaces:**
- Consumes: `roundEntries`, `rounds` (Task 1).
- Produces: no new export. Registration writes one `round_entries` row and sets `players.round_id` when a round is active; writes neither when none is.

> **Placement is load-bearing.** The block goes *before* the first-player advisory-lock probe, because the comment at `routes.ts:77` explicitly protects the shortness of lock 7461001's hold time. Registration must **not** call `ensureCurrentRound`: that opens a transaction (we are already in one) and takes a global advisory lock on a hot path.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/test/rounds-snapshot.test.ts`. These three cases register over HTTP, so the file gains `bootTestServer()` in a `beforeAll` (it is already in the `@gl3/server` project):

```ts
describe("registration snapshot", () => {
  it("gives a mid-round registrant an entry at their own values, standing 0", async () => {
    const roundId = await seedRound("Mid", ago(60_000), ahead(3_600_000), { snapshottedAt: ago(60_000) });

    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "midjoiner", password: "correct horse battery" },
    });
    expect(res.statusCode).toBe(200);

    const [player] = await db.select().from(players).where(eq(players.username, "midjoiner"));
    await db.update(playerStats).set({ exp: 500n, cash: 700n }).where(eq(playerStats.playerId, player!.id));

    const [entry] = await db.select().from(roundEntries)
      .where(and(eq(roundEntries.roundId, roundId), eq(roundEntries.playerId, player!.id)));
    expect(entry).toBeDefined();
    expect(entry!.expAtStart).toBe(0n);
    expect(entry!.joinedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(player!.roundId).toBe(roundId);

    const board = await roundStandings(db, roundId, "exp", 10, false);
    const mine = board.find((e) => e.playerId === player!.id);
    expect(mine!.score).toBe("500");   // delta from THEIR start, not their absolute total
  });

  it("writes no entry and leaves round_id null when no round is active", async () => {
    expect(await db.select().from(rounds)).toEqual([]);
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "noroundplayer", password: "correct horse battery" },
    });
    expect(res.statusCode).toBe(200);

    const [player] = await db.select().from(players).where(eq(players.username, "noroundplayer"));
    expect(player!.roundId).toBeNull();
    expect(await db.select().from(roundEntries)).toEqual([]);
  });

  it("writes no entry when the current round has ended but nobody has rolled it over", async () => {
    await seedRound("Over", ago(7_200_000), ago(3_600_000), { snapshottedAt: ago(7_200_000) });
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "afterhours", password: "correct horse battery" },
    });
    expect(res.statusCode).toBe(200);
    const [player] = await db.select().from(players).where(eq(players.username, "afterhours"));
    expect(player!.roundId).toBeNull();
    expect(await db.select().from(roundEntries)).toEqual([]);
  });

  it("still makes the first registration an Administrator while a round is active", async () => {
    await seedRound("Admin Round", ago(60_000), ahead(3_600_000), { snapshottedAt: ago(60_000) });
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "firstadmin", password: "correct horse battery" },
    });
    expect(res.statusCode).toBe(200);

    const [player] = await db.select().from(players).where(eq(players.username, "firstadmin"));
    expect(player!.roleId).not.toBeNull();
    const grants = await db.select().from(roleModuleAccess).where(eq(roleModuleAccess.roleId, player!.roleId!));
    expect(grants.map((g) => g.moduleKey)).toContain("*");
    expect(await db.select().from(roundEntries)).toHaveLength(1);
  });
});
```

Import `roleModuleAccess` and `roundStandings`, and add the `bootTestServer` scaffolding:

```ts
let app: Awaited<ReturnType<typeof bootTestServer>>["app"];
let closeServer: () => Promise<void>;
beforeAll(async () => { const booted = await bootTestServer(); app = booted.app; closeServer = booted.close; });
afterAll(async () => { await closeServer(); await redis.quit(); });
```

- [ ] **Step 2: Run the file to verify the new cases fail**

```bash
npx vitest run apps/server/test/rounds-snapshot.test.ts
```

Expected: the two pre-existing cases PASS; the four new ones FAIL (no `round_entries` row is written by registration, `players.round_id` stays null in the mid-round case).

- [ ] **Step 3: Write the implementation**

In `apps/server/src/auth/routes.ts`, insert after `await tx.insert(playerStats).values({ playerId });`:

```ts
        // A player who registers halfway through a round competes on progress
        // from the moment they join, not from zero. There is no round id in
        // scope here — the register route knows nothing about rounds — so the
        // block starts with its own read, using the same active predicate
        // ensureCurrentRound's probe uses. Registration deliberately does NOT
        // call ensureCurrentRound: that opens a transaction (we are in one) and
        // takes a global advisory lock, and this is a hot path. A round that
        // has ended but not yet rolled over matches nothing here; the next
        // round's whole-population activation picks the player up.
        const [round] = await tx.select({ id: rounds.id }).from(rounds)
          .where(sql`${rounds.finalizedAt} is null
                     and ${rounds.startsAt} is not null and ${rounds.startsAt} <= now()
                     and (${rounds.endsAt} is null or ${rounds.endsAt} > now())`)
          .orderBy(asc(rounds.startsAt), asc(rounds.id))
          .limit(1);

        if (round) {
          // INSERT ... SELECT off player_stats rather than three literal zeroes:
          // hard-coded 0n would be correct today and would silently start lying
          // the day new players get a starting balance.
          await tx.execute(sql`
            insert into round_entries (round_id, player_id, joined_at, exp_at_start, cash_at_start, bank_at_start)
            select ${round.id}, ps.player_id, now(), ps.exp, ps.cash, ps.bank
            from player_stats ps where ps.player_id = ${playerId}
            on conflict (round_id, player_id) do nothing`);

          await tx.update(players).set({ roundId: round.id }).where(eq(players.id, playerId));
        }
```

Add `rounds` to the schema import and `asc` to the `drizzle-orm` import if either is missing; `sql`, `eq` and `players` are already imported.

- [ ] **Step 4: Run the file to verify it passes**

```bash
npx vitest run apps/server/test/rounds-snapshot.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the auth suite for regressions**

```bash
npx vitest run apps/server/test/auth.test.ts
```

Expected: PASS (registration behaviour is otherwise unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/auth/routes.ts apps/server/test/rounds-snapshot.test.ts
git commit -m "feat(rounds): snapshot a mid-round registrant at their own values"
```

---

### Task 7: The ledger still reconciles across a rollover

**Spec:** §5.2 (`rounds-ledger.test.ts`), §3.6 ("The call shape"), CLAUDE.md rule 3.

**Files:**
- Create test: `apps/server/test/rounds-ledger.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server` include)
- Modify (only if the test finds a defect): `apps/server/src/game/rounds/service.ts`

**Interfaces:**
- Consumes: `ensureCurrentRound` (Task 5); the `bank` plugin's transfer routes and the `crimes` plugin's commit route, driven over HTTP through `bootTestServer()`.
- Produces: no new export. This task's deliverable is the proof — it is an explicit §5.6 acceptance criterion.

> **The `rounds.payout_points` row must be inserted BEFORE `bootTestServer()`, not in `beforeEach`.** Settings are read once into a plain `Record<string, string>` at boot (`test/helpers/server.ts:45`, production at `index.ts:54`). A row written after that is invisible for the life of the server and the payout silently uses §3.6's default table — a fixture bug that reads as a payout bug. `resetDb` truncates `settings`, so re-insert the row after every reset too, and assert the loaded value rather than trusting the insert.

- [ ] **Step 1: Write the test**

Create `apps/server/test/rounds-ledger.test.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { players, playerStats, roundEntries, rounds, settings as settingsTable, transactions }
  from "../src/db/schema/index.js";
import { ensureCurrentRound } from "../src/game/rounds/service.js";
import { loadConfig } from "../src/config.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const AWARDS = [1000n, 500n, 250n];
const SETTINGS_VALUE = "[1000,500,250]";
const STARTING_CASH = 1000n;   // match whatever registration seeds; assert it below

async function seedSetting(): Promise<void> {
  await db.insert(settingsTable)
    .values({ key: "rounds.payout_points", value: SETTINGS_VALUE })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: SETTINGS_VALUE } });
}

let app: Awaited<ReturnType<typeof bootTestServer>>["app"];
let closeServer: () => Promise<void>;

beforeAll(async () => {
  await resetDb(db);
  await seedSetting();                    // BEFORE the boot — settings load once
  const booted = await bootTestServer();
  app = booted.app;
  closeServer = booted.close;
});
afterAll(async () => { await closeServer(); await redis.quit(); });
beforeEach(async () => { await resetDb(db); await seedSetting(); });
```

Then the body:

1. Register three players over HTTP and capture their tokens.
2. Move money through **two real routes** so the ledger is non-trivial: a bank deposit (`POST /api/bank/deposit`) and a crime commit (`POST /api/crimes/:id/commit`) — use whatever paths those plugins expose today; read them from the plugin manifests rather than guessing.
3. Seed an ended round with entries whose `exp_at_start` is below each player's current exp so the placings are unambiguous, plus a successor starting in the past.
4. `await ensureCurrentRound(db, redis, loadedSettingsFromBoot)` — obtain the same record the server loaded by calling `loadSettings(db)` after the boot-time insert, and assert `payoutPoints(thatRecord)` equals `AWARDS` before using it. That assertion is what stops a silent fallback from making the rest of the file vacuous.
5. Assert the per-player per-kind sweep, modelled on `apps/server/test/economy-invariant.test.ts:356-370`:

```ts
for (const playerId of playerIds) {
  const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
  const kinds = { cash: stats!.cash, bank: stats!.bank, points: stats!.points } as const;
  for (const kind of ["cash", "bank", "points"] as const) {
    const ledgerRows = await db.select({ amount: transactions.amount })
      .from(transactions)
      .where(and(eq(transactions.playerId, playerId), eq(transactions.balanceKind, kind)));
    const ledgerSum = ledgerRows.reduce((sum, r) => sum + r.amount, 0n);
    const expected = kind === "cash" ? STARTING_CASH + ledgerSum : ledgerSum;
    expect(kinds[kind], `player ${playerId} kind ${kind}`).toBe(expected);
  }
}
```

6. Payout-specific assertions:

```ts
const payouts = await db.select().from(transactions)
  .where(and(eq(transactions.reason, "round.payout"), eq(transactions.refId, endedRoundId)));

expect(payouts.every((r) => r.balanceKind === "points")).toBe(true);
expect(payouts.every((r) => r.refId === endedRoundId)).toBe(true);
expect(payouts.every((r) => r.jobId === null)).toBe(true);

// Placing order, not just the multiset: paying [250,500,1000] sums the same.
const paidInPlacingOrder = winnersInExpectedOrder.map((id) =>
  payouts.find((r) => r.playerId === id)!.amount);
expect(paidInPlacingOrder).toEqual(AWARDS);
```

`STARTING_CASH` must be read from the code, not guessed — assert it against a freshly registered player's `player_stats.cash` before the rollover, and use that value in the sweep.

- [ ] **Step 2: Register the file in `vitest.workspace.ts`**

```ts
        "test/rounds-ledger.test.ts",
```

- [ ] **Step 3: Run it and read the failure honestly**

```bash
npx vitest run apps/server/test/rounds-ledger.test.ts
```

If it fails, **diagnose before fixing** — the likeliest causes are fixture bugs (settings loaded after boot; `STARTING_CASH` guessed) rather than a defect in Task 5. Only change `service.ts` if the failure is a genuine rule-3 violation.

- [ ] **Step 4: Run it again to verify it passes**

```bash
npx vitest run apps/server/test/rounds-ledger.test.ts
```

Expected: PASS.

- [ ] **Step 5: Prove it can fail**

Temporarily change the payout's `kind: "points"` to `kind: "cash"` in `service.ts`, re-run the file, and observe the per-kind sweep and the `balance_kind` assertion go red. Restore, re-run, observe green. Paste both outputs into the task report.

- [ ] **Step 6: Commit**

```bash
git add apps/server/test/rounds-ledger.test.ts vitest.workspace.ts
git commit -m "test(rounds): the ledger reconciles across a rollover payout"
```

---

### Task 8: Rollover fires exactly once under concurrency

**Spec:** §5.2 (`rounds-rollover.test.ts`), §2.4, §5.6.

**Files:**
- Create test: `apps/server/test/rounds-rollover.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server` include)

**Interfaces:**
- Consumes: `GET /api/rounds` does not exist yet (Task 10), so this file fires **`GET /api/leaderboard/exp`**… **no** — that call site also arrives in Task 10. Until then, drive `ensureCurrentRound(db, redis, settings)` directly, 8 times concurrently with `Promise.all`, from 8 independent `Db` handles obtained by calling `testDb()` eight times (one pool per caller, so they are genuinely simultaneous rather than serialised on one connection).
- Produces: no new export.

> **This task must be re-run after Task 10** with the HTTP form (`app.inject` against `GET /api/rounds`), which is the shape §5.2 specifies. Write it now against `ensureCurrentRound` to prove the lock, then switch the driver to `app.inject` in Task 10's step list and keep both assertions sets. If executing tasks strictly in order feels awkward here, run this task *after* Task 10 instead — the plan's only ordering requirement is that it lands before the branch is finished.

- [ ] **Step 1: Write the test**

Create `apps/server/test/rounds-rollover.test.ts`. Shape:

- Seed an ended round (`snapshotted_at` set, `ends_at` in the past) **and** a successor whose `starts_at` equals that `ends_at` — **also in the past** — with `ends_at` in the future and `snapshotted_at` null. If the successor's `starts_at` is in the future, finalize's re-evaluation never matches it, no activation happens, and assertions 4-5 fail for a reason unrelated to the race.
- Seed at least four players with distinct `exp`, and entries in the ended round, so a three-award table has a non-placer to ignore.
- Subscribe a dedicated `createSubscriber()` to `game:events` **before** firing, with a collector that pushes every frame whose `actorId` is the ended round's id or the successor's id (rule 4 — the channel is global). Use `awaitOwnEvent(subscriber, endedRoundId)` for the arrival edge, then await `awaitOwnEvent(subscriber, successorId)`, then assert on the collected counts.
- Fire 8 concurrent calls with the `fire()` idiom from `apps/server/test/properties-lock-order.test.ts`:

```ts
const fire = (): Promise<unknown> => Promise.resolve(ensureCurrentRound(db, redis, SETTINGS));
const results = await Promise.all(Array.from({ length: 8 }, fire));
```

(`app.inject()` is lazy and does not dispatch until something calls `.then`, which is why the HTTP form needs `Promise.resolve(app.inject(...))`.)

Assertions:

1. all 8 calls resolve — none throws, no 23505;
2. exactly one row in `rounds` has a non-null `finalized_at`, and it is the ended round;
3. `select count(*) from transactions where reason = 'round.payout' and ref_id = <ended id>` equals the award-table length — **not a multiple of it**. This is the assertion a second finalize breaks;
4. `round_entries` for the **successor** holds exactly one row per player, and the successor's `snapshotted_at` is non-null;
5. every `players.round_id` equals the successor's id;
6. **exactly one `round.finished` and exactly one `round.started`** were collected — one of each, not "at least one". A second publish is the observable symptom of the same double-finalize, and it is the one that reaches every connected client. This also covers rule 5: a publish from inside the transaction would still arrive, so the *count* is what proves single settlement.

- [ ] **Step 2: Register the file in `vitest.workspace.ts`**

```ts
        "test/rounds-rollover.test.ts",
```

- [ ] **Step 3: Run it to verify it passes**

```bash
npx vitest run apps/server/test/rounds-rollover.test.ts
```

Expected: PASS.

- [ ] **Step 4: SHOW IT RED — the required procedure**

A concurrency test nobody has watched fail proves nothing.

```bash
# 1. Delete ONLY this line from ensureCurrentRound's settle():
#      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ROUNDS_LOCK})`);
#    Change nothing else — in particular do not reorder the steps.
npx vitest run apps/server/test/rounds-rollover.test.ts
```

Expected: FAIL at assertion 3 with a payout-row count that is a multiple of the award count (typically 2× or 3×, load-dependent).

Why it genuinely fails: under READ COMMITTED two transactions both read `finalized_at IS NULL`, both freeze and both **pay**, and only then does either reach `UPDATE rounds SET finalized_at = now() WHERE id = $1 AND finalized_at IS NULL`. The second blocks on the row lock, re-evaluates its `WHERE`, and updates zero rows — so the stamp is single but the money already moved twice.

**Do not "fix" this by stamping first and branching on `rowCount`, then dropping the lock.** The activation snapshot is not covered by `finalized_at` at all — it is guarded by the successor's own `snapshotted_at`, stamped *after* the insert for the same reason. Two transactions racing it collide on the `(round_id, player_id)` primary key and one request answers 500 on a well-formed `GET /api/rounds`. The lock is what turns "one request 500s" into "one does the work, the others proceed".

- [ ] **Step 5: Restore and re-run**

```bash
git checkout apps/server/src/game/rounds/service.ts
npx vitest run apps/server/test/rounds-rollover.test.ts
```

Expected: PASS. **Paste both outputs into the task report and the PR body** — this is a §5.6 acceptance criterion.

- [ ] **Step 6: Commit**

```bash
git add apps/server/test/rounds-rollover.test.ts vitest.workspace.ts
git commit -m "test(rounds): rollover fires exactly once under 8 concurrent callers"
```

---

### Task 9: Lock order — the fourth pair (rounds↔player)

**Spec:** §2.7, §5.2 (`rounds-lock-order.test.ts`), §5.6.

**Files:**
- Create test: `apps/server/test/rounds-lock-order.test.ts`
- Modify: `vitest.workspace.ts` (`@gl3/server` include)

**Interfaces:**
- Consumes: `ensureCurrentRound` (Task 5); the `bank` plugin's transfer route and the `combat` plugin's attack route, driven over HTTP; a raw `postgres` connection for the barrier.
- Produces: no new export.

> **The corollary that decides whether this file is worth anything** (CLAUDE.md rule 6): *a concurrency test whose participants all acquire locks via the same helper proves only the case that was already safe.* Two concurrent `ensureCurrentRound` calls agree on ordering by construction and would stay green through any bug in §2.7. The counterparties must therefore be **real routes that lock `player_stats` through a different door**: a real bank transfer for one winner (one player, `FOR UPDATE` via `applyBalanceChange`) and a real combat attack between two winners (two players, via `lockPlayersForUpdate`).

- [ ] **Step 1: Write the test**

Create `apps/server/test/rounds-lock-order.test.ts`, modelled on `apps/server/test/properties-lock-order.test.ts`.

Header comment must document these two things, because they look like gaps and are not:

1. The freeze (`UPDATE round_entries … FROM player_stats`) reads `player_stats` **without locking it** — a plain `FROM` takes no row locks. A money move racing the freeze lands on one side of the statement snapshot or the other. That is a "which instant" question, not corruption; this file asserts conservation, never which side a specific racing transfer fell on.
2. `round_entries`' foreign keys take `FOR KEY SHARE` on `players` and on `rounds`. **Nothing in the repo takes `FOR UPDATE` on `players`** — core's `FOR UPDATE` sites are `player_stats`, `locations` and `gangs` (`economy/ledger.ts:42,100,126,165`); plugins add their own only on tables they own (`p_theft_cars`, `p_oc_heists`, `p_properties_properties`). So the FK edge to `players` contends with nothing today. The contended row is `player_stats`, reached by the payout, which is why "then players ascending" is the whole of the second half of the rule.

Mechanism — a **barrier, not a race loop**:

- open a separate `postgres` connection and take `FOR UPDATE` on the *first* lock in the canonical order (the blocker holds exactly one lock, so it cannot itself be half of a cycle);
- queue the real counterparty request behind it;
- queue the finalize-triggering call behind that;
- wait on **observed lock state in `pg_stat_activity`** — never a `sleep`;
- release from one instant with the interleaving already fixed.

Firing two requests and hoping they interleave is a coin flip per run and produces a test that is green for the wrong reason.

Assertions: no response is 500; nothing in the run logs SQLSTATE `40P01`; the finalize completed exactly once (re-use the payout-row-count assertion); the counterparty's money movement appears in `transactions` exactly once.

- [ ] **Step 2: Register the file in `vitest.workspace.ts`**

```ts
        "test/rounds-lock-order.test.ts",
```

- [ ] **Step 3: Run it to verify it passes**

```bash
npx vitest run apps/server/test/rounds-lock-order.test.ts
```

Expected: PASS.

- [ ] **Step 4: Show it red**

Remove the `await lockPlayersForUpdate(tx, winners.map((w) => w.playerId));` pre-lock from `finalize()` in `service.ts` — so the payout takes `player_stats` locks in *delta* order — re-run the file, and observe it go red (a `40P01` deadlock or a 500). Restore, re-run, observe green. Paste both outputs.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/rounds-lock-order.test.ts vitest.workspace.ts
git commit -m "test(rounds): lock order regression for the rounds↔player pair"
```

---

### Task 10: Player routes, the DTO, and the leaderboard `scope` extension

**Spec:** §4.1, §3.3 (**corrected**), §2.2 call sites, §5.2 (`rounds-routes.test.ts`), §5.3 item 4.

**Files:**
- Create: `packages/shared/src/dto/rounds.ts`, `apps/server/src/game/rounds/routes.ts`
- Create test: `apps/server/test/rounds-routes.test.ts`
- Modify: `packages/shared/src/index.ts`, `apps/server/src/app.ts`, `apps/server/src/index.ts`, `apps/server/src/game/leaderboard/routes.ts`, `apps/web/src/lib/errors.ts`, `apps/server/test/leaderboard.test.ts`, `vitest.workspace.ts`

**Interfaces:**
- Consumes: `ensureCurrentRound` (Task 5), `roundStandings` (Task 3).
- Produces:
  ```ts
  // packages/shared/src/dto/rounds.ts
  RoundDtoSchema, RoundDto, RoundListResponseSchema, RoundListResponse,
  RoundStandingsResponseSchema, RoundStandingsResponse
  // apps/server/src/game/rounds/routes.ts
  export function registerRoundsRoutes(
    app: FastifyInstance, db: Db, redis: Redis,
    settings: Record<string, string>,
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  ): void
  // apps/server/src/game/leaderboard/routes.ts — WIDENED
  export function registerLeaderboardRoutes(
    app: FastifyInstance, db: Db, redis: Redis,
    settings: Record<string, string>,
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
    leaderboardPrefix = DEFAULT_LEADERBOARD_PREFIX,
  ): void
  ```

> **The §3.3 correction.** §3.3 claims `registerLeaderboardRoutes`' signature does not change. §2.2 and §4.1 say it gains `settings: Record<string, string>` and call it "the one signature in core that widens". **It widens.** `settings` goes after `redis` and before `requireAuth`, matching `registerHospitalRoutes`' ordering; the trailing `leaderboardPrefix = DEFAULT_LEADERBOARD_PREFIX` default and everything it threads through `AppDeps` are unchanged. Its single call site is `apps/server/src/app.ts:63` and it passes `loadedSettings`.

- [ ] **Step 1: Write the DTO file**

Create `packages/shared/src/dto/rounds.ts`:

```ts
import { z } from "zod";
import { IdSchema, TimestampSchema } from "../primitives.js";
import { LeaderboardEntrySchema, LeaderboardKindSchema } from "./leaderboard.js";

export const RoundDtoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  startsAt: TimestampSchema.nullable(),
  endsAt: TimestampSchema.nullable(),
  /** null when endsAt is null (an open-ended round never counts down). */
  secondsRemaining: z.number().int().nonnegative().nullable(),
  finalizedAt: TimestampSchema.nullable(),
});
export type RoundDto = z.infer<typeof RoundDtoSchema>;

export const RoundListResponseSchema = z.object({
  active: RoundDtoSchema.nullable(),
  finished: z.array(RoundDtoSchema),
});
export type RoundListResponse = z.infer<typeof RoundListResponseSchema>;

export const RoundStandingsResponseSchema = z.object({
  roundId: IdSchema,
  roundName: z.string(),
  kind: LeaderboardKindSchema,
  /** true once finalized_at is set: the board is frozen and will never move again. */
  finalized: z.boolean(),
  entries: z.array(LeaderboardEntrySchema),
});
export type RoundStandingsResponse = z.infer<typeof RoundStandingsResponseSchema>;
```

Add to `packages/shared/src/index.ts`, after `./dto/rank.js` and before `./dto/shop.js`:

```ts
export * from "./dto/rounds.js";
```

If `MoneySchema` ends up unimported, do not import it — `LeaderboardEntrySchema` already carries the signed `score`.

- [ ] **Step 2: Write the failing route tests**

Create `apps/server/test/rounds-routes.test.ts` (project `@gl3/server`, so it needs a `vitest.workspace.ts` entry — add `"test/rounds-routes.test.ts",`). Cases:

1. `GET /api/rounds` with no token → **401**. With a token and an active round → 200, `RoundListResponseSchema` parses, `active.name` matches, `active.secondsRemaining` is a non-negative integer close to the seeded remainder, and `finished` lists the finalized rounds ordered `ends_at DESC NULLS LAST, id DESC` (seed one finalized open-ended round and two dated ones and assert the exact order: dated newest, dated older, then the open-ended one **last**).
2. `GET /api/rounds/:id/standings?kind=cash` → 200 and parses; `kind=bank` and `kind=exp` likewise; no `kind` at all defaults to `exp`.
3. An unknown `kind` → **400** `{ error: "invalid_kind" }`.
4. `GET /api/rounds/not-a-uuid/standings` → **400** `{ error: "invalid_request" }`, **not** 500. Without the param parse the string reaches Postgres and comes back `22P02`, which Fastify renders as a 500 on a request the client got wrong.
5. A well-formed but unknown round id → **404** `{ error: "round_not_found" }`.
6. `GET /api/leaderboard/exp` with **no query string** behaves exactly as it does today — same payload as `apps/server/test/leaderboard.test.ts` already pins.
7. `?scope=all` is identical to the no-query form; `?scope=round` returns the active round's standings; `?scope=bogus` → **400** `{ error: "invalid_scope" }`.
8. **Zero rounds:** `GET /api/rounds` → 200 with `active: null` and `finished: []`; `?scope=round` → 200 with `entries: []` (**not** 404); `?scope=all` unchanged. Nothing 404s, nothing 500s.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run apps/server/test/rounds-routes.test.ts
```

Expected: FAIL — `/api/rounds` 404s and the module does not exist.

- [ ] **Step 4: Write the rounds routes**

Create `apps/server/src/game/rounds/routes.ts`:

```ts
import { LeaderboardKindSchema, IdSchema } from "@gl3/shared";
import { desc, eq, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { rounds } from "../../db/schema/index.js";
import { ensureCurrentRound } from "./service.js";
import { roundStandings } from "./standings.js";

const ParamsSchema = z.object({ id: IdSchema });
const QuerySchema = z.object({ kind: LeaderboardKindSchema.default("exp") }).strict();

/** Same count the all-time board uses, so the boards agree on length. */
const BOARD_SIZE = 10;

interface RoundRow {
  id: string; name: string;
  startsAt: Date | null; endsAt: Date | null; finalizedAt: Date | null;
}

/**
 * Sent as a countdown rather than only `endsAt` so the client's clock skew
 * cannot make a round look already-over on one machine and live on another.
 */
function secondsRemaining(endsAt: Date | null): number | null {
  if (endsAt === null) return null;
  return Math.max(0, Math.floor((endsAt.getTime() - Date.now()) / 1000));
}

const toDto = (row: RoundRow) => ({
  id: row.id,
  name: row.name,
  startsAt: row.startsAt?.toISOString() ?? null,
  endsAt: row.endsAt?.toISOString() ?? null,
  secondsRemaining: secondsRemaining(row.endsAt),
  finalizedAt: row.finalizedAt?.toISOString() ?? null,
});

export function registerRoundsRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  settings: Record<string, string>,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/rounds", { preHandler: requireAuth }, async (_request, reply) => {
    // First, so visiting the Rounds page is one of the things that can trigger
    // a rollover.
    const active = await ensureCurrentRound(db, redis, settings);

    // ends_at is nullable and Postgres sorts NULLs FIRST under DESC, so a
    // finalized open-ended round — exactly what the V2 migrator brings over —
    // would head the hall of fame instead of tailing it. id DESC gives a total
    // order; ids are uuidv7, so descending id is descending creation time.
    const finishedRows = await db.select().from(rounds)
      .where(isNotNull(rounds.finalizedAt))
      .orderBy(sql`${rounds.endsAt} desc nulls last`, desc(rounds.id));

    const activeRow = active === null
      ? null
      : (await db.select().from(rounds).where(eq(rounds.id, active.id)))[0] ?? null;

    return reply.send({
      active: activeRow === null ? null : toDto(activeRow),
      finished: finishedRows.map(toDto),
    });
  });

  app.get("/api/rounds/:id/standings", { preHandler: requireAuth }, async (request, reply) => {
    // An ended-but-unsettled round must settle before it is read, or this same
    // request would report a live board for a round that is over.
    await ensureCurrentRound(db, redis, settings);

    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const query = QuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_kind" });

    const [round] = await db.select().from(rounds).where(eq(rounds.id, params.data.id));
    if (!round) return reply.code(404).send({ error: "round_not_found" });

    const finalized = round.finalizedAt !== null;
    const entries = await roundStandings(db, round.id, query.data.kind, BOARD_SIZE, finalized);
    return reply.send({
      roundId: round.id, roundName: round.name, kind: query.data.kind, finalized, entries,
    });
  });
}
```

- [ ] **Step 5: Widen and extend the leaderboard route**

Rewrite `apps/server/src/game/leaderboard/routes.ts`:

```ts
import { LeaderboardKindSchema } from "@gl3/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { ensureCurrentRound } from "../rounds/service.js";
import { roundStandings } from "../rounds/standings.js";
import { DEFAULT_LEADERBOARD_PREFIX, topN } from "./service.js";

const ParamsSchema = z.object({ kind: LeaderboardKindSchema });
/**
 * The default is "all", not "round": every caller that sends no querystring —
 * the web client included — must keep getting the all-time ZSET board, and on
 * an install with no rounds a "round" default would silently answer empty.
 */
const QuerySchema = z.object({ scope: z.enum(["round", "all"]).default("all") }).strict();

export function registerLeaderboardRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  settings: Record<string, string>,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  leaderboardPrefix = DEFAULT_LEADERBOARD_PREFIX,
): void {
  app.get("/api/leaderboard/:kind", { preHandler: requireAuth }, async (request, reply) => {
    // Unconditional, before the params parse: branching on the query param to
    // skip it would let the all-time board observe a round that ended an hour
    // ago as still active, for no saving beyond one indexed SELECT.
    const active = await ensureCurrentRound(db, redis, settings);

    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_kind" });
    const query = QuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_scope" });

    if (query.data.scope === "round") {
      // No active round is an empty board, not a 404: an empty board is the
      // honest answer for "this season's standings" on a game with no season.
      const entries = active === null
        ? []
        : await roundStandings(db, active.id, params.data.kind, 10, false);
      return reply.send({ kind: params.data.kind, entries });
    }

    const entries = await topN(db, redis, params.data.kind, 10, leaderboardPrefix);
    return reply.send({ kind: params.data.kind, entries });
  });
}
```

- [ ] **Step 6: Wire both into `app.ts`**

In `apps/server/src/app.ts`, add the import after `registerProfileRoutes` (line 11) and before the `plugins/` imports:

```ts
import { registerRoundsRoutes } from "./game/rounds/routes.js";
```

Update the leaderboard call at line 63 and add the rounds call after `registerProfileRoutes` (line 64):

```ts
  registerLeaderboardRoutes(app, deps.db, deps.redis, loadedSettings, requireAuth, leaderboardPrefix);
  registerProfileRoutes(app, deps.db, requireAuth);
  registerRoundsRoutes(app, deps.db, deps.redis, loadedSettings, requireAuth);
```

Both sit before the plugin seam at line 67, which the position satisfies.

- [ ] **Step 7: Add the boot call site**

In `apps/server/src/index.ts`, between `const loadedSettings = await loadSettings(db);` (line 54) and the `loadPlugins` call (line 55):

```ts
// Deliberately here and NOT in buildApp: every integration test builds its
// server through buildApp/bootTestServer, and a boot-time rollover firing under
// those tests would make round assertions race — the same reason the sentence
// sweeper is kept out of buildApp. The boot call is what absorbs the expensive
// case: a server that was down across several scheduled rounds settles them all
// here rather than making the first player of the day pay for it.
await ensureCurrentRound(db, redis, loadedSettings);
```

with `import { ensureCurrentRound } from "./game/rounds/service.js";` beside the other `game/*` imports.

- [ ] **Step 8: Add the error copy**

In `apps/web/src/lib/errors.ts`, add to `MESSAGES` in alphabetical position:

```ts
  invalid_scope: "Unknown leaderboard scope.",
  invalid_window: "A round must end after it starts.",
  round_finalized: "That round has already been settled.",
  round_not_found: "That round no longer exists.",
  round_overlap: "Another round already covers that period.",
```

(`invalid_window`, `round_finalized` and `round_overlap` are emitted by Task 11's admin routes; they go in now so the map is complete in one place.)

- [ ] **Step 9: Pin the leaderboard's backwards compatibility**

In `apps/server/test/leaderboard.test.ts`, add an explicit `?scope=all` case beside the existing no-query case, asserting the identical ZSET-backed payload. `recordScore`, `rebuildLeaderboards` and `topN` are **not** modified.

- [ ] **Step 10: Run the tests to verify they pass**

```bash
npm run typecheck
npx vitest run apps/server/test/rounds-routes.test.ts apps/server/test/leaderboard.test.ts
```

Expected: typecheck exit 0; both files PASS.

- [ ] **Step 11: Switch `rounds-rollover.test.ts` to the HTTP driver**

Now that `GET /api/rounds` exists, change Task 8's file to fire 8 concurrent `Promise.resolve(app.inject({ method: "GET", url: "/api/rounds" }))` calls through `bootTestServer()`, add "all 8 responses are 200" as assertion 1, and keep every other assertion. Re-run it, and re-run the red proof (delete the advisory-lock line, observe assertion 3 fail, restore) so the recorded output matches the shipped shape.

```bash
npx vitest run apps/server/test/rounds-rollover.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/shared/src/dto/rounds.ts packages/shared/src/index.ts \
        apps/server/src/game/rounds/routes.ts apps/server/src/game/leaderboard/routes.ts \
        apps/server/src/app.ts apps/server/src/index.ts apps/web/src/lib/errors.ts \
        apps/server/test/rounds-routes.test.ts apps/server/test/leaderboard.test.ts \
        apps/server/test/rounds-rollover.test.ts vitest.workspace.ts
git commit -m "feat(rounds): player routes and the leaderboard scope toggle"
```

---

### Task 11: Admin — `/api/admin/rounds`, the `rounds` module key, and the overlap rule

**Spec:** §4.2, §4.3 (`roundsPage`), §5.2 (`admin-rounds.test.ts`), §5.3 item 3.

**Files:**
- Create: `apps/server/src/admin/rounds-page.ts`
- Create test: `apps/server/test/admin-rounds.test.ts`
- Modify: `apps/server/src/plugins/validate.ts:4-9`, `apps/server/src/admin/routes.ts` (`moduleKeysOf` at 42-49, the sections payload at 59-87, four new routes), `apps/server/test/admin-ids-hidden.test.ts`, `vitest.workspace.ts`

**Interfaces:**
- Consumes: `hasPermission` (`@gl3/plugin-sdk`), `loadGrants` (`apps/server/src/plugins/routes.js`), `rounds` table (Task 1).
- Produces: `export const roundsPage: PageSchema` from `apps/server/src/admin/rounds-page.ts`; routes `GET /api/admin/rounds`, `GET /api/admin/rounds/table`, `POST /api/admin/rounds`, `POST /api/admin/rounds/edit`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/admin-rounds.test.ts` (project `@gl3/server`; add `"test/admin-rounds.test.ts",` to `vitest.workspace.ts`). Cases:

1. **Authorization.** Core admin routes have no loader tier — `auth: "admin"` applies to *plugin* routes only; core routes use `{ preHandler: [app.requireAuth] }` plus the inline grant check. Assert: no token → 401; a token whose role holds no grant → 403 `forbidden`; a role holding `rounds` → 200; a role holding `*` → 200.
2. **Overlap rejected at write time.** Against one existing non-finalized round, cover all five colliding geometries — identical, strictly inside, strictly containing, overlapping the front edge, overlapping the back edge — each → 400 `round_overlap`; and two that must be **accepted**: strictly before and strictly after, sharing an endpoint (half-open intervals). Editing a round into an overlap is rejected the same way; editing a round without changing its dates is **not** rejected by its own existence.
3. **Overlap with a finalized round is allowed.**
4. **A finalized round is immutable** — editing `startsAt`, `endsAt` **or** `name` on a round with a non-null `finalized_at` → 400 `round_finalized`.
5. **There is no "end it now" button.** Assert the mechanism instead: set `endsAt` into the past through the edit route, then `GET /api/rounds`, and observe the rollover happened.
6. **`invalid_window`** — `endsAt <= startsAt` → 400 `invalid_window`. **`invalid_request`** — a malformed timestamp, and a body with an unknown key (`.strict()`).
7. **Offsets are accepted** — `2026-09-01T00:00:00+02:00` creates successfully (`z.string().datetime({ offset: true })`; bare `.datetime()` would reject it).
8. **Two concurrent creates of the same window produce exactly one round.** Fire both with `Promise.all` over two `Promise.resolve(app.inject(...))` calls; assert **one 201 and one 400 `round_overlap`**, and `SELECT count(*) FROM rounds` is 1. This is the only assertion in the file that fails with §4.2's advisory lock removed — every other case runs sequentially and would stay green.
9. **`GET /api/admin/rounds/table`** parses under `TableRowsResponseSchema` — every value in every row is a `string`, `endsAt` for an open-ended round is `""` (not `null`, not omitted), and `status` is one of `finalized | active | ended | scheduled`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run apps/server/test/admin-rounds.test.ts
```

Expected: FAIL — every route 404s.

- [ ] **Step 3: Reserve the path and guard the module key**

In `apps/server/src/plugins/validate.ts`, extend `RESERVED_BASE_PATHS`:

```ts
  "/api/admin/plugins", "/api/admin/roles", "/api/admin/rounds",
```

`/api/rounds` is deliberately **not** reserved: it is a gameplay path, and a plugin replacing one is the strangler seam working as designed. A plugin that claims it anyway does not shadow core — an exact duplicate is `FST_ERR_DUPLICATED_ROUTE` at boot.

Then add the module-key guard — reserving the path is **not** the same as reserving the key, and both are needed. `moduleKeysOf` lists every loaded plugin id, and grants are bare strings with no namespace, so a plugin whose id is `rounds` would make `hasPermission(grants, "rounds")` satisfiable by an unrelated grant, and the path reservation does not catch it (it fires only for a plugin that declares admin routes). In `validate.ts`, beside the reserved-path check:

```ts
/** Core module keys `moduleKeysOf` (admin/routes.ts) grants over. A plugin id
 *  equal to one of these makes an unrelated plugin's grant satisfy a core
 *  permission check, because grants are stored as bare, un-namespaced strings. */
const RESERVED_MODULE_KEYS = ["roles", "rounds", "*"] as const;
```

and, inside the per-manifest validation, before or beside the path check:

```ts
  if ((RESERVED_MODULE_KEYS as readonly string[]).includes(manifest.id)) {
    fail(`plugin id "${manifest.id}" collides with a core admin module key`);
  }
```

Check first whether such a guard already exists for `roles`; if it does, add `"rounds"` to its list rather than writing a second one.

- [ ] **Step 4: Add the module key and the admin page**

In `apps/server/src/admin/routes.ts`, `moduleKeysOf`:

```ts
    { id: "roles", name: "roles" },
    { id: "rounds", name: "rounds" },
```

`roles` was rejected as the key for rounds: `roles` is transitively equivalent to full admin (it can grant itself `*`), and scheduling a season is a content job.

Create `apps/server/src/admin/rounds-page.ts`:

```ts
import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's round-scheduling section, served through the same payload as plugin
 * adminPages so the client renders core and plugins through one code path.
 *
 * No UUID column: the round id travels only as the edit form's select
 * `valueKey`, so the admin picks a round by name. `admin-ids-hidden.test.ts`
 * enforces this with /^id$|Id$/ — `roundId` would fail, `roundName` passes.
 *
 * Dates are `type: "text"`: the field vocabulary has no date type and adding
 * one to the SDK is out of scope. The label carries the format and
 * `z.string().datetime({ offset: true })` on the body is what enforces it.
 */
export const roundsPage: PageSchema = {
  id: "core-rounds-admin",
  path: "/admin/rounds",
  view: {
    kind: "panel",
    title: "Rounds",
    children: [
      { kind: "table", source: "GET /api/admin/rounds/table", columns: [
        { key: "name", label: "Name" },
        { key: "startsAt", label: "Starts" },
        { key: "endsAt", label: "Ends" },
        { key: "status", label: "Status" },
      ] },
      { kind: "form", action: "POST /api/admin/rounds", submitLabel: "Create round", fields: [
        { name: "name", label: "Round name", type: "text" },
        { name: "startsAt", label: "Starts at (ISO 8601 UTC, e.g. 2026-09-01T00:00:00Z)", type: "text" },
        { name: "endsAt", label: "Ends at (ISO 8601 UTC)", type: "text" },
      ] },
      { kind: "form", action: "POST /api/admin/rounds/edit", submitLabel: "Edit round", fields: [
        { name: "roundId", label: "Round", type: "select", optionsSource: "GET /api/admin/rounds/table", valueKey: "id", labelKey: "name" },
        { name: "name", label: "Round name", type: "text" },
        { name: "startsAt", label: "Starts at (ISO 8601 UTC)", type: "text" },
        { name: "endsAt", label: "Ends at (ISO 8601 UTC)", type: "text" },
      ] },
    ],
  },
};
```

In `registerAdminRoutes`'s `/api/admin/plugins` handler, append the section beside the roles one — copying each field individually, **never** a spread (`PageSchema`'s optional `menu` would be rejected by the client's `.strict()` schema):

```ts
    if (hasPermission(grants, "rounds")) {
      sections.push({
        pluginId: "rounds",
        pages: [{ pluginId: "rounds", id: roundsPage.id, path: roundsPage.path, view: roundsPage.view }],
      });
    }
```

- [ ] **Step 5: Add the four admin routes**

In `apps/server/src/admin/routes.ts`, with these file-level schemas:

```ts
const RoundCreateBodySchema = z.object({
  name: z.string().transform((v) => v.trim()).pipe(z.string().min(1)),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
}).strict();

const RoundEditBodySchema = RoundCreateBodySchema.extend({ roundId: z.string().uuid() }).strict();
```

`{ offset: true }` is not decoration: bare `.datetime()` accepts **only** a `Z` suffix and rejects `2026-09-01T00:00:00+02:00` with the same `invalid_request` a malformed string gets — which looks fine in the web form (`toISOString()` is always `Z`) and fails only for the admin using `curl` from a non-UTC machine.

Status is derived, never stored:

```ts
function roundStatus(row: { startsAt: Date | null; endsAt: Date | null; finalizedAt: Date | null }, now: Date): string {
  if (row.finalizedAt !== null) return "finalized";
  if (row.startsAt === null || row.startsAt > now) return "scheduled";
  if (row.endsAt !== null && row.endsAt <= now) return "ended";
  return "active";
}
```

Each handler opens with the four-line inline block (deliberate house style — a helper hiding `reply.code(403)` behind a return value reads worse than the repetition):

```ts
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(db, playerId);
    if (!hasPermission(grants, "rounds")) return reply.code(403).send({ error: "forbidden" });
```

- `GET /api/admin/rounds` → `200 { rounds: [{ id, name, startsAt, endsAt, finalizedAt, status }] }`, ordered `starts_at ASC NULLS LAST`. Timestamps as ISO strings or null.
- `GET /api/admin/rounds/table` → `200 { rows }` where **every value is a string** — `TableRowsResponseSchema` is `z.object({ rows: z.array(z.record(z.string())) }).strict()`. Render each column: `id` and `name` pass through, `row.startsAt?.toISOString() ?? ""`, `row.endsAt?.toISOString() ?? ""`, and the derived `status`. Never spread the drizzle row: it fails the parse **client-side**, inside `PageRenderer`, where it looks like a rendering bug.
- `POST /api/admin/rounds` → `201 { id }` (uuidv7).
- `POST /api/admin/rounds/edit` → `204`.

Both write routes open `db.transaction` whose **first statement** is the advisory lock — on its own, "SELECT for an overlap, then INSERT" is a textbook check-then-act with no unique index to fall back on, because an overlap is a predicate over two rows:

```ts
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7461002)`);
      // ... invalid_window check, overlap check, then the INSERT / UPDATE
    });
```

Sharing finalize's constant is deliberate: an admin write and a rollover can then never interleave, so an edit cannot move `ends_at` out from under a finalize that has already frozen `final_*` against it.

The overlap check (half-open intervals, `COALESCE(ends_at, 'infinity')` so an open-ended round conflicts with everything after its start; `starts_at IS NULL` rows excluded since they can never be active; finalized rows excluded since a settled round is history; and on edit, the row being edited excluded):

```ts
      const [clash] = await tx.select({ id: rounds.id }).from(rounds)
        .where(sql`${rounds.finalizedAt} is null
                   and ${rounds.startsAt} is not null
                   and ${rounds.startsAt} < ${endsAt}
                   and ${startsAt} < coalesce(${rounds.endsAt}, 'infinity'::timestamptz)
                   ${excludeId === undefined ? sql`` : sql`and ${rounds.id} <> ${excludeId}`}`)
        .limit(1);
      if (clash) return reply.code(400).send({ error: "round_overlap" });
```

`invalid_window` is the separate, simpler check that `endsAt > startsAt` on the submitted row. The edit route loads the target first: missing → `404 round_not_found`; `finalized_at IS NOT NULL` → `400 round_finalized` for **any** field including the name.

The two `GET` routes read **without** the lock, like every other admin listing.

- [ ] **Step 6: Update `admin-ids-hidden.test.ts`**

Its `sections` array (lines 36-41) is built from `CORE_PLUGINS[].adminPages` **plus one hand-written entry for `rolesPage`** — a second core admin page is not discovered automatically. Add beside the roles entry:

```ts
  { label: `core:${roundsPage.id}`, view: roundsPage.view },
```

and raise the walker guard at line 46 from `toBeGreaterThanOrEqual(7)` to `toBeGreaterThanOrEqual(11)`. **11, not 8** — nine plugins declare `adminPages` today, so with `roles` the array already holds 10 against a floor of 7; adding rounds makes 11. Setting it to 8 would leave it slacker than reality. If the count on the branch is not 11, use the actual count — the rule is "floor equals reality".

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run typecheck
npx vitest run apps/server/test/admin-rounds.test.ts apps/server/test/admin-ids-hidden.test.ts apps/server/test/plugin-validate.test.ts
```

Expected: typecheck exit 0; all three PASS.

- [ ] **Step 8: Show the concurrency case red**

Delete the `SELECT pg_advisory_xact_lock(7461002)` line from **`POST /api/admin/rounds`** only, re-run `admin-rounds.test.ts`, and observe case 8 fail with two 201s and `count(*) = 2`. Restore, re-run, observe green. Paste both outputs.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/admin/rounds-page.ts apps/server/src/admin/routes.ts \
        apps/server/src/plugins/validate.ts apps/server/test/admin-rounds.test.ts \
        apps/server/test/admin-ids-hidden.test.ts vitest.workspace.ts
git commit -m "feat(rounds): admin scheduling with write-time overlap rejection"
```

---

### Task 12: Web — the Rounds page and the Leaderboards scope toggle

**Spec:** §4.3, §5.2 (`apps/web/test/rounds-page.test.ts`).

**Files:**
- Create: `apps/web/src/pages/Rounds.tsx`, `apps/web/test/rounds-page.test.ts`
- Modify: `apps/web/src/api/queries.ts`, `apps/web/src/App.tsx`, `apps/web/src/components/Shell.tsx`, `apps/web/src/pages/Leaderboards.tsx`

**Interfaces:**
- Consumes: `RoundListResponseSchema`, `RoundStandingsResponseSchema` (Task 10); `keys.rounds`, `keys.roundStandings`, `keys.leaderboards` (Task 4).
- Produces:
  ```ts
  // apps/web/src/api/queries.ts
  export function useRounds(): UseQueryResult<RoundListResponse>
  export function useRoundStandings(roundId: string, kind: LeaderboardKind): UseQueryResult<RoundStandingsResponse>
  export function useLeaderboard(kind: LeaderboardKind, scope: "round" | "all"): UseQueryResult<LeaderboardResponse>
  // apps/web/src/pages/Rounds.tsx
  export function Rounds(): JSX.Element
  export function formatCountdown(secondsRemaining: number | null): string
  export function hallOfFameOrder(rounds: RoundDto[]): RoundDto[]
  ```

> **`keys.leaderboard` and `useLeaderboard` are both arity changes, so enumerate the callers rather than assuming.** There are exactly three lines: `keys.leaderboard` is called once (`apps/web/src/api/queries.ts:115`, inside `useLeaderboard`), `useLeaderboard` is declared once (`queries.ts:113`) and called once (`apps/web/src/pages/Leaderboards.tsx:15`). `apps/web/src/ws/invalidation.ts` does **not** reference the leaderboard key today, which is why Task 4 introduced `keys.leaderboards()` there rather than editing an existing entry. Each of the three is a compile error if missed.

- [ ] **Step 1: Write the failing test**

`@gl3/web` has no jsdom and renders no components — everything there is a pure function of its arguments. Create `apps/web/test/rounds-page.test.ts` in the shape `apps/web/test/properties-page.test.ts` uses, testing the helpers exported from `Rounds.tsx`:

```ts
import { describe, expect, it } from "vitest";
import { formatCountdown, hallOfFameOrder } from "../src/pages/Rounds.js";
import { keys } from "../src/api/keys.js";

describe("formatCountdown", () => {
  it("renders an ended round as ended, never as a negative duration", () => {
    expect(formatCountdown(0)).toBe("ended");
  });
  it("renders seconds", () => { expect(formatCountdown(45)).toBe("45s"); });
  it("renders days", () => { expect(formatCountdown(3 * 86_400 + 3_600)).toBe("3d 1h"); });
  it("renders an open-ended round as no end date", () => { expect(formatCountdown(null)).toBe("no end date"); });
});

describe("query keys", () => {
  it("keeps the round board and the all-time board in separate cache entries", () => {
    expect(keys.leaderboard("cash", "round")).not.toEqual(keys.leaderboard("cash", "all"));
    expect(keys.roundStandings("r1", "cash")).not.toEqual(keys.leaderboard("cash", "round"));
  });
  it("nests standings under the rounds prefix so one invalidation covers every board", () => {
    expect(keys.roundStandings("r1", "cash").slice(0, 1)).toEqual([...keys.rounds()]);
  });
});

describe("hallOfFameOrder", () => {
  it("orders finished rounds newest first with open-ended rounds last", () => {
    // ... construct three RoundDto literals and assert the order
  });
});
```

Adjust the exact `formatCountdown` output strings to whatever the implementation renders — but keep the three properties: an ended round never renders as a negative duration, a null `secondsRemaining` renders as an open-ended label, and days and seconds are both covered.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project @gl3/web apps/web/test/rounds-page.test.ts
```

Expected: FAIL — `../src/pages/Rounds.js` does not exist and `keys.leaderboard` still takes one argument.

- [ ] **Step 3: Update the query key and hooks**

In `apps/web/src/api/keys.ts`:

```ts
  leaderboard: (kind: LeaderboardKind, scope: "round" | "all") => ["leaderboard", kind, scope] as const,
```

In `apps/web/src/api/queries.ts`:

```ts
export function useLeaderboard(kind: LeaderboardKind, scope: "round" | "all") {
  return useQuery<LeaderboardResponse>({
    queryKey: keys.leaderboard(kind, scope),
    queryFn: async () => LeaderboardResponseSchema.parse(await api(`/api/leaderboard/${kind}?scope=${scope}`)),
  });
}

export function useRounds() {
  return useQuery<RoundListResponse>({
    queryKey: keys.rounds(),
    queryFn: async () => RoundListResponseSchema.parse(await api("/api/rounds")),
  });
}

export function useRoundStandings(roundId: string, kind: LeaderboardKind) {
  return useQuery<RoundStandingsResponse>({
    queryKey: keys.roundStandings(roundId, kind),
    queryFn: async () =>
      RoundStandingsResponseSchema.parse(await api(`/api/rounds/${roundId}/standings?kind=${kind}`)),
  });
}
```

- [ ] **Step 4: Write the Rounds page**

Create `apps/web/src/pages/Rounds.tsx`, hand-written like `Properties.tsx`. Content:

- the active round: name, window, and a countdown driven by `secondsRemaining` ticking locally;
- the three round boards for the active round (cash / bank / exp), selected with the same `styles.tabs` / `styles.tabActive` pattern `Leaderboards.tsx` uses;
- the hall of fame: every finalized round from `finished`, each expandable to its frozen standings;
- no round → a single line saying no season is running, and no boards.

Use `formatMoney` for cash/bank deltas and `formatAmount` for exp deltas — an exp figure rendered with a `$` is the mistake to guard against. Negative deltas need no special handling: `formatAmount` already passes a leading minus through (`apps/web/src/lib/money.ts:28-37`). **Do not clamp negatives to zero anywhere.**

Export `formatCountdown` and `hallOfFameOrder` so the test can reach them without a renderer.

- [ ] **Step 5: Route, nav and the scope toggle**

- `apps/web/src/App.tsx`: `<Route path="rounds" element={<Rounds />} />`, beside `leaderboards`.
- `apps/web/src/components/Shell.tsx`: `["/rounds", "Rounds"],` beside `["/leaderboards", "Leaderboards"]`.
- `apps/web/src/pages/Leaderboards.tsx`: keep the kind tabs exactly as they are; add a second row of two buttons selecting `scope: "round" | "all"`, defaulting to `"all"`, and change line 15 to `const board = useLeaderboard(kind, scope);`. When `scope === "round"` and the board is empty, say so explicitly ("no season is running") rather than rendering an empty table — an empty table and a table that has not loaded look identical.

The toggle exists so the two numbers are never mistaken for each other: a round board showing 4,000 and an all-time board showing 900,000 for the same player are both correct, and without a visible label the smaller one reads as a bug.

- [ ] **Step 6: Run the web suite and typecheck**

```bash
npm run typecheck
npx vitest run --project @gl3/web
```

Expected: typecheck exit 0; the whole `@gl3/web` project PASSES.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/Rounds.tsx apps/web/test/rounds-page.test.ts apps/web/src/api/keys.ts \
        apps/web/src/api/queries.ts apps/web/src/App.tsx apps/web/src/components/Shell.tsx \
        apps/web/src/pages/Leaderboards.tsx
git commit -m "feat(rounds): rounds page and the leaderboard scope toggle"
```

---

### Task 13: Version bump, republish, and whole-tree verification

**Spec:** §4.4 ("`@gl3/shared` version bump"), §5.1, §5.6.

**Files:**
- Modify: `packages/shared/package.json:3`

**Interfaces:**
- Consumes: everything above.
- Produces: `@gl3/shared@0.1.4` on `npm.gl3.dev`.

- [ ] **Step 1: Bump the version**

In `packages/shared/package.json`, `"version": "0.1.3"` → `"version": "0.1.4"`.

This change widens the public surface **additively** — two `GameEvent` variants and the new `dto/rounds.ts` exports — so it is a **patch**. Under `0.x`, `^0.1.0` resolves `>=0.1.0 <0.2.0`, so every existing consumer range keeps working; a minor bump (`0.2.0`) would break all of them.

`packages/plugin-sdk` stays at **`0.1.0`** and is **not** republished: its `CoreEventInput` is *derived* from `GameEvent` (`packages/plugin-sdk/src/ctx.ts:104-112`), so the new variants reach `publishCore` through the SDK's own `@gl3/shared` dependency with no SDK edit — the same reasoning that let `player.discharged` ship as `@gl3/shared@0.1.1` alone.

- [ ] **Step 2: Run the exact command the image build runs**

```bash
npx tsc --build --force apps/server/tsconfig.json
```

Expected: exit 0. This is the only local check for a missing `apps/server/tsconfig.json` project reference — the root tsconfig makes `npm run typecheck` pass regardless.

- [ ] **Step 3: Run the whole suite, bare**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify
```

Expected: **exit 0**. Read the exit code, not the summary line — an unhandled rejection makes vitest exit non-zero while still printing every test passed. Do **not** append `; echo "exit=$?"`. No other suite may be running on this box.

- [ ] **Step 4: Prove every new file actually runs**

```bash
for f in rounds-settings rounds-standings rounds-finalize rounds-snapshot rounds-ledger \
         rounds-rollover rounds-lock-order rounds-routes admin-rounds; do
  npx vitest run "apps/server/test/$f.test.ts" || echo "MISSING WORKSPACE ENTRY: $f"
done
```

Each must find and run its file. An exit 1 with "No test files found" means the `vitest.workspace.ts` entry is missing — the failure mode that leaves `npm run verify` green with the file never executing.

- [ ] **Step 5: Publish `@gl3/shared@0.1.4`**

```bash
npm publish -w @gl3/shared --registry https://npm.gl3.dev
```

`files` in the manifest is load-bearing: `dist/` is gitignored, and publishing without it ships a package with no build output. Build first if the publish is not wired to a prepublish step. The publish must land **before** any out-of-repo plugin can call `publishCore` with `round.started` or `round.finished`.

- [ ] **Step 6: Walk the §5.6 acceptance checklist**

Open the spec at §5.6 and tick each box against the tree. Every one is observable; none is a judgement call. In particular confirm: the red-then-green outputs for `rounds-rollover.test.ts` and the admin concurrency case are in the PR body; `CORPUS` passes at 25; `admin-ids-hidden.test.ts`'s floor reads 11; no plugin-owned table was created, dropped, altered or written, and the count stays **seven of sixteen**.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/package.json
git commit -m "chore(shared): release 0.1.4 with the rounds DTOs and events"
```

---

## Self-Review

**Spec coverage.** §1.5.1/1.5.2/1.5.3 → Task 1. §1.6/1.7 → Tasks 1 and 3 (the hall of fame *is* `round_entries`; no winners table). §1.8 → Global Constraints (rounds are core; no relinquish migration). §2.1 → the architecture line (lazy-at-read, no cron). §2.2/2.2a/2.3/2.4/2.6/2.7 → Task 5, with §2.7's regression test in Task 9 and §2.4's proof in Task 8. §2.5 → Task 6. §3.1 → Task 10 (ZSETs stay all-time; `recordScore`/`rebuildLeaderboards`/`topN` unmodified, pinned by the `leaderboard.test.ts` edit). §3.2/3.4/3.5 → Task 3. §3.3 → Task 10, **with the user's correction applied**. §3.6 → Tasks 2 (parser) and 5 (call shape, notifications, no `jobId`, no Redis). §4.1 → Task 10. §4.2 → Task 11. §4.3 → Tasks 11 (`roundsPage`) and 12 (web). §4.4 → Task 4, plus the version bump in Task 13. §5.1 → a Global Constraint and every task's workspace step. §5.2 → Tasks 1, 3, 5, 6, 7, 8, 9, 10, 11, 12 — nine files plus the sanctioned tenth (`rounds-settings`), and `rounds-absent.test.ts` deliberately absent. §5.3 → Task 4 (items 1-2), Task 11 (item 3), Task 10 (item 4). §5.4 → nothing to build (no plugin hook, no ZSET delta, no perf test). §5.5 → risk 1 accepted and documented in Task 5's comments, risk 2 in the probe's ordering, risk 3 proved by `rounds-snapshot` cases 3-4 and `rounds-routes` case 8. §5.6 → Task 13 step 6.

**Placeholder scan.** Two steps intentionally describe shape rather than paste finished code: Task 9's barrier (it must be copied from `properties-lock-order.test.ts`'s live mechanism, and a fabricated `pg_stat_activity` predicate here would be worse than a pointer to the working one) and Task 7's route-driving steps (the bank and crimes route paths must be read off the plugin manifests, not guessed from this document). Both name the exact file to copy from, the exact assertions, and the exact failure to demonstrate. Everywhere else the code is complete.

**Type consistency.** `roundStandings(exec, roundId, kind, n, finalized, minDelta?)` is declared in Task 3 and called with exactly that shape in Tasks 5 (`(tx, round.id, "exp", awards.length, true, 0n)`) and 10 (`(db, id, kind, 10, finalized)`). `ensureCurrentRound(db, redis, settings)` is declared in Task 5 and called with three arguments at all four sites (Tasks 8, 10 ×3). `payoutPoints(settings)` returns `bigint[]`, consumed as `awards[i]!` (a `bigint`) by `applyBalanceChange`'s `amount`. `ActiveRound` carries `{ id, name, startsAt, endsAt }` and Task 10 re-reads the row for `finalizedAt` rather than inventing a field on it. `keys.leaderboard(kind, scope)` is two-argument in Tasks 4 and 12 consistently; `keys.leaderboards()` (plural, no args) is the invalidation prefix in both. Event field names (`roundId`, `roundName`, `endsAt`, `winners[].placing`, `winners[].points`) match between the schema (Task 4), the publisher (Task 5), the copy (Task 4) and the `CORPUS` entries (Task 4).
