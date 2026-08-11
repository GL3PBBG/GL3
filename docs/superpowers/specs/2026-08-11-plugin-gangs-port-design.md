# Design: port `gangs` to `@gl3/plugin-gangs`

Date: 2026-08-11
Status: design, not yet implemented
Predecessors: `2026-08-11-plugin-mail-port-design.md`, `2026-08-10-plugin-bank-port-design.md`, `2026-08-10-plugin-core-events-design.md`

---

## 1. What this ports, and why it is last

`apps/server/src/game/gangs/routes.ts` (838 lines, 14 routes) becomes
`packages/plugins/gangs/`. The 14 routes answer from the plugin; the core
`routes.ts` is deleted. `permissions.ts` and `logs.ts` **survive** in
`apps/server/src/game/gangs/` — `ctx.ts` keeps importing
`appendGangLog` (for `tx.gangLog`) and adds an import of `hasGangPermission`
(for a new `tx.gangs.hasPermission`).

`gangs` is the **ninth and final** `game/*` module port. The other three
(`profile`, `leaderboard`, `jail`) are deliberate non-ports. After this, M5's
module-port track is complete.

This is the **largest port yet** and the closest analog to `bank`: it carries a
money path (two gang-bank routes that move both a player leg and a gang leg), the
gang↔player lock-order invariant (`lockGangAndPlayerForUpdate`), and a deferred
SDK error gap (`InsufficientGangFundsError`) that this port owns. Where `bank`
was two routes, `gangs` is fourteen — membership (create/accept/leave/transfer/
kick), permissions (grant/revoke), invites, reads, and money — plus the
postgres error introspection no prior plugin has needed (23505 `gang_name_taken`,
23503 `player_not_found` backstop).

## 2. Three-commit shape (Approach 1)

Mirrors the bank/bullets/crimes loader-fix-then-port rhythm. Each commit is
independently reviewable and revertable.

1. **SDK + ctx.ts** — add `InsufficientGangFundsError` to the SDK, add a
   `tx.gangs.hasPermission` capability, and wrap `applyGangBalanceChange` in
   `ctx.ts` to translate core's `InsufficientGangFundsError` into the SDK one.
   **No caller.** Lands first, standalone, proven by a test that fails before
   the wrap. Core still serves gangs.
2. **The plugin package** — `@gl3/plugin-gangs`, 14 routes, wired into the
   build/test registration sites. Core still serves.
3. **Cutover** — `CORE_PLUGINS` += `gangsPlugin`, `app.ts` −=
   `registerGangRoutes`, `git rm routes.ts`. Shown failing first (duplicate-route
   boot error), then green across all 8 gang test files. `permissions.ts` +
   `logs.ts` + the `game/gangs/` directory survive.

Why three, not one: the ctx/SDK change is shared code every future plugin
inherits — isolating it means a regression there is diagnosable without the
plugin noise, and the cutover needs the plugin to exist first so its
red-then-green proof works.

## 3. Commit 1 — the SDK + ctx.ts change

Three additions, all with no caller until Commit 2.

### 3.1 `InsufficientGangFundsError` in the SDK

`packages/plugin-sdk/src/errors.ts`, mirroring `InsufficientFundsError` field
for field:

```ts
export class InsufficientGangFundsError extends Error {
  constructor(
    readonly gangId: string,
    readonly kind: PluginGangBalanceChange["kind"], // "cash" | "bank"
  ) {
    super(`insufficient gang ${kind} for gang ${gangId}`);
    this.name = "InsufficientGangFundsError";
  }
}
```

Exported from `packages/plugin-sdk/src/index.ts` beside
`InsufficientFundsError`. The existing doc-comment in `errors.ts` (the one
explaining why the loader deliberately does not central-map statuses) already
cites gangs as the reason — `bank.withdraw`'s `400 insufficient_gang_funds` is
the case that motivated "each plugin catches its own error." This class is the
missing half the comment anticipated; `InsufficientFundsError` covered the
player leg, this covers the gang leg.

### 3.2 `tx.gangs.hasPermission` capability

A new namespace in `PluginTx` (`packages/plugin-sdk/src/ctx.ts`):

```ts
readonly gangs: {
  hasPermission(gangId: string, playerId: string, permission: string): Promise<boolean>;
};
```

`permission` is `string`, not the `GangPermission` union: that type lives in
core's `permissions.ts` and is off-limits to the SDK. The plugin validates the
enum itself (zod `z.enum(GANG_PERMISSIONS)` on the route param), so by the time
the string reaches `hasPermission` it is one of the five known values.

`ctx.ts` implements it by delegating to core's `hasGangPermission`, which it
imports alongside the `appendGangLog` it already imports:

```ts
gangs: {
  hasPermission: (gangId, playerId, permission) =>
    hasGangPermission(tx, gangId, playerId, permission as GangPermission),
},
```

The `as GangPermission` cast is a single bridge at the SDK/core seam —
`hasGangPermission` takes the `GangPermission` type, the plugin passed a
validated string. This matches how `ctx.ts` already bridges core types
(e.g. the `LeaderboardKind` plumbing). It is the SDK boundary, not `packages/*`
application code, so the one cast is documented and localized.

**It passes `tx`, not `db`.** `hasGangPermission`'s signature is
`(db: Db | Tx, ...)`. The withdraw route's TOCTOU defense (CLAUDE.md rule 2 —
lock-then-recheck) calls it **inside the transaction** with `tx`. Because
`tx.gangs.hasPermission` is defined inside `ctx.transaction`'s `pluginTx`
closure (where `tx` is the live transaction connection), it always receives
`tx` — the locked, in-transaction connection. This is what makes the withdraw
recheck observe post-lock, post-commit state, the same property core's
`routes.ts:823` relies on. The unlocked pre-check (existence, permission before
the lock) happens earlier in the same `ctx.transaction`, before
`tx.locks.gangAndPlayer` is called; the recheck happens after. §4.2 covers this
collapse of core's two-transaction shape into one.

### 3.3 Wrap `applyGangBalanceChange` in `ctx.ts`

Currently (`apps/server/src/plugins/ctx.ts:124`):

```ts
applyGangBalanceChange: (change) => applyGangBalanceChange(tx, change),
```

becomes the exact mirror of the `applyBalanceChange` wrap at `ctx.ts:103-117`:

```ts
applyGangBalanceChange: async (change) => {
  try {
    return await applyGangBalanceChange(tx, change);
  } catch (error) {
    if (error instanceof InsufficientGangFundsError) {
      throw new SdkInsufficientGangFundsError(change.gangId, change.kind);
    }
    throw error;
  }
},
```

`InsufficientGangFundsError` imported from core `economy/ledger.ts`;
`SdkInsufficientGangFundsError` from `@gl3/plugin-sdk`. Without this wrap, a
gang overdraft escapes the loader's `PluginError` catch as an uncaught core
error and answers HTTP 500 instead of `400 insufficient_gang_funds` — the exact
bug the bank port fixed for the player leg and deferred for the gang leg.

**No leaderboard buffering here**, unlike the player-side wrap. Gang balances
have no leaderboard (only player `cash`/`bank`/`exp` do), so the
`bufferScore` line the player wrap has is absent. This is the only structural
difference from the `applyBalanceChange` wrap.

### 3.4 Test

Add a case to the existing ctx drift guard
(`apps/server/test/plugin-ctx-core-events.test.ts`) or a focused assertion:
calling `tx.economy.applyGangBalanceChange` with a gang overdraft throws the
**SDK** `InsufficientGangFundsError`, not core's. Demonstrated **failing**
before the wrap (raw core error escapes, `error instanceof
SdkInsufficientGangFundsError` is false) and green after. This is the
"demand proof a test can fail" step for the gap this port exists to close.
`vitest.workspace.ts` already lists that test file, so no `include` edit.

## 4. Commit 2 — the plugin package

`packages/plugins/gangs/` → `@gl3/plugin-gangs`, manifest id `gangs`,
`version: "1.0.0"`, `basePaths: ["/api/gangs"]`, 14 routes.

Declares **no `menu`, no `pages`, no `events`, no `jobs`** — the same constraint
every core plugin meets (`plugin-manifest-endpoint.test.ts:87`; `buildApp`
throws if a core plugin declares `jobs`).

### 4.1 `src/schema.ts` — six core-owned table mirrors

The biggest mirror set of any port. Column names, types, and nullability are
matched to `apps/server/src/db/schema/social.ts` and `identity.ts` by hand; a
wrong nullability is a runtime/serialisation bug, not always a compile error.
Only the columns the plugin touches are listed (the pattern every port
established); indexes, composite primary keys, and FK constraints stay
core-owned.

```ts
gangs = pgTable("gangs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  info: text("info").notNull(),
  bank: bigint("bank", { mode: "bigint" }).notNull(),
  cash: bigint("cash", { mode: "bigint" }).notNull(),
  level: integer("level").notNull(),
  bossPlayerId: uuid("boss_player_id"),
  underbossPlayerId: uuid("underboss_player_id"),
})
```

`bank`/`cash` mirrored as `bigint` because the DTO `.toString()`s them.
`locationId`, `bullets`, and the `unique` constraint are omitted — gang routes
never touch them, and mirroring them would risk drift for no type benefit.

```ts
gangMembers = pgTable("gang_members", {
  gangId: uuid("gang_id").notNull(),
  playerId: uuid("player_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
})
gangPermissions = pgTable("gang_permissions", {
  gangId: uuid("gang_id").notNull(),
  playerId: uuid("player_id").notNull(),
  permission: text("permission").notNull(),
})
gangInvites = pgTable("gang_invites", {
  id: uuid("id").primaryKey(),
  gangId: uuid("gang_id").notNull(),
  invitedPlayerId: uuid("invited_player_id").notNull(),
  invitedByPlayerId: uuid("invited_by_player_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
})
gangLogs = pgTable("gang_logs", {
  id: uuid("id").primaryKey(),
  gangId: uuid("gang_id").notNull(),
  playerId: uuid("player_id"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
})
players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
})
playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").notNull(),
  gangId: uuid("gang_id"),
  cash: bigint("cash", { mode: "bigint" }).notNull(),
})
```

`playerStats` mirrors `gangId` (create/accept/leave/kick read and write it;
invite reads the target's) and `cash` (the bank routes). The composite primary
keys on `gang_members` (`gang_id, player_id`) and `gang_permissions`
(`gang_id, player_id, permission`) are omitted — drizzle does not require them
for `select`/`insert`/`update`/`delete` to typecheck, and `bank`/`news`/
`bullets` set the precedent of mirroring only what is touched. Risk: a wrong
omission here would surface as a compile error, not a silent bug.

### 4.2 `src/index.ts` — restated schemas

`@gl3/shared` is off-limits to a plugin package, so every schema the routes use
is restated. The bounds and guards below are copied from
`packages/shared/src/dto/gangs.ts` **exactly**; the plan confirms each against
the source before writing, because a wrong bound silently changes which inputs
400.

```ts
const GANG_PERMISSIONS = ["invite", "kick", "bank.withdraw", "edit_info",
  "grant_permissions"] as const; // mirrors permissions.ts:6 + dto/gangs.ts:47

const GangParamsSchema      = z.object({ gangId: IdSchema });
const MemberParamsSchema    = z.object({ gangId: IdSchema, playerId: IdSchema });
const PermissionParamsSchema = z.object({
  gangId: IdSchema, playerId: IdSchema, permission: z.enum(GANG_PERMISSIONS),
});
const InviteParamsSchema    = z.object({ inviteId: IdSchema });

const CreateBody = z.object({
  // name's regex allowlist already excludes NUL, so no noNulByte (dto/gangs.ts:5-6).
  name: z.string().min(3).max(50).regex(/^[A-Za-z0-9 _'-]+$/,
    "letters, digits, spaces, _ - ' only"),
  description: noNulByte(z.string().max(500)).optional(),
  info:        noNulByte(z.string().max(2000)).optional(),
});
const InviteBody   = z.object({ username: noNulByte(z.string().min(3).max(30)) });
const TransferBody = z.object({ playerId: IdSchema });
const GrantBody    = z.object({ playerId: IdSchema, permission: z.enum(GANG_PERMISSIONS) });
const AmountBody   = z.object({ amount: z.string().regex(/^-?\d+$/, "must be an integer string") });
```

`noNulByte` is copied verbatim from `packages/plugins/mail/src/index.ts` (itself
copied from `news`). The NUL guard is load-bearing: `gangs.test.ts:102,110`
assert a 400 on an embedded NUL in `description`/`info`, and `username` reaches
Postgres as an `eq(players.username, ...)` parameter which rejects a NUL
(SQLSTATE 22021). `name` does **not** take `noNulByte` — its regex allowlist
already excludes NUL — matching `dto/gangs.ts:5-6`'s comment.

The `> 0` amount check: core's `GangBankTransferRequestSchema` carries
`.refine((v) => BigInt(v) > 0n)`. The plugin restates the amount as
`AmountBody` (the raw `MoneySchema` regex, same as bank) and does the
`amount <= 0n` check in the handler as `PluginError("amount_must_be_positive",
400)` — exactly the shape bank's port took (`packages/plugins/bank/src/index.ts:49-52`).
The reason is the same: the loader answers every schema failure with
`invalid_request`, which would silently drop the distinct
`amount_must_be_positive` error string if the refine stayed on the schema. The
core routes answer `400` for `<= 0` (no distinct string is asserted in
`gang-bank.test.ts` for this case — only the status — but bank's precedent keeps
the string, and it is harmless).

A 400 from a bad body carries `{ error: "invalid_request" }` with **no `issues`
array**, because the plugin route layer owns body validation and does not
forward zod's `issues`. Every test that asserts on a 400 asserts only the
status code. Identical to what `news`/`mail` documented.

### 4.3 The translation map (core primitive → ctx capability)

| Core (`game/gangs/routes.ts`) | Plugin (`tx`) |
|---|---|
| `db.transaction(async (tx) => …)` | `ctx.transaction(async (tx) => …)` |
| `lockGangAndPlayerForUpdate(tx, g, p)` | `tx.locks.gangAndPlayer(g, p)` |
| `lockPlayersForUpdate(tx, [p])` | `tx.locks.player([p])` |
| `applyBalanceChange(tx, {...})` | `tx.economy.applyBalanceChange({...})` |
| `applyGangBalanceChange(tx, {...})` | `tx.economy.applyGangBalanceChange({...})` |
| `appendGangLog(tx, g, p, msg)` | `tx.gangLog({ gangId: g, playerId: p, message: msg })` |
| `hasGangPermission(db\|tx, g, p, perm)` | `tx.gangs.hasPermission(g, p, perm)` |
| `insertNotification(tx,{…})` + post-commit `publishEvent(notification.created)` | `tx.notify(playerId, body)` — **collapses both** (§4.9) |
| post-commit `publishEvent(redis, {type:"gang.*",…})` | `tx.events.publishCore({type:"gang.*",…})` buffered, flushed post-commit |

### 4.4 One transaction per route — pre-checks live pre-lock inside it

Core splits several routes into an **unlocked pre-check** (existence → 404,
permission/membership → 403, outside the transaction) and a **locked mutation**
(inside the transaction, with a recheck). The TOCTOU defense is about **lock
state**, not transaction boundaries: the pre-check reads with no `FOR UPDATE`
held; the recheck reads after `lockGangAndPlayerForUpdate`.

The plugin has only one database handle — `ctx.transaction` — so the plugin
does **one `ctx.transaction` per route**, with the existence/permission/
membership reads at the top (still unlocked — they run before any
`tx.locks.*` call) and the recheck after `tx.locks.gangAndPlayer`. The
pre-check/recheck lock distinction survives unchanged; only core's separate
pre-tx transaction boundary collapses into the one `ctx.transaction`. This is
the gangs-specific instance of the ported-read pattern STATUS.md records
("ported GET routes open a transaction where the legacy route ran a bare
SELECT"). The `gang-bank.test.ts` TOCTOU test calls core's
`hasGangPermission`/`lockGangAndPlayerForUpdate` directly with `db`/`tx` — it
does not touch the plugin internals, so it is unchanged either way.

Routes with **no** unlocked pre-check (create, leave, transfer, decline) are
single-transaction already in core and stay so.

### 4.5 Read routes — GET gang, logs, members, invites

Four `GET`s, all `auth: "player"`, all `accessInJail` default `true`. Each wraps
its selects in one `ctx.transaction` (the ported-read pattern inherited from
`ranks`). `loadGangDto` becomes a plugin-local helper (select gang + count
members; `bank`/`cash` `.toString()`'d; `memberCount`). Members route builds the
permission map and the role/permissions enrichment verbatim, with the restated
`GANG_PERMISSIONS` feeding the leadership bypass (boss/underboss get
`[...GANG_PERMISSIONS]`). No events on any read. `GET /api/gangs/:gangId` is
the one read any authenticated player can hit (no membership gate) — preserved;
members/logs are members-only.

### 4.6 Membership mutations — create, accept, leave, transfer, kick

Each publishes a `gang.*` core event via `tx.events.publishCore`, buffered and
flushed post-commit (CLAUDE.md rule 5). The lock-then-recheck shape is
preserved through `tx.locks.gangAndPlayer` (or `tx.locks.player` for create):

- **create** — `tx.locks.player([playerId])` (the **only** path that locks
  player-only, not the gang pair; it INSERTs its own `gangs` row under a fresh
  uuidv7 in the same transaction, the documented exemption — no other
  transaction can want a lock on a row it cannot see). In-tx recheck for
  `already_in_a_gang`. Postgres 23505 on `gangs_name_unique` →
  `409 gang_name_taken` (duck-typed, §4.10). Event `gang.created`, actorName from
  `ctx.player.username` (no `players` read).
- **accept** — `tx.locks.gangAndPlayer`, in-tx recheck for
  `already_in_a_gang`, dormant-permission cleanup (delete `gang_permissions`
  rows for the joining player — the mirror of `removeMember`), invite delete,
  gangLog. Event `gang.memberJoined`, actorName from `ctx.player.username`.
- **leave** — `tx.locks.gangAndPlayer`, recheck boss
  (`boss_must_transfer_first`)/membership (`not_a_member`). `removeMember`
  inlined. Event `gang.memberLeft`, **actor = leaver** = `ctx.player.username`.
- **transfer** — `tx.locks.gangAndPlayer(gangId, **targetId**)` (locks the
  target, not the requester); recheck requester-is-boss (`forbidden`),
  already-boss (`already_boss`), target-membership (`not_a_member`). No gang
  event; `tx.notify(targetId, …)` for the new-boss notification (§4.9).
- **kick** — `tx.locks.gangAndPlayer(gangId, targetId)`; recheck
  boss-cannot-be-kicked (`cannot_kick_boss`)/membership (`not_a_member`).
  `removeMember` inlined. Event `gang.memberLeft`, **actor = kicked player**,
  not the kicker (per `events.ts`), so actorName is read from `players` by
  targetId — **not** `ctx.player.username`.

`removeMember` (delete members + perms, clear `playerStats.gangId`, gangLog) is
a plugin-local helper mirroring core's. It must stay a single sequence: the
three-layer permission-mask invariant (STATUS.md "what M3 established") depends
on `gang_permissions` rows being cleared whenever a `gang_members` row is
deleted. Any future plugin path that inserts a `gang_members` row must clear the
matching permission rows first — accept does this; the invariant comment
travels with the helper.

### 4.7 Permission routes — PUT / DELETE

Both pre-check `grant_permissions` via `tx.gangs.hasPermission` (pre-lock) →
`403 forbidden`. PUT locks the pair, rechecks membership (`not_a_member`),
inserts `onConflictDoNothing`. Postgres 23503 FK backstop →
`404 player_not_found` (duck-typed, §4.10) — the membership check intercepts a
nonexistent player first, this catch is the backstop for any future relaxation.
DELETE locks nothing extra, deletes the row + gangLog. Neither emits an event.

### 4.8 Money routes — deposit, withdraw

The bank-port analog, doubled (player leg + gang leg). Both lock the pair
through `tx.locks.gangAndPlayer` and recheck under the lock:

- **deposit** — existence → 404; membership pre-check → `403 not_a_member`;
  `tx.locks.gangAndPlayer`; membership recheck → `MembershipRevokedError` =
  `403 not_a_member`; `applyBalanceChange` (player −cash) then
  `applyGangBalanceChange` (gang +bank). Player overdraft → SDK
  `InsufficientFundsError` → `400 insufficient_cash`.
- **withdraw** — existence → 404; `tx.gangs.hasPermission("bank.withdraw")`
  pre-check → `403 forbidden`; `tx.locks.gangAndPlayer`;
  **`tx.gangs.hasPermission("bank.withdraw")` recheck** →
  `PermissionRevokedError` = `403 forbidden` (the TOCTOU defense — the recheck
  runs under the lock, post-commit-state); `applyGangBalanceChange` (gang
  −bank) then `applyBalanceChange` (player +cash). Gang overdraft → SDK
  **`InsufficientGangFundsError`** (the gap Commit 1 closes) →
  `400 insufficient_gang_funds`.

Both return `{ bank: next.toString() }` where `next` is
`applyGangBalanceChange`'s return (the new gang bank balance). The 100-op
invariant sweep in `gang-bank.test.ts:236` exercises both legs through the real
HTTP route and asserts `sum(ledger) == balance` for **both** player and gang.
This is why the `applyGangBalanceChange` wrap (Commit 1) must only translate the
thrown error class — the core function still writes the ledger row, and the
invariant must hold.

**No `economy-invariant.test.ts` edit.** That file drives bank/travel/bullets
via `callPluginRoute`; gangs' invariant test (`gang-bank.test.ts`) is pure
`app.inject`, unchanged, and is the proof.

### 4.9 `tx.notify` collapses row + event (invite, transfer)

Core's invite: `insertNotification(tx,…)` inside the transaction, then after
commit a manual `publishEvent(notification.created)` with a `players` username
read. `ctx.ts:171`'s `tx.notify(playerId, body)` does **both** — inserts the
notification row and buffers a `notification.created` event (actor = the
notified player, actorName from `players`). So the invite and transfer routes
each lose their post-tx event-publish block and their manual
`insertNotification`; one `tx.notify` call replaces both. The event is
byte-identical (same type, actor, audience, `notificationId`, body).
`awaitOwnEvent` rule-4 filtering is unchanged because the actor is still the
recipient. `tx.notify` generates the `notificationId` internally (`ctx.ts:172`),
so the route no longer mints one.

### 4.10 Postgres error introspection — duck-typed, no `postgres` import

No plugin imports `postgres` today; it is an `apps/server` transport concern.
Two type-guard helpers (CLAUDE.md: `packages/*` — no `any`, guards over casts):

```ts
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err
    && (err as { code: unknown }).code === "23505";
}
function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err
    && (err as { code: unknown }).code === "23503";
}
```

drizzle re-throws the underlying `postgres.PostgresError` with its `code` /
`constraint_name` as plain properties; the guards read `code` off the object
without importing the class.

- **create**: `catch (err) { if (err instanceof AlreadyInGangError) 409;
  if (isUniqueViolation(err)) 409 gang_name_taken; throw err }`. Core checks
  `constraint_name === "gangs_name_unique"`; the plugin checks only `code ===
  "23505"` — `gangs_name_unique` is the sole unique constraint on that insert
  path (name is the only unique column), so the constraint-name check is
  redundant and dropped. If a second unique constraint were ever added to
  `gangs`, this would need narrowing to check `constraint_name` again —
  recorded as a watch item in §8.
- **PUT /permissions**: `catch (err) { if (err instanceof NotAMemberError)
  404; if (isForeignKeyViolation(err)) 404 player_not_found; throw err }`.
  Backstop — the membership check intercepts a nonexistent `playerId` first.

Both catches are tested (`gangs.test.ts:46`, `gang-members.test.ts:131`), so the
duck-type is proven end to end.

## 5. The wire contract — every status code, error string, and event unchanged

The 8 gang test files (81 tests) are the contract, and they are entirely
`app.inject` — the HTTP surface. **Zero route-internal imports**: the two direct
imports are `permissions.ts` (`hasGangPermission`, `GANG_PERMISSIONS`), which
stays in core. So every response must be byte-identical. Highlights the tests
pin:

| Condition | Response | Test |
|---|---|---|
| create success | `201` + gang DTO (`bossPlayerId`, `memberCount:1`) | `gangs.test.ts:24` |
| create dup name | `409 gang_name_taken` | `gangs.test.ts:46` |
| create already-in-gang | `409 already_in_a_gang` | `gangs.test.ts:62` |
| create race (concurrent) | `[201, 409]` | `gangs.test.ts:82` |
| create NUL in description/info | `400` (no `issues`) | `gangs.test.ts:102,110` |
| GET gang not found | `404 gang_not_found` | `gangs.test.ts` |
| members non-member | `403 not_a_member` | `gang-members.test.ts` |
| permission enum sync | `GangPermissionSchema ≡ GANG_PERMISSIONS` | `gang-members.test.ts:52` |
| invite + WS notification | live `notification.created` to invitee | `gang-invites.test.ts` |
| accept, memberJoined event | live event | `gang-invites.test.ts` |
| leave boss | `409 boss_must_transfer_first` | `gang-transfer.test.ts:69` |
| transfer already-boss | `409 already_boss` | `gang-transfer.test.ts:171` |
| kick + deposit no deadlock | both `<500` | `gang-lock-order.test.ts` |
| deposit insufficient_cash | `400 insufficient_cash` | `gang-bank.test.ts` |
| withdraw insufficient_gang_funds | `400 insufficient_gang_funds` | `gang-bank.test.ts` |
| withdraw TOCTOU recheck | recheck sees revoke (false) | `gang-bank.test.ts:199` |
| bank ledger invariant | `sum(ledger)==balance` both sides, 100 ops | `gang-bank.test.ts:236` |

`gang.memberLeft` actor = **kicked/left player** (not the kicker) — the
membership tests assert this via `awaitOwnEvent(subscriber, kickedPlayerId)`.
`gang.created`/`memberJoined` actorName fallback is `"unknown"` (matches core)
when the `players` read misses. The `notification.created` actor is the
**recipient** (invitee/new-boss), rule 4.

## 6. The cutover proof (Commit 3)

Same red-then-green as mail. After registering `gangsPlugin` in `CORE_PLUGINS`
but **before** deleting `registerGangRoutes` from `app.ts`, run:

```bash
npx vitest run apps/server/test/gangs.test.ts
```

Expected: **fails at boot** with a Fastify duplicate-route error on
`/api/gangs` (`Method 'POST' already declared for uri: '/api/gangs'`). This is
the proof the plugin is actually live — a dead plugin means core keeps serving
and the test stays green (a false cutover). Then delete the `app.ts:7` import +
`app.ts:58` call, `git rm routes.ts`, re-run → green across all 8 gang files.

```bash
grep -rn "game/gangs/routes\|registerGangRoutes" apps/server/src
```
Expected: no output. But `game/gangs/permissions` and `game/gangs/logs`
**remain** — `ctx.ts` imports both. The `game/gangs/` directory survives with
those two files.

## 7. Lock ordering — unchanged, now ctx-enforced

Every `(gang, player)` pair goes through `tx.locks.gangAndPlayer`, which
delegates to `lockGangAndPlayerForUpdate` (UUID-compare order). The six routes
that take the pair (accept, leave, transfer, kick, deposit, withdraw) all use
it. create uses `tx.locks.player` alone (the INSERTs-own-row exemption).
`gang-lock-order.test.ts` stays green unchanged — it drives real HTTP
kick+deposit and asserts no 500. The M3 deadlock (CLAUDE.md rule 6) is now
structurally enforced the same way bullets/travel/crimes enforce theirs: the
capability is the only way to lock the pair.

**No new lock-order regression test** — `gang-lock-order.test.ts` already exists
and is unchanged. Unlike bullets/travel (which added new tests for defects the
port closed), gangs' test predates the port and the port changes nothing about
the lock order.

## 8. Registration sites — all eight

`news`/`mail` are the template. Commit 2 lands sites 1–5 + 8 (build/wire);
Commit 3 lands sites 6–7 (the cutover).

1. `packages/plugins/gangs/` — `package.json`, `tsconfig.json`, `src/schema.ts`,
   `src/index.ts`. `drizzle-orm` is a dependency (this plugin has a `schema.ts`),
   version copied from `packages/plugins/mail/package.json`.
2. `apps/server/package.json` — `"@gl3/plugin-gangs": "*"`, then `npm install`.
3. `apps/server/tsconfig.json` — a `references` entry. **Fails only in CI.**
   Catch locally: `npx tsc --build --force apps/server/tsconfig.json`.
4. root `tsconfig.json` — a `references` entry.
5. `vitest.workspace.ts` — a `srcAliases` entry. **Fails nothing**; silently
   grades a src-only edit against a stale `dist/`.
6. `apps/server/src/plugins/core-plugins.ts` — import + `CORE_PLUGINS` entry
   (**Commit 3**).
7. `apps/server/src/app.ts:7,58` — delete `registerGangRoutes` (**Commit 3**).
8. `Dockerfile.server` — five COPY lines + comment lines. **Fails only in CI.**
   `grep -c "packages/plugins/gangs" Dockerfile.server` must equal 5 (matching
   every other port).

## 9. Docs

`docs/STATUS.md`:
- Line 3 — stage to `M5 stage 10 (gangs port)`.
- M5 milestone row — nine of nine module ports shipped; one remaining → zero.
- Suite count line — update to the verified figure.
- Add a "The `gangs` port (Plan 10)" section after the mail section.
- Close the `InsufficientGangFundsError` watch item (bank-port carry-forward,
  §3 of the bank section) — gangs closes it. The `plugin_job_runs` PK and
  second-`ctx.transaction` watch items stay open (gangs declares no jobs).
- Add a watch item: the create-gang duck-type checks only `code === "23505"`,
  not `constraint_name` — narrow if a second unique constraint is ever added to
  `gangs`.

`CLAUDE.md` "Current state": change "eight of the twelve… have shipped… the one
remaining port (`gangs`)" to all nine module ports shipped; note M5 module-ports
complete.

## 10. Out of scope

- **`profile`, `leaderboard`, `jail`** — deliberate non-ports (STATUS.md).
  `leaderboard`/`jail` reach plugins via ctx; `profile` blocked by the
  `@gl3/shared` XSS guard. Unchanged.
- **No unique constraint on `gang_invites (gang_id, invited_player_id)`** —
  STATUS.md watch item, pre-existing, inert (accept clears all pending invites).
  Not introduced or closed here.
- **Kick×deposit-only deadlock coverage** — STATUS.md watch item. leave/accept/
  transfer/PUT-perms are sound by the same argument but untested. Pre-existing;
  not closed by this port.
- **`GANG_PERMISSIONS` becomes three copies** — shared schema (source), core
  `permissions.ts`, plugin `index.ts`. The enum-sync test guards shared↔core.
  shared↔plugin drift would surface as a `z.enum` mismatch on the PUT/DELETE
  param (a 400 where core accepted, or vice versa). Recorded as a watch item;
  the param zod is the guard, not a new test.
- **No pagination** on invites/members/logs — pre-existing, inherited verbatim.
  `logs` is capped at `limit(50)`; invites at `limit(50)`; members unbounded.
- **The `400` carries no `issues` array** — a property of the plugin route
  layer, not a gangs-specific change (§4.2).
