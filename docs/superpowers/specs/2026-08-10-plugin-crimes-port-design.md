# Design: port `crimes` to `@gl3/plugin-crimes`

Date: 2026-08-10
Status: approved, not yet implemented
Predecessors: `2026-08-10-plugin-bank-port-design.md`,
`2026-08-10-plugin-bullets-port-design.md`,
`2026-08-10-travel-plugin-port-design.md`,
`2026-08-10-plugin-core-events-design.md`

---

## 1. What this ports, and why it is next

`apps/server/src/game/crimes/` (`routes.ts`, `worker.ts`) becomes
`packages/plugins/crimes/`. `GET /api/crimes`, `POST /api/crimes/:crimeId/commit`
and the BullMQ worker that resolves a commit all answer from the plugin; the
core directory and the `queue/` module are deleted.

`crimes` is the seventh of twelve `game/*` modules to port and the **first with
a BullMQ worker**. The six prior ports (`ranks`, `notifications`, `news`,
`bank`, `bullets`, `travel`) resolved every action synchronously inside a route
handler. `crimes` does not: the route enqueues a job, and a worker resolves the
outcome in a separate transaction. The plugin job system
(`manifest.jobs`, `ctx.jobs.enqueue`, seeded `ctx.job.rng`, the
`plugin_job_runs` idempotency guard) was built for exactly this module — it has
shipped with `examples/hello-plugin` and a unit test, but no real module has
exercised it. This port is that proof.

Scope is `crimes` alone. `mail` and `gangs` get their own specs.

## 2. The replay gap, and the decision that follows

Core's `processCrimeJob` does one thing the plugin framework cannot reproduce as
written: on a **retried, already-committed** job it republishes `crime.resolved`
anyway (`game/crimes/worker.ts` "Decision 1"). The reasoning is that a BullMQ
retry almost always exists *because* the first attempt committed its
transaction and then died before publishing — staying silent would leave a
client waiting forever for an event that already happened.

The plugin path cannot do this. `ctx.transaction` inserts a `plugin_job_runs`
row as its first statement; a retry hits the primary key and throws
`JobAlreadyAppliedError` *before the handler body runs* (`apps/server/src/plugins/ctx.ts:86-99`).
`runPluginJob` catches that error and treats it as success
(`apps/server/src/plugins/jobs.ts:67`) — the handler body, including every
`publishCore`, never executes. So a replay emits **zero** events, where core
re-emits `crime.resolved`.

The retry that triggers this path is reachable: §2.5 restores `attempts: 3` on
plugin queues, matching core's crime queue, so BullMQ does retry a job whose
publish step threw.

**Decision: accept the behaviour change.** No SDK change. The case it moves is
"transaction committed, then the publish step failed" — a Redis hiccup after a
Postgres commit. Under core that event is eventually redelivered on the retry;
under the plugin it is lost until the client reconnects or re-fetches its
state. That is strictly weaker, and it is the same class of deviation `bullets`
took with its `no_location` 409 (`docs/superpowers/specs/2026-08-10-plugin-bullets-port-design.md`
§3.2): a rare, effectively-unreachable path whose core behaviour was an
incidental property rather than a designed guarantee. Recorded here rather than
smoothed over.

The consequences, made concrete:

- `crime-worker-idempotency.test.ts`'s assertion that a retried job yields two
  `crime.resolved` events (`events.toHaveLength(2)`) becomes **one**, with a
  comment citing this section.
- The double-pay / double-jail / double-rank DB-state assertions in the same
  file are **unaffected** — they assert database state, which is still guarded
  by `plugin_job_runs`, not by events.

## 2.5 Restore `attempts: 3` on plugin queues (loader change)

The §2 replay path is only reachable if BullMQ actually retries. Core's crime
queue sets `defaultJobOptions: { attempts: 3, backoff: { type: "exponential",
delay: 500 }, removeOnComplete: 1000, removeOnFail: 5000 }`
(`apps/server/src/queue/index.ts:21-26`). The plugin loader's
`createPluginQueues` passes **only** `{ connection: redis }`
(`apps/server/src/plugins/jobs.ts:29-31`), and BullMQ's default is `attempts: 1`
— no retry. Without a fix, a plugin crime job never retries, so the §2 case is
unreachable at runtime *and* transient failures (publish throw, transient
Postgres error) become permanent event losses instead of being recovered.

**Fix: copy core's `defaultJobOptions` into `createPluginQueues`.** One object
literal on the `new Queue(...)` call, matching core's crime queue field for
field:

```ts
new Queue(pluginQueueName(prefix, manifest.id, jobName), {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 500 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
}),
```

This is broader than crimes-only — it is shared loader code, so every plugin
job gains retries. That is the intent: the at-least-once model (CLAUDE.md rule
1, ENGINEERING-NOTES) assumes retries happen, and the `plugin_job_runs` guard
makes a retry safe for *any* plugin job, not just crimes. A plugin that
specifically wanted `attempts: 1` has no way to opt out today, and none is
added — per-plugin retry config (a manifest field) was considered and rejected
as SDK surface this one module does not justify. If `mail` or `gangs` later need
it, that is the spec to revisit.

Proven by the retargeted `crime-worker-idempotency.test.ts`: with `attempts: 3`
and the `plugin_job_runs` guard, a hand-driven second `runPluginJob` (a retry's
exact shape) credits once and emits one event (§2), not zero and not double.

## 3. Package shape

`packages/plugins/crimes/` → `@gl3/plugin-crimes`, manifest id `crimes`,
`version: "1.0.0"`, `basePaths: ["/api/crimes"]`, two routes and one job.

It declares **no `menu`, no `pages`, no `events`** — required by
`plugin-manifest-endpoint.test.ts:87`, which asserts a no-arg boot answers
`GET /api/plugins` with exactly `{ menu: [], pages: [], events: [] }`. A `jobs`
declaration is fine: jobs are not part of that payload, and the "core plugin
declares jobs" throw in `app.ts:96-98` is bypassed because both `index.ts` and
`bootTestServer` pass an explicit `plugins` set with a queue prefix, so they
never hit `buildApp`'s default-load guard (see §7).

### 3.1 `src/schema.ts` — mirrors, not ownership

Read mirrors (and one write mirror) of three core-owned tables. Column names
and types match `apps/server/src/db/schema/` exactly. None is declared in the
manifest's `tables` map; none gets a migration here — core owns and migrates
all three. This is the pattern `bullets` and `travel` established (bullets
spec §2.1): schema isolation is compiler-enforced for relational queries
(`PluginDbTx` omits `query`) and for money (`applyBalanceChange`), and is a
**convention** for everything else. A plugin that mirrors a table can write it.

```ts
crimes = pgTable("crimes", {
  id, name, description,
  cooldownSeconds, minPayout, maxPayout,
  minBullets, maxBullets, expReward,
  jailChancePercent, jailSeconds, sort,
})

playerCrimeSkill = pgTable("player_crime_skill", {
  playerId, crimeId, chance,  // read only — GL3 never bumps skill on use
})

crimeLog = pgTable("crime_log", {
  id, playerId, crimeId, success, payout, jobId, createdAt,
})
```

`crimes` is read by both routes and the job. `player_crime_skill` is read by
the list route (chance per crime) and the job (chance for the roll). `crime_log`
is **written** by the job and read by no production path — only acceptance and
idempotency tests assert on it, so the mirror needs only the columns those
write and read.

`payout`/`minPayout`/`maxPayout`/`expReward` are `bigint`; `chance` is
`numeric(5,2)` materialised as a string (`"35.00"`), read as-is for the roll.
`bullets`/`minBullets`/`maxBullets` are `integer`.

### 3.2 `src/index.ts` — the routes

`@gl3/shared` is off-limits, so `IdSchema` is restated (`z.string().uuid()`),
matching `travel` and `bullets`.

#### `listRoute` — `GET /api/crimes`

Ports `game/crimes/routes.ts:26-47` verbatim in behaviour. Reads crimes ordered
by `sort`, reads the player's skill rows, peeks the cooldown, returns the same
body. `DEFAULT_CRIME_CHANCE = "35.00"` is restated in the plugin (V2's default
ladder start, spec §1.2).

```ts
{ crimes: rows.map((c) => ({
  id, name, description,
  cooldownSeconds: c.cooldownSeconds,
  minPayout: c.minPayout.toString(),
  maxPayout: c.maxPayout.toString(),
  chance: skillByCrime.get(c.id) ?? DEFAULT_CRIME_CHANCE,
  cooldownRemaining,
})) }
```

No jail gate: listing is not an action (same as travel's `GET /api/locations`).

#### `commitRoute` — `POST /api/crimes/:crimeId/commit`

Ports `game/crimes/routes.ts:49-93`. `accessInJail: false` — committing is an
action and gates on jail; the loader runs `releaseIfExpired` and answers
`423 { error: "jailed", remainingSeconds }` + `retry-after` (the header was
fixed in the loader ahead of the `bullets` port, so `crimes` inherits it).

| # | Step | Notes |
|---|---|---|
| 1 | jail gate | loader-owned (`accessInJail: false`) → 423 + retry-after |
| 2 | zod-parse `:crimeId` | loader-owned → 400 `invalid_request` on a bad uuid |
| 3 | look the crime up **before** claiming cooldown | a typo costs nothing |
| 4 | missing crime → `PluginError("crime_not_found", 404)` | |
| 5 | `ctx.cooldown.acquire("crime", playerId, crime.cooldownSeconds)` | `SET NX EX` (rule 2) |
| 6 | miss → `PluginError("on_cooldown", 429, { retryAfter }, { "retry-after": … })` | |
| 7 | `const jobId = await ctx.jobs.enqueue("commit", { playerId, crimeId })` | seed generated in `ctx.jobs.enqueue` |
| 8 | enqueue throws → `ctx.cooldown.release("crime", playerId)` then rethrow | don't strand the player |
| 9 | return `{ status: 202, body: { jobId, accepted: true } }` | outcome arrives over WS |

`ctx.player` is non-null on a route, so `actorId`/`actorName` come from it; but
the route never needs them — the job resolves the actor itself (§4).

## 4. The `commit` job — the core of the port

Ports `processCrimeJob` (`game/crimes/worker.ts:50-225`) into the plugin
transaction model. This is where `crimes` diverges from every prior port.

### 4.1 Pre-transaction reads

Same as core. `ctx.player` is `null` inside a job (`plugins/ctx.ts:56`), so the
actor is resolved from the database, not the snapshot:

- fetch `crimes` by id — drop the job if gone (deleted between enqueue and resolve)
- fetch `players.username` for the actor — drop if gone
- fetch `player_crime_skill` → `chance`, fallback `DEFAULT_CRIME_CHANCE`

These are unlocked reads, as in core. The roll depends only on the seed and the
chance, and the chance is seeded once at registration (GL3 has no
progression-by-use — verified: nothing in `game/` writes `player_crime_skill`).
An unlocked read of a value that no concurrent writer changes is safe.

### 4.2 The roll — seeded, verbatim

The RNG is `ctx.job.rng`, derived from `job.data.seed`, which `ctx.jobs.enqueue`
generated at enqueue time (`plugins/ctx.ts:241`). A BullMQ retry replays the
same seed, so the outcome is reproducible — but reproducibility is not
idempotency (ENGINEERING-NOTES); `plugin_job_runs` is what stops the replay
re-applying side effects.

```ts
const roll = ctx.job.rng.int(0, 10_000);          // two decimals of precision
const success = roll < Math.round(chance * 100);
const payout = success ? ctx.job.rng.bigint(crime.minPayout, crime.maxPayout) : 0n;
const bullets = success ? BigInt(ctx.job.rng.int(crime.minBullets, crime.maxBullets + 1)) : 0n;
const exp = success ? crime.expReward : 0n;
const jailRoll = !success && crime.jailChancePercent > 0 ? ctx.job.rng.int(0, 100) : 100;
const jailed = jailRoll < crime.jailChancePercent;
```

Identical to core, draw for draw, from the same seeded stream. The `jailRoll`
default-100 makes a successful crime or a zero-`jailChancePercent` crime never
jail.

### 4.3 The one transaction

```ts
await ctx.transaction(async (tx) => {
  // (0) plugin_job_runs insert is ALREADY FIRST — structural in ctx.ts:86-99.
  //     A retry throws JobAlreadyAppliedError before this closure body runs;
  //     runPluginJob swallows it. The plugin never writes this key.
  await tx.db.insert(crimeLog).values({
    id: uuidv7(), playerId, crimeId, success, payout, jobId: ctx.job!.id,
  });                       // (1) crime_log row — same data, no longer the guard
  if (payout > 0n) {         // (2)
    await tx.economy.applyBalanceChange(
      { playerId, amount: payout, kind: "cash", reason: "crime.payout", refId: crimeId });
  }
  let promotion = null;      // (3)
  if (exp > 0n) promotion = await tx.economy.applyExpAndRankUp(playerId, exp);
  if (jailed) await tx.jail.sendToJail(playerId, crime.jailSeconds);  // (4)
  // (5) in-tx read for effectiveJailedUntil — see §4.4
  const [fresh] = await tx.db.select({ jailedUntil: playerStats.jailedUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  // (6) buffer the events — flushed after commit, in this order
  await tx.events.publishCore({ type: "crime.resolved", …, jailedUntil: … });
  if (jailed) await tx.events.publishCore({ type: "player.jailed", … });
  if (promotion) await tx.events.publishCore({ type: "player.rankedUp", … });
  return promotion;
});
```

**No explicit locks.** Crimes is single-player: no location, no gang, no second
player. `applyBalanceChange`, `sendToJail` and `applyExpAndRankUp` each take the
player row lock internally, in the same ascending-id order, so the transaction
is deadlock-free by construction. There is no lock-order surface to regress
(§6).

`crime_log.job_id` is populated (the m1 acceptance test and the idempotency test
assert on it) but it is **no longer the idempotency guard**. That role moves to
`plugin_job_runs (plugin_id, job_id)`. The `crime_log_job_id_unique` index stays
in the schema — core owns it — and is now incidental rather than load-bearing.

### 4.4 `effectiveJailedUntil` — an in-transaction read

Core re-reads `player_stats.jailedUntil` **after** the transaction commits
(`worker.ts:129-131`) so `crime.resolved` reports the player's real jail state
on an idempotent replay — the local `jailed` flag is wrong on a replay, because
the replay's jail (if any) was written by the *original* attempt.

The plugin cannot re-read after `ctx.transaction` returns: the event is
buffered *inside* the transaction and flushed by the loader after commit. The
resolution is a **single read inside the transaction, after `sendToJail`**
(step 5 above). It is the same connection, so it sees its own write; it is the
committed value on the fresh path; and on the replay path it never runs at all
(`JobAlreadyAppliedError` aborts first). Correct by construction, and one fewer
round trip than core's post-commit re-read.

### 4.5 What the ctx absorbs

Two core responsibilities collapse into the ctx machinery, deleting code:

1. **Leaderboard scores.** Core re-reads `player_stats.exp` and `.cash` after
   the transaction and calls `recordScore` by hand (`worker.ts:147-154`). The
   ctx economy wrappers buffer one score per changed kind and flush after
   commit (`plugins/ctx.ts:120-152`). So the ported job's
   `applyBalanceChange` + `applyExpAndRankUp` already keep both leaderboards
   current. The manual re-reads and `recordScore` calls are deleted.
2. **The `alreadyProcessed` branch.** Core branches on a caught
   `crime_log_job_id_unique` violation to drive the replay-republish (§2). The
   plugin path makes that branch unreachable — `JobAlreadyAppliedError` aborts
   the closure before any `publishCore`. Deleted.

## 5. Errors and the wire contract

Every status code, error string and response body on the **route** is
unchanged:

| Condition | Response | Source |
|---|---|---|
| `GET` success | `200 { crimes: […] }` | `listRoute` |
| `POST` accepted | `202 { jobId, accepted: true }` | `commitRoute` |
| Bad `:crimeId` uuid | `400 { error: "invalid_request" }` | loader zod gate |
| Crime not found | `404 { error: "crime_not_found" }` | `PluginError` |
| On cooldown | `429 { error: "on_cooldown", retryAfter }` + `retry-after` | `PluginError` + header |
| Jailed | `423 { error: "jailed", remainingSeconds }` + `retry-after` | loader gate |
| No token | `401` | `app.requireAuth` |

The job has no wire contract — it publishes `crime.resolved`,
`player.jailed`, `player.rankedUp` to the player's private audience, exactly as
core did, via `publishCore` (byte-identical envelope shape, `id`/`at` filled by
the SDK).

## 6. Lock order — none to test

Crimes touches only the acting player's row. There is no location, no gang, no
second player, and therefore no multi-row lock and no ABBA surface. Unlike
`bullets` (location→player) and `travel` (locations→player), there is nothing
for a `crimes-lock-order.test.ts` to regress. **No lock-order test is added**,
and this section exists so a future reader does not add one expecting parity
with the bullets/travel ports. If crimes ever grows a second lock (e.g. an
accomplice), this changes.

## 7. Cutover

Crimes is the `queue/` module's only consumer, so the cutover deletes more than
the prior ports did.

**Delete:**
- `apps/server/src/game/crimes/` (`routes.ts`, `worker.ts`)
- `apps/server/src/queue/index.ts` (`CRIME_QUEUE`, `CrimeJobData`,
  `createCrimeQueue`) — the whole file, crimes was its only consumer
- `apps/server/src/index.ts` — `startCrimeWorker`, `createCrimeQueue`, the
  `crimeQueue` const (the plugin's worker comes from `createPluginWorkers`
  via the loader)
- `apps/server/src/app.ts` — `crimeQueue: Queue<CrimeJobData>` from `AppDeps`,
  the `registerCrimeRoutes` call and its import

**`AppDeps` loses a required field.** Today six test files plus
`helpers/server.ts` and `index.ts` construct a `crimeQueue` purely to satisfy
the required field. After it drops:

- `helpers/server.ts:34,48,79,98` — the crime queue + worker setup collapses
  into the plugin worker the loader already starts. `startCrimeWorker` and
  `createCrimeQueue` imports go. `bootTestServer` keeps its prefixed plugin
  queue isolation (`plugin-test-${uuid}:`).
- `bank.test.ts:114`, `bullets.test.ts:127`, `jail.test.ts:88`,
  `leaderboard.test.ts:78`, `ranks.test.ts:91`, `travel.test.ts:275,334` — each
  drops its `createCrimeQueue(createRedis(...))` argument. They were throwaway
  queues satisfying a field the route never read.

**The jobs-for-core-plugins throw is not hit.** `app.ts:96-98` throws only on
`buildApp`'s *default* load path (`deps.plugins === undefined`). Both real
entry points pass plugins explicitly: `index.ts` via
`withCorePlugins(optionalManifests)` + `loadPlugins(...)`, and `bootTestServer`
the same with a random prefix. Crimes declaring `jobs` is fine on both paths.
The default-load path remains a hard error if any core plugin ever declares
jobs without an isolated prefix — this port does not relax that guard.

## 8. Registration sites

A new plugin package has eight registration sites, three of which fail
silently or only in CI (CLAUDE.md). All eight, with `travel`/`bullets` as the
template:

1. `packages/plugins/crimes/` — `package.json`, `tsconfig.json`, `src/`
2. `apps/server/package.json` — `"@gl3/plugin-crimes": "*"`, then `npm install`
3. `apps/server/tsconfig.json` — a `references` entry. **Fails only in CI.**
   Catch locally with `npx tsc --build --force apps/server/tsconfig.json`
4. root `tsconfig.json` — a `references` entry
5. `vitest.workspace.ts` — a `srcAliases` entry (`@gl3/plugin-crimes`).
   **Fails nothing**; silently grades a src-only edit against a stale `dist/`
6. `apps/server/src/plugins/core-plugins.ts` — import and add to `CORE_PLUGINS`
7. `apps/server/src/app.ts` — delete `registerCrimeRoutes` (§7)
8. `Dockerfile.server` — **five** COPY sites.
   `grep -c "packages/plugins/crimes" Dockerfile.server` must be 5. **Fails only in CI.**

## 9. Testing

**Existing files that change:**

- **`crimes.test.ts`** — the `app.inject` blocks for `GET /api/crimes` and
  `POST …/commit` (including the two-concurrent-commits-exactly-one-accepted,
  404, 429, 423 cases) are the byte-identity proof and stay unchanged. The
  `describe("processCrimeJob — jail and rank-up wiring")` block
  (`crimes.test.ts:137-206`) imports `../src/game/crimes/worker.js` directly and
  calls `processCrimeJob(db, redis, …)`. That path is deleted. Both tests
  retarget to the real plugin handler via `runPluginJob`:

  ```ts
  import { runPluginJob } from "../src/plugins/jobs.js";
  import crimesPlugin from "@gl3/plugin-crimes";
  await runPluginJob(deps, crimesPlugin, "commit", { id: "jail-test-job", data: { playerId, crimeId, seed } });
  ```

  `runPluginJob` drives the real handler in-process against real Postgres and
  Redis, with the real `plugin_job_runs` guard. The jail and rank-up assertions
  (jailedUntil not extended on retry; rankId/cash not doubled) are unchanged.

- **`crime-worker-idempotency.test.ts`** — both describes retarget to
  `runPluginJob`. The double-pay / double-jail / double-rank DB-state
  assertions hold unchanged (guarded by `plugin_job_runs`). The
  `events.toHaveLength(2)` assertion becomes `1`, with a comment citing §2.
  The `logs[0]?.jobId === job.id` assertion holds — `crime_log` still records
  `jobId`.

- **`acceptance/m1-vertical-slice.test.ts`** — asserts `crime_log` row counts
  after commit. Unchanged: the plugin still writes `crime_log`. The full HTTP
  commit path (route → enqueue → worker → event) still works end to end.

- **`economy-invariant.test.ts`** — calls `processCrimeJob` directly (`:102`).
  Retargets to `runPluginJob` like the others. The 1000-op
  `sum(ledger) == balance` sweep keeps covering crimes' real path.

**No new test file.** §6 explains why there is no lock-order test.

**The proof-it-can-fail discipline (CLAUDE.md):** the retargeted idempotency
test is the proof. Before accepting, demonstrate it red against a handler that
credits without the guard (e.g. a handler whose transaction does not go through
`ctx.transaction`, or a temporarily-broken `plugin_job_runs` path) — show
double-pay — then green under the real handler. The two-concurrent-commits test
in `crimes.test.ts` is the cooldown-claim proof and is unchanged.

**vitest.workspace.ts:** the retargeted *files* are already in the `include`
lists (they exist). The `@gl3/plugin-crimes` `srcAliases` entry is the one
addition needed so a test importing the plugin resolves to source, not a stale
`dist/`.

## 10. Out of scope

- `mail`, `gangs` — their own specs.
- The §2 replay deviation — accepted, not fixable without an SDK change.
- Skill progression by use. V2 raised `US_crimes` chances on successful crimes;
  GL3 does not (no writer exists in `game/`). The migrator explodes `US_crimes`
  into seeded `player_crime_skill` rows (M4); runtime never bumps them. Not
  introduced here.
- Any change to crime seeding, payout ranges, jail chances or cooldowns.
- The three Minors carried forward from the `bank` branch review
  (`docs/STATUS.md`); none is in code this port touches — though §4.4's
  in-tx read does finally give `applyExpAndRankUp`'s zero-gain path a caller
  adjacent to it, which is the natural place to close Minor 1 if that work is
  taken up later.
