# Sentence Sweeper (jail + hospital release over WebSocket) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server the actor that ends jail and hospital sentences, so the browser learns about release over the existing WebSocket instead of polling `GET /api/jail` and `GET /api/hospital` every 2 seconds.

**Architecture:** A single in-process sweeper ticks on an interval, selects `player_stats` rows whose `jailed_until` / `hospital_until` have elapsed, and settles each one in its own short transaction. The settle statement's `WHERE ... IS NOT NULL` clause *is* the atomic claim, so two server instances (or two overlapping ticks) can race freely and the release event still fires exactly once — the same trick `releaseIfExpired` already uses. The existing lazy-on-read path stays exactly where it is: correctness must not depend on a background process being alive, so the sweeper is a latency optimisation, not the mechanism of record.

**Tech Stack:** TypeScript (strict, ESM), Fastify, drizzle-orm 0.45 / drizzle-kit 0.31, Postgres 16, Redis pub/sub, zod, React + TanStack Query, vitest.

**Spec:** This document, §Background. There is no separate spec file — the design was settled in conversation and is recorded below in full. `SPEC.md` §2.2 (events) and `CLAUDE.md` rules 1–6 are the standing constraints.

---

## Background (the spec this plan argues from)

### Why the 2-second poll exists today

Nothing in GL3 frees a player on a timer. `GET /api/jail` calls
`releaseIfExpired` (`apps/server/src/game/jail/status.ts:39`), which is the
only place an elapsed `jailed_until` is cleared. Hospital is the same shape:
`settleHospital` (`apps/server/src/game/hospital/status.ts:65`) is the only
place an elapsed `hospital_until` is cleared, and it restores health at the
same time. **Asking is what ends a sentence.** The client therefore polls:

- `apps/web/src/api/queries.ts:73` — `useJail`, `refetchInterval` 2s *while jailed*.
- `apps/web/src/api/queries.ts:541` — `useHospital`, `refetchInterval` 2s **unconditionally**, which is a plain bug: a healthy player sitting on `/hospital` hits the server every 2 seconds for nothing.

The WebSocket cannot help *as the code stands* because it is push-from-actor
and time passing has no actor. But the server can be that actor. The
`player.released` event already exists (`packages/shared/src/events.ts:30`)
and is already published by `releaseIfExpired` — the only missing piece is
something server-side that notices expiry.

### Two candidate designs, and why the sweep won

**A. One delayed BullMQ job per sentence.** Exact timing, zero idle work.
Rejected because: `sendToJail`/`sendToHospital` take `tx` and are plugin-facing
as `tx.jail.sendToJail` / `tx.hospital.sendToHospital`, so enqueue-after-commit
would be an SDK surface change; re-jailing or pardoning leaves orphan jobs
needing jobId dedup; and rows created outside that path (the M4 V2 import)
would get no job at all.

**B. A sweep tick (chosen).** One indexed `SELECT` per tick, then one small
transaction per expired row. `UPDATE ... WHERE hospital_until IS NOT NULL
RETURNING` is the atomic claim, so multi-instance safety and CLAUDE.md rule 1
(at-least-once idempotency) come free from the statement rather than from a
bookkeeping table. No tx plumbing, no SDK change, no orphan jobs, and it
catches rows from any origin.

### Why the sweeper settles one player per transaction

CLAUDE.md rule 6. A bulk `UPDATE ... WHERE hospital_until <= now()` takes row
locks in *scan order*, which is not sorted order, and would deadlock (40P01)
against combat's `lockPlayersForUpdate`, which sorts ascending. Holding exactly
one player lock at a time cannot deadlock against anything, because a deadlock
needs a cycle and a single-lock holder has no outgoing edge. The candidate
`SELECT` is deliberately lock-free; two sweepers picking the same row is fine
because the claim is the `UPDATE`, not the `SELECT`.

### Why the lazy path stays

If the sweeper process dies, or a deploy restarts it, or someone runs the
server without it, players must still get out of jail. `releaseIfExpired` on
the gated routes becomes belt-and-braces instead of the mechanism. For the
same reason the client keeps a *slow* safety poll (30s) rather than dropping
polling entirely: a client whose socket is mid-reconnect would otherwise sit
on a stale "jailed" screen indefinitely. 2s → 30s is a 15× reduction and
survives socket loss.

### Scope note: hospital needs a new core event

`settleHospital` publishes nothing today, and its own doc comment says why:
`GameEventSchema` has `player.released` for jail but no hospital equivalent.
This plan adds `player.discharged`. That is an additive change to the core
event union, which `CoreEventInput` in the SDK derives from — so plugins gain
the ability to publish it too. That is consistent with `publishCore` being
unrestricted by design (CLAUDE.md, design §5).

## Global Constraints

- TypeScript strict. **No `any` in `packages/*`** — none, not even a cast. In `apps/*` prefer `unknown` plus a zod parse, and type guards over casts.
- ESM only; relative imports carry a `.js` extension despite `.ts` sources.
- Money is `bigint` in Postgres and TypeScript; bigint column defaults are written `` .default(sql`0`) ``, never `.default(0n)`.
- Integration tests run against **real** Postgres and Redis. No mocks for DB, queue or bus paths, ever.
- Tests asserting on `game:events` **must** filter by their own `actorId` via `awaitOwnEvent()` from `test/helpers/events.ts` (CLAUDE.md rule 4).
- Publish events only **after** the transaction commits (CLAUDE.md rule 5).
- A foreign key is a lock; every player↔player path goes through `lockPlayersForUpdate` (CLAUDE.md rule 6).
- Conventional Commits.
- Verification command, run **locally**, reading the exit code and not the summary:
  ```bash
  export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
  export REDIS_URL=redis://localhost:6379
  npm run verify
  ```
  Never run two full suites at once. Never run `FLUSHALL`/`FLUSHDB`.
- Baseline before this plan: **142 files / 1052 tests**, `npm run verify` exit 0.

---

## File Structure

**Created:**
- `apps/server/src/game/sweep/sweeper.ts` — the whole feature's server side: `sweepExpiredSentences` (one pass, pure of timers, fully testable) and `startSentenceSweeper` (the thin timer wrapper). One file because the pass and its scheduler change together and neither is meaningful alone.
- `apps/server/drizzle/0008_sentence_expiry_indexes.sql` (+ its `meta/` snapshot) — generated.
- `apps/server/test/sentence-sweeper.test.ts` — sweep behaviour, idempotency, concurrent-claim.
- `apps/server/test/sentence-sweeper-lock-order.test.ts` — rule 6 regression: sweeper vs combat.
- `apps/server/test/sentence-sweeper-loop.test.ts` — the timer wrapper: overlap guard, error containment, stop().

**Modified:**
- `packages/shared/src/events.ts` — add the `player.discharged` variant.
- `apps/server/src/db/schema/identity.ts:76-80` — two partial indexes.
- `apps/server/src/game/jail/status.ts` — `releaseIfExpiredWithOutcome`; `releaseIfExpired` becomes a wrapper.
- `apps/server/src/game/hospital/status.ts` — `settleHospitalTx` reports the claim; new `dischargeIfExpired` publishes `player.discharged`.
- `apps/server/src/config.ts` — `SWEEP_INTERVAL_MS`.
- `apps/server/src/index.ts` — start the sweeper (production boot only, never `buildApp`, so the test server never runs one).
- `apps/web/src/ws/invalidation.ts` — `player.discharged` case; `keys.hospital()` added to `player.attacked`.
- `apps/web/src/lib/eventCopy.ts` — `player.discharged` copy.
- `apps/web/src/api/queries.ts` — exported refetch-interval predicates, 2s → 30s, hospital poll made conditional.
- `apps/web/src/pages/Jail.tsx`, `apps/web/src/pages/Hospital.tsx` — comments and on-screen copy that currently promise a 2-second poll.
- `apps/web/test/invalidation.test.ts`, `apps/web/test/event-copy.test.ts` — new cases.
- New `apps/web/test/refetch-intervals.test.ts`.
- `CLAUDE.md`, `docs/STATUS.md`, `docs/ENGINEERING-NOTES.md`.

---

### Task 1: Partial indexes on the expiry columns

The sweeper runs a `SELECT` every couple of seconds forever. Without these it
is a sequential scan of `player_stats` on every tick. Partial (`WHERE ... IS
NOT NULL`) because the overwhelming majority of rows have both columns null,
and a partial index over the tiny live set stays in cache.

**Files:**
- Modify: `apps/server/src/db/schema/identity.ts:76-80`
- Create: `apps/server/drizzle/0008_sentence_expiry_indexes.sql` (generated)
- Test: `apps/server/test/sentence-sweeper.test.ts` (created here, extended in Task 4)

**Interfaces:**
- Consumes: nothing.
- Produces: indexes `player_stats_jailed_until_idx` and `player_stats_hospital_until_idx`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/sentence-sweeper.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
afterAll(async () => { await conn.end(); });

describe("sentence expiry indexes", () => {
  it("indexes both expiry columns partially, so the sweep never seq-scans", async () => {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'player_stats'
        AND indexname IN ('player_stats_jailed_until_idx', 'player_stats_hospital_until_idx')
      ORDER BY indexname
    `);
    const found = [...rows].map((r) => r.indexname);
    expect(found).toEqual(["player_stats_hospital_until_idx", "player_stats_jailed_until_idx"]);
    // Partial, not full: the WHERE clause is the whole point.
    for (const row of rows) expect(row.indexdef.toLowerCase()).toContain("where");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npx vitest run apps/server/test/sentence-sweeper.test.ts
```

Expected: FAIL — `expect(found).toEqual([...])` receives `[]`.

- [ ] **Step 3: Add the indexes to the schema**

In `apps/server/src/db/schema/identity.ts`, the `playerStats` table's index
block currently ends with `locationIdx`. Add two entries after it:

```ts
  locationIdx: index("player_stats_location_idx").on(t.locationId),
  // The sentence sweeper selects on these every tick. Partial because almost
  // every row has both columns null — the index only ever holds live sentences.
  jailedUntilIdx: index("player_stats_jailed_until_idx")
    .on(t.jailedUntil).where(sql`${t.jailedUntil} is not null`),
  hospitalUntilIdx: index("player_stats_hospital_until_idx")
    .on(t.hospitalUntil).where(sql`${t.hospitalUntil} is not null`),
```

`sql` must be imported from `drizzle-orm` at the top of the file if it is not
already there.

- [ ] **Step 4: Generate the migration**

```bash
cd /home/dlite/GL3/apps/server && npx drizzle-kit generate
```

Read the generated `drizzle/0008_*.sql`. It must contain two
`CREATE INDEX ... WHERE ...` statements and **nothing else** — no table
rewrites, no column changes. Rename the file to
`0008_sentence_expiry_indexes.sql` only if drizzle-kit named it something
else *and* you also update `drizzle/meta/_journal.json` to match; if in doubt
keep the generated name.

If drizzle-kit emits the indexes without their `WHERE` clause (partial-index
serialisation has been version-sensitive in this repo's toolchain — see
CLAUDE.md on `BigInt` defaults for the same class of problem), hand-write the
SQL file instead:

```sql
CREATE INDEX "player_stats_jailed_until_idx" ON "player_stats" USING btree ("jailed_until") WHERE "jailed_until" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "player_stats_hospital_until_idx" ON "player_stats" USING btree ("hospital_until") WHERE "hospital_until" IS NOT NULL;
```

and leave the generated snapshot/journal entries in place.

- [ ] **Step 5: Run the test to verify it passes**

The template database every test file clones is rebuilt from core migrations
by `test/helpers/global-setup.ts`, so the new migration applies automatically.

```bash
npx vitest run apps/server/test/sentence-sweeper.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/schema/identity.ts apps/server/drizzle apps/server/test/sentence-sweeper.test.ts
git commit -m "perf(db): index jailed_until and hospital_until partially for the sweeper"
```

---

### Task 2: The `player.discharged` core event

Hospital release has no event today. Adding one is what lets the client stop
polling. The union is exhaustively switched in two places in the web app, so
TypeScript will point at both.

**Files:**
- Modify: `packages/shared/src/events.ts:30` (insert after `player.released`)
- Modify: `apps/web/src/ws/invalidation.ts:32-33` and `:47-49`
- Modify: `apps/web/src/lib/eventCopy.ts:31-32`
- Test: `apps/web/test/invalidation.test.ts`, `apps/web/test/event-copy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GameEvent` variant `{ type: "player.discharged" }` with only the shared base fields (`id`, `at`, `actorId`, `actorName`, `audience`). No payload: `keys.me()` invalidation refetches the restored health anyway, and every field added to a core event is a field every plugin can now emit.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/invalidation.test.ts` (inside its existing top-level
`describe`, matching the file's existing style for building an event — reuse
whatever local helper it already has; if it constructs literals inline, do the
same):

```ts
  it("player.discharged refreshes the hospital page and the wallet", () => {
    const event: GameEvent = {
      id: "01920000-0000-7000-8000-000000000001",
      type: "player.discharged",
      at: "2026-08-14T00:00:00.000Z",
      actorId: "01920000-0000-7000-8000-0000000000aa",
      actorName: "tester",
      audience: { kind: "player", playerId: "01920000-0000-7000-8000-0000000000aa" },
    };
    expect(invalidationKeys(event, "01920000-0000-7000-8000-0000000000aa")).toEqual([
      keys.hospital(), keys.me(),
    ]);
  });

  it("player.attacked also refreshes hospital, because combat can discharge a target silently", () => {
    const event: GameEvent = {
      id: "01920000-0000-7000-8000-000000000002",
      type: "player.attacked",
      at: "2026-08-14T00:00:00.000Z",
      actorId: "01920000-0000-7000-8000-0000000000aa",
      actorName: "tester",
      audience: { kind: "player", playerId: "01920000-0000-7000-8000-0000000000aa" },
      targetId: "01920000-0000-7000-8000-0000000000bb",
      targetName: "victim",
      damage: 5,
    };
    expect(invalidationKeys(event, "01920000-0000-7000-8000-0000000000aa")).toContainEqual(keys.hospital());
  });
```

Append to `apps/web/test/event-copy.test.ts`, matching that file's existing
construction style:

```ts
  it("describes a hospital discharge", () => {
    expect(describeEvent({
      id: "01920000-0000-7000-8000-000000000003",
      type: "player.discharged",
      at: "2026-08-14T00:00:00.000Z",
      actorId: "01920000-0000-7000-8000-0000000000aa",
      actorName: "tester",
      audience: { kind: "player", playerId: "01920000-0000-7000-8000-0000000000aa" },
    })).toBe("Discharged from hospital");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run --project @gl3/web apps/web/test/invalidation.test.ts apps/web/test/event-copy.test.ts
```

Expected: FAIL — the `player.discharged` literal is not assignable to
`GameEvent`, and the `player.attacked` assertion fails because
`keys.hospital()` is not in its list.

- [ ] **Step 3: Add the event variant**

In `packages/shared/src/events.ts`, directly after the `player.released` line:

```ts
  z.object({ ...base, type: z.literal("player.released") }),
  // actor = the discharged player. The hospital counterpart of
  // player.released: published by the sentence sweeper (and by
  // dischargeIfExpired on the lazy path) when an elapsed hospital_until is
  // cleared. No payload — the client's keys.me() refetch carries the
  // restored health, and every field here is a field every plugin can emit.
  z.object({ ...base, type: z.literal("player.discharged") }),
```

- [ ] **Step 4: Handle it in both exhaustive switches**

`apps/web/src/ws/invalidation.ts` — add a case, and extend `player.attacked`:

```ts
    case "player.discharged":
      // The sentence ended and health came back; /hospital is the whole page
      // for the discharged player and health lives on /api/auth/me.
      return [keys.hospital(), keys.me()];
```

```ts
    case "player.attacked":
      // Bullets moved and the target's health did, so the list a player is
      // looking at is stale; the log gains a row for both parties. Hospital is
      // in here because combat settles an elapsed sentence for both
      // participants itself (combat's own settleHospitalIfElapsed), which
      // publishes nothing — so this is the only signal the target gets when
      // an attack beats the sweeper to their discharge.
      return [keys.me(), keys.combatTargets(), keys.combatLog(), keys.hospital()];
```

`apps/web/src/lib/eventCopy.ts` — add a case after `player.released`:

```ts
    case "player.discharged":
      return "Discharged from hospital";
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run --project @gl3/web apps/web/test/invalidation.test.ts apps/web/test/event-copy.test.ts
npm run typecheck
```

Expected: PASS, and typecheck clean — if any other exhaustive switch over
`GameEvent["type"]` exists anywhere, typecheck is what finds it. Fix any it
reports before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/events.ts apps/web/src/ws/invalidation.ts apps/web/src/lib/eventCopy.ts apps/web/test
git commit -m "feat(events): add player.discharged, the hospital counterpart of player.released"
```

---

### Task 3: Release helpers that report whether *this* call did the release

The sweeper needs to know which rows it actually claimed, so it can publish
exactly once and so its tests can assert on a count. Jail already has the
claim logic but throws the answer away; hospital has the claim logic and
publishes nothing at all. Both get a variant that reports the outcome, with
the existing exported signatures left untouched so no caller changes.

**Files:**
- Modify: `apps/server/src/game/jail/status.ts:39-68`
- Modify: `apps/server/src/game/hospital/status.ts:65-79`
- Test: `apps/server/test/sentence-sweeper.test.ts` (extend)

**Interfaces:**
- Consumes: `player.discharged` from Task 2.
- Produces:
  - `releaseIfExpiredWithOutcome(db: Db, redis: Redis, playerId: string): Promise<{ status: JailStatus; released: boolean }>`
  - `releaseIfExpired(db: Db, redis: Redis, playerId: string): Promise<JailStatus>` — unchanged signature, now a wrapper.
  - `dischargeIfExpired(db: Db, redis: Redis, playerId: string): Promise<{ status: HospitalStatus; discharged: boolean }>` — opens its own transaction, takes the player lock, publishes after commit.
  - `settleHospital(tx: Tx, playerId: string): Promise<HospitalStatus>` — unchanged signature and behaviour (still publishes nothing; it runs inside a caller's transaction, and rule 5 forbids publishing there).

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/sentence-sweeper.test.ts`. Add the imports and the
per-file fixtures at the top of the file (the existing file from Task 1 only
has `testDb`):

```ts
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, playerStats, ranks } from "../src/db/schema/index.js";
import { dischargeIfExpired } from "../src/game/hospital/status.js";
import { releaseIfExpiredWithOutcome } from "../src/game/jail/status.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { awaitOwnEvent } from "./helpers/events.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

/** A player with a rank whose max health is 140, so a restore is visible. */
async function makePlayer(): Promise<string> {
  const id = uuidv7();
  // uuidv7's leading hex is a timestamp and collides across fast inserts —
  // slice the random tail, same as hospital-status.test.ts.
  await db.insert(players).values({ id, username: `sw-${id.slice(-8)}` });
  const rankId = uuidv7();
  // `0n` in an INSERT value, not sql`0` — the sql`` form is only needed for
  // bigint COLUMN DEFAULTS, which drizzle-kit's serialiser crashes on.
  await db.insert(ranks).values({
    id: rankId, name: `r-${rankId.slice(-8)}`, expRequired: 0n, maxHealth: 140,
  });
  await db.insert(playerStats).values({ playerId: id, health: 100, rankId });
  return id;
}
```

and the tests:

```ts
describe("release helpers report their own claim", () => {
  beforeEach(async () => {
    await resetDb(db);
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
  });

  it("releaseIfExpiredWithOutcome reports released=true exactly once", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    const event = awaitOwnEvent(subscriber, id);
    const first = await releaseIfExpiredWithOutcome(db, redis, id);
    expect(first.released).toBe(true);
    expect(first.status.jailed).toBe(false);
    expect((await event).type).toBe("player.released");

    const second = await releaseIfExpiredWithOutcome(db, redis, id);
    expect(second.released).toBe(false);
  });

  it("releaseIfExpiredWithOutcome reports released=false while the sentence runs", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, id));

    const outcome = await releaseIfExpiredWithOutcome(db, redis, id);
    expect(outcome.released).toBe(false);
    expect(outcome.status.jailed).toBe(true);
  });

  it("dischargeIfExpired restores health, publishes player.discharged, and claims once", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    const event = awaitOwnEvent(subscriber, id);
    const first = await dischargeIfExpired(db, redis, id);
    expect(first.discharged).toBe(true);
    expect((await event).type).toBe("player.discharged");

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(140);
    expect(row?.hospitalUntil).toBeNull();

    const second = await dischargeIfExpired(db, redis, id);
    expect(second.discharged).toBe(false);
  });

  it("dischargeIfExpired leaves a live sentence alone", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, id));

    const outcome = await dischargeIfExpired(db, redis, id);
    expect(outcome.discharged).toBe(false);
    expect(outcome.status.hospitalised).toBe(true);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run apps/server/test/sentence-sweeper.test.ts
```

Expected: FAIL — `releaseIfExpiredWithOutcome` and `dischargeIfExpired` are
not exported.

- [ ] **Step 3: Refactor jail**

In `apps/server/src/game/jail/status.ts`, replace the body of
`releaseIfExpired` (keeping its doc comment, which already explains why the
repeated `IS NOT NULL` is the arbiter) with a wrapper, and move the work into
the reporting variant:

```ts
/**
 * As `releaseIfExpired`, but also reports whether THIS call performed the
 * release. The sentence sweeper needs that answer: it publishes once per
 * genuine claim and counts claims in its tests. Every request path wants the
 * status only, and calls the wrapper below.
 */
export async function releaseIfExpiredWithOutcome(
  db: Db, redis: Redis, playerId: string,
): Promise<{ status: JailStatus; released: boolean }> {
  const [row] = await db.select({ jailedUntil: playerStats.jailedUntil, username: players.username })
    .from(playerStats)
    .innerJoin(players, eq(players.id, playerStats.playerId))
    .where(eq(playerStats.playerId, playerId));
  if (!row) return { status: FREE, released: false };

  const status = statusFrom(row.jailedUntil);
  if (status.jailed) return { status, released: false }; // still serving time
  if (row.jailedUntil === null) return { status: FREE, released: false };

  const cleared = await db.update(playerStats)
    .set({ jailedUntil: null })
    .where(and(eq(playerStats.playerId, playerId), isNotNull(playerStats.jailedUntil)))
    .returning({ playerId: playerStats.playerId });

  if (cleared.length === 0) return { status: FREE, released: false };

  const event: GameEvent = {
    id: uuidv7(),
    type: "player.released",
    at: new Date().toISOString(),
    actorId: playerId,
    actorName: row.username,
    audience: { kind: "player", playerId },
  };
  await publishEvent(redis, event);
  return { status: FREE, released: true };
}
```

and keep the existing exported entry point, with its existing doc comment
above it, as:

```ts
export async function releaseIfExpired(db: Db, redis: Redis, playerId: string): Promise<JailStatus> {
  return (await releaseIfExpiredWithOutcome(db, redis, playerId)).status;
}
```

- [ ] **Step 4: Refactor hospital and add `dischargeIfExpired`**

In `apps/server/src/game/hospital/status.ts`, rename the current
`settleHospital` body to an internal reporting function and re-export the old
name as a wrapper. Keep the existing doc comment on `settleHospital` but drop
its "Publishes no event" paragraph's second sentence (the reason no longer
holds — the variant now exists) and replace it with the rule-5 reason:

```ts
/**
 * Reports whether THIS call cleared the sentence, which the caller needs to
 * decide whether to publish `player.discharged`. Publishing cannot happen in
 * here: this runs inside the caller's transaction and CLAUDE.md rule 5 says
 * events are facts, published only after commit.
 */
async function settleHospitalTx(
  tx: Tx, playerId: string,
): Promise<{ status: HospitalStatus; discharged: boolean }> {
  const [row] = await tx.select({ hospitalUntil: playerStats.hospitalUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  if (!row) return { status: FREE, discharged: false };

  const status = statusFrom(row.hospitalUntil);
  if (status.hospitalised) return { status, discharged: false }; // still admitted
  if (row.hospitalUntil === null) return { status: FREE, discharged: false };

  const maxHealth = await maxHealthFor(tx, playerId);
  const cleared = await tx.update(playerStats)
    .set({ hospitalUntil: null, health: maxHealth })
    .where(and(eq(playerStats.playerId, playerId), isNotNull(playerStats.hospitalUntil)))
    .returning({ playerId: playerStats.playerId });
  return { status: FREE, discharged: cleared.length > 0 };
}

export async function settleHospital(tx: Tx, playerId: string): Promise<HospitalStatus> {
  return (await settleHospitalTx(tx, playerId)).status;
}

/**
 * The db-level counterpart of jail's `releaseIfExpired`, and the hospital
 * entry point the sentence sweeper uses.
 *
 * Opens its own transaction and takes the player lock through
 * `lockPlayersForUpdate` — exactly one lock, held alone, which is what makes
 * the sweeper unable to deadlock against combat's two-player ordering
 * (CLAUDE.md rule 6: a deadlock needs a cycle, and a single-lock holder has
 * no outgoing edge).
 *
 * The event is published after commit (rule 5), and only when the UPDATE
 * matched — so two sweepers, or a sweeper racing a discharge request, publish
 * `player.discharged` exactly once between them.
 */
export async function dischargeIfExpired(
  db: Db, redis: Redis, playerId: string,
): Promise<{ status: HospitalStatus; discharged: boolean }> {
  const [row] = await db.select({ username: players.username })
    .from(players).where(eq(players.id, playerId));
  if (!row) return { status: FREE, discharged: false };

  const outcome = await db.transaction(async (tx) => {
    await lockPlayersForUpdate(tx, [playerId]);
    return settleHospitalTx(tx, playerId);
  });

  if (outcome.discharged) {
    const event: GameEvent = {
      id: uuidv7(),
      type: "player.discharged",
      at: new Date().toISOString(),
      actorId: playerId,
      actorName: row.username,
      audience: { kind: "player", playerId },
    };
    await publishEvent(redis, event);
  }
  return outcome;
}
```

The file's current imports are `{ and, eq, isNotNull }` from `drizzle-orm`,
`type { Db }`, `{ playerStats, ranks }` and `{ lockPlayersForUpdate, type Tx }`.
Add to them:

```ts
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
```

and widen the schema import to `{ players, playerStats, ranks }`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run apps/server/test/sentence-sweeper.test.ts apps/server/test/hospital-status.test.ts apps/server/test/jail.test.ts apps/server/test/hospital-concurrency.test.ts
```

Expected: PASS, including the pre-existing files — their call sites did not
change, which is the point of the wrappers.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/game/jail/status.ts apps/server/src/game/hospital/status.ts apps/server/test/sentence-sweeper.test.ts
git commit -m "feat(game): report release/discharge claims and publish player.discharged"
```

---

### Task 4: `sweepExpiredSentences` — one pass

The pass itself: no timers, no config, fully callable from a test. This is
where the "one player per transaction" rule from §Background lives.

**Files:**
- Create: `apps/server/src/game/sweep/sweeper.ts`
- Test: `apps/server/test/sentence-sweeper.test.ts` (extend)

**Interfaces:**
- Consumes: `releaseIfExpiredWithOutcome`, `dischargeIfExpired` from Task 3.
- Produces: `sweepExpiredSentences(db: Db, redis: Redis, limit?: number): Promise<SweepResult>` where `interface SweepResult { released: string[]; discharged: string[] }` — arrays of player ids this call actually claimed. Also exports `const SWEEP_BATCH_LIMIT = 500`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/sentence-sweeper.test.ts`, adding
`import { sweepExpiredSentences } from "../src/game/sweep/sweeper.js";` to the
imports:

```ts
describe("sweepExpiredSentences", () => {
  beforeEach(async () => {
    await resetDb(db);
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
  });

  it("releases an elapsed jail sentence and publishes player.released", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    const event = awaitOwnEvent(subscriber, id);
    const result = await sweepExpiredSentences(db, redis);

    expect(result.released).toContain(id);
    expect((await event).type).toBe("player.released");
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.jailedUntil).toBeNull();
  });

  it("discharges an elapsed hospital sentence, restoring rank max health", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    const event = awaitOwnEvent(subscriber, id);
    const result = await sweepExpiredSentences(db, redis);

    expect(result.discharged).toContain(id);
    expect((await event).type).toBe("player.discharged");
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.health).toBe(140);
    expect(row?.hospitalUntil).toBeNull();
  });

  it("leaves live sentences alone", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() + 60_000), hospitalUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, id));

    const result = await sweepExpiredSentences(db, redis);

    expect(result.released).toEqual([]);
    expect(result.discharged).toEqual([]);
  });

  it("is idempotent — a second pass claims nothing", async () => {
    const id = await makePlayer();
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() - 1000), health: 0, hospitalUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    const first = await sweepExpiredSentences(db, redis);
    expect(first.released).toEqual([id]);
    expect(first.discharged).toEqual([id]);

    const second = await sweepExpiredSentences(db, redis);
    expect(second.released).toEqual([]);
    expect(second.discharged).toEqual([]);
  });

  it("claims exactly once when two sweeps race, which is what makes a second instance safe", async () => {
    const ids = await Promise.all([makePlayer(), makePlayer(), makePlayer()]);
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() - 1000), health: 0, hospitalUntil: new Date(Date.now() - 1000) })
      .where(inArray(playerStats.playerId, ids));

    const [a, b] = await Promise.all([
      sweepExpiredSentences(db, redis),
      sweepExpiredSentences(db, redis),
    ]);

    // Every player released/discharged exactly once ACROSS both passes.
    expect([...a.released, ...b.released].sort()).toEqual([...ids].sort());
    expect([...a.discharged, ...b.discharged].sort()).toEqual([...ids].sort());
  });
});
```

Add `inArray` to the `drizzle-orm` import at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run apps/server/test/sentence-sweeper.test.ts
```

Expected: FAIL — cannot resolve `../src/game/sweep/sweeper.js`.

- [ ] **Step 3: Write the sweeper pass**

Create `apps/server/src/game/sweep/sweeper.ts`:

```ts
import { and, isNotNull, lte, or } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Db } from "../../db/client.js";
import { playerStats } from "../../db/schema/index.js";
import { dischargeIfExpired } from "../hospital/status.js";
import { releaseIfExpiredWithOutcome } from "../jail/status.js";

/**
 * How many expired rows one pass will settle. Bounds the work a single tick
 * can do so a backlog (a restart after downtime, or the M4 import landing a
 * pile of already-expired sentences) drains over several ticks instead of
 * holding one long pass open. Anything left over is picked up next tick.
 */
export const SWEEP_BATCH_LIMIT = 500;

export interface SweepResult {
  /** Player ids whose jail sentence THIS pass ended. */
  released: string[];
  /** Player ids whose hospital stay THIS pass ended. */
  discharged: string[];
}

/**
 * One pass of the sentence sweeper: find sentences whose deadline has passed
 * and end them.
 *
 * The candidate SELECT takes no locks on purpose. Two servers — or two
 * overlapping passes — will happily pick the same row; the claim is the
 * UPDATE inside `releaseIfExpiredWithOutcome` / `dischargeIfExpired`, whose
 * `WHERE ... IS NOT NULL` matches for exactly one of them. That is where
 * CLAUDE.md rule 1's at-least-once idempotency comes from here: from the
 * statement, not from a bookkeeping table.
 *
 * Rows are settled ONE AT A TIME, each in its own transaction holding exactly
 * one player lock. A bulk `UPDATE ... WHERE hospital_until <= now()` would
 * take its row locks in scan order, which is not sorted order, and could
 * deadlock against combat's ascending `lockPlayersForUpdate` (rule 6). A
 * holder of a single lock has no outgoing wait edge and so cannot be part of
 * a cycle.
 *
 * This is a latency optimisation, not the mechanism of record: the lazy path
 * on the gated routes still releases players if no sweeper is running at all.
 */
export async function sweepExpiredSentences(
  db: Db, redis: Redis, limit: number = SWEEP_BATCH_LIMIT,
): Promise<SweepResult> {
  const now = new Date();
  const candidates = await db.select({
    playerId: playerStats.playerId,
    jailedUntil: playerStats.jailedUntil,
    hospitalUntil: playerStats.hospitalUntil,
  })
    .from(playerStats)
    .where(or(
      and(isNotNull(playerStats.jailedUntil), lte(playerStats.jailedUntil, now)),
      and(isNotNull(playerStats.hospitalUntil), lte(playerStats.hospitalUntil, now)),
    ))
    .limit(limit);

  const result: SweepResult = { released: [], discharged: [] };
  for (const candidate of candidates) {
    if (candidate.jailedUntil !== null) {
      const { released } = await releaseIfExpiredWithOutcome(db, redis, candidate.playerId);
      if (released) result.released.push(candidate.playerId);
    }
    if (candidate.hospitalUntil !== null) {
      const { discharged } = await dischargeIfExpired(db, redis, candidate.playerId);
      if (discharged) result.discharged.push(candidate.playerId);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run apps/server/test/sentence-sweeper.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Prove the race test can fail**

A concurrency test that has never been red proves nothing (CLAUDE.md working
method). Temporarily weaken the claim in
`apps/server/src/game/jail/status.ts` — drop `isNotNull(playerStats.jailedUntil)`
from `releaseIfExpiredWithOutcome`'s UPDATE `WHERE`:

```ts
    .where(eq(playerStats.playerId, playerId))
```

Re-run:

```bash
npx vitest run apps/server/test/sentence-sweeper.test.ts -t "claims exactly once"
```

Expected: FAIL — a player id appears twice across the two passes. **Restore
the `isNotNull` clause** and re-run to confirm green before committing.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/game/sweep/sweeper.ts apps/server/test/sentence-sweeper.test.ts
git commit -m "feat(game): add sweepExpiredSentences, one pass over elapsed sentences"
```

---

### Task 5: Lock-order regression test — sweeper vs combat

CLAUDE.md rule 6 has cost this repo two shipped deadlocks, and its corollary
says a concurrency test whose participants all lock through the same helper
proves only the case that was already safe. The sweeper and combat are
genuinely different lock shapes — one lock versus two sorted — so this test
exercises the pair that has never been exercised.

**Files:**
- Create: `apps/server/test/sentence-sweeper-lock-order.test.ts`

**Interfaces:**
- Consumes: `sweepExpiredSentences` from Task 4.
- Produces: nothing (test-only).

- [ ] **Step 1: Write the test**

Copy `apps/server/test/combat-lock-order.test.ts`'s entire fixture verbatim —
its module-level `testDb()` / `createRedis()`, `waitForLockWaiters`,
`equipPeashooter`, `fire`, `attack`, and its whole `beforeAll`/`afterAll`
(register two players, give both a location with `bulletStock: 0`,
`exp: 100_000n`, `bullets: 1000n`, equip the always-hits-for-1 peashooter;
clean up both players' `cooldownKey(...)` by targeted `redis.del`, **never**
FLUSHDB). It is the worked example for this shape, and it boots through
`bootTestServer()`, which is what runs combat's plugin migrations.

Then create `apps/server/test/sentence-sweeper-lock-order.test.ts` with that
fixture and this body. The barrier is the point: firing a sweep and two
attacks at each other and hoping they interleave is a coin flip per round,
and the file being copied says so at length. A blocker connection holding
both rows parks every participant on its first lock, so the cycle — if the
code can form one — is already set up when the barrier releases.

```ts
import { pgErrorCode } from "./helpers/pg-error.js";
// …plus the combat-lock-order fixture's own imports.

describe("sentence sweeper lock ordering", () => {
  it("survives a sweep released from the same barrier as a mutual attack", async () => {
    // Both players have an ELAPSED hospital sentence, so the sweeper has real
    // work on both rows — and `dischargeIfExpired` is the sweeper path that
    // actually takes a player lock (jail's release is a bare UPDATE). Combat
    // settles elapsed sentences for both participants itself, so the two
    // paths are contending for exactly the same two rows.
    const past = new Date(Date.now() - 1000);
    await db.update(playerStats)
      .set({ health: 0, hospitalUntil: past })
      .where(inArray(playerStats.playerId, [playerA, playerB]));

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<unknown>[] = [];

    try {
      // Hold BOTH rows in ascending order — the shipped helper's own order,
      // so this barrier is not itself an out-of-order actor.
      await t0`BEGIN`;
      await t0`
        SELECT player_id FROM player_stats
        WHERE player_id IN (${playerA}::uuid, ${playerB}::uuid)
        ORDER BY player_id FOR UPDATE
      `;

      const ab = fire(attack(playerB, tokenA));
      const ba = fire(attack(playerA, tokenB));
      const sweep = sweepExpiredSentences(db, redis);
      inFlight.push(ab, ba, sweep);

      // Three backends parked on their first lock.
      await waitForLockWaiters(3);

      await t0`ROLLBACK`; // starts all three from the same instant

      const [abRes, baRes] = await Promise.all([ab, ba]);
      // A deadlock surfaces as 40P01 → unhandled → HTTP 500.
      expect(abRes.statusCode, `A→B body: ${abRes.body}`).not.toBe(500);
      expect(baRes.statusCode, `B→A body: ${baRes.body}`).not.toBe(500);

      // And the sweep itself neither deadlocked nor was starved out.
      const error = await sweep.then(() => undefined, (e: unknown) => e);
      expect(pgErrorCode(error)).not.toBe("40P01");
      expect(error).toBeUndefined();
    } finally {
      try { await t0`ROLLBACK`; } catch { /* already rolled back */ }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }
  });
});
```

Note the sweep is asserted on directly rather than through a
`catch`-and-inspect helper: `rejectionOf` in `test/helpers/pg-error.ts` is for
promises that *must* reject, and this one must not.

- [ ] **Step 2: Run the test**

```bash
npx vitest run apps/server/test/sentence-sweeper-lock-order.test.ts
```

Expected: PASS. If `waitForLockWaiters(3)` times out, the sweep found no
candidates — check that the `hospitalUntil` UPDATE above committed before the
blocker took its rows.

- [ ] **Step 3: Prove it can fail**

The mutation has to make the sweeper hold *two* locks in the order the
rejected bulk UPDATE could produce. In `apps/server/src/game/sweep/sweeper.ts`,
temporarily replace the per-candidate `dischargeIfExpired` call with an
inline transaction that locks the batch **descending**:

```ts
    // TEMPORARY — proving the lock-order test can fail. Revert.
    // Stands in for the bulk `UPDATE ... WHERE hospital_until <= now()` this
    // design rejected: many rows locked in one transaction, in an order
    // nothing coordinates with combat's ascending sort.
    if (candidate.hospitalUntil !== null) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT player_id FROM player_stats
          WHERE player_id IN ${sql.raw(`(${candidates.map((c) => `'${c.playerId}'::uuid`).join(",")})`)}
          ORDER BY player_id DESC FOR UPDATE
        `);
      });
      continue;
    }
```

Re-run:

```bash
npx vitest run apps/server/test/sentence-sweeper-lock-order.test.ts
```

Expected: FAIL with `40P01 deadlock detected`, deterministically — the
descending sweep holds B while combat holds A and asks for B. That failure is
real evidence rather than an unfair adversary: the out-of-order actor here is
the sweeper itself, which is production code, and the shipped single-lock
version is the thing that makes the cycle impossible. **Revert the temporary
block** and confirm green.

- [ ] **Step 4: Commit**

```bash
git add apps/server/test/sentence-sweeper-lock-order.test.ts
git commit -m "test(sweep): prove the sweeper cannot deadlock against combat"
```

---

### Task 6: The timer loop and its wiring

**Files:**
- Modify: `apps/server/src/game/sweep/sweeper.ts` (append)
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/server/test/sentence-sweeper-loop.test.ts`
- Test: `apps/server/test/config.test.ts` (extend)

**Interfaces:**
- Consumes: `sweepExpiredSentences` from Task 4.
- Produces:
  - `startSentenceSweeper(deps: { db: Db; redis: Redis; intervalMs: number; onError?: (error: unknown) => void }): { stop: () => void }`
  - `Config.sweepIntervalMs: number` from `SWEEP_INTERVAL_MS` (default 2000; **0 disables the sweeper entirely**).

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/sentence-sweeper-loop.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { startSentenceSweeper } from "../src/game/sweep/sweeper.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
afterAll(async () => { await conn.end(); redis.disconnect(); });

beforeEach(async () => { await resetDb(db); });

/** Polls until `check` is true or the deadline passes — no arbitrary sleeps. */
async function until(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("until: condition never became true");
}

describe("startSentenceSweeper", () => {
  it("frees a player with no request from them at all", async () => {
    const id = uuidv7();
    await db.insert(players).values({ id, username: `loop-${id.slice(-8)}` });
    await db.insert(playerStats).values({ playerId: id, jailedUntil: new Date(Date.now() - 1000) });

    const sweeper = startSentenceSweeper({ db, redis, intervalMs: 50 });
    try {
      await until(async () => {
        const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
        return row?.jailedUntil === null;
      });
    } finally {
      sweeper.stop();
    }
  });

  it("keeps ticking after a pass throws", async () => {
    const errors: unknown[] = [];
    // An unreachable Postgres makes the candidate SELECT reject, so EVERY
    // pass throws and the loop has to survive repeatedly. Not a mock — a real
    // driver against a real (refused) socket.
    //
    // Deliberately NOT a broken Redis: createRedis passes
    // `maxRetriesPerRequest: null` and leaves ioredis's offline queue on, so
    // a publish to an unreachable Redis QUEUES FOREVER instead of rejecting,
    // and this test would hang rather than fail.
    const { db: brokenDb, sql: brokenConn } = createDb("postgres://gl3:gl3@127.0.0.1:1/gl3");
    const sweeper = startSentenceSweeper({
      db: brokenDb, redis, intervalMs: 25, onError: (error) => { errors.push(error); },
    });
    try {
      await until(async () => Promise.resolve(errors.length >= 2));
    } finally {
      sweeper.stop();
      await brokenConn.end({ timeout: 1 }).catch(() => undefined);
    }
    // Two errors means the loop survived the first one.
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("stop() halts the loop", async () => {
    const id = uuidv7();
    await db.insert(players).values({ id, username: `stop-${id.slice(-8)}` });
    await db.insert(playerStats).values({ playerId: id });

    const sweeper = startSentenceSweeper({ db, redis, intervalMs: 25 });
    sweeper.stop();
    await db.update(playerStats)
      .set({ jailedUntil: new Date(Date.now() - 1000) })
      .where(eq(playerStats.playerId, id));

    await new Promise((resolve) => setTimeout(resolve, 200));
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, id));
    expect(row?.jailedUntil).not.toBeNull();
  });
});
```

Append to `apps/server/test/config.test.ts`, matching how that file already
builds a minimal env object:

```ts
  it("defaults SWEEP_INTERVAL_MS to 2000 and allows 0 to disable", () => {
    const base = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" };
    expect(loadConfig({ ...base }).sweepIntervalMs).toBe(2000);
    expect(loadConfig({ ...base, SWEEP_INTERVAL_MS: "0" }).sweepIntervalMs).toBe(0);
    expect(loadConfig({ ...base, SWEEP_INTERVAL_MS: "500" }).sweepIntervalMs).toBe(500);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run apps/server/test/sentence-sweeper-loop.test.ts apps/server/test/config.test.ts
```

Expected: FAIL — `startSentenceSweeper` is not exported;
`sweepIntervalMs` is not on `Config`.

- [ ] **Step 3: Write the loop**

Append to `apps/server/src/game/sweep/sweeper.ts`:

```ts
export interface SweeperHandle {
  /** Stops the loop. Safe to call more than once. */
  stop: () => void;
}

export interface SweeperDeps {
  db: Db;
  redis: Redis;
  /** Milliseconds between the END of one pass and the START of the next. */
  intervalMs: number;
  onError?: (error: unknown) => void;
}

/**
 * Runs `sweepExpiredSentences` on a loop.
 *
 * A self-scheduling `setTimeout` rather than `setInterval`: the delay is
 * measured from the END of each pass, so a slow pass can never overlap the
 * next one. Overlap would not corrupt anything — the claim UPDATE makes
 * double-settling impossible — but it would pile transactions onto a database
 * that is already the reason the pass was slow.
 *
 * A throwing pass is reported and swallowed. The loop must outlive a
 * transient Redis or Postgres blip; the lazy release path on the gated routes
 * is what keeps players correct while it is blipping.
 */
export function startSentenceSweeper(deps: SweeperDeps): SweeperHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    try {
      await sweepExpiredSentences(deps.db, deps.redis);
    } catch (error) {
      deps.onError?.(error);
    }
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, deps.intervalMs);
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
```

- [ ] **Step 4: Add the config value**

In `apps/server/src/config.ts`, add to `EnvSchema` after `SESSION_TTL`:

```ts
  /**
   * Milliseconds between sentence-sweeper passes. `0` disables the sweeper,
   * which is safe: `releaseIfExpired`/`settleHospital` still free players
   * lazily on their next request, exactly as they did before the sweeper
   * existed. Non-negative rather than positive for that reason.
   */
  SWEEP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2000),
```

add `sweepIntervalMs: number;` to the `Config` interface, and
`sweepIntervalMs: parsed.SWEEP_INTERVAL_MS,` to the returned object.

- [ ] **Step 5: Wire it into production boot**

In `apps/server/src/index.ts`, after the `attachGateway(...)` call at the end:

```ts
// Deliberately here and NOT in buildApp: every integration test builds its
// server through buildApp/bootTestServer, and a background process quietly
// clearing jailed_until under those tests would make half of them race. In
// production the sweeper is what turns release into a WebSocket push instead
// of a client poll.
if (config.sweepIntervalMs > 0) {
  startSentenceSweeper({
    db, redis, intervalMs: config.sweepIntervalMs,
    onError: (error) => { app.log.error({ err: error }, "sentence sweep failed"); },
  });
}
```

with `import { startSentenceSweeper } from "./game/sweep/sweeper.js";` added to
the imports.

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest run apps/server/test/sentence-sweeper-loop.test.ts apps/server/test/config.test.ts
npm run typecheck
npx tsc --build --force apps/server/tsconfig.json
```

Expected: PASS and both builds clean. The `tsc --build` is the exact command
the CI image build runs — running it locally is what catches a missing project
reference that `npm run typecheck` would hide (CLAUDE.md).

- [ ] **Step 7: Verify the server actually boots with it**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
node apps/server/dist/index.js &
sleep 3
curl -sf http://localhost:3000/health || curl -sf http://localhost:3000/api/health
kill %1
```

Expected: the server starts, answers, and logs no sweep errors. (Use whichever
health path exists — check `apps/server/src/app.ts` for the route it
registers.)

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/game/sweep/sweeper.ts apps/server/src/config.ts apps/server/src/index.ts apps/server/test/sentence-sweeper-loop.test.ts apps/server/test/config.test.ts
git commit -m "feat(server): run the sentence sweeper on a tick, configurable via SWEEP_INTERVAL_MS"
```

---

### Task 7: Stop the client polling every 2 seconds

**Files:**
- Modify: `apps/web/src/api/queries.ts:66-74` and `:535-543`
- Modify: `apps/web/src/pages/Jail.tsx:13-15,22-23,41`
- Modify: `apps/web/src/pages/Hospital.tsx:16`
- Create: `apps/web/test/refetch-intervals.test.ts`

**Interfaces:**
- Consumes: `player.discharged` invalidation from Task 2; the sweeper from Task 6.
- Produces:
  - `jailRefetchInterval(data: JailStatus | undefined): number | false`
  - `hospitalRefetchInterval(data: HospitalStatus | undefined): number | false`
  - `const SENTENCE_SAFETY_POLL_MS = 30_000`

Extracted as named exports purely so they are testable — a `refetchInterval`
closure inlined in a `useQuery` options object cannot be asserted on without a
mounted query client.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/refetch-intervals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SENTENCE_SAFETY_POLL_MS, hospitalRefetchInterval, jailRefetchInterval,
} from "../src/api/queries.js";

describe("sentence safety polling", () => {
  it("polls slowly while jailed", () => {
    expect(jailRefetchInterval({ jailed: true, until: null, remainingSeconds: 10 }))
      .toBe(SENTENCE_SAFETY_POLL_MS);
  });

  it("does not poll once free", () => {
    expect(jailRefetchInterval({ jailed: false, until: null, remainingSeconds: 0 })).toBe(false);
  });

  it("does not poll before the first response", () => {
    expect(jailRefetchInterval(undefined)).toBe(false);
    expect(hospitalRefetchInterval(undefined)).toBe(false);
  });

  it("polls slowly while hospitalised, and not at all when healthy", () => {
    expect(hospitalRefetchInterval({ hospitalised: true, until: null, remainingSeconds: 10 }))
      .toBe(SENTENCE_SAFETY_POLL_MS);
    // The bug this replaces: the hospital query polled unconditionally, so a
    // healthy player on /hospital hit the server every 2 seconds forever.
    expect(hospitalRefetchInterval({ hospitalised: false, until: null, remainingSeconds: 0 }))
      .toBe(false);
  });

  it("is far slower than the WebSocket it backs up", () => {
    expect(SENTENCE_SAFETY_POLL_MS).toBeGreaterThanOrEqual(30_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project @gl3/web apps/web/test/refetch-intervals.test.ts
```

Expected: FAIL — none of the three symbols are exported.

- [ ] **Step 3: Rewrite the two queries**

In `apps/web/src/api/queries.ts`, replace `JAIL_POLL_MS`'s use with the new
predicates. Find where `JAIL_POLL_MS` is declared and replace it with:

```ts
/**
 * The server's sentence sweeper ends jail and hospital sentences on a ~2s tick
 * and pushes `player.released` / `player.discharged` over the socket, so the
 * page no longer has to ask. This poll is the backstop for the window where
 * the socket is down (reconnect is 2s, but a server restart can be longer) —
 * without it a mid-reconnect client would sit on a stale "you're jailed"
 * screen. 30s rather than the old 2s: 15× less traffic, and the socket is what
 * makes it feel instant.
 */
export const SENTENCE_SAFETY_POLL_MS = 30_000;

export function jailRefetchInterval(data: JailStatus | undefined): number | false {
  return data?.jailed === true ? SENTENCE_SAFETY_POLL_MS : false;
}

export function hospitalRefetchInterval(data: HospitalStatus | undefined): number | false {
  return data?.hospitalised === true ? SENTENCE_SAFETY_POLL_MS : false;
}
```

Delete `JAIL_POLL_MS` if nothing else references it (`grep -n JAIL_POLL_MS
apps/web/src` to confirm). Then:

```ts
export function useJail() {
  return useQuery<JailStatus>({
    queryKey: keys.jail(),
    queryFn: async () => JailStatusSchema.parse(await api("/api/jail")),
    refetchInterval: (query) => jailRefetchInterval(query.state.data),
  });
}
```

```ts
export function useHospital() {
  return useQuery<HospitalStatus>({
    queryKey: keys.hospital(),
    queryFn: async () => HospitalStatusSchema.parse(await api("/api/hospital")),
    refetchInterval: (query) => hospitalRefetchInterval(query.state.data),
  });
}
```

Replace `useJail`'s existing doc comment (the one beginning "There is no cron
that frees players") with:

```ts
/**
 * `GET /api/jail` still calls releaseIfExpired, so asking is still *a* way a
 * sentence ends — but it is no longer the only one. The server's sentence
 * sweeper ends sentences on a tick and pushes `player.released`, which
 * invalidates this query (see ws/invalidation.ts). The slow poll here is the
 * backstop for a client whose socket is down, not the mechanism.
 */
```

and `useHospital`'s comment ("Same reason as the jail query...") with:

```ts
  // Same shape as the jail query: the sweeper pushes `player.discharged` and
  // this slow poll only covers a dropped socket. It is now CONDITIONAL — the
  // previous version polled unconditionally, so a healthy player sitting on
  // /hospital hit the server every 2 seconds for nothing.
```

- [ ] **Step 4: Fix the page copy that promises a 2-second poll**

`apps/web/src/pages/Jail.tsx` — replace the comment at lines 13-15:

```tsx
  // The socket re-anchors this on `player.released`; the slow safety poll
  // re-anchors it if the socket is down. The display ticks locally every 1s
  // between anchors, which is what stops a throttled or suspended tab showing
  // a sentence that expired minutes ago (see lib/countdown.ts).
```

replace the comment at lines 22-23:

```tsx
  // The server's sentence sweeper is what frees a player now — GET /api/jail
  // still calls releaseIfExpired as a backstop, so this page works even with
  // the sweeper disabled (SWEEP_INTERVAL_MS=0).
```

and the on-screen sentence at line 41 — "This page checks every couple of
seconds and lets you out automatically." becomes:

```tsx
        You'll be let out automatically.
```

`apps/web/src/pages/Hospital.tsx` — replace the equivalent comment at line 16
with the same first paragraph, naming `player.discharged` instead of
`player.released`. Read the file and check whether it carries a matching
on-screen "checks every couple of seconds" sentence; if so, give it the same
treatment.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run --project @gl3/web
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/queries.ts apps/web/src/pages/Jail.tsx apps/web/src/pages/Hospital.tsx apps/web/test/refetch-intervals.test.ts
git commit -m "perf(web): replace the 2s jail/hospital polls with the release socket events"
```

---

### Task 8: Documentation and full verification

**Files:**
- Modify: `CLAUDE.md:20` (the "21 core `GameEvent` variants" count)
- Modify: `docs/STATUS.md`
- Modify: `docs/ENGINEERING-NOTES.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing (docs only).

- [ ] **Step 1: Update the event count in CLAUDE.md**

`CLAUDE.md:20` reads "lets a plugin publish any of the 21 core `GameEvent`
variants verbatim". Confirm the new count first rather than assuming:

```bash
grep -c 'type: z.literal(' packages/shared/src/events.ts
```

Subtract the `plugin.event` variant if that grep includes it, and write the
resulting number. Then update the line.

- [ ] **Step 2: Add a STATUS.md entry**

Add a paragraph to `docs/STATUS.md` in the same voice as the existing feature
entries:

> The **sentence sweeper** has since shipped: a tick
> (`apps/server/src/game/sweep/sweeper.ts`, `SWEEP_INTERVAL_MS`, default 2000,
> `0` disables) that ends elapsed jail and hospital sentences without waiting
> for the player to ask, publishing `player.released` and the new
> `player.discharged`. The lazy path on the gated routes is unchanged and
> still authoritative when no sweeper runs. Its claim is the existing
> `WHERE ... IS NOT NULL` UPDATE, so a second instance is safe with no
> bookkeeping table; it settles one player per transaction holding one lock,
> which is why it shares no edge with the four existing lock pairs
> (`test/sentence-sweeper-lock-order.test.ts`). The web client's 2-second
> jail and hospital polls dropped to a 30-second socket-down backstop, and the
> hospital poll — previously unconditional — now runs only while the player is
> actually admitted.

- [ ] **Step 3: Add an ENGINEERING-NOTES.md entry**

Add a section explaining the *why*, in that file's existing style — the two
designs from §Background, why the sweep won over per-sentence delayed jobs,
why one player per transaction, and why the lazy path stays. This is the note
that stops a future reader "simplifying" the sweeper into a bulk UPDATE.

- [ ] **Step 4: Run the full verification**

Nothing else may be running — no other agent's suite, no second terminal.

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify > /tmp/verify-sweeper.log 2>&1
echo "exit=$?"
tail -30 /tmp/verify-sweeper.log
```

Expected: `exit=0`. **The exit code is the verdict, not the summary line** — an
unhandled rejection makes vitest exit non-zero while still printing
`Tests N passed`. Any non-zero exit is a failure even if every test passed.

- [ ] **Step 5: Update the suite count**

Read the file/test totals from `/tmp/verify-sweeper.log` and update every
place the old `142 files / 1052 tests` appears:

```bash
grep -rn "1052\|142 files" CLAUDE.md docs/*.md
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/STATUS.md docs/ENGINEERING-NOTES.md
git commit -m "docs: record the sentence sweeper and the polls it replaces"
```

---

## Verification Summary

The feature is done when all of these hold:

1. `npm run verify` exits 0 with nothing else running.
2. `npx tsc --build --force apps/server/tsconfig.json` is clean (the CI image build's own command).
3. The concurrent-claim test in Task 4 has been *shown* failing with the `isNotNull` clause removed, and green with it restored.
4. The lock-order test in Task 5 has been *shown* failing with a bulk UPDATE in place, and green with the per-player loop restored.
5. `grep -rn "JAIL_POLL_MS" apps/web/src` returns nothing.
6. A manually jailed player is freed with the browser closed: set `jailed_until` to the past directly in `psql`, wait ~3s with the server running, and confirm the column is null without any request having been made.
