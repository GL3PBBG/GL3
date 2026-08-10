# Plugin Core Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a plugin publish the nineteen core `GameEventSchema` variants, and make the ctx capabilities own the post-commit side effects their callers cannot reach — unblocking the seven remaining `game/*` module ports.

**Architecture:** `@gl3/plugin-sdk` re-exports a `CoreEventInput` type derived from `@gl3/shared`'s `GameEvent` (the SDK already depends on `@gl3/shared`; the isolation rule binds plugin *packages*, not the SDK). `apps/server/src/plugins/ctx.ts` gains `tx.events.publishCore`, buffered in the same post-commit array as `tx.events.publish` so relative order is preserved. The economy capabilities buffer Redis leaderboard writes and `tx.notify` buffers a `notification.created`; both flush after commit alongside the events. `jail.sendToJail` deliberately gains nothing.

**Tech Stack:** TypeScript 5.6 (strict, ESM), zod 3.25, drizzle-orm 0.45.2, Fastify, Postgres 16, Redis 7, ioredis, BullMQ, vitest 2.1.

**Spec:** `docs/superpowers/specs/2026-08-10-plugin-core-events-design.md`

## Global Constraints

- TypeScript strict. **No `any` in `packages/*`** — none, not even a cast. In `apps/*` prefer `unknown` plus a zod parse, and type guards over casts.
- ESM only; relative imports carry a `.js` extension despite `.ts` sources.
- A plugin package may import **only** `@gl3/plugin-sdk`, `zod` and `drizzle-orm`. It may not import `@gl3/shared` — restate any schema it needs. The SDK itself may import `@gl3/shared`.
- Zod-validates every external boundary — HTTP bodies, route params, WS frames both directions, bus messages.
- Money is `bigint` in Postgres and TypeScript, and crosses the wire as a **decimal string** (`MoneySchema`, `/^-?\d+$/`). Never a JSON number.
- **Publish events only after the transaction commits** (CLAUDE.md rule 5). Never publish inside `db.transaction(...)`.
- **Tests asserting on `game:events` must filter by their own `actorId`** (CLAUDE.md rule 4) — use `awaitOwnEvent()` from `apps/server/test/helpers/events.ts`, or a local watcher that filters on `actorId`.
- **A foreign key is a lock** (CLAUDE.md rule 6). Every gang↔player path goes through `lockGangAndPlayerForUpdate`.
- Integration tests run against **real** Postgres and Redis. No mocks for DB, queue or bus paths, ever.
- **Never run `FLUSHALL` / `FLUSHDB`.** Redis is shared across every test file and every concurrent agent.
- **Never run two full test suites at once.** This box has 32 CPUs but ~3.8 GB RAM; `maxWorkers` is capped at 6 in `vitest.config.ts` — do not raise it.
- **Read `verify`'s exit code, not its summary.** Run `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"` and treat any non-zero exit as a failure even when every test passed.
- Conventional Commits.
- Environment for every test command:
  ```bash
  export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
  export REDIS_URL=redis://localhost:6379
  ```

## File Structure

**Created:**
- `packages/plugin-sdk/src/id.ts` — `newId()`, the uuidv7 generator a plugin cannot import directly.
- `packages/plugin-sdk/test/id.test.ts` — `newId` is distinct per call and time-ordered.
- `packages/plugin-sdk/test/core-event-input.test-d.ts` — type-level guard that `CoreEventInput` is the core variants minus `id`/`at`, and excludes `plugin.event`.
- `apps/server/test/plugin-ctx-core-events.test.ts` — the nineteen-variant corpus, the coverage drift guard, ordering, and rule 5 for `publishCore`.
- `packages/plugins/news/package.json`, `tsconfig.json`, `src/schema.ts`, `src/index.ts` — the news port (Task 5).

**Modified:**
- `packages/plugin-sdk/src/ctx.ts` — `OmitFromUnion`, `CoreEventInput`, `PluginTx.events.publishCore`.
- `packages/plugin-sdk/src/index.ts` — export `CoreEventInput` and `newId`.
- `packages/plugin-sdk/package.json` — add the `uuidv7` dependency.
- `apps/server/src/plugins/ctx.ts` — `BufferedEvent` union, `publishCore`, `toCoreEvent`, leaderboard buffer, `notify` event, `leaderboardPrefix` dep.
- `apps/server/src/app.ts`, `apps/server/src/index.ts` — thread `leaderboardPrefix`.
- `apps/server/test/helpers/server.ts`, `apps/server/test/plugin-loader.test.ts`, `apps/server/test/plugin-jobs.test.ts`, `apps/server/test/plugin-ctx-transaction.test.ts`, `apps/server/test/plugin-ctx-cooldown.test.ts` — the `PluginCtxDeps` literals gain `leaderboardPrefix`.
- `vitest.workspace.ts`, `tsconfig.json`, `Dockerfile.server`, `apps/server/src/plugins/core-plugins.ts` — register `@gl3/plugin-news` (Task 5).

**Deleted (Task 5):**
- `apps/server/src/game/news/routes.ts`, `apps/server/src/game/news/access.ts`, and their registration in `apps/server/src/app.ts`.

---

### Task 1: `CoreEventInput` and `newId` in the SDK

**Files:**
- Modify: `packages/plugin-sdk/src/ctx.ts` (add after `PluginEventInput`, ~line 88; extend `PluginTx.events`, ~line 145)
- Create: `packages/plugin-sdk/src/id.ts`
- Modify: `packages/plugin-sdk/src/index.ts` (the `export type { … } from "./ctx.js"` block, plus a new value export)
- Modify: `packages/plugin-sdk/package.json` (add the `uuidv7` dependency)
- Test: `packages/plugin-sdk/test/core-event-input.test-d.ts` (create), `packages/plugin-sdk/test/id.test.ts` (create)

**Interfaces:**
- Consumes: `GameEvent` from `@gl3/shared` — already imported at `packages/plugin-sdk/src/ctx.ts:1`.
- Produces: `CoreEventInput` (exported type), `PluginTx["events"]["publishCore"](event: CoreEventInput): Promise<void>`, and `newId(): string`. Task 2 implements the method; Task 5 calls both.

**Context:** `packages/plugin-sdk/package.json` already declares `"@gl3/shared": "*"` and `ctx.ts:1` already does `import type { GameEvent } from "@gl3/shared";`. The `@gl3/plugin-sdk` vitest project has `typecheck: { enabled: true }`, which is what makes a `.test-d.ts` file run — see the existing `packages/plugin-sdk/test/scope.test-d.ts`.

**Why `newId` is here:** a plugin package may import only `@gl3/plugin-sdk`, `zod` and `drizzle-orm`, so it cannot reach `uuidv7` — and `game_news.id` (like most core tables) has no database-side default, so the first port that INSERTS a row needs an id generator. `ranks` and `notifications` never inserted anything, which is why the gap has not surfaced until now. The SDK is the right home: it already depends on `@gl3/shared`, and re-exporting the generator keeps every plugin on uuidv7 rather than letting each reach for `crypto.randomUUID()` (v4 — no time ordering, and a silent break from every id in this schema).

- [ ] **Step 1: Write the failing type test**

Create `packages/plugin-sdk/test/core-event-input.test-d.ts`:

```ts
import type { CoreEventInput, PluginTx } from "../src/index.js";
import { expectTypeOf } from "vitest";

/**
 * `CoreEventInput` is derived from `@gl3/shared`'s `GameEvent`, not restated,
 * so it cannot drift silently. What it CAN do is stop being a union minus the
 * right fields — these are the three properties that make it usable.
 */

// 1. `id` and `at` are core's to fill, and must not be askable of a plugin.
expectTypeOf<CoreEventInput>().not.toHaveProperty("id");
expectTypeOf<CoreEventInput>().not.toHaveProperty("at");

// 2. The envelope is excluded — `plugin.event` has its own input type.
type PluginEventVariant = Extract<CoreEventInput, { type: "plugin.event" }>;
expectTypeOf<PluginEventVariant>().toEqualTypeOf<never>();

// 3. A representative core variant is accepted whole, with `id`/`at` absent.
expectTypeOf<{
  type: "news.posted";
  actorId: string;
  actorName: string;
  audience: { kind: "global" };
  newsId: string;
  title: string;
}>().toMatchTypeOf<CoreEventInput>();

// 4. The method exists on the tx surface with the derived input type.
expectTypeOf<PluginTx["events"]["publishCore"]>()
  .parameters.toEqualTypeOf<[CoreEventInput]>();
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --typecheck --project @gl3/plugin-sdk
```

Expected: FAIL — `Module '"../src/index.js"' has no exported member 'CoreEventInput'` and `Property 'publishCore' does not exist`.

- [ ] **Step 3: Add the type and the method**

In `packages/plugin-sdk/src/ctx.ts`, immediately after the `PluginEventInput` interface:

```ts
/**
 * `Omit` does not distribute over a union — `Omit<A | B, "id">` collapses to
 * the shared keys and destroys the discriminant. This conditional type is a
 * naked type parameter, so it distributes and each variant keeps its own
 * fields.
 */
type OmitFromUnion<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What a plugin supplies to `tx.events.publishCore`: every core event variant
 * minus the two fields core fills in — `id` (uuidv7) and `at` (ISO string).
 * `plugin.event` is excluded; that envelope has its own input type,
 * `PluginEventInput`.
 *
 * Derived from `GameEvent` rather than restated, so a new core variant reaches
 * plugins automatically and cannot drift. The cost is that adding a core
 * variant is an SDK surface change — `apps/server/test/plugin-ctx-core-events.test.ts`
 * is the guard that makes that coupling visible.
 */
export type CoreEventInput = OmitFromUnion<
  Exclude<GameEvent, { type: "plugin.event" }>,
  "id" | "at"
>;
```

Then replace the `events` member of `PluginTx` (currently `readonly events: { publish(event: PluginEventInput): Promise<void> };`) with:

```ts
  /**
   * Both methods buffer into ONE array, so a handler's relative call order
   * survives to the wire — `game/crimes/worker.ts` publishes `crime.resolved`
   * before `player.jailed` deliberately, and a port must be able to keep that.
   * The loader publishes after commit and discards on rollback, which makes
   * CLAUDE.md rule 5 unrepresentable rather than merely documented.
   */
  readonly events: {
    publish(event: PluginEventInput): Promise<void>;
    /** Publishes a core `GameEventSchema` variant verbatim — no envelope. */
    publishCore(event: CoreEventInput): Promise<void>;
  };
```

In `packages/plugin-sdk/src/index.ts`, add `CoreEventInput` to the alphabetically-ordered `export type { … } from "./ctx.js"` block — it goes first, before `GangLogEntry`.

- [ ] **Step 4: Run the type test to verify it passes**

```bash
npx vitest run --typecheck --project @gl3/plugin-sdk
```

Expected: PASS.

Note: `apps/server/src/plugins/ctx.ts` will now fail `tsc` — its `PluginTx` literal is missing `publishCore`. That is expected and is Task 2's opening state. Do **not** stub it here.

- [ ] **Step 5: Write the failing test for `newId`**

Create `packages/plugin-sdk/test/id.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newId } from "../src/index.js";

/**
 * A plugin cannot import `uuidv7` — the isolation rule allows only
 * `@gl3/plugin-sdk`, `zod` and `drizzle-orm` — and core tables have no
 * database-side id default, so a port that inserts a row needs this.
 */
describe("newId", () => {
  it("returns a distinct uuid on each call", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("is time-ordered, so ids sort by creation", () => {
    const ids = Array.from({ length: 50 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
npx vitest run --project @gl3/plugin-sdk test/id.test.ts
```

Expected: FAIL — `Module '"../src/index.js"' has no exported member 'newId'`.

- [ ] **Step 7: Implement `newId`**

Add `"uuidv7": "^1.0.2"` to the `dependencies` of `packages/plugin-sdk/package.json`, next to `drizzle-orm`. Match the version already resolved in the root `package-lock.json` — `apps/server` depends on it, so it is present; run `npm ls uuidv7` to read the resolved version and use that major/minor.

Create `packages/plugin-sdk/src/id.ts`:

```ts
import { uuidv7 } from "uuidv7";

/**
 * A time-ordered uuid, the id every table in this schema uses. Exposed here
 * because a plugin package may import only `@gl3/plugin-sdk`, `zod` and
 * `drizzle-orm` — it cannot reach `uuidv7` itself — and core tables have no
 * database-side default for `id`. Deliberately NOT `crypto.randomUUID()`:
 * that is v4, which has no time ordering, and mixing the two would make
 * `ORDER BY id` mean different things for different rows in one table.
 */
export function newId(): string {
  return uuidv7();
}
```

Export it from `packages/plugin-sdk/src/index.ts`:

```ts
export { newId } from "./id.js";
```

- [ ] **Step 8: Run both tests to verify they pass**

```bash
npm install
npx vitest run --typecheck --project @gl3/plugin-sdk
```

Expected: PASS, including `id.test.ts` and `core-event-input.test-d.ts`.

- [ ] **Step 9: Commit**

```bash
git add packages/plugin-sdk package.json package-lock.json
git commit -m "feat(plugin-sdk): add CoreEventInput, publishCore and newId to the plugin surface"
```

---

### Task 2: `publishCore` in the plugin ctx

**Files:**
- Modify: `apps/server/src/plugins/ctx.ts:49` (the buffer), `:82-84` (the `events` member), `:91-93` (the flush), `:140-152` (`toEnvelope`, gains a sibling)
- Test: `apps/server/test/plugin-ctx-core-events.test.ts` (create)
- Modify: `vitest.workspace.ts` (register the new test file in the `@gl3/server` project's `include` array)

**Interfaces:**
- Consumes: `CoreEventInput` from `@gl3/plugin-sdk` (Task 1).
- Produces: a working `tx.events.publishCore`. Tasks 4 and 5 rely on it; Task 4 pushes onto the same buffer directly.

**Context:** `apps/server/src/bus/publish.ts`'s `publishEvent` already runs `GameEventSchema.parse` on everything it publishes, so validation of a core event is free at the flush. The buffer lives in the `transaction()` call's closure (`ctx.ts:48-49`), which is what discards it on rollback.

**`vitest.workspace.ts` has two silent failure modes — both already bit this project.** (a) The `@gl3/server` project's `include` is an explicit array, not a glob: a test file that is not listed **never runs and never reports**. (b) Every workspace package a test imports needs an entry in `srcAliases`, or the specifier resolves to gitignored `dist/` and grades the last build. Task 2 needs (a); Task 5 needs both.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/plugin-ctx-core-events.test.ts`:

```ts
import { GameEventSchema, type GameEvent } from "@gl3/shared";
import type { CoreEventInput } from "@gl3/plugin-sdk";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

beforeAll(async () => { await subscriber.subscribe(GAME_EVENTS_CHANNEL); });
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

async function createPlayer(): Promise<{ id: string; username: string }> {
  const id = uuidv7();
  // Whole uuid, not a prefix: uuidv7's leading hex is the millisecond
  // timestamp, so two players minted in the same tick collide on the
  // `players_username_unique` index.
  const username = `pcce${id}`;
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return { id, username };
}

const deps = (): Parameters<typeof createPluginCtx>[0] =>
  ({ db, redis, queues: new Map(), settings: {} });
const opts = { pluginId: "t", player: null, job: null, filters: [] };

/**
 * `game:events` is one global channel shared by every test file running in
 * parallel (CLAUDE.md rule 4), so this filters on the freshly-minted actorId.
 * Local rather than `awaitOwnEvent` because these cases need to collect
 * SEVERAL frames, and the rollback case needs the timeout to be the success.
 */
function watchOwnEvents(actorId: string, expected: number): { seen: GameEvent[]; settled: Promise<void> } {
  const seen: GameEvent[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const onMessage = (channel: string, raw: string): void => {
    if (channel !== GAME_EVENTS_CHANNEL) return;
    const parsed = GameEventSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.actorId !== actorId) return;
    seen.push(parsed.data);
    if (seen.length >= expected) resolveDone();
  };
  subscriber.on("message", onMessage);
  const settled = Promise.race([done, new Promise<void>((r) => setTimeout(r, 1500))])
    .then(() => { subscriber.off("message", onMessage); });
  return { seen, settled };
}

/**
 * One sample per core variant, built by the plugin-facing shape: no `id`, no
 * `at`. `actorId`/`actorName` are filled per-test from a fresh player, so the
 * corpus carries placeholders the test overwrites.
 */
type CorpusEntry = Omit<CoreEventInput, "actorId" | "actorName">;

const UUID_A = "01920000-0000-7000-8000-00000000000a";
const UUID_B = "01920000-0000-7000-8000-00000000000b";
const AT = "2026-08-10T00:00:00.000Z";

const CORPUS: readonly CorpusEntry[] = [
  { type: "crime.resolved", audience: { kind: "global" }, crimeId: UUID_A, crimeName: "Rob a store", success: true, payout: "500", bullets: "2", exp: "10", jailedUntil: null },
  { type: "player.jailed", audience: { kind: "global" }, until: AT, reason: "failed a crime" },
  { type: "player.released", audience: { kind: "global" } },
  { type: "player.travelled", audience: { kind: "global" }, fromLocationId: null, toLocationId: UUID_A, cost: "100" },
  { type: "player.attacked", audience: { kind: "global" }, targetId: UUID_A, targetName: "Sollozzo", damage: 12 },
  { type: "player.killed", audience: { kind: "global" }, victimId: UUID_A, victimName: "Sollozzo" },
  { type: "bounty.placed", audience: { kind: "global" }, bountyId: UUID_A, targetId: UUID_B, targetName: "Sollozzo", amount: "1000" },
  { type: "bounty.claimed", audience: { kind: "global" }, bountyId: UUID_A, targetId: UUID_B, targetName: "Sollozzo", amount: "1000" },
  { type: "gang.created", audience: { kind: "global" }, gangId: UUID_A, gangName: "Corleone" },
  { type: "gang.memberJoined", audience: { kind: "gang", gangId: UUID_A }, gangId: UUID_A },
  { type: "gang.memberLeft", audience: { kind: "gang", gangId: UUID_A }, gangId: UUID_A },
  { type: "mail.received", audience: { kind: "player", playerId: UUID_A }, mailId: UUID_B, recipientId: UUID_A, subject: "Business" },
  { type: "notification.created", audience: { kind: "player", playerId: UUID_A }, notificationId: UUID_B, body: "You have mail." },
  { type: "news.posted", audience: { kind: "global" }, newsId: UUID_A, title: "Round 2 begins" },
  { type: "chat.message", audience: { kind: "global" }, body: "Leave the gun." },
  { type: "player.joined", audience: { kind: "global" } },
  { type: "player.rankedUp", audience: { kind: "global" }, rankId: UUID_A, rankName: "Thug", cashReward: "250", bulletReward: "5", maxHealth: 120 },
  { type: "bank.transacted", audience: { kind: "player", playerId: UUID_A }, direction: "deposit", amount: "100", cash: "900", bank: "100" },
  { type: "bullets.purchased", audience: { kind: "player", playerId: UUID_A }, locationId: UUID_A, quantity: 5, cost: "500", cash: "500", bullets: "5" },
];

describe("tx.events.publishCore", () => {
  /**
   * The drift guard. `CoreEventInput` is DERIVED from `GameEventSchema`, so a
   * twentieth core variant reaches the SDK for free — and would reach the wire
   * completely untested. This fails the moment a variant is added without a
   * corpus entry, which is the prompt to add one.
   */
  it("covers every core variant declared by GameEventSchema", () => {
    const covered = new Set(CORPUS.map((e) => e.type));
    const declared = [...GameEventSchema.optionsMap.keys()]
      .filter((t): t is string => typeof t === "string" && t !== "plugin.event");
    expect(declared.filter((t) => !covered.has(t as CorpusEntry["type"]))).toEqual([]);
    expect(CORPUS).toHaveLength(declared.length);
  });

  it("publishes every core variant verbatim, with core-filled id and at", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const watch = watchOwnEvents(player.id, CORPUS.length);

    await ctx.transaction(async (tx) => {
      for (const entry of CORPUS) {
        await tx.events.publishCore({
          ...entry, actorId: player.id, actorName: player.username,
        } as CoreEventInput);
      }
    });

    await watch.settled;
    expect(watch.seen.map((e) => e.type)).toEqual(CORPUS.map((e) => e.type));
    for (const event of watch.seen) {
      // Not `plugin.event`: the whole point is that these are indistinguishable
      // from core's own emissions on the wire.
      expect(event.type).not.toBe("plugin.event");
      expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(() => new Date(event.at).toISOString()).not.toThrow();
    }
  });

  it("preserves call order across publish and publishCore", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const watch = watchOwnEvents(player.id, 3);

    await ctx.transaction(async (tx) => {
      await tx.events.publishCore({
        type: "news.posted", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, newsId: UUID_A, title: "first",
      });
      await tx.events.publish({
        name: "middle", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, payload: {},
      });
      await tx.events.publishCore({
        type: "chat.message", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, body: "last",
      });
    });

    await watch.settled;
    expect(watch.seen.map((e) => e.type)).toEqual(["news.posted", "plugin.event", "chat.message"]);
  });

  it("drops a buffered core event when the transaction rolls back", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const watch = watchOwnEvents(player.id, 1);

    await expect(ctx.transaction(async (tx) => {
      await tx.events.publishCore({
        type: "news.posted", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, newsId: UUID_A, title: "never",
      });
      throw new Error("boom");
    })).rejects.toThrow("boom");

    await watch.settled;
    expect(watch.seen).toEqual([]);
  });
});
```

Then add `"test/plugin-ctx-core-events.test.ts",` to the `@gl3/server` project's `include` array in `vitest.workspace.ts`, in alphabetical position (after `"test/plugin-ctx-cooldown.test.ts"` is not present in that project — insert immediately before `"test/plugin-ctx-port-prereqs.test.ts"`).

- [ ] **Step 2: Run it to verify it fails**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npx vitest run --project @gl3/server test/plugin-ctx-core-events.test.ts
```

Expected: FAIL — `tx.events.publishCore is not a function`.

If it reports `No test files found`, the `include` edit above did not land — fix that first; a missing entry means the file silently never runs.

- [ ] **Step 3: Implement `publishCore`**

In `apps/server/src/plugins/ctx.ts`:

Add `CoreEventInput` to the `import type { … } from "@gl3/plugin-sdk"` list at the top, and add `GameEventSchema` to the `@gl3/shared` import (it is currently `import type { GameEvent } from "@gl3/shared";` — it becomes a value import too):

```ts
import { GameEventSchema, type GameEvent } from "@gl3/shared";
```

Above `createPluginCtx`, add the buffer element type:

```ts
/**
 * One buffer holds both kinds so a handler's relative call order survives to
 * the wire. `game/crimes/worker.ts` publishes `crime.resolved` before
 * `player.jailed` deliberately — "so a client that reacts to player.jailed can
 * already cross-reference the crime that caused it" — and a ported crimes
 * module must be able to keep that.
 */
type BufferedEvent =
  | { kind: "plugin"; event: PluginEventInput }
  | { kind: "core"; event: CoreEventInput };
```

Replace the buffer declaration (`ctx.ts:49`):

```ts
      const buffered: BufferedEvent[] = [];
```

Replace the `events` member of `pluginTx` (`ctx.ts:82-84`):

```ts
          events: {
            publish: async (event) => { buffered.push({ kind: "plugin", event }); },
            publishCore: async (event) => { buffered.push({ kind: "core", event }); },
          },
```

Replace the flush loop (`ctx.ts:91-93`):

```ts
      for (const entry of buffered) {
        await publishEvent(
          deps.redis,
          entry.kind === "plugin"
            ? toEnvelope(options.pluginId, entry.event)
            : toCoreEvent(entry.event),
        );
      }
```

And add, next to `toEnvelope`:

```ts
/**
 * `id`/`at` are built exactly as `toEnvelope` and core's own emitters build
 * them. The `GameEventSchema.parse` is what supplies the `GameEvent` return
 * type without a cast — `Omit` distributed over a union does not spread back
 * into the union by inference, and `apps/*` prefers a zod parse to a cast.
 * `publishEvent` parses again; that second parse is a few microseconds and
 * buys the type honesty here.
 */
function toCoreEvent(event: CoreEventInput): GameEvent {
  return GameEventSchema.parse({ id: uuidv7(), at: new Date().toISOString(), ...event });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run --project @gl3/server test/plugin-ctx-core-events.test.ts
```

Expected: PASS, 4 tests.

Then confirm the tree typechecks:

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/plugins/ctx.ts apps/server/test/plugin-ctx-core-events.test.ts vitest.workspace.ts
git commit -m "feat(plugins): let a plugin publish core game events"
```

---

### Task 3: Leaderboard writes follow plugin economy changes

**Files:**
- Modify: `apps/server/src/plugins/ctx.ts` (`PluginCtxDeps`, the economy capabilities, the post-commit flush)
- Modify: `apps/server/src/app.ts:70`, `:108`, `:113-117`
- Modify: `apps/server/src/index.ts:46`
- Modify: `apps/server/test/helpers/server.ts:73`
- Modify: `apps/server/test/plugin-loader.test.ts:28`, `apps/server/test/plugin-jobs.test.ts:31`, `apps/server/test/plugin-ctx-transaction.test.ts:38` and `:173`, `apps/server/test/plugin-ctx-cooldown.test.ts:12`
- Test: `apps/server/test/plugin-ctx-core-events.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `recordScore(redis, kind, playerId, score, prefix)` and `DEFAULT_LEADERBOARD_PREFIX` from `apps/server/src/game/leaderboard/service.js`; `LeaderboardKind` = `"cash" | "bank" | "exp"` from `@gl3/shared`.
- Produces: `PluginCtxDeps.leaderboardPrefix: string` (**required**, not optional). `LoadPluginsDeps = Omit<PluginCtxDeps, "queues">` picks it up automatically — that is why that type is derived rather than restated.

**Context (why this is one task, not two):** the prefix threading has no observable behaviour of its own; it exists so the leaderboard writes land in the test's own namespace. `bootTestServer` gives each booted server a run-unique `leaderboard-test-${randomUUID()}` prefix precisely because Redis is shared across every concurrently-running test file. Without threading, a plugin-driven `recordScore` would write to the production `leaderboard:*` keys during tests.

Making the field **required** is deliberate: an omitted prefix silently means "production keys," which is exactly the bug being prevented. All nine construction sites are compile errors until updated — that is the mechanism.

**Which capabilities gain what:**

| Capability | Buffers |
|---|---|
| `applyBalanceChange` | the returned balance, for `kind` — unless `kind === "points"` (no leaderboard) |
| `addExp` | fresh `player_stats.exp` |
| `applyExpAndRankUp` | fresh `exp` **and** fresh `cash` |
| `applyGangBalanceChange` | nothing — `LeaderboardKind` is per-player |
| `jail.sendToJail` | nothing |

`applyExpAndRankUp` must buffer cash as well as exp: it pays a rank-up cash reward through core's **internal** `applyBalanceChange` (`apps/server/src/economy/ranks.ts:46-47`), which the ctx wrapper never intercepts. Buffering only exp would leave cash stale after a rank-up.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/plugin-ctx-core-events.test.ts`. Add these imports at the top of the file:

```ts
import { randomUUID } from "node:crypto";
```

and extend the existing `players, playerStats` import from `../src/db/schema/index.js` (already present).

Replace the existing `deps` helper with one that carries a file-unique prefix, and add the new block at the end of the file:

```ts
// A prefix unique to this file's run, for the same reason bootTestServer has
// one: Redis is shared across every concurrently-running test file, so a
// shared `leaderboard:*` key would let two files see each other's scores.
const leaderboardPrefix = `pcce-test-${randomUUID()}`;

const deps = (): Parameters<typeof createPluginCtx>[0] =>
  ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix });

describe("plugin economy changes update the leaderboard", () => {
  const score = async (kind: "cash" | "bank" | "exp", playerId: string): Promise<string | null> =>
    await redis.zscore(`${leaderboardPrefix}:${kind}`, playerId);

  it("records the committed balance for a cash change", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);

    await ctx.transaction(async (tx) => {
      await tx.economy.applyBalanceChange({
        playerId: player.id, amount: 750n, kind: "cash", reason: "plugin_test",
      });
    });

    expect(await score("cash", player.id)).toBe("750");
  });

  it("records only the FINAL balance when one transaction moves cash twice", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);

    await ctx.transaction(async (tx) => {
      await tx.economy.applyBalanceChange({ playerId: player.id, amount: 500n, kind: "cash", reason: "a" });
      await tx.economy.applyBalanceChange({ playerId: player.id, amount: -200n, kind: "cash", reason: "b" });
    });

    expect(await score("cash", player.id)).toBe("300");
  });

  it("records exp after addExp", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);

    await ctx.transaction(async (tx) => { await tx.economy.addExp(player.id, 42n); });

    expect(await score("exp", player.id)).toBe("42");
  });

  it("writes nothing when the transaction rolls back", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);

    await expect(ctx.transaction(async (tx) => {
      await tx.economy.applyBalanceChange({ playerId: player.id, amount: 900n, kind: "cash", reason: "rolled_back" });
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(await score("cash", player.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npx vitest run --project @gl3/server test/plugin-ctx-core-events.test.ts
```

Expected: FAIL — the four new tests report `expected null to be "750"` (and similar). The `rolls back` case will pass vacuously; that is fine, it is the guard that must not break later.

- [ ] **Step 3: Add the dependency field and thread it**

In `apps/server/src/plugins/ctx.ts`, extend `PluginCtxDeps`:

```ts
export interface PluginCtxDeps {
  db: Db;
  redis: Redis;
  /** Per-plugin BullMQ queues, keyed `<pluginId>:<jobName>`. Task 11 fills it. */
  queues: Map<string, Queue>;
  settings: Record<string, string>;
  /**
   * Required, not optional-with-a-default: an omitted prefix silently means
   * the production `leaderboard:*` keys, and `bootTestServer` namespaces its
   * own per boot so concurrent test files do not collide on shared Redis.
   * `buildApp` applies the `?? DEFAULT_LEADERBOARD_PREFIX` default at the one
   * place that already owns that decision.
   */
  leaderboardPrefix: string;
}
```

In `apps/server/src/app.ts`, add the import:

```ts
import { DEFAULT_LEADERBOARD_PREFIX } from "./game/leaderboard/service.js";
```

Immediately before the `registerBankRoutes(...)` line, hoist the resolved prefix:

```ts
  const leaderboardPrefix = deps.leaderboardPrefix ?? DEFAULT_LEADERBOARD_PREFIX;
```

Change `registerLeaderboardRoutes(app, deps.db, deps.redis, requireAuth, deps.leaderboardPrefix);` to pass `leaderboardPrefix`. Change the default-path `loadPlugins` call to:

```ts
    loaded = await loadPlugins({ db: deps.db, redis: deps.redis, settings: {}, leaderboardPrefix }, CORE_PLUGINS);
```

And the `registerPluginRoutes` deps literal to:

```ts
  registerPluginRoutes(app, loaded.manifests, {
    db: deps.db,
    redis: deps.redis,
    queues: loaded.queues,
    settings: {},
    leaderboardPrefix,
  });
```

In `apps/server/src/index.ts`, add the import and pass the constant:

```ts
import { DEFAULT_LEADERBOARD_PREFIX } from "./game/leaderboard/service.js";
// …
const loadedPlugins = await loadPlugins(
  { db, redis, settings: {}, leaderboardPrefix: DEFAULT_LEADERBOARD_PREFIX },
  manifests,
);
```

In `apps/server/test/helpers/server.ts`, the `loadPlugins` call at line 73 gains `leaderboardPrefix` — the run-unique `leaderboardPrefix` const is already in scope at line 47:

```ts
        { db, redis, settings: {}, leaderboardPrefix },
```

In each of the four remaining test files, add a file-unique prefix to the deps literal. `apps/server/test/plugin-loader.test.ts:28`, `apps/server/test/plugin-jobs.test.ts:31`, `apps/server/test/plugin-ctx-transaction.test.ts:38` and `:173`, `apps/server/test/plugin-ctx-cooldown.test.ts:12` — in each, add near the top of the file:

```ts
import { randomUUID } from "node:crypto";
// Redis is shared across every concurrently-running test file; a shared
// `leaderboard:*` key would let two files see each other's scores.
const leaderboardPrefix = `<filename>-test-${randomUUID()}`;
```

(substituting a short name per file: `loader`, `jobs`, `ctxtx`, `cooldown`) and add `leaderboardPrefix` to the deps object literal.

- [ ] **Step 4: Buffer and flush the leaderboard writes**

In `apps/server/src/plugins/ctx.ts`, add the imports:

```ts
import { eq } from "drizzle-orm";
import type { LeaderboardKind } from "@gl3/shared";
import { playerStats } from "../db/schema/index.js";
import { recordScore } from "../game/leaderboard/service.js";
import type { Tx } from "../economy/ledger.js";
```

Add the helper at the bottom of the file:

```ts
/**
 * Read inside the transaction, so the buffered score is the one the
 * transaction is about to commit rather than whatever a concurrent writer
 * leaves behind. `addExp` returns void and `applyExpAndRankUp` returns only
 * the promotion, so there is nothing to buffer without this read.
 */
async function freshStats(tx: Tx, playerId: string): Promise<{ exp: bigint; cash: bigint } | undefined> {
  const [row] = await tx
    .select({ exp: playerStats.exp, cash: playerStats.cash })
    .from(playerStats)
    .where(eq(playerStats.playerId, playerId));
  return row;
}
```

Inside `transaction`, next to the event buffer:

```ts
      // Keyed so a second change to the same player+kind replaces the first:
      // the leaderboard wants the FINAL balance, not each intermediate one.
      const scores = new Map<string, { kind: LeaderboardKind; playerId: string; score: bigint }>();
      const bufferScore = (kind: LeaderboardKind, playerId: string, score: bigint): void => {
        scores.set(`${kind}:${playerId}`, { kind, playerId, score });
      };
```

Replace the `economy` member of `pluginTx`:

```ts
          economy: {
            applyBalanceChange: async (change) => {
              const after = await applyBalanceChange(tx, change);
              // `points` has no leaderboard — LeaderboardKind is cash/bank/exp.
              if (change.kind !== "points") bufferScore(change.kind, change.playerId, after);
              return after;
            },
            applyGangBalanceChange: (change) => applyGangBalanceChange(tx, change),
            addExp: async (playerId, amount) => {
              await addExp(tx, playerId, amount);
              const fresh = await freshStats(tx, playerId);
              if (fresh) bufferScore("exp", playerId, fresh.exp);
            },
            applyExpAndRankUp: async (playerId, expGain) => {
              const result = await applyExpAndRankUp(tx, playerId, expGain);
              // Both kinds: a rank-up pays its cash reward through core's own
              // internal applyBalanceChange (economy/ranks.ts), which this
              // wrapper never sees, so buffering exp alone leaves cash stale.
              const fresh = await freshStats(tx, playerId);
              if (fresh) {
                bufferScore("exp", playerId, fresh.exp);
                bufferScore("cash", playerId, fresh.cash);
              }
              return result;
            },
          },
```

And in the post-commit block, **before** the event flush:

```ts
      // Leaderboard first, then events — the order game/crimes/worker.ts uses.
      // Deliberately not wrapped in try/catch, for the reason that file states:
      // the balance that committed is correct, and the next boot's
      // rebuildLeaderboards repairs the index, so failing loudly beats a
      // silently stale one. The existing event flush already behaves this way.
      for (const entry of scores.values()) {
        await recordScore(deps.redis, entry.kind, entry.playerId, entry.score, deps.leaderboardPrefix);
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run --project @gl3/server test/plugin-ctx-core-events.test.ts
npm run typecheck
```

Expected: all tests PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/plugins/ctx.ts apps/server/src/app.ts apps/server/src/index.ts apps/server/test
git commit -m "feat(plugins): keep the leaderboard current after a plugin economy change"
```

---

### Task 4: `tx.notify` publishes `notification.created`

**Files:**
- Modify: `apps/server/src/plugins/ctx.ts` (the `notify` member, ~line 81)
- Test: `apps/server/test/plugin-ctx-core-events.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: the `BufferedEvent` buffer from Task 2; `insertNotification` from `apps/server/src/game/notifications/service.js` (already imported).
- Produces: no signature change — `notify(playerId, body): Promise<void>` is unchanged. The event is a side effect.

**Context:** `packages/shared/src/events.ts:50-51` documents `notification.created` as "actor = the notified player" — the recipient, **not** whoever triggered it. `apps/server/src/game/gangs/routes.ts:409-421` spells out why at length: it matches every other privately-audienced event, and `awaitOwnEvent(subscriber, actorId)` is the mandated CLAUDE.md rule-4 filter, so getting the actor wrong silently breaks any caller waiting on the recipient's id. `audience` is `{ kind: "player", playerId }` — the same recipient.

There is deliberately no opt-out. No core caller wants a notification without the event; adding the option now would be YAGNI.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/plugin-ctx-core-events.test.ts`:

```ts
describe("tx.notify", () => {
  it("publishes notification.created addressed to the NOTIFIED player", async () => {
    const actor = await createPlayer();
    const recipient = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    // Filters on the recipient, not the actor — that is the assertion.
    const watch = watchOwnEvents(recipient.id, 1);

    await ctx.transaction(async (tx) => { await tx.notify(recipient.id, "You have mail."); });

    await watch.settled;
    expect(watch.seen).toHaveLength(1);
    const event = watch.seen[0];
    if (event?.type !== "notification.created") throw new Error(`expected notification.created, got ${String(event?.type)}`);
    expect(event.actorId).toBe(recipient.id);
    expect(event.actorName).toBe(recipient.username);
    expect(event.audience).toEqual({ kind: "player", playerId: recipient.id });
    expect(event.body).toBe("You have mail.");
    expect(event.notificationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(actor.id).not.toBe(event.actorId);
  });

  it("publishes nothing when the transaction rolls back", async () => {
    const recipient = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const watch = watchOwnEvents(recipient.id, 1);

    await expect(ctx.transaction(async (tx) => {
      await tx.notify(recipient.id, "never sent");
      throw new Error("boom");
    })).rejects.toThrow("boom");

    await watch.settled;
    expect(watch.seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npx vitest run --project @gl3/server test/plugin-ctx-core-events.test.ts
```

Expected: FAIL — `expected [] to have a length of 1`.

- [ ] **Step 3: Publish from `notify`**

In `apps/server/src/plugins/ctx.ts`, add `players` to the schema import (it currently imports `pluginJobRuns` and, after Task 3, `playerStats`):

```ts
import { players, playerStats, pluginJobRuns } from "../db/schema/index.js";
```

Replace the `notify` member of `pluginTx`:

```ts
          /**
           * The row AND the event, always. `events.ts` documents
           * notification.created as "actor = the notified player" — the
           * recipient, not whoever triggered it — matching every other
           * privately-audienced event, and matching what core's own gang
           * routes publish. `awaitOwnEvent(subscriber, actorId)` is the
           * mandated rule-4 filter, so the wrong actor here silently breaks
           * every caller waiting on the recipient's own id.
           */
          notify: async (playerId, body) => {
            const notificationId = uuidv7();
            await insertNotification(tx, { id: notificationId, playerId, body });
            const [target] = await tx
              .select({ username: players.username })
              .from(players)
              .where(eq(players.id, playerId));
            buffered.push({
              kind: "core",
              event: {
                type: "notification.created",
                actorId: playerId,
                // "unknown" is the fallback every other event-publishing site
                // in this codebase uses (gangs/routes.ts, mail/routes.ts).
                actorName: target?.username ?? "unknown",
                audience: { kind: "player", playerId },
                notificationId,
                body,
              },
            });
          },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --project @gl3/server test/plugin-ctx-core-events.test.ts
npx vitest run --project @gl3/server test/plugin-ctx-port-prereqs.test.ts
npm run typecheck
```

Expected: all PASS; typecheck exit 0. `plugin-ctx-port-prereqs.test.ts` calls `tx.notify` and must stay green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/plugins/ctx.ts apps/server/test/plugin-ctx-core-events.test.ts
git commit -m "feat(plugins): publish notification.created from tx.notify"
```

---

### Task 5: Port the news module to a plugin

**Files:**
- Create: `packages/plugins/news/package.json`, `packages/plugins/news/tsconfig.json`, `packages/plugins/news/src/schema.ts`, `packages/plugins/news/src/index.ts`
- Delete: `apps/server/src/game/news/routes.ts`, `apps/server/src/game/news/access.ts`
- Modify: `apps/server/src/app.ts` (drop the import and the `registerNewsRoutes` call), `apps/server/src/plugins/core-plugins.ts`, `tsconfig.json`, `vitest.workspace.ts`, `Dockerfile.server`
- Test: `apps/server/test/news.test.ts` — **unchanged**. It passing against the plugin is the port's proof.

**Interfaces:**
- Consumes: `tx.events.publishCore` (Task 2), `definePlugin`/`route`/`PluginError` from `@gl3/plugin-sdk`.
- Produces: `@gl3/plugin-news` default export, added to `CORE_PLUGINS`.

**Context:** This is the smallest port that exercises `publishCore` end to end — one event (`news.posted`), a global audience, no ctx capability, no ordering subtlety. It validates the design before `crimes` and `gangs`, which carry the real complexity.

**Strangler swap, never coexistence.** Two handlers on one Fastify path is a duplicate-route collision at boot. `registerNewsRoutes` must be deleted in the same commit that registers the plugin.

**A plugin may not import `@gl3/shared`.** `PostNewsRequestSchema` and `noNulByte` are restated with zod, the same way `packages/plugins/notifications/src/index.ts` restates its param schema. The NUL-byte refinement is load-bearing: Postgres `text` rejects an embedded NUL outright (SQLSTATE 22021), and `news.test.ts` has two tests asserting 400 rather than 500 for it.

**One accepted wire difference.** Core's news route returned `{ error: "invalid_request", issues: [...] }` on a bad body; the plugin route layer (`apps/server/src/plugins/routes.ts:38-40`) returns `{ error: "invalid_request" }` with no `issues`. Nothing in `apps/web/src` reads `issues` (verified by grep), and `news.test.ts` asserts only the status code. Note this in the plugin's header comment; do not try to reproduce `issues`.

**`hasModuleAccess` has exactly one caller** (the news POST route), so `access.ts` is deleted rather than kept. Its logic moves into the plugin against mirrored tables. Preserve all three semantics its tests cover: no role → deny; a role granting a *different* module → deny; `moduleKey === "*"` → allow.

- [ ] **Step 1: Create the plugin package skeleton**

`packages/plugins/news/package.json`:

```json
{
  "name": "@gl3/plugin-news",
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

`packages/plugins/news/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../plugin-sdk" }]
}
```

`packages/plugins/news/src/schema.ts`:

```ts
import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Mirrors of core-owned tables — this plugin reads and writes `game_news` and
 * reads the two role tables, but owns none of their schemas. Column names and
 * types match `apps/server/src/db/schema/social.ts` and `identity.ts` exactly,
 * which is what lets `tx.db.select` / `tx.db.insert` type and serialise
 * correctly. None is listed in this plugin's manifest `tables` map and none
 * gets a migration here: core already owns and migrates all three (same
 * pattern and reasoning as `packages/plugins/ranks/src/schema.ts`).
 */
export const gameNews = pgTable("game_news", {
  id: uuid("id").primaryKey(),
  authorId: uuid("author_id"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
  roleId: uuid("role_id"),
});

export const roleModuleAccess = pgTable("role_module_access", {
  roleId: uuid("role_id").notNull(),
  moduleKey: text("module_key").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.roleId, t.moduleKey] }) }));
```

- [ ] **Step 2: Write the plugin**

`packages/plugins/news/src/index.ts`:

```ts
import { definePlugin, newId, PluginError, route } from "@gl3/plugin-sdk";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { gameNews, players, roleModuleAccess } from "./schema.js";

/**
 * Ported verbatim from `apps/server/src/game/news/routes.ts` and
 * `access.ts`: paths, status codes, response bodies and the `news.posted`
 * event are byte-identical. `apps/server/test/news.test.ts` is unchanged and
 * is the proof.
 *
 * Two deliberate differences:
 *  - A 400 from a bad body carries `{ error: "invalid_request" }` with no
 *    `issues` array, because the plugin route layer owns body validation
 *    (`apps/server/src/plugins/routes.ts`). Nothing in `apps/web` reads
 *    `issues`.
 *  - The reads happen inside `ctx.transaction`, since that is a plugin's only
 *    database handle. The POST's insert and its event were already ordered
 *    this way (CLAUDE.md rule 5); `publishCore` buffers and flushes on commit.
 *
 * `@gl3/shared` is off-limits to a plugin package, so `PostNewsRequestSchema`
 * and `noNulByte` are restated below. The NUL-byte refinement is load-bearing:
 * Postgres `text` rejects an embedded NUL outright (SQLSTATE 22021), turning
 * an otherwise-legal post into a 500 without it.
 */
// Write the six-character escape (backslash-u-0-0-0-0), never a literal NUL
// character: a raw NUL is invisible in every editor, makes the file binary
// to grep, and will not survive a copy/paste — the refinement would then
// silently accept everything it exists to reject. This plan file caught
// exactly that during its own review.
const noNulByte = <T extends z.ZodString>(schema: T): z.ZodEffects<T, string, string> =>
  schema.refine((value) => !value.includes("\u0000"), { message: "must not contain a NUL byte" });

const PostNewsBodySchema = z.object({
  title: noNulByte(z.string().min(1).max(200)),
  body: noNulByte(z.string().min(1).max(10_000)),
});

export default definePlugin({
  id: "news",
  version: "1.0.0",
  basePaths: ["/api/news"],
  routes: [
    route({
      method: "POST",
      path: "/api/news",
      body: PostNewsBodySchema,
      handler: async (ctx, { body }) => {
        const playerId = ctx.player?.id;
        if (playerId === undefined) throw new PluginError("unauthorized", 401);

        return ctx.transaction(async (tx) => {
          // Role/module access gate, ported from access.ts. Three cases the
          // suite covers explicitly: no role denies; a role granting a
          // DIFFERENT module denies (so the check cannot degrade to
          // "has any row"); and `*` is the V2-preserved admin wildcard.
          const [author] = await tx.db
            .select({ roleId: players.roleId, username: players.username })
            .from(players)
            .where(eq(players.id, playerId));
          if (!author?.roleId) throw new PluginError("forbidden", 403);
          const grants = await tx.db
            .select({ moduleKey: roleModuleAccess.moduleKey })
            .from(roleModuleAccess)
            .where(eq(roleModuleAccess.roleId, author.roleId));
          if (!grants.some((g) => g.moduleKey === "news" || g.moduleKey === "*")) {
            throw new PluginError("forbidden", 403);
          }

          const id = uuidv7();
          await tx.db.insert(gameNews).values({
            id, authorId: playerId, title: body.title, body: body.body,
          });

          // Buffered here, published after commit — events are facts, not
          // commands (CLAUDE.md rule 5). events.ts documents news.posted as
          // "actor = the author", audience global.
          await tx.events.publishCore({
            type: "news.posted",
            actorId: playerId,
            actorName: author.username,
            audience: { kind: "global" },
            newsId: id,
            title: body.title,
          });

          return { status: 201, body: { id } };
        });
      },
    }),
    route({
      method: "GET",
      path: "/api/news",
      auth: "public",
      handler: async (ctx) => ctx.transaction(async (tx) => {
        const rows = await tx.db.select().from(gameNews).orderBy(desc(gameNews.createdAt)).limit(50);
        const authorIds = [...new Set(rows.map((r) => r.authorId).filter((id): id is string => id !== null))];
        const authors = authorIds.length > 0
          ? await tx.db.select({ id: players.id, username: players.username })
              .from(players).where(inArray(players.id, authorIds))
          : [];
        const nameById = new Map(authors.map((a) => [a.id, a.username]));

        return {
          status: 200,
          body: {
            news: rows.map((n) => ({
              id: n.id,
              authorId: n.authorId,
              authorName: n.authorId ? nameById.get(n.authorId) ?? null : null,
              title: n.title,
              body: n.body,
              createdAt: n.createdAt.toISOString(),
            })),
          },
        };
      }),
    }),
  ],
});
```

Note the id: `newId()` comes from `@gl3/plugin-sdk` (Task 1). Do **not** add `uuidv7` to this package's dependencies — the isolation rule allows a plugin only `@gl3/plugin-sdk`, `zod` and `drizzle-orm`, and routing the generator through the SDK is exactly why Task 1 adds it.

- [ ] **Step 3: Register the package and run the existing suite to verify it fails**

`tsconfig.json` — add after the notifications reference:

```json
    { "path": "./packages/plugins/news" },
```

`vitest.workspace.ts` — add to `srcAliases.resolve.alias`:

```ts
      "@gl3/plugin-news": fileURLToPath(
        new URL("./packages/plugins/news/src/index.ts", import.meta.url),
      ),
```

Without this, the specifier resolves to gitignored `dist/` and grades the last `tsc --build` instead of the source.

`apps/server/src/plugins/core-plugins.ts` — import the default export as `newsPlugin` and add it to `CORE_PLUGINS`, following the existing `rankPlugin` / `notificationsPlugin` lines exactly.

Then install the new workspace and run:

```bash
npm install
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npx vitest run --project @gl3/server test/news.test.ts
```

Expected: FAIL — a Fastify duplicate-route error (`Method 'POST' already declared for route '/api/news'`), because core's route is still registered. That failure IS the proof that the plugin's routes are live.

- [ ] **Step 4: Delete core's news module and verify green**

```bash
git rm apps/server/src/game/news/routes.ts apps/server/src/game/news/access.ts
```

In `apps/server/src/app.ts`, delete the `import { registerNewsRoutes } from "./game/news/routes.js";` line and the `registerNewsRoutes(app, deps.db, deps.redis, requireAuth);` call.

```bash
npx vitest run --project @gl3/server test/news.test.ts
npm run typecheck
```

Expected: `news.test.ts` PASS, all cases, unmodified. Typecheck exit 0.

If `hasModuleAccess` is referenced anywhere else after the delete, `tsc` will say so — there was exactly one caller when this plan was written, but check the error rather than assuming.

- [ ] **Step 5: Update `Dockerfile.server`**

Six lines, mirroring the two existing plugin packages. This file **cannot be built or validated on this machine** — Docker is unavailable, and the CI `images` job is the only thing that exercises it. Getting it wrong costs a CI round trip, so copy the `notifications` lines exactly and change only the directory name.

Add alongside each existing `packages/plugins/notifications` line:

```dockerfile
COPY packages/plugins/news/package.json packages/plugins/news/
```
(at both line ~48 and line ~95 — the two dependency-install stages)

```dockerfile
COPY packages/plugins/news/tsconfig.json packages/plugins/news/tsconfig.json
COPY packages/plugins/news/src packages/plugins/news/src
```
(at ~line 63, the build stage)

```dockerfile
COPY --from=builder /app/packages/plugins/news/dist packages/plugins/news/dist
```
(at ~line 107, the runtime stage)

- [ ] **Step 6: Run the full suite and commit**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. Read the exit code, not the summary — an unhandled rejection anywhere makes vitest exit non-zero while still printing a passing test count.

```bash
git add -A
git commit -m "feat(plugins): port the news module to a plugin"
```

---

## Verification

After the last task, run the full suite twice back to back, checking the exit code each time — a single green proves little against an intermittent failure, and this plan touches the shared `game:events` channel and shared Redis keys:

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify > /tmp/verify1.log 2>&1; echo "exit=$?"
npm run verify > /tmp/verify2.log 2>&1; echo "exit=$?"
```

Both must print `exit=0`. Do not run these concurrently with any agent's own suite run.

## Follow-on work (not in this plan)

The six remaining ports — `bank`, `bullets`, `travel`, `crimes`, `mail`, `gangs` — each get their own task, with `crimes` and `gangs` last. `crimes` is the one that consumes the ordering guarantee this plan builds: it publishes `crime.resolved` before `player.jailed`, republishes `crime.resolved` on the idempotent-replay path, and does **not** republish `player.jailed` / `player.rankedUp` there. All three behaviours stay caller-controlled through `publishCore`; nothing in this plan automates them.
