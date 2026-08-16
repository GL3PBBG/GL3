# Rounds — seasonal scoring — design

**Date:** 2026-08-16
**Status:** approved
**Cluster:** fourth and last of four activating migrated-but-unread V2 tables
(`rounds`, and the dormant `players.round_id` column). Follows
`2026-08-15-properties-design.md`.

Rounds give GL3 a repeating scoring window — a season — without wiping
anything. An administrator schedules rounds ahead of time; while a round is
open every player's standing in it is the **progress they made inside the
window**, computed as `current − snapshot` from a `round_entries` row written
once when they joined; when `ends_at` passes, the next request that notices
finalizes the round under a Postgres advisory lock — freezing every
participant's figures, paying `points` to the top exp placers through
`applyBalanceChange`, and snapshotting the whole population into the next
scheduled round. Finished rounds stay queryable forever and are the hall of
fame. This is core, not a plugin; it adds one core migration (`0011`), two
`GameEvent` variants, three read routes, four admin routes and one web page,
and it reads or writes **no** plugin-owned table.

**Terminology**, one name per concept throughout. An **entry** is a
`round_entries` row — one per player per round. The **snapshot** is the
`*_at_start` figures that entry carries, written once when the player enters
the round. The **freeze** is writing `final_*` into every entry of a round that
is settling. **Finalize** is the freeze-pay-stamp-advance sequence for one
round; **rollover** is the whole lazy operation, which may finalize several
rounds in a row. A **standing** is one player's number for one metric in one
round; a **board** is the ordered list of them. The paid placers are the
**winners**. The **hall of fame** is the finished-round view over the same
entries.

---

## 1. Goal, non-goals, and data model

### 1.1 Goal

An administrator schedules rounds ahead of time (`name`, `starts_at`,
`ends_at`); while a round is open, each player has a standing in it equal to the
**progress they made inside the window**, not their absolute total; when a
round's `ends_at` passes, the next request that notices finalizes it — freezing
every participant's final numbers, paying `points` to the top placers through
`applyBalanceChange`, and snapshotting everybody into the next scheduled round.
Finished rounds stay queryable forever and are the hall of fame. Nothing is
deleted, nothing is reset, and no worker or cron job is introduced: rollover is
lazy-at-read under a Postgres advisory transaction lock, the same idiom jail
expiry, hospital discharge, detective reveals and property income already use
(§2.1).

### 1.2 Why a soft season, not a wipe

The genre reflex is a hard wipe: at the end of a round, cash, exp, items, gangs
and properties all go back to zero, and everyone starts level. We are explicitly
not doing that.

A wipe is what you reach for when the economy is bad. If money compounds so
hard that a month-old player can never be caught, deleting everyone's money
every few months is a way of hiding that — it resets the symptom on a timer. The
answer is to build an economy where progress does not run away in the first
place, and then a wipe buys nothing that is worth what it costs: players lose
the items they bought, the gang they built, the property they saved for, and a
returning veteran finds an empty account instead of the character they left.

So a round in GL3 is a **scoring window and nothing else**. The single most
important property of this design, and the one every later decision defers to:

> **No plugin-owned table is ever read or written by this feature. No player
> asset is ever deleted or reset. There is no plugin reset hook, and none is
> needed.**

If a future task finds itself wanting a `reset()` on the plugin SDK, that task
has misread this spec.

### 1.3 The problem a soft season creates, and the fix

Because nothing is wiped, a round board built on absolute totals is just the
all-time board with a new title. Worse, it is permanently closed: a player who
registers during round 3 is behind by two rounds of accumulation and can never
place, no matter how well they play.

The fix is to score the **delta over the window**:

* At the moment a player enters a round, core writes a snapshot of their stats —
  exp, cash, bank — into a new table, `round_entries`.
* Their standing in that round, for any metric, is `current − snapshot`.
* When the round finalizes, `current` is frozen into the same entry, so a settled
  board never moves again.

This costs **no hot-path write anywhere**. Nothing is added to
`applyBalanceChange`, to `addExp`, to any plugin, or to any money path. The
snapshot is written once per player per round; everything else is a subtraction
performed at read time.

### 1.4 Non-goals

These are decisions, not omissions. Each one is a thing an implementer might
reasonably add, and each is deliberately excluded.

1. **No wipe, no reset, no plugin reset hook.** See §1.2. No plugin-owned table
   (`p_inventory_*`, `p_oc_*`, `p_bounties_*`, `p_detectives_*`, `p_combat_*`,
   `p_theft_*`, `p_properties_*`) is read or written by any code in this
   feature. There is no relinquish migration and no plugin gains one: the count
   stays **seven of sixteen plugins declaring migrations**.
2. **No new worker, no cron, no BullMQ queue.** Core has no workers and is not
   getting one for this. Rollover happens lazily, in-request, under
   `pg_advisory_xact_lock` (§2.1). The tail-latency cost of that choice is named
   plainly in §5.5 risk 1 rather than hidden.
3. **No new leaderboard kinds.** Round boards use the existing
   `LeaderboardKindSchema` enum — `cash`, `bank`, `exp` — unchanged
   (`packages/shared/src/dto/leaderboard.ts`). No `points` board, no `rank`
   board, no `kills` board.
4. **No new Redis structures and no change to the existing ZSETs.**
   `recordScore`, `topN` and `rebuildLeaderboards` in
   `apps/server/src/game/leaderboard/service.ts` keep their exact current
   behaviour, and the `leaderboard:{cash,bank,exp}` ZSETs stay **all-time
   absolute values**. Round boards are computed in Postgres; the write-cost
   argument that settles this is §3.1.
5. **No schema change to `players` beyond writing a column that already
   exists.** `players.round_id` was created by `0000_core_schema.sql`, has an FK
   to `rounds` (`ON DELETE set null`) and an index (`players_round_idx`), and is
   today written by exactly one thing in the repo — the V2 migrator at
   `apps/migrate/src/migrators/players.ts:37,42,46`. No code in `apps/server`
   reads or writes it. This feature is the **first server code ever to write
   it**. It does not alter it. The column has been a dormant migrated column,
   exactly like properties' `plugin_id`.
6. **No "end it now" admin button.** The schedule is the mechanism: setting
   `ends_at` to a past instant *is* ending the round now. A second path to the
   same effect would be a second thing to keep consistent with the overlap rule
   (§4.2).
7. **No top-N truncation of history.** Every participant's entry in every
   finished round is retained — see §1.6.

### 1.5 Data model

Two changes, both in core, both in migration `0011`.

#### 1.5.1 `rounds` gains two columns, and the nullable-dates rule

`rounds` already exists — created by `apps/server/drizzle/0000_core_schema.sql`
lines 78-83, declared at `apps/server/src/db/schema/identity.ts:26-31`:

```ts
export const rounds = pgTable("rounds", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
});
```

It gains exactly two columns, `finalized_at` and `snapshotted_at`:

```sql
ALTER TABLE "rounds" ADD COLUMN "finalized_at" timestamp with time zone;
ALTER TABLE "rounds" ADD COLUMN "snapshotted_at" timestamp with time zone;
```

and in the drizzle declaration, appended after `endsAt`:

```ts
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  snapshottedAt: timestamp("snapshotted_at", { withTimezone: true }),
```

**`snapshotted_at` marks that the round's opening population has been taken.**
A round's board is a delta from a starting position, so every round needs one
whole-population `INSERT ... SELECT FROM player_stats` before its board means
anything. That insert happens **when the round becomes active** — the first
`ensureCurrentRound` at or after `starts_at` — not when its predecessor
settles, and not at creation time. `snapshotted_at IS NULL` is the flag that
says the insert is still owed; stamping it is what makes the activation
idempotent, exactly as `finalized_at` makes the settle idempotent. §2.2a is the
full mechanism and §2.3 step 4 explains why finalize deliberately does *not*
snapshot its successor.

The two stamps are independent and both are needed. Without `snapshotted_at`,
"has this round been snapshotted?" can only be asked as `SELECT count(*) FROM
round_entries WHERE round_id = $1` — which is a different question (it is also
0 for a round snapshotted on an empty install) and which cannot be made
race-safe by a `WHERE` guard on an `UPDATE`.

`finalized_at` separates **ended** from **settled**. `ends_at < now()` says the
window is over; `finalized_at IS NOT NULL` says the freeze-and-pay ran. Keeping
them separate is what makes finalize idempotent: the rollover transaction is
guarded by `WHERE finalized_at IS NULL`, so a hundred concurrent requests that
all notice the same expired round produce exactly one payout — the first one
through the advisory lock does the work, the rest find `finalized_at` already
set and update zero rows. §2.4 is the full argument for why the lock and the
guard are two independent defences rather than one mechanism stated twice.

Rejected alternative: reusing `ends_at IS NOT NULL AND ends_at < now()` as the
settled test, with no new column. That conflates "the clock ran out" with "we
paid", and the moment those two differ — which is precisely the window this
feature lives in — there is no way to tell whether a payout already happened.
One nullable timestamp is the cheapest possible fix.

**`starts_at` and `ends_at` stay nullable.** They were created nullable in
`0000`, V2-migrated installs have rows with real values from the legacy game,
and tightening them to `NOT NULL` would mean inventing dates for any row that
lacks them. Instead the rule is stated once, here, and enforced in every read
path:

> **A round is active at instant `T` iff
> `starts_at IS NOT NULL AND starts_at <= T AND (ends_at IS NULL OR ends_at > T)`.**
> The interval is half-open: `[starts_at, ends_at)`.

The two null cases are not symmetric, and this is deliberate:

* **`starts_at IS NULL` means the row can never be active.** A round with no
  start is a name and nothing else: it is never selected as the active round, it
  never receives snapshots, it is never finalized, and it is excluded from the
  overlap check (§4.2) because it cannot collide with anything.
* **`ends_at IS NULL` means "runs until an admin gives it an end date".** Such a
  round *is* active and simply never rolls over. That is not a special case
  invented here: `apps/migrate/src/migrators/rounds.ts:20` writes
  `endsAt: unixToDate(row.RND_end)` from a nullable `RND_end`, so every migrated
  V2 install already has exactly one open-ended round shaped like this. Its
  practical consequence for scheduling is the forcing function in §4.2.

The admin create/edit routes require both fields, so every round created through
GL3 has them.

#### 1.5.2 New core table `round_entries`

One entry per player per round. It carries the snapshot taken when the player
entered the round, and — once the round finalizes — the frozen final figures.

DDL, in `apps/server/drizzle/0011_round_entries.sql`:

```sql
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
```

with the two foreign keys and one index:

```sql
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "round_entries_player_idx" ON "round_entries" USING btree ("player_id");
```

Notes on each choice:

* **Composite primary key `(round_id, player_id)`**, in that order. It is the
  uniqueness constraint the design needs ("one entry per player per round") and
  simultaneously the index the live-board query uses: `WHERE re.round_id = $1`
  is a prefix scan on the PK. This matches the shape core already uses for
  `role_module_access`, `player_items` and `player_timers` — composite PK, no
  surrogate id. A surrogate `id uuid` plus a unique index would be one more
  column and one more index for nothing.
* **`ON DELETE cascade` on both FKs.** Deleting a player removes their entries
  (same as `player_stats`, `player_items`, `player_timers`); deleting a round
  removes its entries. `set null` is impossible here — both columns are part of
  the primary key. Note that `players.round_id` keeps its existing `set null`
  and is untouched.
* **`round_entries_player_idx` on `player_id`.** The PK covers round-scoped
  reads; this index covers the other direction — "every round this player has
  played", which is how a player's own hall-of-fame history is read.
* **Bigint defaults are written `DEFAULT 0` in SQL and `` .default(sql`0`) `` in
  drizzle, never `.default(0n)`** — drizzle-kit's serialiser crashes on
  `BigInt`. This is the same convention as every bigint in `player_stats`.
* **The `final_*` columns are nullable and have no default.** NULL means "this
  round has not been finalized for this player". That is the discriminator the
  standing formula reads; a default of 0 would be indistinguishable from a
  player who genuinely finished on zero.

**One index is added to `rounds`**, and only one:

```sql
CREATE INDEX "rounds_open_idx" ON "rounds" USING btree ("starts_at") WHERE "finalized_at" IS NULL;
```

It exists for exactly one read — `ensureCurrentRound`'s unlocked probe (§2.2),
which sits at the head of every rounds and leaderboard request and is the one
query in this feature on a hot path. It is a plain partial index in the same
form `apps/server/drizzle/0008_sentence_expiry_indexes.sql` uses, so it runs
inside a transaction (`CREATE INDEX CONCURRENTLY` could not; drizzle runs all
pending migrations in a single transaction). **No index is added on `ends_at`.**
A GL3 install has a handful of round rows — V2's largest had tens — nothing
looks a round up by its end date, and that line of DDL would never be used.

Drizzle declaration, appended to `apps/server/src/db/schema/identity.ts`
immediately after the `playerStats` block and before `playerTimers` (it
references both `rounds` and `players`, and both live in this same file — which
is exactly why it belongs here and not in a new schema file; a new file would
need an extra `export *` line in `apps/server/src/db/schema/index.ts` and would
import `players` across files for no benefit):

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

Every identifier used here — `pgTable`, `uuid`, `bigint`, `timestamp`,
`primaryKey`, `index`, `sql` — is already imported at the top of
`identity.ts:1-5`. No new imports are required.

#### 1.5.3 The migration: `0011_round_entries.sql`

The highest core migration today is `0010_relinquish_properties`, so **the next
core migration number is 0011** and the file is:

```
apps/server/drizzle/0011_round_entries.sql
```

The filename stem must equal the journal tag exactly — the drizzle runner reads
`${folder}/${tag}.sql` and never lists the directory. Because this migration is
hand-written (it is not a pure drizzle-kit generation),
`apps/server/drizzle/meta/_journal.json` **must be hand-edited** to add an
eleventh entry. A `.sql` file absent from the journal never runs, silently:

```json
    {
      "idx": 11,
      "version": "7",
      "when": 1787002800000,
      "tag": "0011_round_entries",
      "breakpoints": true
    }
```

`when` must be strictly greater than `0010`'s `1786916400000` or the migration
is skipped without error. `1787002800000` is exactly 86400000 greater, matching
the hand-picked cadence `0009` and `0010` already use. No `meta/0011_*.json`
snapshot is written — `0005`, `0006`, `0009` and `0010` have none either, for
the same reason.

The file contains **eight statements**, separated by the literal marker
`--> statement-breakpoint`, in this order:

1. `ALTER TABLE "rounds" ADD COLUMN "finalized_at" timestamp with time zone;`
2. `ALTER TABLE "rounds" ADD COLUMN "snapshotted_at" timestamp with time zone;`
3. `CREATE TABLE "round_entries" (...)`
4. `ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_round_id_rounds_id_fk" ...`
5. `ALTER TABLE "round_entries" ADD CONSTRAINT "round_entries_player_id_players_id_fk" ...`
6. `CREATE INDEX "round_entries_player_idx" ...`
7. `CREATE INDEX "rounds_open_idx" ON "rounds" USING btree ("starts_at") WHERE "finalized_at" IS NULL;`
8. The settle-the-past `UPDATE` below.

All pending core migrations run inside a single transaction, so every statement
either commits or rolls back together.

**Statement 8 is DML, and it is not optional.** It is:

```sql
UPDATE "rounds"
   SET "finalized_at" = now(), "snapshotted_at" = now()
 WHERE "ends_at" IS NOT NULL AND "ends_at" < now();
```

The reason is the V2-migrated install, which is the only kind of install that
has `rounds` rows before this migration runs. `apps/migrate` copies **every**
historical V2 round — a long-running install has tens of them, all long expired.
Without statement 8 every one of them lands `finalized_at = NULL`, which the
`ensureCurrentRound` probe (§2.2) reads as "expired and unsettled". The probe
picks the *earliest* such round, so the first request after deploy would
cascade-finalize the entire V2 history in one transaction, publishing a
`round.finished` per round and paying out a settings-configured award per round
to whoever happened to have entries — which is nobody, since no `round_entries`
row exists for any of them. Above the §2.6 cap of 50 the cascade throws instead,
and because `ensureCurrentRound` sits at the head of every rounds and
leaderboard request, **every one of those requests 500s from then on**, with no
way out short of a manual `UPDATE`. Statement 8 is that `UPDATE`, run once, at
the only moment it is guaranteed to be safe.

Stamping `snapshotted_at` alongside matters for the same reason: a round already
marked finalized must never be picked up by the activation path (§2.2a) either.
Both stamps together say "this row is history; leave it alone".

The statement is deliberately conservative:

* It touches only rows that are **unambiguously over** — `ends_at IS NOT NULL
  AND ends_at < now()`. A migrated open-ended round (`ends_at IS NULL`, which
  §1.5.1 notes every V2 install has exactly one of) is left alone and becomes
  the install's live round, which is the correct outcome. A round whose window
  is still open is left alone.
* On a fresh install it matches zero rows and is a no-op, so it costs nothing
  in the common case and needs no `IF EXISTS`-style guard.
* It is idempotent by construction: re-running it re-stamps rows that already
  carry both timestamps, and drizzle's journal means it never runs twice anyway.
* `now()` inside the migration transaction is the transaction's start time, so
  every row gets one identical timestamp. That timestamp is not a claim about
  when the round *actually* ended — it is a marker meaning "settled at the
  moment GL3 took ownership", which is the same convention the properties V2
  migrator uses when it stamps `last_claimed_at` (`apps/migrate/src/migrators/
  properties.ts:32`).

Note that this is DML in a *core drizzle migration*, which is new — the
properties precedent above lives in the V2 migration CLI, not in
`apps/server/drizzle/`. So core loses its previous property that no core
migration contains an `INSERT`/`UPDATE`/`DELETE`. That property was never a
rule, only an observation, and the alternative — shipping a feature that
bricks every migrated install on first request — is not a trade.

It carries a comment header in the house style of `0006`, `0007`, `0009` and
`0010`: what the migration is for, plus the paragraph above on why statement 8
exists, since a future reader deleting it as "a stray backfill" is exactly the
mistake the comment has to prevent.

### 1.6 The hall of fame is the same table

There is no `round_winners` table, and adding one would be a mistake.

When a round finalizes, its entries are frozen in place by writing `final_exp` /
`final_cash` / `final_bank`. That freeze is complete: **every participant's
entry is kept, not just the winners'.** The consequence is that "the hall of
fame" and "the round board" are the same query against the same rows, differing
only in which round id is passed and in whether the board reads frozen or live
figures.

This removes a decision that is easy to get wrong and expensive to change later:
*how many winners do we keep?* Store only a top-N and the number is baked into
history — a later "show top 25" is unanswerable for every round already
finalized, and a player who came 11th in a round they played for three months
has no record they were ever there. Keeping every entry costs one row per player
per round, which at V2's real scale (thousands of players, a round every few
weeks) is trivial, and it makes "which rounds have I played, and where did I
place in each" a normal query rather than a feature request.

### 1.7 The standing formula

For a round `R`, a player `P`, and a metric `m ∈ {exp, cash, bank}`:

```
standing(R, P, m) = (final_m ?? current_m) − m_at_start
```

where `final_m` is `round_entries.final_{exp,cash,bank}` and `current_m` is
`player_stats.{exp,cash,bank}`. In practice:

* **Live round** (`finalized_at IS NULL`): `final_m` is NULL, so the standing is
  `player_stats.m − round_entries.m_at_start`, joined on `player_id`. It moves
  as the player plays.
* **Finalized round** (`finalized_at IS NOT NULL`): `final_m` is set, so the
  standing is `round_entries.final_m − round_entries.m_at_start` and does not
  touch `player_stats` at all. A settled board can never move again — not when
  the player later earns money, not when they quit, not when a plugin is
  installed or removed.

Two properties of this formula look like bugs to someone who has not read the
rest of the spec, and neither is:

* **A negative standing is a real standing.** `cash` and `bank` deltas go
  negative for a player who spent their round buying properties, weapons and
  bullets, and the board displays them negative. The full argument, and the
  three things an implementer must not "fix", is §3.5.
* **`exp` is monotonic**, so the exp board is the one that reads as "who played
  hardest". Nothing in GL3 reduces exp. It is the default board and the payout
  board (§3.6).

Nothing is stored for a standing. It is a subtraction performed at read, over
rows that were written once.

### 1.8 Why core, not a plugin

GL3's table-ownership rule pushes new gameplay tables toward the plugin that
consumes them — that is what core migrations `0007`, `0009` and `0010` exist to
correct. Rounds are the case that rule does not reach, for four independent
reasons:

1. `rounds` is **already a core table** (`0000_core_schema.sql`, SPEC §2.5) and
   is not a plugin's to take.
2. Rollover writes `players.round_id` — a core column with a core FK. The plugin
   SDK exposes no write access to `players`.
3. Round standings are a second view over the core leaderboard service and share
   its `LeaderboardKind` enum and DTOs, which live in `@gl3/shared`, not in any
   plugin's surface.
4. Registration must write a `round_entries` row inside the **core** auth
   transaction at `apps/server/src/auth/routes.ts` — a plugin cannot join that
   transaction.

A plugin would need write access to two core tables plus leaderboard internals,
none of which the SDK exposes, and inventing that access would widen the SDK's
trust surface for one feature. Rounds are core. There is no relinquish
migration and the plugin migration count stays at seven of sixteen.

---

## 2. Rollover, finalize, and lock order

### 2.1 Why lazy-at-read, and not a cron job or a worker

Core has no workers and no scheduler. Every time-based mechanic in GL3 already
resolves on the next request that cares, and rounds join that list rather than
starting a new one:

- **Jail.** `releaseIfExpiredWithOutcome` in
  `apps/server/src/game/jail/status.ts:44` is the only place an expired
  `jailed_until` is cleared, and its own comment says why: "every gated route
  calls it first, so release happens lazily on the player's next request
  instead of needing a cron job."
- **Hospital.** `settleHospital` / `dischargeIfExpired` in
  `apps/server/src/game/hospital/status.ts:68,111` do the same for
  `hospital_until`, restoring health in the same statement.
- **Detectives.** The search outcome is rolled and stored at purchase time and
  hidden behind a time gate; the comment at
  `packages/plugins/detectives/src/index.ts:206-209` reads "The outcome sits
  hidden in the row until ends_at (time-gated reveal) — no delayed job needed."
- **Properties.** Income is never stored. `accruedSince`
  (`packages/plugins/properties/src/resolve.ts:9`) computes whole elapsed hours
  from `last_claimed_at` at read time, capped by the `income.cap` setting.

The one background process in the tree, `startSentenceSweeper`, is an
optimisation on top of the lazy path, not a replacement for it: it exists to
turn a jail release into a WebSocket push rather than a client poll, it is
started in `apps/server/src/index.ts:73-78` and deliberately *not* in
`buildApp`, and if it never ran the game would still be correct.

Rounds follow the same idiom. Admin creates rounds ahead of time (§4.2); the
active round is whichever row covers now (§1.5.1); and the first request to
notice that `ends_at` has passed performs the rollover. No cron, no queue, no
new worker.

The rejected alternative is a BullMQ delayed job fired at round creation for
`ends_at`. It loses on three counts. It makes an admin edit to `ends_at` a
job-rescheduling problem (cancel, re-enqueue, and handle the job that already
fired for the old time). It makes the round schedule depend on Redis, when
Postgres is the source of truth for every other sentence in the game for
exactly the reason jail's comment gives — a Redis flush must not change game
state. And BullMQ is at-least-once (CLAUDE.md rule 1), so the job would need
its own idempotency key on top of the `finalized_at` guard we need anyway. The
guard alone is simpler and covers both.

### 2.2 `ensureCurrentRound` — contract

Lives in **`apps/server/src/game/rounds/service.ts`** (new directory, beside
`game/jail`, `game/hospital`, `game/leaderboard`).

```ts
export interface ActiveRound {
  id: string;
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
}

export async function ensureCurrentRound(
  db: Db,
  redis: Redis,
  settings: Record<string, string>,
): Promise<ActiveRound | null>;
```

**All three parameters are required, at every call site, with no defaults.**
This is the single signature; §3.3, §3.6 and §4.1 all refer to this one.

It takes `redis` as well as `db` because a rollover publishes `round.finished`
and `round.started`, and CLAUDE.md rule 5 says events are facts published only
**after** the transaction commits — so the publish cannot live inside the
transaction and cannot be handed back to the caller without making every call
site remember to do it. `ensureCurrentRound` owns both.

It takes `settings` because finalize's payout reads the `rounds.payout_points`
award table (§3.6), and settings are loaded once at boot into a
`Record<string, string>` — never re-read with a `SELECT`. Threading it as a
parameter rather than importing a module-level singleton is what the rest of
core already does, and it is what keeps a test able to pin the award table
without touching the `settings` table.

**Threading it costs a change at three sites**, and this spec is explicit that
the signature *does* change relative to today's non-existent function — nothing
in core has this signature to preserve:

1. **`apps/server/src/index.ts`** already has the loaded record in scope: it
   calls `await loadSettings(db)` at line 54 and binds the result. The boot call
   site (below) passes that binding directly.
2. **`apps/server/src/app.ts`** already loads settings into the same shape for
   the test/boot harness (line 32) and already passes them into `loadPlugins`.
   The new `registerRoundRoutes` call (§4.1) takes the same value.
3. **`apps/server/src/game/leaderboard/routes.ts`** — `registerLeaderboardRoutes`
   (declared at `routes.ts:10-14`) does **not** have settings in scope today, so
   it gains one parameter, `settings: Record<string, string>`, and its single
   call site in `app.ts` passes the same record. This is the one signature in
   core that widens.

There is no fourth. `ensureCurrentRound` is never reached from a plugin, so
`PluginCtx` is untouched.

It opens its own transaction and must therefore **never be called from inside
one**. No plugin reaches it; it is not exposed on `PluginCtx`.

**The fast path opens no transaction.** The first thing `ensureCurrentRound`
does is one unlocked read:

```sql
SELECT id, name, starts_at, ends_at, finalized_at, snapshotted_at
FROM rounds
WHERE finalized_at IS NULL
  AND starts_at IS NOT NULL AND starts_at <= now()
ORDER BY starts_at ASC, id ASC
LIMIT 1
```

- No row → return `null`. The game has no active round; nothing else happens.
  This is the state of every GL3 install today (§5.5 risk 3).
- Row with `ends_at <= now()` → open the finalize transaction described in §2.3.
  This case is checked **first**: a round that is both unsnapshotted and already
  over is settled, not activated, and §2.3's step 1 handles the empty entry set
  without special-casing.
- Row still within its window (`ends_at IS NULL` or `ends_at > now()`) with
  `snapshotted_at IS NULL` → open the **activation** transaction described in
  §2.2a, then return the round.
- Row still within its window with `snapshotted_at IS NOT NULL` → return it
  directly, no transaction. This is the steady state and the overwhelmingly
  common outcome. An open-ended round never rolls over, so a V2-migrated round
  with a NULL `ends_at` cannot trigger a surprise finalize (§1.5.1).

The probe selects `snapshotted_at` for exactly this branch. Note the ordering of
the two transactional cases is a genuine precedence rule, not incidental:
finalize is checked before activation.

Rows with a NULL `starts_at` are excluded by the predicate rather than ordered
around: they are inert by §1.5.1, and selecting one as active would make a
dateless placeholder the current season.

That shape is copied deliberately from the first-admin claim in
`apps/server/src/auth/routes.ts:73-80`, whose comment states the principle:
"The probe *before* the lock is what keeps it off the hot path: every
registration after the first finds another player and never takes the lock at
all. The recheck under the lock is the one that decides — the unlocked probe
can only be stale in the direction of 'maybe empty'." Here the unlocked probe
can only be stale in the direction of "maybe ended", and the recheck under the
lock decides.

`ORDER BY starts_at ASC, id ASC` is the deterministic tie-break demanded by
§5.5 risk 2: overlap is rejected at admin write time, but that check is
application-level, so the read path must pick one round rather than trust
uniqueness. Earliest `starts_at` wins; `id ASC` settles an exact tie so two
replicas never disagree about which round is active.

This read is the one `rounds_open_idx` exists for (§1.5.2).

#### Call sites — exactly four

1. **Boot**, in `apps/server/src/index.ts`, after `await loadSettings(db)` at
   line 54 and before `loadPlugins` at line 55. Not in `buildApp`: every
   integration test builds its server through `buildApp`/`bootTestServer`, and
   a boot-time rollover firing under those tests would make round assertions
   race, for the same reason the sentence sweeper is kept out of `buildApp`
   (comment at `index.ts:68-72`). The boot call is what absorbs the expensive
   case — a server that was down across several scheduled rounds settles them
   all at boot rather than making the first player of the day pay for it.
2. **`GET /api/rounds`** — head of the handler, before anything else.
3. **`GET /api/rounds/:id/standings`** — head of the handler.
4. **`GET /api/leaderboard/:kind`** — head of the existing handler at
   `apps/server/src/game/leaderboard/routes.ts:15`, **unconditionally**, before
   the `ParamsSchema.safeParse` at line 16. `db` and `redis` are already
   parameters of `registerLeaderboardRoutes`; `settings` is the one parameter it
   gains (above). It runs for `scope=all` too: branching on the query param to
   skip it would mean the all-time board could observe a round that ended an
   hour ago as still active, for no saving beyond one indexed SELECT.

No other route calls it. In particular **registration does not** — see §2.5.

The cost on the common path is one indexed `SELECT ... LIMIT 1` against
`rounds` per rounds/leaderboard request, and zero transactions.

**What it returns, in every case.** The return value is always *the round that
is active when the function returns*, or `null`:

- fast path, no work done → the probed row;
- after an activation → the same row, now snapshotted;
- after a finalize (or a chain of them, §2.6) → the round that is active
  *after* the settling, re-read inside the same transaction. If the newly
  current round was itself activated in that transaction, the row returned
  reflects that. If no round is active afterwards → `null`.

A successful finalize therefore never returns the round it just finalized. This
matters because `GET /api/rounds` renders the return value as "the current
round"; returning a settled round there would show players a season that ended.

**It must not throw on the common path.** `ensureCurrentRound` sits at the head
of `GET /api/leaderboard/:kind`, a route that exists today and works today, so
any throw from it turns an existing green route into a 500. The only sanctioned
throw is §2.6's iteration cap, which is a genuine misconfiguration. Everything
else — no rounds table rows, a round with NULL dates, a payout setting that
fails to parse (§3.6 falls back to the default table rather than throwing) — is
handled by returning `null` or proceeding.

### 2.2a Activation — taking the round's opening snapshot

A round's board is a delta from a starting position. Until every player has a
`round_entries` row for the round, the board is empty and the payout has nobody
to pay. Something has to take that opening snapshot, and this is it.

**When.** The first `ensureCurrentRound` call at or after the round's
`starts_at` that finds `snapshotted_at IS NULL`. Not at round creation (an admin
may create a round weeks ahead, and snapshotting then would freeze a start
position from before the round began, so everything earned in between would
count). Not when the previous round finalizes (there may be a gap between the
two, and everything earned in the gap would count — and on a fresh install
there is no previous round to hang it off at all, which is precisely why round
one would otherwise have zero entries and pay nobody).

**The transaction.** Same shape as finalize, same lock:

1. `SELECT pg_advisory_xact_lock(7461002)` — the same key finalize takes (§2.4).
   One key serialises both operations against each other, which is what we want:
   they mutate the same two tables and are never both correct at once.
2. Recheck under the lock, and it is the guard:
   ```sql
   SELECT id, name, starts_at, ends_at FROM rounds
   WHERE id = $1 AND snapshotted_at IS NULL AND finalized_at IS NULL
     AND starts_at IS NOT NULL AND starts_at <= now()
     AND (ends_at IS NULL OR ends_at > now())
   ```
   Zero rows → another request activated it (or it ended, or it was edited)
   while we waited. Commit, re-read the active round, return it. No error.
3. The whole-population snapshot:
   ```sql
   INSERT INTO round_entries (round_id, player_id, joined_at, exp_at_start, cash_at_start, bank_at_start)
   SELECT $1, ps.player_id, now(), ps.exp, ps.cash, ps.bank
   FROM player_stats ps
   ON CONFLICT (round_id, player_id) DO NOTHING
   ```
   `ON CONFLICT DO NOTHING` because a player who registered between `starts_at`
   and this call already inserted their own entry (§2.5), and theirs is the more
   accurate one — it was taken when they actually joined.
4. Stamp it:
   ```sql
   UPDATE rounds SET snapshotted_at = now() WHERE id = $1 AND snapshotted_at IS NULL
   ```
   As with step 3 of finalize, the `WHERE` makes this statement the arbiter of
   "did THIS call activate the round", and `round.started` is published only
   when it matched a row.
5. Point everyone at it:
   ```sql
   UPDATE players SET round_id = $1 WHERE round_id IS DISTINCT FROM $1
   ```
   `IS DISTINCT FROM` skips rows already pointing at the round, so the statement
   is re-runnable and, on the common case of a re-activation attempt, touches
   nothing. This is the first server code ever to write `players.round_id`
   (§1.4 item 5).

**After commit**, publish `round.started` (§4.4) — global, carrying the round's
id, name and `endsAt`. Rule 5: after the commit, never inside it.

**Steps 1-2 belong to the standalone path only.** Activation is reached two
ways, and only the first opens a transaction of its own:

- from `ensureCurrentRound`'s probe (§2.2, the in-window-unsnapshotted branch) —
  all five steps, its own transaction, its own post-commit publish;
- from finalize's step 4 (§2.3) — **steps 3-5 only**, inside the finalize
  transaction, whose step 0 already holds 7461002 and whose step-4 probe already
  *is* the recheck under that lock. The `round.started` publish is then one entry
  in finalize's accumulated post-commit list, not a publish of its own.

So the code is one function taking the round row and a `tx`, containing steps
3-5; the standalone path is a thin wrapper that opens the transaction, takes the
lock, runs the recheck, calls it, and publishes. Steps 3-5 are written once and
reached twice — never copied.

**Lock order.** Steps 3-5 touch `round_entries`, `rounds` and `players` — the
same three tables, in the same order, as finalize's step 4 did in the rejected
alternative. §2.7 covers the ordering argument for both paths together; nothing
here takes `FOR UPDATE` on `player_stats`, so activation shares no lock edge
with the economy.

**Cost.** One `INSERT ... SELECT` and one `UPDATE` over `player_stats` /
`players` — two whole-table passes, once per round, on the first request after
the round opens. At V2's real scale (thousands of players) that is a
sub-second transaction that happens a handful of times a year.

**Why a stamp column rather than "does the round have entries".** Three
reasons. `SELECT count(*) FROM round_entries WHERE round_id = $1` is a different
question — it is also zero for a round activated on an install with no players.
A count cannot be turned into a race-safe `UPDATE ... WHERE` guard, so the
"did I do it" arbiter of step 4 would have no equivalent. And the count grows
with the population while the stamp is one nullable timestamp read straight off
the row the probe already fetched.

**Rejected alternative: make finalize step 4 snapshot its successor.** That was
the original design, and it fails three ways. Round one has no predecessor, so
it never gets a snapshot at all — an empty board and a payout to nobody, both
silent. A gap between rounds means everything earned in the gap counts toward
the next round, contradicting §1.1's "your progress *this season*". And a
schedule edited after the previous finalize (an admin inserting a round, or
moving `starts_at` earlier) leaves the newly-current round unsnapshotted with
nothing that will ever fix it. Activation keyed on the round's own `starts_at`
has none of these properties, and it makes each round's start position depend
only on that round's own schedule.

### 2.3 Finalize — the four ordered steps

When the probe finds `ends_at <= now()`, `ensureCurrentRound` opens
`await db.transaction(async (tx) => { ... })` — core's transaction style
throughout (`apps/server/src/auth/routes.ts:64`); there is no wrapper helper
and drizzle's `db.transaction` is called directly. Raw SQL inside it goes
through ``await tx.execute(sql`...`)`` with `sql` imported from `drizzle-orm`.

The **first statement in the transaction** is the advisory lock (§2.4).
Immediately after it comes the recheck, which is the guard (§2.4):

```sql
SELECT id, name, ends_at FROM rounds
WHERE id = $1 AND finalized_at IS NULL AND ends_at <= now()
```

Zero rows → another request finalized this round while we waited on the lock.
Do nothing, commit, re-read the active round, return it. Losers find the work
done and proceed; they do not error and they do not retry the payout.

One row → run the four steps, in this order.

**Step 1 — freeze `final_*` for the ending round.** One whole-population
statement:

```sql
UPDATE round_entries AS re
SET final_exp = ps.exp, final_cash = ps.cash, final_bank = ps.bank
FROM player_stats AS ps
WHERE ps.player_id = re.player_id AND re.round_id = $1
```

This is what makes a settled board stop moving: the standings query for a
finalized round reads `final_*` instead of `player_stats` (§3.2). It runs
*before* the payout on purpose — the payout credits `points`, which is not one
of the three frozen metrics, but freezing first means the numbers the board
shows are the numbers the placings were computed from, with no statement in
between that could touch `exp`, `cash` or `bank`.

**Step 2 — pay the top placers.**

Placings are taken from the **exp** board, and there is no second ranking
statement — this step calls §3.2's `roundStandings` with the finalize
transaction's own handle:

```ts
const awards = payoutPoints(settings);                       // §3.6
const winners = await roundStandings(tx, roundId, "exp", awards.length, true, 0n);
```

Passing `tx` rather than `db` is required, not stylistic: step 1 froze
`final_*` inside this transaction, and under READ COMMITTED a pooled `db`
handle would not see those rows yet — it would rank on the pre-freeze state, or
on `exp_at_start` alone. `roundStandings` accepts `Db | Tx` for exactly this
(§3.2).

`finalized: true` is likewise required: step 1 has run, so the frozen columns
are the truth, and the live variant's join to `player_stats` would let a
concurrent crime payout shift a placing between the freeze and the award.

`minDelta: 0n` — the `delta > 0` filter — is not a nicety: a round nobody played
(an entire scheduled window that elapsed while the server was down, §2.6) would
otherwise pay first place to whichever zero-delta row sorted first. It is the
only difference between the payout's ranking and the board's, and it can only
ever remove rows the board would have shown with a zero or negative standing.

`awards.length` as `n` means the query returns at most as many rows as there are
awards, so there is no slicing afterwards: **`winners` is already the paid set**,
and it may be shorter than `awards` (or empty) when fewer players scored a
positive delta. Award *i* goes to `winners[i]`; a trailing award with no
corresponding winner is simply not paid. §3.6's description of "the top
`awards.length` standings" describes this same set.

`exp` is the payout metric because it is the only monotonic one; the full
argument is §3.6.

The award table comes from the setting `rounds.payout_points`, read from the
boot-loaded settings record through `payoutPoints()` — the parser, its
defaults, its bounds and the restart semantics that follow are all §3.6. It is
**not** read with a `SELECT` inside this transaction.

Every award goes through `applyBalanceChange`
(`apps/server/src/economy/ledger.ts:50`) — CLAUDE.md rule 3, one transaction,
one ledger row, `bigint` throughout — with `kind: "points"`,
`reason: "round.payout"`, and `refId` set to the round id. `ref_id` is what
makes an award traceable to its round without adding a column to
`transactions`, and it is what lets `test/economy-invariant.test.ts`'s
`sum(ledger) == balance` keep holding. The exact call shape, field by field, is
§3.6.

This is the one step that is **not** a single whole-population statement: it is
one `applyBalanceChange` per award, bounded by `awards.length` (three, at the
default). It cannot be folded into one UPDATE, because rule 3 requires a ledger
row per movement and `applyBalanceChange` is the only sanctioned way to write
one. Three round trips in a rare transaction is not worth breaking that for.

Before the first `applyBalanceChange`, call `lockPlayersForUpdate(tx, winnerIds)`
**once** with the whole winner set, per the ordering rule in §2.7.

**Step 3 — stamp `finalized_at`.**

```sql
UPDATE rounds SET finalized_at = now() WHERE id = $1 AND finalized_at IS NULL
```

The `WHERE finalized_at IS NULL` is repeated here even though the recheck
already established it under the lock, for the same reason jail's release
UPDATE repeats `jailed_until IS NOT NULL` (`jail/status.ts:37-42`): the
statement itself is then the arbiter of "did THIS call settle the round", and
`round.finished` is published only when it matched a row.

**Step 4 — re-evaluate, and hand off to activation.**

Finalize does **not** snapshot the next round. It re-runs the probe of §2.2
inside the same transaction and dispatches on what it finds, exactly as
§2.2's caller would:

```sql
SELECT id, name, starts_at, ends_at, finalized_at, snapshotted_at
FROM rounds
WHERE finalized_at IS NULL
  AND starts_at IS NOT NULL AND starts_at <= now()
ORDER BY starts_at ASC, id ASC
LIMIT 1
```

- **No row** → done. The round is finalized, no new round is current,
  `players.round_id` is left pointing at the finalized round, and
  `ensureCurrentRound` returns `null`. The game continues untouched; this is
  the same state as an install that never had a round (§5.5 risk 3). Note in
  particular that a round scheduled to start *later* is not matched here —
  `starts_at <= now()` excludes it — and it will be activated by whichever
  request first arrives after its `starts_at`.
- **Row with `ends_at <= now()`** → that round has also expired; run steps 1-4
  again for it. This is §2.6's loop, and it lives here rather than as a separate
  mechanism.
- **Row still within its window with `snapshotted_at IS NULL`** → run §2.2a's
  steps 3-5 for it, in this same transaction. The advisory lock is already held
  (step 0), and re-taking it inside the same transaction is a no-op, so the
  activation body runs directly without its own lock or recheck — the probe just
  performed *is* the recheck, under the lock.
- **Row still within its window and already snapshotted** → done; return it.
  This happens when the next round was activated earlier and its predecessor is
  only being settled now.

Doing it this way means `players.round_id` and the opening snapshot are written
by exactly one piece of code (§2.2a steps 3-5), reached from two places, rather
than by two copies that must be kept in step.

**After commit**, publish, in this order:

1. one `round.finished` per round finalized in this transaction, oldest first;
2. one `round.started` if the transaction activated a round.

Both are global (§4.4). The events are accumulated into a local array as the
transaction proceeds and published only after `db.transaction` resolves —
CLAUDE.md rule 5: these are facts about what committed, so nothing is published
from inside the transaction, and if it rolls back nothing is published at all.
§2.6 states the accumulation shape for the multi-round case.

### 2.4 The advisory lock, and the `finalized_at` guard as a separate defence

**The lock.** The first statement inside the finalize transaction is:

```ts
await tx.execute(sql`SELECT pg_advisory_xact_lock(7461002)`);
```

Single-argument (bigint key) form, transaction-scoped, released automatically
at commit or rollback.

The precedent is `apps/server/src/auth/routes.ts:84`, the first-admin claim,
which uses the same call with the constant **7461001**. That is the only
advisory lock in production server code today. The only other advisory lock
anywhere in the repo is
`pg_advisory_lock(hashtext('gl3_test_template_build'))` in
`apps/server/test/helpers/global-setup.ts:76`, which is session-scoped and
keyed by `hashtext` of a string rather than by a hand-picked integer — so
**7461002 is free**, and it is the obvious next number in the 74610xx block
core has started. Any future core advisory lock takes 7461003 and so on; do not
reuse 7461001, and do not pick a number outside the block.

What the lock buys is what it buys in the registration case. Under READ
COMMITTED two concurrent requests that both notice `ends_at` has passed each
read `finalized_at IS NULL`, and both would run the payout — paying every
winner twice. The lock serialises the recheck-and-settle: the second request
blocks until the first commits, then its recheck sees `finalized_at` set and it
does nothing.

**The guard is a second, independent defence.** `WHERE finalized_at IS NULL`
appears both in the recheck and in step 3's UPDATE, and it is not redundant
with the lock. They fail in different directions:

- The lock protects against **concurrent** finalizes and nothing else. It is
  released at commit, so it says nothing at all about a finalize that already
  committed an hour ago.
- The guard protects against **repeated** finalizes across time — a second
  call after the first has committed and released, a manual re-run, a bug that
  calls `ensureCurrentRound` twice in one request, a future change that moves
  finalize into a BullMQ job (§5.5 risk 1) where at-least-once delivery is the
  norm (CLAUDE.md rule 1).

Neither substitutes for the other. Dropping the lock and keeping the guard
would still double-pay two simultaneous requests, because both read NULL before
either wrote. Dropping the guard and keeping the lock would re-pay on any
second call, because the lock is long gone. `finalized_at` is the column that
makes "ended" and "settled" different states, and it is the reason finalize is
idempotent rather than merely serialised.

**7461002 has a second holder: the two admin write routes** (§4.2). They take it
as their own first statement so that the overlap check and the write it authorises
cannot interleave with each other or with a rollover. That is the whole set of
holders — finalize, activation reached from finalize, `POST /api/admin/rounds` and
`POST /api/admin/rounds/edit`. No read path takes it.

### 2.5 Mid-round registration

A player who registers halfway through a round must compete on progress from
the moment they join, not from zero — otherwise the snapshot design would
punish late joiners exactly the way absolute totals punish new players.

**Where the code goes.** Inside the existing single
`await db.transaction(async (tx) => { ... })` in
`apps/server/src/auth/routes.ts:64-94`, as a block placed **after**
`await tx.insert(playerStats).values({ playerId });` (line 71) and **before**
the first-player probe at line 81. Before the probe, not after: the probe block
can take advisory lock 7461001, and the existing comment at `routes.ts:77`
explicitly protects the shortness of that lock's hold time. Adding statements
after the lock is taken would lengthen it for every first-ever registration.

**What is in scope at line 72.** `tx` (the drizzle transaction), `playerId`
(the `uuidv7()` string, already inserted into `players`), `parsed.data`
(username, password, optional email), `passwordHash`, `config`, `db`, `redis`,
`request`, `reply`. There is **no round id in scope** — the register route
knows nothing about rounds — so the block starts with its own read.

**The three statements.**

```ts
// 1. The active round, same predicate ensureCurrentRound's probe uses.
const [round] = await tx.select({ id: rounds.id }).from(rounds)
  .where(sql`${rounds.finalizedAt} is null
             and ${rounds.startsAt} is not null and ${rounds.startsAt} <= now()
             and (${rounds.endsAt} is null or ${rounds.endsAt} > now())`)
  .orderBy(asc(rounds.startsAt), asc(rounds.id))
  .limit(1);

if (round) {
  // 2. Snapshot this player's starting stats.
  await tx.execute(sql`
    insert into round_entries (round_id, player_id, joined_at, exp_at_start, cash_at_start, bank_at_start)
    select ${round.id}, ps.player_id, now(), ps.exp, ps.cash, ps.bank
    from player_stats ps where ps.player_id = ${playerId}
    on conflict (round_id, player_id) do nothing`);

  // 3. Point the player at the round.
  await tx.update(players).set({ roundId: round.id }).where(eq(players.id, playerId));
}
```

Statement 2 is an `INSERT ... SELECT` off `player_stats` rather than three
literal zeroes. A fresh `player_stats` row today is all defaults — `cash`,
`bank` and `exp` are each ``.default(sql`0`)``
(`apps/server/src/db/schema/identity.ts:58-62`) — so hard-coded `0n`s would be
correct right now and would silently start lying the day someone gives new
players a starting balance. The `SELECT` reads a row this transaction inserted
one statement ago, so it costs one index lookup and cannot be wrong.

**The predicate excludes a round whose `ends_at` has already passed.** That is
deliberate: registration must not call `ensureCurrentRound`, because
`ensureCurrentRound` opens a transaction (we are already in one) and takes a
global advisory lock (registration is a hot path the existing comment goes out
of its way to keep off locks). So when the current round has ended but nobody
has triggered the rollover yet, the predicate matches nothing, registration
inserts no entry, and `players.round_id` stays NULL. The player is not lost: the
**next round's activation** (§2.2a step 3) is a whole-population
`INSERT ... SELECT FROM player_stats`, so it picks them up along with everyone
else.

Note the pickup is activation's, not finalize's. Finalize does not snapshot
anything (§2.3 step 4, and the rejected alternative at the end of §2.2a) — a
sentence saying "the next finalize picks them up" would be describing the design
that was rejected. Throughout this document "the next round" means the row the
probe will next return as active, and the only statement that ever inserts
entries for it is the one guarded by its own `snapshotted_at`.

**Cost.** Three extra statements on registration when a round is active, all
index lookups; one statement when no round is active; zero when the install has
no `rounds` rows at all, since the first SELECT returns nothing. Registration
is rate-limited to 5 per hour per IP (`routes.ts:52`) and already pays for an
argon2id hash, so this is not a path where three index lookups matter.

**The one race, and why we accept it.** Registration can read round R, then
finalize can commit (freezing `final_*` for every entry that existed at that
moment), then registration can commit its entry for R — an entry in a finalized
round with `final_*` NULL. The standings query for a finalized round therefore
reads `COALESCE(re.final_exp, re.exp_at_start)` and friends (§3.2), which scores
that player exactly 0. That is truthful: they joined after the round was
settled.

**What it actually costs them, stated honestly.** It is *not* true that the same
rollover sweeps them into the successor. Under READ COMMITTED the activation's
whole-population `INSERT ... SELECT FROM player_stats` (§2.2a step 3) reads a
snapshot taken when that statement began, and the racing registration has not
committed yet — its `player_stats` row is invisible to it, exactly as its
`players` row is. So the registrant lands with a zero-scored entry in the round
that just ended, `players.round_id` still pointing at it, and **no entry in the
successor**. The successor is already stamped `snapshotted_at`, so nothing
re-runs; they sit out that one round's board and payout, and the activation
after it picks them up with everyone else.

We accept that, because closing it costs the same global serialisation point the
paragraph below rejects, and the window is the milliseconds between the freeze
of §2.3 step 1 and the insert of §2.2a step 3 — a registration must both start
before the round's `ends_at` and commit inside that gap. The blast radius is one
player, one round, and it self-heals.

The rejected fix was to take advisory lock 7461002 in the register transaction
as well. It would close the race, at the price of putting a single global
serialisation point on every registration in the game, permanently, to correct
one zero-scored row in a round the player did not play. `COALESCE` is a cheaper
answer to a cheaper problem.

### 2.6 Several rounds ending at once

If the server was down across more than one scheduled window, finalizing the
first ended round makes the *next* round current — and it may have ended too.
`ensureCurrentRound` therefore loops **inside the one transaction**: after step
4 it re-evaluates the new active round, and if that round's `ends_at` has also
passed it runs the four steps again. The loop is bounded at **50 iterations**
and throws `too many rounds to settle in one pass` beyond that, so a schedule
misconfigured into thousands of one-second rounds fails loudly instead of
holding the advisory lock while it grinds.

Looping rather than settling one round per call is what stops the read path
from handing back a round that has already ended. A skipped round pays nobody,
because every entry's exp delta is 0 and step 2 filters on `delta > 0`.

This is also why the boot call site exists: after a long outage the whole chain
settles in the boot transaction, before the server accepts its first request.

### 2.7 Lock order — the fourth pair

CLAUDE.md rule 6: **a foreign key is a lock.** Inserting a row whose FK
references another row takes `FOR KEY SHARE` on the referenced row, and no lock
call appears in the code, so these edges are invisible to a reader who only
greps for explicit locks. Three pairs exist today —
gang↔player (`lockGangAndPlayerForUpdate`), location↔player (locations-first,
via `lockLocationForUpdate` / `lockLocationsForUpdate`), and player↔player
(`lockPlayersForUpdate`, deduped and sorted ascending in one statement). Rounds
introduce the **fourth: rounds↔player.**

**What each statement actually locks.**

Two transactions in this design touch these tables, and it matters which is
which: **activation** (§2.2a, steps 3-5 — the whole-population
`INSERT ... SELECT` into `round_entries`, the `snapshotted_at` stamp, and the
whole-table `UPDATE players SET round_id`) and **finalize** (§2.3, steps 1-3 —
the `final_*` freeze, the payout, and the `finalized_at` stamp). They take the
same advisory lock, so they never run concurrently with each other, but they lock
different things and the paragraphs below name each by its own section.

- `round_entries` has two foreign keys, to `players(id)` and to `rounds(id)`.
  Every INSERT into it — activation's whole-population `INSERT ... SELECT`, and
  registration's single-row insert — takes `FOR KEY SHARE` on the referenced
  `players` row and on the referenced `rounds` row. `FOR KEY SHARE` is the
  weakest row lock Postgres has and is compatible with itself, so concurrent
  registrations never contend on the round row.
- The payout in step 2 takes `FOR UPDATE` on `player_stats` rows, via
  `lockPlayersForUpdate` inside `applyBalanceChange`. Note the table:
  `player_stats`, not `players`. `round_entries` does **not** reference
  `player_stats`, so the FK edge and the exclusive edge land on two different
  tables.
- `applyBalanceChange` also inserts a `transactions` row whose FK takes
  `FOR KEY SHARE` on `players` — shared, compatible with step 4's.
- Finalize's step 3 (`UPDATE rounds SET finalized_at`), activation's step 4
  (`UPDATE rounds SET snapshotted_at`) and activation's step 5
  (`UPDATE players SET round_id`) all touch **non-key columns**, so each takes
  `FOR NO KEY UPDATE`, which does **not** conflict with `FOR KEY SHARE`. This
  is the single most load-bearing fact in the whole pair: a finalize stamping
  `finalized_at` cannot block a registration holding `FOR KEY SHARE` on the
  same round row, and a registration cannot block the finalize.

**What activation's step 5 does block, stated plainly.**
`UPDATE players SET round_id = $1 WHERE round_id IS DISTINCT FROM $1` takes
`FOR NO KEY UPDATE` on **every row it touches**, which on the activation of a new
round is the whole `players` table. `FOR NO KEY UPDATE` *does* conflict with
itself, so for the life of that transaction every other single-row
`UPDATE players` in the game waits. There are exactly two:

- `apps/server/src/auth/routes.ts:132` — the lazy argon2id upgrade on a
  V2-migrated player's first login (`passwordHash`, `legacyPasswordSha256`).
- `apps/server/src/admin/routes.ts:147` — admin role assignment (`role_id`).

Neither is a deadlock risk: both are single-statement updates that hold one
`players` row and then want nothing else, so no cycle can form — they wait, and
then they proceed. The cost is latency, bounded by activation's own duration
(§2.2a's "sub-second at V2's real scale"), paid once per round, and landing on at
most a handful of logins. That is why step 5 is a plain whole-table `UPDATE` and
not a batched one: batching would trade a short total block for a long series of
short blocks, and give up the statement's re-runnability for it.

The insert half of registration is unaffected — an `INSERT` into `players` takes
no lock on rows that do not exist yet, so registration continues throughout.

**The rule: advisory lock first, then players ascending.**

Concretely, inside `ensureCurrentRound`'s transaction:

1. `pg_advisory_xact_lock(7461002)` — the first statement, before any row is
   read or written.
2. All `rounds` / `round_entries` work.
3. `lockPlayersForUpdate(tx, winnerIds)` once with the complete winner set,
   before the first `applyBalanceChange`, so the exclusive `player_stats` locks
   are taken ascending in one statement rather than in board order across
   several. That helper dedupes and sorts ascending and takes all the locks in a
   single statement (`ledger.ts:35-43`); the per-winner `applyBalanceChange`
   calls each re-invoke it internally and are no-ops on locking from then on.

**Why this is acyclic.**

- *Finalize vs finalize* — impossible. The advisory lock admits one.
- *Rollover vs registration* — one-way. Activation's whole-table
  `UPDATE players SET round_id` can wait on an in-flight registration's
  uncommitted `players` row. Registration never waits on anything the rollover
  holds, because every lock it wants on `rounds` is `FOR KEY SHARE` and both
  activation and finalize only ever hold `FOR NO KEY UPDATE` there —
  compatible. One direction of waiting is not a cycle.
- *Finalize vs an ordinary economy request* — finalize holds `FOR UPDATE` on a
  winner's `player_stats` row and `FOR NO KEY UPDATE` on `players` rows. A
  combat, bank or crime transaction holds `player_stats` locks and takes
  `FOR KEY SHARE` on `players` through its `transactions` insert. `FOR KEY SHARE`
  does not conflict with `FOR NO KEY UPDATE`, so the economy request never
  waits on the `players` half; it can only wait on `player_stats`, and finalize
  never waits on it back.

**The invariant a future change could break.** The pair stays acyclic only
because *no code path takes an exclusive lock on a `players` row and then asks
for a `player_stats` lock*. Nothing does today: economy paths touch
`player_stats` only, admin role assignment (`UPDATE players SET role_id`)
touches `players` only, and registration's `UPDATE players SET round_id` is on
a row it inserted itself. **Any new transaction that UPDATEs `players` and then
calls `applyBalanceChange` closes the cycle against finalize** — finalize would
hold the winner's `player_stats` and want that `players` row, while the other
transaction holds the `players` row and wants `player_stats`. If such a path is
ever needed, it must take its `player_stats` locks first.

**No ordinary request path reaches `rounds` or `round_entries` except through
`ensureCurrentRound`** — which takes the advisory lock before anything else —
**and registration's three-statement block in §2.5**, which takes no exclusive
lock at all. That is what keeps the fourth pair reasoning to a single page.
Admin round management (§4.2) writes `rounds` and is the third writer; it takes
7461002 as its own first statement, then `FOR NO KEY UPDATE` on the row it edits,
and must never touch `round_entries` or `player_stats`. The advisory lock is what
makes the last clause true rather than merely likely: an admin write and a
rollover are strictly serialised, so an edit cannot move `ends_at` out from under
a finalize that has already frozen `final_*` against it, and a finalized round's
dates are immutable in either order. Its row lock is therefore uncontended in
practice, and it adds no edge to the graph above — it holds one `rounds` row and
wants nothing else.

**Regression test.** `apps/server/test/rounds-lock-order.test.ts`, modelled on
`test/theft-lock-order.test.ts` and `test/properties-lock-order.test.ts`. Its
shape, its counterparties and the inversion it must be shown failing under are
§5.2. CLAUDE.md's corollary applies with force here: *a concurrency test whose
participants all acquire locks via the same helper proves only the case that was
already safe.* Two concurrent `ensureCurrentRound` calls agree on ordering by
construction and would stay green through any bug in this section.

---

## 3. Scoring, boards, and the round payout

### 3.1 Round boards are computed in Postgres; Redis stays all-time

The three Redis ZSETs (`leaderboard:cash`, `leaderboard:bank`, `leaderboard:exp`)
are not touched by this feature. `recordScore`, `topN` and `rebuildLeaderboards`
in `apps/server/src/game/leaderboard/service.ts` keep their exact current
behaviour, their exact current signatures, and their exact current `prefix`
defaults. No new ZSET is created, no ZSET is renamed, and `DEFAULT_LEADERBOARD_PREFIX`
is unchanged.

The rejected alternative was a fourth ZSET per round holding each player's delta,
maintained incrementally. It loses on write cost. There is exactly one production
writer of any leaderboard score in the repo — `apps/server/src/plugins/ctx.ts:248`,
inside the plugin transaction wrapper, which flushes a buffered
`recordScore` after commit for every `cash`/`bank`/`exp` movement any plugin
makes. A round ZSET would mean a *second* `zadd` at that same site for every
balance change made by any of the sixteen installed plugins, plus the equivalent
at `rebuildLeaderboards`, plus a decision about what happens to that key at
rollover, plus a repair story when Redis and Postgres disagree about which round
was active when a score was written. That is a write on the hottest path in the
game — crimes, combat, banking, theft, properties all pass through it — bought
to speed up a page nobody reloads in a loop.

Postgres already holds both halves of the subtraction (`round_entries.*_at_start`
and `player_stats.*`), so the delta is a query, not a maintained value. A query
also cannot drift: there is no state to repair, and no rebuild sweep to write.
The cost is that a round board is a table scan of one round's entries rather than
an O(log n + k) ZSET range — see §3.4, where that cost is bounded and accepted.

Note also that `applyBalanceChange` in `apps/server/src/economy/ledger.ts` writes
no Redis at all — `recordScore` has exactly one production caller and it is not
core. Core routes that move money (the hospital discharge, and the round payout
in §3.6) already leave the ZSETs alone until the next boot's
`rebuildLeaderboards`. The payout's Redis silence is therefore the existing core
default, not a special case invented here.

### 3.2 The standings query

New file: `apps/server/src/game/rounds/standings.ts`.

```ts
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { LeaderboardEntry, LeaderboardKind } from "@gl3/shared";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../economy/ledger.js";
import { players, playerStats, roundEntries } from "../../db/schema/index.js";

export async function roundStandings(
  exec: Db | Tx,
  roundId: string,
  kind: LeaderboardKind,
  n: number,
  finalized: boolean,
  minDelta?: bigint,
): Promise<LeaderboardEntry[]>
```

**Two parameters exist for the payout, and only for it.**

`exec` is `Db | Tx`, not `Db`. The two read routes pass the pooled `db`; the
payout (§2.3 step 2) calls this same function with the finalize transaction's
`tx`, because ranking must read the `final_*` values *this* transaction froze
one statement earlier, which an out-of-transaction `db` handle cannot see under
READ COMMITTED. `Tx` is the existing exported alias at
`apps/server/src/economy/ledger.ts:26`
(`Parameters<Parameters<Db["transaction"]>[0]>[0]`); drizzle's query builder is
identical on both, so the body needs no branching.

`minDelta` is optional and appends one predicate — `AND <delta expression> >
$minDelta` — when supplied. The payout passes `0n`; both read routes omit it and
get the unfiltered board. §2.3 step 2 explains why the payout needs it.

There is exactly one ranking statement in this design, in this file. No other
site writes its own.

`kind` is the **existing** `LeaderboardKind` from
`packages/shared/src/dto/leaderboard.ts` — `z.enum(["cash", "bank", "exp"])`.
No new kind is added, `LeaderboardKindSchema` is not edited, and `points` is
deliberately not a kind (§3.6). The return type is the existing
`LeaderboardEntry` (`{ playerId, username, score, rank }`), so a round board and
the all-time board are the same shape on the wire and the web client parses both
with `LeaderboardEntrySchema`.

Two column maps, mirroring the `column` map in `economy/ledger.ts`:

```ts
const CURRENT = { cash: playerStats.cash, bank: playerStats.bank, exp: playerStats.exp } as const;
const START   = { cash: roundEntries.cashAtStart, bank: roundEntries.bankAtStart, exp: roundEntries.expAtStart } as const;
const FINAL   = { cash: roundEntries.finalCash,   bank: roundEntries.finalBank,   exp: roundEntries.finalExp } as const;
```

**Live round** (`finalized === false`) — the delta is current minus start, so it
moves as the player plays:

```sql
SELECT re.player_id, (ps.exp - re.exp_at_start) AS delta
FROM round_entries re
JOIN player_stats ps ON ps.player_id = re.player_id
WHERE re.round_id = $1
ORDER BY delta DESC, re.player_id ASC
LIMIT $2
```

**Finalized round** (`finalized === true`) — both operands live in
`round_entries`, so there is **no join to `player_stats` at all** and the board
can never move again:

```sql
SELECT re.player_id, (COALESCE(re.final_exp, re.exp_at_start) - re.exp_at_start) AS delta
FROM round_entries re
WHERE re.round_id = $1
ORDER BY delta DESC, re.player_id ASC
LIMIT $2
```

Two notes on that second statement, both deliberate:

- Dropping the join is a refinement of the standing formula's wording in §1.7
  ("Finalized variant reads `final_exp - exp_at_start`"), not a departure from
  it. Once `final_*` is frozen, `player_stats` contributes nothing, and joining
  it would let a *finalized* board be influenced by rows the freeze already
  captured.
- The `COALESCE` covers exactly one case: an entry whose `final_*` is NULL in a
  round that has `finalized_at` set — a registration that raced the finalize
  transaction (§2.5) and inserted after the freeze `UPDATE` but under a
  different active-round read. Such an entry scores **0**, i.e. "joined,
  recorded no progress". The two alternatives both lose: without `COALESCE`, a
  NULL delta sorts unpredictably (`NULLS FIRST` on `DESC` in Postgres would put
  it at the *top* of the board), and a `WHERE final_exp IS NOT NULL` filter would
  make the player vanish from a hall-of-fame table that is supposed to list every
  participant.

`ORDER BY delta DESC, re.player_id ASC` — the `player_id` tiebreak is
load-bearing, not cosmetic. The payout (§3.6) ranks with the same statement, and
without a total order two players on an identical delta swap places between the
render a player saw and the transaction that paid out. Both call sites use the
same ordering, so what the board showed is what got paid.

Implement the statement with drizzle's query builder plus a `sql<string>`
expression rather than `db.execute(sql\`...\`)`. Core uses `.execute(sql\`…\`)` in
exactly two places today, and neither is a row-returning query: the plugin
migration runner's `sql.raw(migration.sql)`
(`apps/server/src/plugins/migrate.ts:45`) and the first-admin advisory lock
(`apps/server/src/auth/routes.ts:84`). So the rule is narrower than "core never
calls `execute`" — it is that **core never reads rows through it**. Statements
this design adds that return nothing keep using it and are consistent with that:
the advisory lock (§2.4), and the three whole-population statements (finalize
step 1's `UPDATE … FROM`, activation step 3's `INSERT … SELECT` and step 5's
`UPDATE players`), which drizzle's builder cannot express. Anything whose result
is read — this standings query above all — goes through the builder, so the row
type is inferred rather than asserted:

```ts
const delta = finalized
  ? sql<string>`(coalesce(${FINAL[kind]}, ${START[kind]}) - ${START[kind]})`
  : sql<string>`(${CURRENT[kind]} - ${START[kind]})`;
```

selected as `{ playerId: roundEntries.playerId, delta }`, from `roundEntries`,
`.innerJoin(playerStats, eq(playerStats.playerId, roundEntries.playerId))` **only
in the live branch**, `.where(eq(roundEntries.roundId, roundId))`,
`.orderBy(desc(delta), asc(roundEntries.playerId))`, `.limit(n)`.

`delta` arrives from postgres.js as a **JavaScript string** — an `int8` minus an
`int8` is an `int8`, and the driver hands `int8` back as a string. That string is
already the wire format `MoneySchema` wants. Pass it straight into
`LeaderboardEntry.score`. Never call `Number()` on it, never round-trip it
through `BigInt` and back for formatting; both reintroduce the floating point the
money rule exists to keep out.

Names are resolved in a **second query**, byte-identical to what `topN` already
does:

```ts
const rows = await db.select({ id: players.id, username: players.username })
  .from(players).where(inArray(players.id, ids));
```

with `nameById.get(id) ?? "unknown"` and `rank: i + 1` (index within the returned
slice — the same positional, non-dense rank `topN` returns). Doing the naming in
a separate query rather than a third join keeps the delta statement a pure
two-table (live) or one-table (finalized) read, and guarantees the "unknown"
fallback behaves identically on the round board and the all-time board. If the
round board resolved names differently, a player deleted mid-round would render
one way on one page and another way on the other.

`roundStandings` takes no `redis`, and takes no `prefix`. The `prefix`
parameter on the leaderboard service exists solely to namespace parallel test
files on one shared Redis (see the comment above `DEFAULT_LEADERBOARD_PREFIX`);
a Postgres query in a per-test cloned database needs no equivalent, and adding
an unused parameter would imply it does.

### 3.3 Where the query is used

- `GET /api/rounds/:id/standings?kind=cash|bank|exp` calls it once, with
  `finalized` taken from whether that round's `finalized_at` is non-null.
- `GET /api/leaderboard/:kind?scope=round` delegates to it for the active round;
  `scope=all` keeps calling `topN` against the ZSET, unchanged.
- The payout (§2.3 step 2) calls it with the finalize transaction's own handle,
  `finalized: true`, `n = awards.length`, and `minDelta: 0n` — the only caller
  that passes a `Tx` and the only caller that passes `minDelta`.
- Both round read paths pass `n = 10`, the same hardcoded count the all-time
  route passes today, so the three boards on the Rounds page and the toggle on
  Leaderboards agree on length.

The full route contracts — querystring schemas, error strings, and the
backward-compatibility argument for the `"all"` default — are §4.1.
`registerLeaderboardRoutes` gains `db`-side access it already has; its signature
`(app, db, redis, requireAuth, leaderboardPrefix = DEFAULT_LEADERBOARD_PREFIX)`
does not change, and neither does the `leaderboardPrefix` threading through
`app.ts:60,63` and `index.ts`.

### 3.4 The performance bound is documented, not enforced

`ORDER BY (a - b)` sorts on a computed key. Postgres cannot read an index in
order to satisfy it, so the plan is a scan of the entries for that `round_id`
(found through the primary key's leading column) plus a top-N sort. It is
O(entries-in-round), not O(log n + k).

That is accepted, and it is accepted the same way the Redis ZSET's 2^53 score
ceiling is accepted — a bound written down rather than a mechanism built. V2's
real scale is thousands of players per round; a few thousand rows through a
bounded top-10 sort is sub-millisecond, on a page that is read rarely and never
polled. Building an index for it now would be optimising a page whose traffic we
can already bound.

The future fix, if a game ever outgrows it, is a stored generated column per kind
on `round_entries` (`exp_delta bigint GENERATED ALWAYS AS (final_exp - exp_at_start) STORED`
for the finalized case) plus a `(round_id, <delta>) DESC` index. That is a
later migration with **no API consequence**: `roundStandings`'s signature, its
return type, and both routes stay exactly as specified here. Do not pre-build it.
Note the live board cannot use that trick — its second operand lives in
`player_stats` and changes constantly — so the escape hatch covers the hall of
fame, which is the half that accumulates rows without bound.

### 3.5 Negative standings are real standings

`cash` and `bank` deltas can be negative, and the board shows them negative. A
player who spent their round buying properties, weapons and bullets genuinely
finished with less cash than they started with, and hiding that behind a
`GREATEST(delta, 0)` would turn a spender into someone who did nothing. Clamping
would also erase the distinction between a player who broke even and one who
spent everything. The board is a record of what moved, not a scoreboard that only
counts up.

Three consequences the implementer must not "fix":

- `LeaderboardEntrySchema.score` is `MoneySchema`, whose regex is `/^-?\d+$/`
  (`packages/shared/src/primitives.ts:12`) — it **already accepts a leading
  minus**. A negative delta crosses the wire as a normal decimal string; no
  `@gl3/shared` change is needed for it, and none should be made.
- A negative delta still sorts correctly under `ORDER BY delta DESC`; a player
  can legitimately appear on the board below zero when fewer than ten players
  gained.
- `exp` is monotonic in GL3 — nothing subtracts experience — so the `exp` board
  is the only one of the three that cannot go negative, and it is the one that
  reads as "who played hardest". That property is why it is also the payout
  board (§3.6) and the default board (§4.1).

### 3.6 The payout

#### The setting

One core setting key, stored in the existing `settings` table as the literal
string `rounds.payout_points`, holding a JSON array of point awards ordered by
placing. Its length defines N: `[1000, 500, 250]` pays three places, `[5000]`
pays one, `[]` pays nobody. There is no separate "how many places" setting to
fall out of sync with the award list.

New file `apps/server/src/game/rounds/settings.ts`:

```ts
const DEFAULT_PAYOUT_POINTS: readonly bigint[] = [1000n, 500n, 250n];
const MAX_PAYOUT_PLACES = 100;

export function payoutPoints(settings: Record<string, string>): bigint[]
```

Called as `payoutPoints(loadedSettings)` — core reads the plain
`Record<string, string>` directly, exactly as
`apps/server/src/game/hospital/routes.ts:15` does with
`settings["hospital.discharge_cost_per_second"]`. The plugin-side
`ctx.settings.get(key)` closure and its `<pluginId>.` namespacing do not apply:
this is core, and the key is spelled in full.

Parsing rules, all of them chosen for the same reason hospital's parser was:
**`settings` is admin-edited free text and a typo there must not take a request
down.**

- Missing key, or a value whose `.trim()` is `""` → `DEFAULT_PAYOUT_POINTS`. The
  blank check must come first and must be explicit: `JSON.parse("")` throws, but
  the whole class of "admin cleared the field" mistakes should land on the
  default rather than in a catch block by accident.
- `JSON.parse` inside `try`/`catch`; any throw → `DEFAULT_PAYOUT_POINTS`.
- Not `Array.isArray` → `DEFAULT_PAYOUT_POINTS`.
- Each element may be a **number** (must satisfy `Number.isSafeInteger` and
  `>= 0`) or a **string** matching `/^\d+$/`; both are converted with
  `BigInt(...)`. Both spellings are accepted because the admin field is a text
  box, `[1000, 500, 250]` and `["1000","500","250"]` are both things an admin
  will type, and rejecting one silently means a whole round pays nothing. Any
  element that satisfies neither → `DEFAULT_PAYOUT_POINTS` for the whole array;
  a partially-parsed award table is worse than the default, because it silently
  reorders the prizes.
- The result is truncated to the first `MAX_PAYOUT_PLACES` (100) entries. Finalize
  runs inside one player's request (§5.5 risk 1), so the number of
  `applyBalanceChange` calls it makes must be bounded by something other than an
  admin's patience with a text field.
- An empty array `[]` parses successfully to zero awards. That is a legitimate
  configuration — "run rounds, pay nothing" — and must **not** fall back to the
  default.

The parser never throws. A bad value degrades to the default; it does not fail
the finalize transaction.

#### Who gets paid

Placings come from the **`exp`** board of the finalizing round, ranked by the
`roundStandings` call in §2.3 step 2 — §3.2's finalized variant with
`minDelta: 0n`, read on the finalize transaction's own handle after `final_*`
has been frozen.

`exp` and not cash or bank, and this is a decision, not an oversight. `exp` is
monotonic, so the `exp` delta is the only one of the three that cannot be gamed
by simply not spending: on a cash board the round's winner is whoever hoarded,
and a player who spent their winnings on properties — playing the game harder —
places below someone who sat on their balance. Paying on `exp` pays activity.

The number paid is `winners.length`, which the query itself bounds: `n =
awards.length` caps it above and `minDelta: 0n` may return fewer. A round with
two scoring participants and a three-entry award table pays two. Zero
participants pays nobody and is not an error; a game with no rounds and a game
with an empty round must both finalize cleanly (§5.5 risk 3).

#### The call shape

Inside the finalize transaction, after the freeze and before `finalized_at` is
stamped — `winners` is §2.3 step 2's `roundStandings` result, already limited,
so there is no slice here:

```ts
await lockPlayersForUpdate(tx, winners.map((w) => w.playerId));

for (const [i, winner] of winners.entries()) {
  await applyBalanceChange(tx, {
    playerId: winner.playerId,
    amount: awards[i]!,
    kind: "points",
    reason: "round.payout",
    refId: roundId,
  });
}
```

Every field of that object is specified:

- `kind: "points"` — a member of the existing `BalanceKind` union
  (`"cash" | "bank" | "points"`, `economy/ledger.ts:6`) and an existing column
  (`player_stats.points`, `bigint`, `` .default(sql`0`) ``). No schema change.
- `reason: "round.payout"` — a free-text `text` column, no enum to extend.
- `refId: roundId` — `transactions.ref_id` is a plain `uuid` column with no FK,
  so a round id fits and every award is traceable to its round through the
  ledger. This is why no new column is needed anywhere to answer "what did round
  X pay out": `SELECT * FROM transactions WHERE reason = 'round.payout' AND ref_id = $1`.
- **No `jobId`.** `transactions.job_id` carries a UNIQUE index and exists for
  at-least-once BullMQ workers (CLAUDE.md rule 1). Finalize is not a job — it is
  a lazy-at-read transaction whose idempotency comes from
  `pg_advisory_xact_lock` plus the `WHERE finalized_at IS NULL` guard (§2.4).
  Passing a fabricated job id here would add a second, redundant idempotency
  mechanism and a unique-violation failure mode; passing the *same* one twice
  would 23505. Leave it unset.

The explicit `lockPlayersForUpdate(tx, ...)` before the loop is not redundant
with the one `applyBalanceChange` takes internally. It acquires every winner's
`player_stats` row in one ascending-ordered statement, which is what satisfies
the rounds↔player rule of §2.7 ("advisory lock first, then players ascending");
the per-call lock inside `applyBalanceChange` then re-locks a row this
transaction already holds, which is free. Paying the winners in board order
without that pre-lock would take player locks in *delta* order — an order that
varies per round and shares no edge with any other lock path in the game.

`InsufficientFundsError` cannot fire here: every award is non-negative
(guaranteed by the parser) and `points` starts at 0, so
`next = current + amount` is never negative. Do not wrap the loop in a catch for
it; a throw from that call would mean the parser let a negative through, and
that must fail loudly.

The payout writes **no Redis**. `applyBalanceChange` never has, `points` is not a
`LeaderboardKind`, and the plugin wrapper that *does* buffer scores explicitly
skips `points` for exactly that reason (`plugins/ctx.ts:122-125`: "`points` has no
leaderboard — LeaderboardKind is cash/bank/exp").

#### Why points, and not cash

Cash is the obvious prize and it is wrong. The snapshot design exists so that a
round measures progress made *inside* the window; paying the round-1 winner cash
injects money into the exact economy round 2 is about to measure, and hands them
a head start in it. It would reintroduce carryover through the prize, having
removed it from the scoring. Bank has the same defect. `exp` is not payable at
all — paying it would corrupt the one board that reads as pure activity.

`points` is the only balance in the game with no leaderboard kind and no existing
faucet. Awarding it therefore cannot move any board: not the all-time ZSETs
(there is no `leaderboard:points` and none is being added), and not the next
round's standings (an entry snapshots `exp`, `cash` and `bank`, and points is in
none of them). The prize is, by construction, invisible to everything the
round measures. That is the property being bought, and it is why the prize is not
a currency the player can immediately spend into a board.

#### Consequence: a settings change takes effect at the next restart

`loadSettings` (`apps/server/src/settings/load.ts`) reads the whole `settings`
table once, at boot — `index.ts:54` in production, `app.ts:32` for the test
harness — into a plain `Record<string, string>` held in memory, because
`PluginCtx.settings.get` is synchronous and the values must already be there when
a route runs. Writing the `rounds.payout_points` row changes the table but not the
loaded record.

**And "editing the setting" does not mean an admin form.** Nothing in GL3 writes
the `settings` table — not core, not any of the sixteen plugins. Every setting in
the game (`hospital.discharge_cost_per_second`, properties' `income.cap`, every
plugin setting) is edited out of band: the V2 migrator's
`apps/migrate/src/migrators/settings.ts` populates it, and after that an operator
writes the row with SQL. The admin sections that *do* exist edit domain tables
(towns, items, ranks, crimes), never `settings`. This design adds no settings
route either — an admin surface for settings is a separate feature with its own
validation story (a malformed `rounds.payout_points` is a JSON parse away from a
payout that pays nobody), and §3.6's parse-failure fallback exists precisely
because the value arrives unvalidated.

So: **a change to the award table is a SQL edit, and takes effect at the next
server restart.** This
is the documented, pre-existing behaviour of every setting in GL3, not a
limitation this feature introduces — the comment in `load.ts` states it outright
("Changing a setting therefore needs a restart, which matches V2 — `settings` is
admin-edited configuration, not live game state"), and `hospital.discharge_cost_per_second`,
properties' `income.cap` and every plugin setting behave identically.

The one consequence worth stating plainly for rounds specifically: a round that
finalizes between an admin's edit and the next restart pays the **old** award
table. That is acceptable and is not worth a re-read on the finalize path.
Rounds are created ahead of time and the schedule is the mechanism (§4.2); an
operator changing prizes does it between rounds, alongside the restart, and a
per-request settings re-read would put a `SELECT` on the head of a path that is
already the design's one tail-latency risk. Do **not** add a live reload for this
key alone — a settings mechanism that is live for one key and cached for the
other forty is worse than one that is honestly cached for all of them.

#### What the payout does not do

It publishes no event of its own. The winners travel on the global
`round.finished` variant emitted by the finalize transaction after commit
(CLAUDE.md rule 5 — events are facts, published after commit, never inside
`db.transaction(...)`), and the per-player "you were paid" message reuses the
existing `notifications` table rather than a third `GameEvent` variant (§4.4).

---

## 4. Routes, web pages, admin, and events

Everything in this section is **core**, not a plugin — the four reasons are
§1.8, and the consequence is that the plugin migration count is untouched.

Two shapes recur below and are named once here so they are not re-argued per
route:

- **`ensureCurrentRound(db, redis, settings)`** is the lazy rollover entry point of §2.2.
  Every route in this section that can observe a round calls it **first**, before
  any other query. It is cheap when there is nothing to do (one indexed SELECT)
  and takes `pg_advisory_xact_lock` only when it actually finalizes.
- **No round is a supported state.** Every GL3 install today has zero `rounds`
  rows. With none, `GET /api/rounds` returns `active: null` and an empty history,
  `scope=round` returns an empty entries array, the standings route 404s for any
  id, and nothing else in the game behaves differently. Rounds are strictly
  additive (§5.5 risk 3).

Which round is active, and what the two nullable date columns mean, is fixed once
in §1.5.1 and not restated per route.

### 4.1 Player routes

All three are core routes registered with the core `requireAuth` preHandler — plain
logged-in session. The loader's `auth: "admin" | "player" | "public"` tier vocabulary
applies only to *plugin* routes (`apps/server/src/plugins/routes.ts:27-34`) and is not
in play here.

New DTO file **`packages/shared/src/dto/rounds.ts`**, registered with one line in
`packages/shared/src/index.ts` (`export * from "./dto/rounds.js";`, placed after
the existing `./dto/rank.js` line and before `./dto/shop.js`):

```ts
import { z } from "zod";
import { IdSchema, MoneySchema, TimestampSchema } from "../primitives.js";
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

`LeaderboardEntrySchema` is reused verbatim (`playerId`, `username`, `score`,
`rank`) rather than a new round-specific entry type. Its `score` is `MoneySchema`,
which already carries a sign, so a negative standing needs no second entry type
and no schema change — §3.5 is the full argument, and "do not clamp negatives to
zero anywhere" is the instruction that follows from it.

#### Where these routes live, and where they are registered

Both round routes live in one new file, **`apps/server/src/game/rounds/routes.ts`**,
alongside the other new files of this design in the same new directory
(`ensureCurrentRound` in `apps/server/src/game/rounds/service.ts`, `roundStandings`
in `apps/server/src/game/rounds/standings.ts`). It follows the shape every other
core module's `routes.ts` already has — a single exported `register*Routes`
function taking the app plus its dependencies, no side effects at import time:

```ts
export function registerRoundsRoutes(
  app: FastifyInstance,
  db: Db,
  redis: Redis,
  settings: Record<string, string>,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void;
```

`settings` sits before `requireAuth` because that is the order
`registerHospitalRoutes` already uses (`app.ts:62`), and `redis` before
`settings` matches `registerLeaderboardRoutes`. Both are needed for the same
reason: every handler in this file starts with `ensureCurrentRound(db, redis,
settings)` (§2.2).

Registration is one import and one call in `apps/server/src/app.ts`:

- the import beside the other `game/*` route imports (`app.ts:7-11`, which are
  alphabetical — `registerRoundsRoutes` goes after `registerProfileRoutes` on
  line 11 and before the `plugins/` imports on line 12);
- the call in the core-route block at `app.ts:61-65`, inserted **after**
  `registerProfileRoutes(app, deps.db, requireAuth);` (line 64) and before
  `registerWsRoutes` (line 65):

```ts
  registerRoundsRoutes(app, deps.db, deps.redis, loadedSettings, requireAuth);
```

`loadedSettings` is already in scope there — `app.ts:32` binds it from
`await loadSettings(deps.db)`, and `registerHospitalRoutes` on line 62 already
passes it. This is the same `Record<string, string>` §2.2 requires, so no new
plumbing is introduced by this design's *route* half; the only widened core
signature is `registerLeaderboardRoutes` (§2.2), which needs it for its
`scope=round` branch and does not have it today.

The routes must be registered **before** the plugin seam at `app.ts:67`, which
the position above satisfies. `/api/rounds` is deliberately *not* added to
`RESERVED_BASE_PATHS` — only `/api/admin/rounds` is (§4.2 carries the argument).

#### `GET /api/rounds`

- Auth: `requireAuth`.
- Params: none. Querystring: none — no filters, no paging. The hall of fame is every
  finalized round the game has ever had, which at V2 scale is tens of rows.
- Handler: `await ensureCurrentRound(db, redis, settings)` **first**, so visiting the Rounds
  page is one of the things that can trigger a rollover. Then one select for the
  active round and one for the finalized ones.
- Response `200 RoundListResponse`: `active` is the active round per §1.5.1 or
  `null`; `finished` is every round with `finalized_at IS NOT NULL`, ordered
  **`ends_at DESC NULLS LAST, id DESC`**. Both parts of that are load-bearing.
  `ends_at` is nullable and Postgres sorts NULLs **first** under `DESC` by
  default, so a finalized open-ended round — exactly what the V2 migrator brings
  over (§1.5) — would head the hall of fame instead of tailing it; `NULLS LAST`
  puts it where a reader expects. The `id DESC` tiebreak gives a total order, so
  two rounds sharing an `ends_at` (or two open-ended ones sharing a NULL) do not
  swap places between renders; ids are uuidv7, so descending id is descending
  creation time and the tiebreak reads as "newest first" rather than as
  arbitrary. `secondsRemaining` is computed server-side as
  `max(0, floor((ends_at - now) / 1000))` and is `null` when `ends_at` is `null`.
  Sending a countdown in seconds rather than only `endsAt` means the client's clock
  skew cannot make a round look already-over on one machine and live on another; the
  client still gets `endsAt` for display.
- Errors: none beyond the 401 `requireAuth` already produces.

#### `GET /api/rounds/:id/standings?kind=cash|bank|exp`

- Auth: `requireAuth`.
- Params schema, file-level const in the route module:
  `const ParamsSchema = z.object({ id: IdSchema });`
  parsed with `safeParse(request.params)`; failure → `400 { error: "invalid_request" }`.
  This is not decoration. An unvalidated uuid param reaches Postgres and 500s with a
  raw `PostgresError` body instead of returning a clean 400 — the repo already pays
  for that lesson in `noNulByte`'s comment. The code is the repo-wide
  `invalid_request`, not a bespoke `invalid_round_id`: every zod parse failure in
  core answers with that one string (`auth/routes.ts:55,118`,
  `admin/routes.ts:134,168,183,206`, `plugins/routes.ts:68,70`), and it is already
  mapped in `apps/web/src/lib/errors.ts`. A new per-route code would be one more
  unmapped string for no information the player can act on.
- Querystring schema:
  `const QuerySchema = z.object({ kind: LeaderboardKindSchema.default("exp") }).strict();`
  parsed with `safeParse(request.query)`; failure → `400 { error: "invalid_kind" }`,
  the same error string the existing leaderboard route already uses for a bad kind
  (`apps/web/src/lib/errors.ts:33` already maps it, so the client needs no new copy).
  The default is `exp` because it is the only monotonic metric and therefore the only
  one that answers "who played this round hardest" without a caveat (§3.5).
- Handler: `await ensureCurrentRound(db, redis, settings)` first — an ended-but-unsettled round
  must settle before it is read, or the same request would report a live board for a
  round that is over. Then load the round row; unknown id → `404 { error: "round_not_found" }`.
  Then `roundStandings` for that round and kind, `LIMIT 10`.
- Row count is the hardcoded literal `10`, matching what the existing leaderboard
  route passes to `topN` (`apps/server/src/game/leaderboard/routes.ts:19`). No `limit`
  querystring: the existing board does not have one either, and adding one here alone
  would make the two boards differ for no reason a player can see.
- `rank` is `i + 1` over the returned slice — index in the ordered result, not a
  dense/competition rank. Same as `topN`. Ties therefore get distinct ranks in an
  arbitrary but stable order; this matches the all-time board's existing behaviour and
  is not worth diverging from for a read-rare page.
- Response `200 RoundStandingsResponse`. `finalized` is `finalized_at !== null`, and
  is what selects the frozen or the live variant of the one query in §3.2.

#### `GET /api/leaderboard/:kind?scope=round|all` — the backward-compatible extension

What the route does **today**, verbatim from
`apps/server/src/game/leaderboard/routes.ts:15-20`:

```ts
app.get("/api/leaderboard/:kind", { preHandler: requireAuth }, async (request, reply) => {
  const params = ParamsSchema.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: "invalid_kind" });

  const entries = await topN(db, redis, params.data.kind, 10, leaderboardPrefix);
  return reply.send({ kind: params.data.kind, entries });
});
```

`request.query` is never referenced today: there is no querystring schema, and the
count is the hardcoded literal `10`.

The change is one `await ensureCurrentRound(db, redis, settings)` at the head of the handler
(§2.2 call site 4 — unconditional, before the params parse), one added querystring
schema, and one branch:

```ts
const QuerySchema = z.object({ scope: z.enum(["round", "all"]).default("all") }).strict();
```

parsed with `safeParse(request.query)`; failure → `400 { error: "invalid_scope" }`
(a new string, so `apps/web/src/lib/errors.ts` gains one mapping beside the existing
`invalid_kind`).

- `scope=all` — and therefore **every caller that sends no querystring at all** —
  takes exactly the path above, unchanged: `topN` against the Redis ZSET, absolute
  values, prefix threaded from `leaderboardPrefix`. This is why the default is `"all"`
  and not `"round"`. The web client today calls `` api(`/api/leaderboard/${kind}`) ``
  with no query params (`apps/web/src/api/queries.ts:115-116`), and any third-party
  or scripted caller does the same; a default of `"round"` would silently change every
  one of their answers, and on an install with no rounds would change them to empty.
- `scope=round` — delegate to `roundStandings` for the **active** round, `LIMIT 10`.
  No active round → `{ kind, entries: [] }`. Not a 404: an empty board is the honest
  answer for "the current season's standings" on a game that is not running a season,
  and a 404 would make the web toggle need an error state for a state that is not an
  error.
- The response body is **unchanged in shape** — still `{ kind, entries }`, still
  `LeaderboardResponseSchema`. No `scope` echo field. The caller knows what it asked
  for, `LeaderboardResponseSchema` needs no edit, and this keeps the extension inside
  `@gl3/shared`'s existing surface. (The DTO file `packages/shared/src/dto/leaderboard.ts`
  is not touched by this route at all.)
- `recordScore`, `rebuildLeaderboards` and `topN` keep their **exact** current
  behaviour, including the trailing `prefix = DEFAULT_LEADERBOARD_PREFIX` argument on
  all three and the `leaderboardPrefix` field threaded through `AppDeps`,
  `LoadPluginsDeps` and `PluginCtxDeps` — §3.1.

### 4.2 Admin routes — `/api/admin/rounds`

Core-owned, beside `/api/admin/roles`. Plugins claim `/api/admin/<pluginId>`; core
reserves its own paths, so **`"/api/admin/rounds"` is added to
`RESERVED_BASE_PATHS` in `apps/server/src/plugins/validate.ts:4-9`**, joining
`"/api/admin/plugins"` and `"/api/admin/roles"`. Without it a plugin whose id happens
to be `rounds` would claim the path at boot and win. Deliberately **not** reserved:
`/api/rounds` itself. `RESERVED_BASE_PATHS` does hold four non-admin entries today —
`/api/auth`, `/api/ws`, `/api/plugins` and `/health` — but those are the *shell*:
authentication, the socket, the manifest endpoint and the health probe, none of
which is a game module. No core **gameplay** path is reserved: `/api/bank`,
`/api/leaderboard`, `/api/jail`, `/api/hospital` and `/api/profile` are all
claimable, precisely because a plugin replacing one is the strangler seam working
as designed (§1.8 — `profile`, `leaderboard` and `jail` are deliberate non-ports,
not protected ones). `/api/rounds` is a gameplay path and gets the gameplay rule.

A plugin that claims it anyway does not silently shadow core: both register on the
same Fastify instance, so an exact duplicate is `FST_ERR_DUPLICATED_ROUTE` at boot —
loud, immediate, and before any request is served.

Permission key: a new module key **`rounds`**. `moduleKeysOf` in
`apps/server/src/admin/routes.ts:42-49` gains `{ id: "rounds", name: "rounds" }` beside
the existing `{ id: "roles", name: "roles" }`, and every rounds handler checks
`hasPermission(grants, "rounds")`. Reusing the `roles` key was rejected: `roles`
is transitively equivalent to full admin (it can grant itself `*`), and scheduling a
season is a content job. Whoever runs seasons should not thereby be able to promote
themselves.

**Reserving the path is not the same as reserving the key, and both are needed.**
`moduleKeysOf` builds its list as `"*"`, `"roles"`, then **every loaded plugin id**
(`apps/server/src/admin/routes.ts:42-49`) — so a plugin whose id is `rounds` puts a
second `rounds` row into the grant list, and a grant made against *that* row
satisfies `hasPermission(grants, "rounds")` for core's rounds admin, because grants
are stored as bare module-key strings with no namespace. The path reservation does
not catch this: it only fires for a plugin that *declares admin routes*, and a
plugin with no `adminPages` at all still contributes its id as a module key. So
`"rounds"` joins `"roles"` in whatever guard the loader already applies to
`"roles"` — and if it applies none, add one: a plugin id equal to a core module key
is a hard boot failure, thrown from `validate.ts` beside the reserved-path check,
with the same loud-at-boot behaviour. This is cheap to get wrong quietly and
expensive to notice: the symptom is a content editor holding an unrelated plugin's
grant who can silently reschedule the season.

Every handler repeats the two inline lines the existing core admin routes use — the
repetition is deliberate house style (`apps/server/src/admin/routes.ts:54-57`):

```ts
const playerId = request.playerId;
if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
const grants = await loadGrants(db, playerId);
if (!hasPermission(grants, "rounds")) return reply.code(403).send({ error: "forbidden" });
```

Bodies are `.strict()` zod objects. Timestamps arrive as ISO 8601 strings validated
with **`z.string().datetime({ offset: true })`** and are converted with
`new Date(...)` before the write. The `{ offset: true }` is not decoration: bare
`z.string().datetime()` accepts **only** a `Z` suffix and rejects
`2026-09-01T00:00:00+02:00` with the same `invalid_request` an outright malformed
string gets. The web form sends `toISOString()`, which is always `Z`, so the
default would look fine in the UI and fail only for the admin using `curl` from a
non-UTC machine — the worst kind of validation bug, because the message gives no
hint which field or why. `new Date(...)` normalises the offset to the same instant
either way, and the column is `timestamptz`, so accepting offsets costs nothing
downstream.

| Method + path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/admin/rounds` | — | `200 { rounds: [{ id, name, startsAt, endsAt, finalizedAt, status }] }`, ordered `starts_at ASC NULLS LAST` | 401, 403 |
| `GET /api/admin/rounds/table` | — | `200 { rows: [{ id, name, startsAt, endsAt, status }] }` | 401, 403 |
| `POST /api/admin/rounds` | `{ name, startsAt, endsAt }` | `201 { id }` (uuidv7) | 400 `invalid_request`, 400 `invalid_window`, 400 `round_overlap` |
| `POST /api/admin/rounds/edit` | `{ roundId, name, startsAt, endsAt }` | `204` | 400 `invalid_request`, 400 `invalid_window`, 400 `round_overlap`, 400 `round_finalized`, 404 `round_not_found` |

`status` is derived in the handler, never stored: `"finalized"` when `finalized_at`
is set, else `"active"` when the round covers now, else `"ended"` when `ends_at` has
passed (settled on the next `ensureCurrentRound`), else `"scheduled"`.

`GET /api/admin/rounds/table` exists as a twin of `GET /api/admin/rounds` for the same
reason `GET /api/admin/roles/table` does: a `table` view node and a `select` field's
`optionsSource` both parse the response with `TableRowsResponseSchema`, so the shape
must be `{ rows }` with string values, while the JSON listing keeps its own shape.

**"String values" is literal and it is enforced by zod**: `TableRowsResponseSchema`
is `z.object({ rows: z.array(z.record(z.string())) }).strict()`
(`packages/shared/src/dto/plugins.ts:249-251`) — `.strict()`, so `rows` is the only
key the envelope may carry — and every value in every row
must be a `string` — not a `Date`, not a number, not `null`, not `undefined`. The
handler therefore renders each column itself rather than spreading the drizzle row:
`id` and `name` pass through, `startsAt`/`endsAt` become
`row.startsAt?.toISOString() ?? ""` (a nullable `ends_at` is the empty string, not
`null` — omitting the key would also parse, but then the column silently vanishes
from that one row while every other row shows it), and `status` is the derived
string above. A row spread straight from the query fails the parse **client-side**,
inside `PageRenderer`, where it looks like a rendering bug rather than a handler
one.

**Edit is `POST .../edit`, not `PATCH /api/admin/rounds/:id`.** The admin view
vocabulary's `form` node is `{ kind: "form", action: "METHOD /abs/path", fields }`
(`packages/plugin-sdk/src/pages.ts`) with no interpolation of a path parameter — the
id has to travel as a field in the body. `POST /api/admin/roles/grants/revoke` is the
existing precedent for exactly this.

**There is deliberately no "end it now" button** (§1.4 item 6). Rounds are created
ahead of time and the schedule *is* the mechanism: setting `ends_at` to an instant in
the past ends the round, and the next `ensureCurrentRound` settles it. A separate
end-now endpoint would be a second way to reach the same state, with its own bugs, its
own audit story, and its own race against the lazy rollover — for zero capability the
edit form does not already have.

**Overlap is rejected at write time.** A new or edited round may not cover an instant
that another **non-finalized** round covers. Intervals are half-open (§1.5.1), so the
test is `a.starts_at < b.ends_at AND b.starts_at < a.ends_at`, evaluated in SQL with
`COALESCE(ends_at, 'infinity'::timestamptz)` so an open-ended round conflicts with
everything after its start. Rows with `starts_at IS NULL` are excluded from the check
entirely — they can never be active, so they cannot collide with anything. The edit
route excludes the row being edited. `invalid_window` is the separate, simpler check
that `ends_at > starts_at` on the submitted row.

This has a real consequence on a migrated V2 install: the open-ended round the
migrator brought over conflicts with every future round, so an admin must give it an
`ends_at` before scheduling the next one. That is the intended forcing function — you
cannot schedule round 2 until you say when round 1 ends — and the alternative
(ignoring open-ended rounds in the check) produces two simultaneously-active rounds,
which is the one thing the read path cannot resolve correctly.

Postgres cannot express "at most one non-finalized round covers now" as a constraint,
so this application-level check is the only guard. Because it is the only guard, the
read path never *trusts* it: it picks deterministically (earliest `starts_at` among
rows covering now, §2.2) rather than assuming uniqueness. See §5.5 risk 2.

**The check and the write are one transaction under the rollover's advisory lock.**
On its own, "SELECT for an overlap, then INSERT" is a textbook check-then-act: two
admins submitting adjacent windows at the same time each read a clean board and each
write, and the pair that results overlaps. There is no unique index to fall back on —
an overlap is a predicate over two rows, not a value. So both write routes open
`db.transaction` and make their **first statement**
``await tx.execute(sql`SELECT pg_advisory_xact_lock(7461002)`)`` — the same constant
the finalize takes (§2.4) — with the overlap `SELECT` and the `INSERT`/`UPDATE`
inside it. Two concurrent writes then serialise: the second runs its check against
the first's committed row and answers `400 round_overlap`.

Sharing the finalize's constant rather than taking a third one is deliberate and it
is the cheaper choice in both directions. It means an admin write and a rollover can
never interleave — an edit cannot move `ends_at` out from under a finalize that has
already frozen `final_*` against it — and the contention it buys is nil: rollovers
are rare, admin writes are rarer, and neither holds the lock for more than a few
statements. A distinct constant would need its own argument for why those two
sequences are safe to run concurrently, and there isn't one.

This does **not** extend to the two `GET` routes. They read without the lock, like
every other admin listing, and a listing that is a few milliseconds stale is not a
correctness problem.

**A finalized round's dates are immutable.** `POST /api/admin/rounds/edit` returns
`400 round_finalized` when `finalized_at IS NOT NULL`, for any field including the
name. Its entries hold frozen `final_*` values snapshotted against the window that
existed at the time; moving the window afterwards would leave a board that says one
thing and a schedule that says another, and there is no repair for it short of
re-running a finalize that has already paid out.

### 4.3 Web

**`apps/web/src/pages/Rounds.tsx`** — hand-written, like `Properties.tsx`, not a
manifest-declared page. It is a core page: the manifest page renderer serves plugin
`pages`, and core pages are React modules.

- Route `<Route path="rounds" element={<Rounds />} />` in `apps/web/src/App.tsx`,
  beside `leaderboards`; nav entry `["/rounds", "Rounds"]` in
  `apps/web/src/components/Shell.tsx` beside `["/leaderboards", "Leaderboards"]`.
- Content: the active round (name, window, and a countdown driven by
  `secondsRemaining` ticking locally), the three round boards for the active round
  (cash / bank / exp, selected by the same `styles.tabs` / `styles.tabActive` pattern
  `Leaderboards.tsx` already uses), and the hall of fame — every finalized round from
  `finished`, each expandable to its frozen standings. No round → a single line saying
  no season is running, and no boards.
- Query keys in `apps/web/src/api/keys.ts`:
  `rounds: () => ["rounds"] as const` and
  `roundStandings: (roundId: string, kind: LeaderboardKind) => ["rounds", roundId, "standings", kind] as const`.
  Standings are nested under `rounds` on purpose: invalidating `["rounds"]` covers
  every board without enumerating them, because TanStack matches query keys by prefix.
- Hooks in `apps/web/src/api/queries.ts`: `useRounds()` parsing with
  `RoundListResponseSchema`, `useRoundStandings(roundId, kind)` parsing with
  `RoundStandingsResponseSchema`.

**`apps/web/src/pages/Leaderboards.tsx`** gains a round/all-time toggle. The existing
kind tabs stay exactly as they are; a second row of two buttons selects
`scope: "round" | "all-time"`, defaulting to `"all-time"`. The toggle exists so the
two numbers are never mistaken for each other — a round board showing 4,000 and an
all-time board showing 900,000 for the same player are both correct, and without a
visible label the smaller one reads as a bug.

- `keys.leaderboard` becomes
  `leaderboard: (kind: LeaderboardKind, scope: "round" | "all") => ["leaderboard", kind, scope] as const`,
  and gains a sibling `leaderboards: () => ["leaderboard"] as const` — the prefix over
  every kind and scope, for invalidation.
- `useLeaderboard(kind)` becomes `useLeaderboard(kind, scope)` and appends
  `?scope=${scope}` to the URL. The response schema is unchanged.
- **Both are arity changes, so enumerate the callers rather than assuming.** There
  are exactly three lines to touch, and no more: `keys.leaderboard` is called once
  (`apps/web/src/api/queries.ts:115`, inside `useLeaderboard`), `useLeaderboard` is
  declared once (`queries.ts:113`) and called once
  (`apps/web/src/pages/Leaderboards.tsx:15`, `const board = useLeaderboard(kind)` →
  `useLeaderboard(kind, scope)`). Note in particular that
  `apps/web/src/ws/invalidation.ts` does **not** reference the leaderboard key
  today — no existing case invalidates it — which is why §4.4's two new cases
  introduce `keys.leaderboards()` there rather than editing an existing entry.
  Every one of the three is a compile error if missed, so this list is a
  convenience, not a safety net.
- When `scope === "round"` and the board is empty, the page says so explicitly ("no
  season is running") rather than rendering an empty table, because an empty table and
  a table that has not loaded look identical.

**`apps/server/src/admin/rounds-page.ts`** — a `PageSchema` constant exported as
`roundsPage`, sitting beside `apps/server/src/admin/roles-page.ts` and imported by
`registerAdminRoutes`. It is appended to the sections payload with the synthetic
`pluginId: "rounds"` when `hasPermission(grants, "rounds")`, exactly as `rolesPage` is
appended with `pluginId: "roles"` (`apps/server/src/admin/routes.ts:59-87`). Copy each
field into the `PagePayload` individually — never a spread; `PageSchema`'s optional
`menu` would be rejected by the client's `.strict()` schema.

```ts
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

Two constraints this shape is obeying:

1. **No UUIDs in admin tables.** The `table` node declares no column whose `key` is
   exactly `id` or ends in `Id`; the round id travels only as the edit form's select
   `valueKey`, so the admin picks a round by name and never sees a UUID.
   `apps/server/test/admin-ids-hidden.test.ts` enforces this with
   `ID_COLUMN_RE = /^id$|Id$/`, and its `sections` array must gain the rounds page —
   see §5.3 — otherwise the new table is simply not checked and the guard passes
   vacuously.
2. **Dates are `type: "text"`.** The field vocabulary is
   `text | number | decimal | money | password` plus `select` and `hidden`
   (`packages/plugin-sdk/src/pages.ts`); there is no date field and adding one to the
   SDK is out of scope for this feature. The label carries the format, and
   `z.string().datetime({ offset: true })` on the body (§4.2) is what actually
   enforces it — the `{ offset: true }` matters here specifically because this
   field is free text an operator types by hand, where a `+02:00` is far likelier
   than in the JSON the web form builds with `toISOString()`.

The Admin page itself needs no change: `apps/web/src/pages/Admin.tsx` renders every
section through the one `renderNode` + `PageRenderer` path with no core-specific
branch, so the rounds section appears as a tab labelled `rounds` for free.

#### Error copy — the five new codes

`apps/web/src/lib/errors.ts` maps every snake_case code the API can emit to a
sentence, and its header comment states the list is the full set found in
`apps/server/src` — a code with no entry renders to the player as the raw string
`"400 round_overlap"`. This design introduces five, all of which must be added to
`MESSAGES` (alphabetical, like the rest of the map):

```ts
  invalid_scope: "Unknown leaderboard scope.",
  invalid_window: "A round must end after it starts.",
  round_finalized: "That round has already been settled.",
  round_not_found: "That round no longer exists.",
  round_overlap: "Another round already covers that period.",
```

`invalid_request`, `unauthorized` and `forbidden` — the other codes these routes
emit — are already mapped and need nothing. Three of the five are admin-only and
will realistically only ever be read by an operator, but the map is
route-agnostic: the client resolves copy by code, not by which page asked.

### 4.4 Events

Two new variants, both **global**, added to the discriminated union in
`packages/shared/src/events.ts` immediately before the `plugin.event` envelope. Both
spread the shared `base` (`{ id, at, actorId, actorName, audience }`, events.ts:8-14),
so `at` and the actor fields are carried by the envelope and never repeated in the
payload. Money fields are `MoneySchema` (decimal string), counts are
`z.number().int()`.

```ts
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

`TimestampSchema` is already imported at events.ts:2; nothing new is imported.

**Where each envelope field comes from.** `id` is a fresh `uuidv7()` at publish
time, and `at` is `new Date().toISOString()` — the same two lines every existing
core publisher writes, since `base` is populated by the caller and there is no
factory. `actorId`/`actorName` are covered below. `winners[].username` is **not**
resolved separately: `winners` is the `roundStandings` result from §2.3 step 2,
whose entries are `LeaderboardEntry` (`{ playerId, username, score, rank }`), so
the username is already in hand, already resolved by §3.2's second query, and
already carries the same `?? "unknown"` fallback the all-time board uses. The
mapping is `playerId ← playerId`, `username ← username`, `placing ← rank`,
`points ← the award for that index`, which is the paid figure and deliberately
**not** `score` (`score` is the round delta that earned the placing; `points` is
what was paid for it).

**Audience** is a field on the event, not a publish argument: both carry
`audience: { kind: "global" }`. Everything is published to the single Redis channel
`game:events` and fanned out by audience downstream, which is why any test asserting
on these must filter by its own actor id (CLAUDE.md rule 4, `awaitOwnEvent()`).

**Actor.** Rollover has no acting player — it is triggered by whichever request
happened to notice, and naming that player as the actor would tell every other player
that Bob ended the season. `base.actorId` is a non-nullable `IdSchema`, so a null is
not available. Both events therefore set `actorId` to the **round's own id** and
`actorName` to the **round's name**. That is a real uuid (so zod passes and the
gateway routes normally), it is stable, it never attributes the event to a player, and
it gives tests a per-round discriminator to filter on. Neither event's client copy
reads `actorName`, so the substitution is invisible in the UI.

**Payout notifications reuse the existing `notifications` table.** The finalize
transaction calls `insertNotification(tx, { id: uuidv7(), playerId, body })`
(`apps/server/src/game/notifications/service.ts`) once per winner, with a body
like `Round "Summer 2026" finished — you placed 1st and were paid 1000 points.` It
deliberately does **not** publish a `notification.created` event per winner: that
would be N extra publishes on the tail of the one unlucky request that absorbed the
rollover, and the global `round.finished` already names every winner. The winners'
notification list refreshes because `round.finished` invalidates `keys.notifications()`.

#### The three places that must be updated when the union widens

1. **`apps/web/src/lib/eventCopy.ts`** — `describeEvent`'s `switch (event.type)` has
   no `default` and returns `string`, so a missing case fails compilation with TS2366
   ("Function lacks ending return statement"). Add:
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
2. **`apps/web/src/ws/invalidation.ts`** — `invalidationKeys`'s `switch` is likewise
   `default`-less with a non-void return type, so a missing case is TS2366 there too.
   Add:
   ```ts
   case "round.started":
     return [keys.rounds(), keys.leaderboards(), keys.me()];
   case "round.finished":
     return [keys.rounds(), keys.leaderboards(), keys.notifications(), keys.me()];
   ```
   `keys.leaderboards()` is the `["leaderboard"]` prefix added in §4.3; it covers both
   scopes and all three kinds in one entry. `keys.me()` is in both because a payout
   moves `points`, which `/api/auth/me` reports.
3. **`apps/server/test/plugin-ctx-core-events.test.ts`** — the `CORPUS` drift guard at
   lines 74-100. `CoreEventInput` is derived from `GameEventSchema`, so a new variant
   reaches the SDK and the wire for free; `CORPUS` is what proves it was actually
   exercised. It currently holds 23 entries and must reach **25**, one per new
   variant, e.g.
   `{ type: "round.started", audience: { kind: "global" }, roundId: UUID_A, roundName: "Season 1", endsAt: "2026-09-01T00:00:00.000Z" },`.
   **This one only fails under the integration suite.** It is a runtime assertion, not
   a type error: the file needs Postgres and Redis, so `npm run typecheck` passes
   without it, the `@gl3/web` project passes without it, and CI's `verify:ci` job —
   which runs with no database or Redis service containers — passes without it. Only
   a local `npm run verify` catches it. `player.backfired` shipped past two separate
   task reviews on exactly this gap.

While in `events.ts`, fix the stale comment at line 95: it says "The twenty-two core
variants above stay closed and unchanged", the true count is already 23
(`player.discharged` and `player.backfired` landed after it was written), and it
becomes **25** here. The runtime guard counts correctly regardless — it derives from
`GameEventSchema.optionsMap` — but the comment has now misled two readers.

#### `@gl3/shared` version bump

`packages/shared/package.json` is at **`0.1.3`** today (line 3). This change widens
its public surface additively — two `GameEvent` variants and the new
`packages/shared/src/dto/rounds.ts` exports — so it ships as a **patch: `0.1.4`**, and
it must be **republished to `npm.gl3.dev`**. Under `0.x`, `^0.1.0` resolves
`>=0.1.0 <0.2.0`, so every existing consumer range keeps working; a minor bump
(`0.2.0`) would break all of them and is not what an additive change warrants.

`packages/plugin-sdk` stays at **`0.1.0`** and is not republished. Its `CoreEventInput`
is *derived* from `GameEvent` rather than restated
(`packages/plugin-sdk/src/ctx.ts:104-112`), so the new variants reach `publishCore`
through the SDK's own `@gl3/shared` dependency with no SDK edit at all — the same
reasoning that let `player.discharged` ship as `@gl3/shared@0.1.1` alone.

Two riders on the republish. First, inside this repo every consumer resolves
`@gl3/shared` through the workspace, so `npm run verify` is green while the registry
copy stays stale — the publish is the only thing that reaches third-party plugin
authors, and it must land **before** any out-of-repo plugin can call `publishCore`
with `round.started` or `round.finished`. Second, `files` in the manifest is
load-bearing: `dist/` is gitignored, and publishing without it ships a package with no
build output.

---

## 5. Testing strategy, risks, and acceptance

### 5.1 Before anything else: register every new test file

`vitest.workspace.ts` enumerates `apps/server` test files **explicitly**, one string
per file, inside each project's `include` array. This is the ninth registration
site described in `CLAUDE.md` — unlike the other eight it is **per test file, not
per plugin**, and it fails completely silently. A file that is not listed:

- never runs, in any invocation;
- makes `npx vitest run apps/server/test/<name>.test.ts` exit 1 with `No test files
  found` and no other hint;
- leaves `npm run verify` **green**, so it can sit committed and reviewed and never
  execute once.

This bit three separate tasks on the `feat/car-theft` branch. Do not treat it as
boilerplate.

The syntax is one array element, path relative to `./apps/server`, no leading
`./`, trailing comma, inserted into the existing list:

```ts
        "test/rounds-rollover.test.ts",
```

The four `apps/server` projects and the rule for picking one (all verified against
`vitest.workspace.ts:185-334`):

| project | setup | put a file here when |
| --- | --- | --- |
| `@gl3/server:unit` | none | it touches neither Postgres nor Redis — a pure function of its arguments |
| `@gl3/server:redis-only` | none | it calls `createRedis()` but never `testDb()` |
| `@gl3/server:db-only` | `globalSetup`, `setupFiles: [isolatedDb]`, 30s hook/test timeouts | it calls `testDb()` but never `createRedis()` / `bootTestServer()` |
| `@gl3/server` (default) | `globalSetup`, `setupFiles: [isolatedDb, rateLimitIsolation]`, 30s timeouts | it calls `bootTestServer()`, or both `testDb()` and `createRedis()` |

Defaulting into `@gl3/server` is always *safe*; it just pays for a database clone
the file may not use. Getting it wrong in the other direction — a `bootTestServer()`
file placed in `:unit` — fails immediately and loudly, so the risk is only wasted
setup, never a false green.

The three package projects (`@gl3/shared`, `@gl3/plugin-sdk`, `@gl3/web`) use the
glob `test/**/*.test.ts`. A new file under `apps/web/test/` needs **no** workspace
entry.

Run the suite as `npm run verify`, bare, and act on its exit code. Do not append
`; echo "exit=$?"` — that makes the shell's status the status of `echo` and hides a
failing run from anything reading it. If you need the log, use
`npm run verify > /tmp/verify.log 2>&1` and then read `$?` before running anything
else. A non-zero exit is a failure even when the summary line says every test
passed: an unhandled rejection anywhere in the run produces exactly that
combination, which is how the gateway's missing `.catch` survived two "green" runs.

### 5.2 New test files

Nine new files: eight under `apps/server/test/`, each of which **needs the
`vitest.workspace.ts` entry** described above, plus one under `apps/web/test/`,
which is glob-included and needs none.

| file | project |
| --- | --- |
| `apps/server/test/rounds-rollover.test.ts` | `@gl3/server` |
| `apps/server/test/rounds-finalize.test.ts` | `@gl3/server` |
| `apps/server/test/rounds-ledger.test.ts` | `@gl3/server` |
| `apps/server/test/rounds-lock-order.test.ts` | `@gl3/server` |
| `apps/server/test/rounds-snapshot.test.ts` | `@gl3/server` |
| `apps/server/test/rounds-standings.test.ts` | `@gl3/server:db-only` |
| `apps/server/test/rounds-routes.test.ts` | `@gl3/server` |
| `apps/server/test/admin-rounds.test.ts` | `@gl3/server` |
| `apps/web/test/rounds-page.test.ts` | `@gl3/web` (glob — no entry needed) |

A file named `rounds-absent.test.ts` was considered and deliberately **not**
created: §5.5 risk 3 (a game with no `rounds` row must work unchanged) is proved
inside `rounds-snapshot.test.ts` (registration with no active round) and
`rounds-routes.test.ts` (every read surface with zero rounds). Splitting it out
would give a third file that resets the same database to the same empty state to
assert the same absence. If you find yourself creating it, put the assertions in
the two files named here instead.

---

#### `apps/server/test/rounds-rollover.test.ts` — rollover fires exactly once
**Project: `@gl3/server`** (needs `bootTestServer()` — HTTP, Postgres and Redis).

**What it proves.** When N concurrent requests all arrive after `ends_at` has
passed, exactly one of them performs the finalize, and the other N-1 find the work
done and answer normally.

**Shape.** Seed one round whose `ends_at` is already in the past, and a successor
whose `starts_at` equals that `ends_at` — **also in the past** — with its own
`ends_at` in the future and its `snapshotted_at` null. The successor's `starts_at`
must be at or before `now()` or the finalize's re-evaluation (§2.3 step 4) will not
match it, no activation happens, and assertions 4 and 5 fail for a reason that has
nothing to do with the race under test. Seed enough players that the payout has real winners
(at least four, so a three-award `rounds.payout_points` has a non-placer to ignore).
Then fire 8 concurrent `GET /api/rounds` through `app.inject()` with
`Promise.all(...)`, using the same `fire()` idiom as
`apps/server/test/properties-lock-order.test.ts` (`Promise.resolve(app.inject(...))`
— `inject()` is lazy and does not dispatch until something calls `.then`, so a bare
`app.inject()` in an array is not actually in flight).

Assertions:

1. all 8 responses are 200 — no 500, no 23505;
2. exactly one row in `rounds` has a non-null `finalized_at`, and it is the ended
   round;
3. `select count(*) from transactions where reason = 'round.payout' and ref_id = <ended round id>`
   equals `rounds.payout_points.length` — **not** a multiple of it. This is the
   assertion that a second finalize breaks;
4. `round_entries` for the *successor* round contains exactly one entry per player,
   no duplicates (the PK would have thrown, so this catches the milder bug where a
   loser's insert silently no-ops half a population), and the successor's
   `snapshotted_at` is non-null exactly once;
5. every player's `players.round_id` equals the successor round's id;
6. **exactly one `round.finished` and exactly one `round.started` reach
   `game:events`** — the only assertion anywhere that these two events are
   published at all. Subscribe before firing the 8 requests and collect with
   `awaitOwnEvent()` from `test/helpers/events.ts`, filtering on `actorId`:
   §4.4 sets `actorId` to the **round's own id** precisely so a test has a
   per-round discriminator on a globally-audienced event, and the channel is
   shared across every concurrently-running file (CLAUDE.md rule 4). Filter
   `round.finished` on the ended round's id and `round.started` on the
   successor's. Assert **one of each**, not "at least one": a second publish
   is the observable symptom of the same double-finalize assertion 3 catches,
   and it is the one that would reach every connected client. This also
   covers rule 5 — a publish from inside the transaction would still arrive,
   so the count is what proves single-settlement, not the presence.

**It must be SHOWN RED.** A concurrency test nobody has watched fail proves
nothing; `CLAUDE.md` says so and this repo has the scars. The required procedure,
recorded in the PR:

- delete the `SELECT pg_advisory_xact_lock(7461002)` line from `ensureCurrentRound`,
  changing **nothing else** — in particular do not reorder the four steps;
- run only this file: `npx vitest run apps/server/test/rounds-rollover.test.ts`;
- observe assertion 3 fail with a payout-row count that is a multiple of the award
  count (typically 2x or 3x, load-dependent);
- restore the line, re-run, observe green;
- paste both outputs.

**Why removing the lock genuinely fails, and the trap in "improving" it.** Under
read committed, two transactions both read `finalized_at IS NULL`, both run the
freeze and both run the **payout**, and only then does either reach the
`UPDATE rounds SET finalized_at = now() WHERE id = $1 AND finalized_at IS NULL`.
The second `UPDATE` blocks on the row lock, re-evaluates its `WHERE` against the
committed version, and updates zero rows — so the *stamp* is single, but the money
already moved twice. The `finalized_at` guard alone does not protect anything that
happens before it (§2.4).

An implementer may be tempted to "fix" this by stamping first and branching on
`rowCount`, then dropping the advisory lock. Do not. The activation snapshot the
finalize hands off to (§2.2a's `INSERT ... SELECT` into `round_entries` for the
successor round) is not covered by `finalized_at` at all — it is guarded by the
successor's own `snapshotted_at`, which is stamped *after* the insert for exactly
the same reason `finalized_at` is stamped after the payout. Two transactions
racing it collide on the
`(round_id, player_id)` primary key and one request answers 500 on a well-formed
`GET /api/rounds`. The advisory lock is what turns "one request 500s" into "one
request does the work, the others proceed" — the guard is for the *later* requests
that arrive after the transaction committed, and for the boot path.

The constant is `7461002`, and §2.4 records the check that it is free.

---

#### `apps/server/test/rounds-finalize.test.ts` — idempotency of the guard, called directly
**Project: `@gl3/server`.** The finalize entry point publishes `round.finished`
and `round.started` after commit, which needs a Redis client, so this file needs
both services even though it never makes an HTTP request.

**What it proves.** Calling the finalize path twice — sequentially, with no
concurrency at all — settles the round exactly once. This is the *other* half of
the safety argument: `rounds-rollover.test.ts` covers simultaneous callers,
this covers the boot-then-first-request sequence and any future extra call site.

**Shape.** Drive `ensureCurrentRound` directly (no `bootTestServer`), the way
`apps/server/test/hospital-status.test.ts` drives its status function. Seed an
ended round plus a scheduled successor. Then:

1. call it once. Snapshot the whole world: `rounds.finalized_at`, every
   `round_entries.final_exp/final_cash/final_bank`, every `players.round_id`, the
   full `transactions` rows with `reason = 'round.payout'`, and every
   `player_stats.points`;
2. move a player's `points` and `exp` with a direct `applyBalanceChange` / update so
   the *live* numbers differ from the frozen ones;
3. call it again. Assert `finalized_at` is byte-identical to the first value (not
   merely non-null — a re-stamp would be a silent bug), the `final_*` columns are
   unchanged despite step 2, and `transactions` gained **zero** new
   `round.payout` rows;
4. call it a third time. Same assertions. Three runs, not two, mirrors the
   idempotency proof `apps/migrate` uses over its 26 target tables — two runs can
   pass by accident when the second is a no-op for the wrong reason.

Also assert the negative case in the same file: with an active round whose `ends_at`
is in the future, `ensureCurrentRound` writes nothing at all — no `finalized_at`, no
entries for a successor, no ledger rows. The cheap early return is the entire reason
this can sit at the head of a read route.

---

#### `apps/server/test/rounds-ledger.test.ts` — the money still reconciles across a rollover
**Project: `@gl3/server`.**

**What it proves.** `sum(ledger) == balance` per player per kind survives a
rollover, including the `points` kind that the payout moves. Rule 3 says every
balance movement goes through `applyBalanceChange`; this is the file that proves the
payout obeyed it rather than issuing an `UPDATE player_stats SET points = points + …`
that would leave the ledger short.

**Shape.** Deliberately modelled on
`apps/server/test/economy-invariant.test.ts:356-370`, the existing per-player
per-kind sweep:

```ts
const kinds = { cash: stats.cash, bank: stats.bank, points: stats.points } as const;
for (const kind of ["cash", "bank", "points"] as const) {
  const ledgerRows = await db.select({ amount: transactions.amount })
    .from(transactions)
    .where(and(eq(transactions.playerId, playerId), eq(transactions.balanceKind, kind)));
  const ledgerSum = ledgerRows.reduce((sum, r) => sum + r.amount, 0n);
  const expected = kind === "cash" ? STARTING_CASH + ledgerSum : ledgerSum;
  expect(kinds[kind], `player ${playerId} kind ${kind}`).toBe(expected);
}
```

Run it after: seeding players with a known starting cash, moving money around
through at least two real routes so the ledger is non-trivial, then triggering a
rollover that pays the winners.

**The `rounds.payout_points` row must be inserted BEFORE `bootTestServer()`, not
in `beforeEach`.** Settings are read once, into a plain `Record<string, string>`,
at boot — `bootTestServer` does it at `test/helpers/server.ts:45`
(`const loadedTestSettings = await loadSettings(db)`), before `loadPlugins` and
before `buildApp`, and production does the same at `index.ts:54`. A row written
after that is invisible for the life of the server, so the payout silently falls
back to §3.6's default award table and the third assertion above compares against
the wrong array — a failure that reads as a payout bug and is a fixture bug. The
trap is documented at `apps/server/test/combat-repair.test.ts:17` for the same
reason. Two consequences for this file: the insert goes in `beforeAll` ahead of
the boot call, and `resetDb(db)` in `beforeEach` must not truncate it away — if
it does, the row is still gone from the *table* but the boot-loaded record is
untouched, so the test passes for a reason the next reader cannot see. Prefer
seeding the setting once and asserting the loaded value, e.g. by reading it back
through a route, over trusting the insert landed.

Additional assertions specific to the payout:

- every `round.payout` row has `balance_kind = 'points'`. `balanceKind` is the
  Postgres enum `('cash','bank','points')`
  (`apps/server/src/db/schema/enums.ts:4`), so `points` is a first-class ledger
  kind and needs no schema change;
- every `round.payout` row has `ref_id` equal to the finalized round's id.
  `transactions.ref_id` is a plain `uuid` column with no FK
  (`apps/server/src/db/schema/economy.ts`), so a round id fits without a new column
  and without adding an edge to the lock graph;
- the multiset of payout `amount`s equals the configured `rounds.payout_points`
  array, in placing order against the standings query's own ordering. Not "the sum
  matches" — a bug that paid `[1000,1000,1000]` sums differently but a bug that paid
  `[250,500,1000]` does not, and getting the placing backwards is the likeliest
  mistake here;
- no `round.payout` row has `job_id` set. `transactions.job_id` carries a UNIQUE
  index; finalize is not a BullMQ job and must not borrow the idempotency key of
  one. Its idempotency is `finalized_at` plus the advisory lock, and mixing the two
  mechanisms would make the second finalize fail with 23505 instead of no-opping.

---

#### `apps/server/test/rounds-lock-order.test.ts` — the fourth pair
**Project: `@gl3/server`.**

It joins the tree's existing lock-order regression files — `gang-`, `travel-`,
`combat-`, `bounties-`, `oc-`, `theft-`, `properties-` and `sentence-sweeper-`.
The pair it guards is **rounds↔player**, the fourth pair (§2.7); the existing three
pairs are gang↔player, location↔player and player↔player.

**The order under test:** advisory lock first, then players ascending. Concretely,
inside the finalize transaction: `pg_advisory_xact_lock(7461002)` before any table
is touched; then the payout's `applyBalanceChange` calls, which reach
`lockPlayersForUpdate` and therefore take `player_stats` `FOR UPDATE` in ascending
id order (`apps/server/src/economy/ledger.ts:35-43`). Paying winners in *placing*
order rather than ascending id order is the specific inversion this file exists to
catch: placing order is by delta, which is uncorrelated with id.

**The corollary that decides whether this file is worth anything.** `CLAUDE.md`,
rule 6: *a concurrency test whose participants all acquire locks via the same helper
proves only the case that was already safe*. The pre-existing gang deadlock test
agreed on ordering by construction and stayed green straight through the bug. So the
counterparty here must **not** be another call into the rounds code, and must not be
a hand-rolled `SELECT … FOR UPDATE` written to match. Use real routes that lock
`player_stats` through a different door:

- a real **bank transfer** (`POST /api/bank/...`, the `bank` plugin) moving money
  for one of the winners — one player, `FOR UPDATE` via `applyBalanceChange`;
- a real **combat attack** (`combat` plugin) between two winners — two players, via
  `lockPlayersForUpdate`, which is what makes A-shoots-B safe against B-shoots-A and
  is the closest existing thing to a multi-row `player_stats` holder.

**Barrier, not a race loop.** Copy the mechanism from
`apps/server/test/properties-lock-order.test.ts`: open a separate `postgres`
connection, take `FOR UPDATE` on the *first* lock in the canonical order, queue the
real counterparty request behind it, queue the finalize-triggering request behind
that, wait on observed lock state in `pg_stat_activity` (never a `sleep`), then
release from one instant with the interleaving already fixed. Firing two requests
and hoping they interleave is a coin flip per round and produces a test that is
green for the wrong reason.

The blocker transaction must itself take exactly one lock, and it must be the first
in the canonical order — a transaction holding one lock cannot be half of a cycle,
which is why the blocker is not itself an out-of-order actor.

It must be shown failing before it is trusted: remove the
`lockPlayersForUpdate(winnerIds)` pre-lock, or reorder steps 2 and 4, and watch it
go red.

Assertions: no response is 500; nothing in the run logs SQLSTATE `40P01`; the
finalize completed exactly once (re-use the payout-row-count assertion); the
counterparty's money movement is present in `transactions` exactly once.

**Two things this file must document in its header comment, because they look like
gaps and are not:**

1. The freeze (`UPDATE round_entries … FROM player_stats`) reads `player_stats`
   **without locking it** — a plain `FROM` takes no row locks. So a money move
   racing the freeze lands on one side of the statement snapshot or the other. That
   is a "which instant" question, not corruption; the test asserts conservation
   (`sum(ledger) == balance`), never which side a specific racing transfer fell on.
2. `round_entries`' foreign keys take `FOR KEY SHARE` on `players` and on `rounds`
   (rule 6: a foreign key is a lock, and no lock call appears in the code). Verified:
   **nothing in the repo takes `FOR UPDATE` on `players`.** That is the load-bearing
   claim, and it is the narrow one — it is *not* true that core's three helpers are
   the only `FOR UPDATE` sites in the repo. Core's are `player_stats`, `locations`
   and `gangs` (`apps/server/src/economy/ledger.ts:42,100,126,165`); plugins add
   their own on tables they own — `p_theft_cars`
   (`packages/plugins/theft/src/index.ts:561`), `p_oc_heists`
   (`packages/plugins/oc/src/index.ts:219`) and `p_properties_properties`
   (`packages/plugins/properties/src/index.ts:119,206,290,529`). None of those is
   `players`, and none of them is reachable from a finalize, so the FK edge to
   `players` contends with nothing today. The contended row is `player_stats`,
   reached by the payout, and that is why "then players ascending" is the whole of
   the second half of the rule.

---

#### `apps/server/test/rounds-snapshot.test.ts` — every player gets an entry, at their own values
**Project: `@gl3/server`** (registration goes through HTTP).

**What it proves.** The snapshot is whole-population and value-correct, and a
mid-round joiner competes on progress from the moment they joined rather than from
zero.

Cases:

1. **A player who never makes a request still gets an entry.** Register three
   players, move their stats with direct database writes, then seed an ended round
   plus an already-started successor (`starts_at` in the past, `ends_at` in the
   future, `snapshotted_at` null — the same seeding the rollover file needs, for the
   same reason) and let the rollover be triggered by a *fourth* player's request.
   Assert all three of the passive players
   have an entry for the successor round whose `exp_at_start`, `cash_at_start` and
   `bank_at_start` equal their `player_stats` at activation, and whose
   `players.round_id` was updated. This is the point of the
   `INSERT … SELECT FROM player_stats` being whole-population: laziness applies to
   *when* rollover happens, never to *who* it covers.
2. **A mid-round registrant gets an entry at their own values, not zeros.** Register
   a player during an active round after giving the fixture a non-zero starting
   position (seed cash/bank/exp immediately after registration, then register a
   second player mid-round and set their stats before asserting). Assert their entry
   exists with `joined_at` inside the round window and `*_at_start` equal to their
   stats at insert time, and that their standing immediately after joining is `0`,
   not their absolute total. That zero is the entire reason the table exists:
   without it a round-3 joiner can never place.
3. **No active round means no entry.** With zero rows in `rounds`, register a
   player. Assert `round_entries` is empty and `players.round_id` is null. This is
   §5.5 risk 3's registration half. It matters because the registration transaction
   has no round id in scope — `apps/server/src/auth/routes.ts:60-94` inserts
   `players` then `player_stats` and has neither a round id nor a location id
   available, so the snapshot insert must first query `rounds` inside the same
   transaction and do nothing when that query is empty (§2.5).
4. **Registration still becomes the first admin.** Same file, one case: with an
   active round present, the very first registration still gets the Administrator
   role with `*`. The new insert sits in the same transaction as the first-player
   advisory-lock probe (`routes.ts:81-91`), and placing it *before* the probe keeps
   the lock's hold time minimal — the property the comment at `routes.ts:77`
   explicitly protects. This case fails loudly if someone puts the round query
   inside the locked section.
5. **The first round ever activates with no predecessor.** Register three players
   with **zero** rows in `rounds` (so none of them gets an entry — case 3's
   condition). Then insert a single round with `starts_at` in the past, `ends_at` in
   the future, `finalized_at` null and `snapshotted_at` null, and make one request
   that calls `ensureCurrentRound`. Assert: all three players have an entry, the
   round's `snapshotted_at` is non-null, and every `players.round_id` points at it.
   This is the case a finalize-time snapshot cannot reach at all — there is no
   predecessor to finalize — and it is the whole reason the snapshot is keyed to
   activation (§2.2a). Call `ensureCurrentRound` a second time and assert the entry
   count is unchanged and `snapshotted_at` did not move: the stamp is the
   idempotency guard, and this is where it is proven.

---

#### `apps/server/test/rounds-standings.test.ts` — the standings math
**Project: `@gl3/server:db-only`.** It calls `testDb()` and never `createRedis()`
or `bootTestServer()`: the standings query is pure Postgres, and the Redis ZSETs are
untouched by this feature.

**Why this is not in `@gl3/server:unit`.** The delta arithmetic lives in SQL
(`ps.exp - re.exp_at_start`), not in a TypeScript function, so a `:unit` test would
be testing a mock of the thing under test. The one genuinely pure piece is rank
assignment (`rank = i + 1` over an already-ordered array, matching `topN`'s
behaviour in `apps/server/src/game/leaderboard/service.ts:32-47`); if the
implementation extracts that into a named function, its tie cases can move to
`@gl3/server:unit` — and that file needs its own `vitest.workspace.ts` entry too.

Cases, all against real rows:

1. **Live board reads current minus start.** Seed entries, move `player_stats`, assert
   the ordering and the delta values.
2. **Frozen board never moves again.** Finalize the round, then move `player_stats`
   again by a large amount, and assert the board is byte-identical to what it was at
   finalize — it must read `re.final_exp - re.exp_at_start`, not the live column. Run
   the same assertion for all three kinds.
3. **Negative deltas are real standings and are rendered.** A player who spent the
   round buying properties genuinely placed below where they started. Assert the
   cash board contains a negative delta, that it sorts below every positive one, and
   that the response parses under `LeaderboardResponseSchema` — `MoneySchema` already
   permits the leading minus (§3.5), so this case is asserting that nobody
   "helpfully" clamps at zero.
4. **exp is monotonic.** Assert no negative delta is reachable on the exp board given
   only exp credits, which is what makes the exp board the "who played hardest"
   board.
5. **Ties are deterministic.** Give two players identical deltas and run the same
   query ten times; assert the same order every time. `ORDER BY delta DESC` alone
   does not guarantee this — Postgres may return equal keys in any order, and it
   will change with plan or physical row order. So the query needs a secondary key
   (`ORDER BY delta DESC, re.player_id ASC`), and this case is what forces it. A
   board that flickers between two refreshes is a bug, and — critically — the
   payout's placing order is the *same* ordering, so a non-deterministic tie-break
   decides who gets 1000 and who gets 500 by coin flip. Flaky means broken.
6. **`limit` is respected and short populations do not pad.** A round with two
   entries and a limit of 10 returns two rows, ranked 1 and 2.
7. **A round with zero entries returns `[]`**, not an error. This is §5.5 risk 3's
   read half at the query level.

---

#### `apps/server/test/rounds-routes.test.ts` — the three player surfaces
**Project: `@gl3/server`.**

1. `GET /api/rounds` returns the active round (name, `starts_at`, `ends_at`,
   seconds remaining) plus finished rounds, and requires auth — 401 without a token.
2. `GET /api/rounds/:id/standings?kind=cash` returns a board; `kind=bank` and
   `kind=exp` likewise; an unknown `kind` returns **400** with the same
   `invalid_kind` shape the existing leaderboard route uses
   (`apps/server/src/game/leaderboard/routes.ts:9-21`), because `kind` comes from
   the existing `LeaderboardKindSchema` enum and no new kinds are introduced.
3. **A malformed `:id` returns 400, not 500.** Send `/api/rounds/not-a-uuid/standings`.
   Without a zod parse of the route param the string reaches Postgres and comes back
   as SQLSTATE `22P02`, which Fastify renders as a 500 on a request the client got
   wrong. This is the specific failure `CLAUDE.md`'s "zod-validates every external
   boundary, including route params" rule exists for, and it is worth its own
   assertion because it is invisible until someone types a URL by hand.
4. **`GET /api/leaderboard/:kind` with no query string behaves exactly as it does
   today.** This is the backwards-compatibility assertion for the one existing
   route being touched. Today the route parses only `request.params` and never reads
   `request.query` at all; the new optional `scope` must default to `"all"` and
   return the identical Redis-ZSET-backed payload. Assert against the same
   expectations `apps/server/test/leaderboard.test.ts` already encodes.
5. `?scope=round` returns the active round's standings, `?scope=all` returns the
   ZSET board, and an unknown `scope` value returns 400 rather than silently falling
   back — a typo that silently returns all-time numbers on a page labelled "this
   round" is the exact confusion the toggle exists to prevent.
6. **Zero rounds: every read surface still works.** With no rows in `rounds`,
   `GET /api/rounds` returns 200 with no active round and an empty history,
   `?scope=round` returns an empty entries array, and `?scope=all` is unchanged.
   Nothing 404s and nothing 500s. This is §5.5 risk 3's read half at the HTTP level.

---

#### `apps/server/test/admin-rounds.test.ts` — admin writes and the overlap rule
**Project: `@gl3/server`.**

1. **Authorization.** Core admin routes have no loader tier — the `auth: "admin"`
   tier applies to *plugin* routes only. Every core admin route uses
   `{ preHandler: [app.requireAuth] }` and then repeats the grant check inline
   (`apps/server/src/admin/routes.ts:54-87`). Assert: no token → 401; a token with
   no role → 403 `forbidden`; a token whose role holds `rounds` → 200; a token whose
   role holds `*` → 200. That last one matters because `hasPermission` treats `*` as
   passing everything (`packages/plugin-sdk/src/authz.ts:14-16`).
2. **Overlap is rejected at write time.** Creating a round whose `[starts_at,
   ends_at)` covers any instant already covered by a non-finalized round returns 400.
   Cover all five geometries against an existing round: identical, strictly inside,
   strictly containing, overlapping the front edge, overlapping the back edge — and
   two that must be **accepted**: strictly before and strictly after, sharing an
   endpoint. Editing a round into an overlap is rejected the same way, and editing a
   round without changing its dates is not rejected by its own existence.
3. **Overlap with a *finalized* round is allowed.** The check covers non-finalized
   rounds only; a settled round is history and cannot become active again.
4. **A finalized round's dates are immutable** — editing `starts_at` or `ends_at`
   on a round with a non-null `finalized_at` returns 400. Its `name` follows the
   same rule; the whole row is history.
5. **There is no "end it now" button, and no route provides one.** Assert the
   ending mechanism instead: set `ends_at` into the past through the edit route,
   then hit `GET /api/rounds`, and observe the rollover happened. The schedule *is*
   the mechanism — `ends_at` in the past is ending it now — and a reviewer seeing
   this case knows not to add the button.
6. **No UUIDs in the admin table.** The rounds admin section's `table` columns must
   not include a key equal to `id` or ending in `Id`. This is enforced by the
   existing `apps/server/test/admin-ids-hidden.test.ts`, which must be edited (§5.3)
   — this file does not duplicate that assertion, it just must not violate it.
   Note the regex is case-sensitive on the suffix: `roundId` fails, `roundName`
   passes.
7. **Two concurrent creates of the same window produce exactly one round.** Fire
   both requests with `Promise.all` over two `app.inject` calls, then assert
   **one 201 and one 400 `round_overlap`**, and that `SELECT count(*) FROM rounds`
   is 1. Assertions 2-6 all run sequentially and would stay green with the advisory
   lock (§4.2) deleted — this is the one that turns red, because without it both
   transactions read an empty overlap set before either commits and both insert.
   The outcome is deterministic despite the race: whichever transaction takes
   7461002 first wins, and the spec makes no claim about which that is. Fastify's
   `inject` runs the two as genuinely separate in-flight requests, so no extra
   machinery is needed.

---

#### `apps/web/test/rounds-page.test.ts` — client logic only
**Project: `@gl3/web`** (glob include — no workspace entry needed).

`@gl3/web` has no jsdom and renders no components: everything there is a pure
function of its arguments (`vitest.workspace.ts:172-183`). So this file tests the
extracted helpers, in the shape `apps/web/test/properties-page.test.ts` uses —
export the decision function from `Rounds.tsx` and test it directly:

- the countdown formatter against a round ending in the past (renders as ended, not
  as a negative duration), one ending in seconds, and one ending in days;
- the scope toggle's derived query key, so `["leaderboard", kind]` and the round
  board never collide in the React Query cache — two boards under one key is how the
  "two numbers mistaken for each other" bug actually happens;
- the hall-of-fame list ordering for finished rounds.

Negative deltas need no client change: `formatAmount` already handles a leading
minus (`apps/web/src/lib/money.ts:28-37`, `"-50"` → `"-50"`). Use `formatAmount` for
exp deltas and `formatMoney` for cash/bank deltas — an exp figure rendered with a
`$` is the mistake to guard against, and one assertion here is cheaper than noticing
it in the browser.

---

### 5.3 Existing test files that must be edited

These are not new files and need no workspace entry — but three of the four fail in
ways that are easy to miss.

1. **`apps/server/test/plugin-ctx-core-events.test.ts` — the `CORPUS` drift guard.**
   `CORPUS` (lines 74-100) currently holds one entry per core `GameEvent` variant;
   the guard at lines 109-115 derives the declared list from
   `GameEventSchema.optionsMap` and asserts both directions plus
   `expect(CORPUS).toHaveLength(declared.length)`. Adding `round.started` and
   `round.finished` means adding two entries, taking it from 23 to 25. **This is a
   runtime failure, not a typecheck failure** — the full reasoning, and the
   `player.backfired` precedent, is §4.4.
2. **`apps/web/src/lib/eventCopy.ts` and `apps/web/src/ws/invalidation.ts`** — the
   two exhaustive switches. Both have no `default` branch and a non-void return
   type, so a missing case is TS2366 at `npm run typecheck`: loud and immediate. Add
   the arms given in §4.4. `invalidationKeys` returning `[]` is an accepted answer
   where nothing needs refetching (see its `chat.message` arm), but for these two the
   round board and `keys.me()` do need it. Add matching cases to the existing
   `apps/web/test/event-copy.test.ts` and `apps/web/test/invalidation.test.ts`.
3. **`apps/server/test/admin-ids-hidden.test.ts`** — it builds its `sections` list
   from `CORE_PLUGINS[].adminPages` **plus one hand-written entry for `rolesPage`**
   (the array is lines 36-41). A second core admin page is not discovered
   automatically: add ``{ label: `core:${roundsPage.id}`, view: roundsPage.view }``
   next to the roles entry, and bump the walker guard
   `expect(sections.length).toBeGreaterThanOrEqual(7)` (line 46) to `11`.

   **11, not 8.** The guard is a floor that has not been raised as plugins gained
   admin pages: nine plugins declare `adminPages` today (`news`, `ranks`,
   `inventory`, `bullets`, `theft`, `properties`, `crimes`, `travel` — and one
   each, so nine sections counting `roles`) so the array already holds **10**
   entries against a floor of 7. Adding the rounds page makes 11, and the guard
   must say 11. Setting it to 8 would leave it slacker than the value it has
   today, which is the opposite of what raising it is for. If the count on the
   branch is not 11, use the actual count — the rule is "floor equals reality",
   not a number copied from this document.

   This file is in `@gl3/server:unit` — no database.
4. **`apps/server/test/leaderboard.test.ts`** — add the `?scope=all` case alongside
   the existing no-query case, so both the default and the explicit value are pinned
   against the ZSET behaviour. `recordScore`, `rebuildLeaderboards` and `topN` keep
   their exact current behaviour and this file is the proof of that.

### 5.4 What is deliberately *not* tested

- **No plugin reset hook, no plugin-table assertions.** A round is a scoring window;
  nothing is deleted or reset. No plugin-owned table is touched by this feature, so
  there is no per-plugin test matrix and no `packages/plugins/*/test/` change. If a
  task hands you a plugin test file to write for rounds, the design has been
  misread.
- **No test of the ZSET holding a delta.** Round boards are computed in Postgres and
  the Redis ZSETs stay all-time (§3.1). There is no `zincrby` anywhere in `apps/` or
  `packages/` today and this feature adds none.
- **No performance test on the standings query.** The bound is documented, not
  enforced — §3.4. That matches how the ZSET's 2^53 ceiling is already handled.

---

### 5.5 Risks

**Risk 1 — the unlucky request pays for rollover.** One player's request absorbs a
whole-population write: the freeze, the payouts, the stamp and the snapshot
`INSERT … SELECT`. At V2's real scale that is a few statements over a few thousand
rows — tens of milliseconds — but it is a real tail-latency spike landing on
whoever happens to be first through the door after `ends_at`. It is accepted because
core has no workers and no cron, and every time-based mechanic in GL3 already works
this way (§2.1). **If it ever bites, the mitigation is moving finalize to a job —
not redesigning the data.** The table shape, the snapshot semantics and the
standings queries are all unchanged by that move.

**Risk 2 — overlap validation is application-level.** Postgres cannot express "at
most one non-finalized round covers now" as a constraint. Admin write-time
validation (§4.2) is the only guard, and a direct `INSERT` into `rounds` by a DBA
bypasses it entirely. Because uniqueness cannot be trusted, the **read path picks
deterministically — the earliest `starts_at` among the rounds covering now** —
rather than assuming there is only one. That determinism is what keeps a violated
invariant from turning into a board that changes between two refreshes.

**Risk 3 — a game with no `rounds` row must work unchanged.** Every GL3 install
today has zero rounds; migrated installs have V2's. Rounds are strictly additive: no
active round means no snapshots, no boards, `scope=round` returns empty, and nothing
else in the game notices. `players.round_id` — dormant until this feature, §1.4 item
5 — must stay null on an install with no rounds.

---

### 5.6 Acceptance criteria

A reviewer can check each of these off against the tree. Every one is observable —
none of them is a judgement call.

- [ ] All eight new `apps/server/test/*.test.ts` files exist **and** appear as
      explicit entries in `vitest.workspace.ts`, in the projects named in §5.2.
      Verify by running each file alone: `npx vitest run apps/server/test/<name>.test.ts`
      must find and run it, not exit 1 with "No test files found".
- [ ] `apps/web/test/rounds-page.test.ts` exists (glob-included; no workspace entry).
- [ ] `npm run verify` exits **0**, run bare, with no other suite running
      concurrently on this box. Read the exit code, not the summary line.
- [ ] `npx tsc --build --force apps/server/tsconfig.json` succeeds — the exact
      command the image build runs, and the only local check for a missing
      `apps/server/tsconfig.json` project reference.
- [ ] The PR contains the **red** output of `rounds-rollover.test.ts` with
      `pg_advisory_xact_lock(7461002)` removed and the four finalize steps otherwise
      unchanged, showing a duplicated `round.payout` row count, followed by the green
      output with the line restored.
- [ ] `admin-rounds.test.ts` contains a two-concurrent-creates case asserting one
      201, one 400 `round_overlap`, and `count(*) = 1` — the only assertion in that
      file that fails with §4.2's advisory lock removed.
- [ ] `rounds-finalize.test.ts` calls the finalize path **three** times and asserts
      an unchanged `finalized_at` value, unchanged `final_*` columns, and zero
      additional `round.payout` ledger rows after the first call.
- [ ] `rounds-ledger.test.ts` asserts `sum(transactions.amount) == player_stats.<kind>`
      per player for `cash`, `bank` **and** `points` after a rollover, and asserts
      every payout row carries `balance_kind = 'points'`, `ref_id = <round id>` and a
      null `job_id`.
- [ ] `rounds-lock-order.test.ts`'s counterparties are **real routes that do not
      share the rounds code's locking helper** (a bank transfer and a combat attack),
      and it uses a `pg_stat_activity` barrier rather than a sleep or a race loop. A
      file where both sides call the same helper does not satisfy this criterion even
      if it is green.
- [ ] `rounds-snapshot.test.ts` proves a player who made no request still receives an
      entry, that a mid-round registrant's entry carries their own values
      (standing 0, not their absolute total), and that with zero `rounds` rows
      registration writes no entry and leaves `players.round_id` null.
- [ ] `rounds-standings.test.ts` covers negative deltas on cash/bank, a frozen board
      that does not move after `player_stats` changes, and ties returning the same
      order across ten identical queries.
- [ ] `plugin-ctx-core-events.test.ts`'s `CORPUS` has entries for `round.started` and
      `round.finished`, and its length assertion passes at 25.
- [ ] `apps/web/src/lib/eventCopy.ts` and `apps/web/src/ws/invalidation.ts` each have
      arms for both new variants, with matching cases in
      `apps/web/test/event-copy.test.ts` and `apps/web/test/invalidation.test.ts`.
- [ ] `admin-ids-hidden.test.ts` includes the rounds admin page in its `sections`
      list and its guard reads `toBeGreaterThanOrEqual(11)` — the true section
      count on the branch, not the stale 7 it carries today.
- [ ] `leaderboard.test.ts` pins both the no-query default and explicit `?scope=all`
      to the existing ZSET behaviour; `recordScore`, `rebuildLeaderboards` and `topN`
      are unmodified.
- [ ] `@gl3/shared` has an additive **patch** version bump (`0.1.3` → `0.1.4`) for the
      two new `GameEvent` variants and the new rounds DTO file, and is republished to
      `npm.gl3.dev`. `@gl3/plugin-sdk` needs **no** bump: `CoreEventInput` is derived
      from `GameEvent` rather than restated, so it picks the variants up through its
      `@gl3/shared` dependency. A minor bump (`0.2.0`) would break every
      `"^0.1.0"` peer range in the wild and is not what this is.
- [ ] No plugin-owned table is created, dropped, altered or written by this change,
      and no relinquish migration is added. It stays **seven of sixteen** plugins
      declaring migrations.
- [ ] The new core migration is `0011_round_entries.sql`, containing the **eight**
      statements of §1.5.3 — seven DDL plus the settle-the-past `UPDATE`, which is
      deliberate DML and the one thing that stops a V2-migrated install
      cascade-finalizing its whole round history on first boot — with a matching
      hand-written entry in
      `apps/server/drizzle/meta/_journal.json` — `{ "idx": 11, "version": "7",
      "when": 1787002800000, "tag": "0011_round_entries", "breakpoints": true }`.
      A `.sql` file absent from the journal **never runs and fails silently**: the
      runner reads `${tag}.sql` per journal entry and never lists the directory.
