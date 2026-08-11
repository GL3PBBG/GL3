# Design: port `mail` to `@gl3/plugin-mail`

Date: 2026-08-11
Status: design, not yet implemented
Predecessors: `2026-08-10-plugin-core-events-design.md`, `2026-08-10-plugin-crimes-port-design.md`

---

## 1. What this ports, and why it is next

`apps/server/src/game/mail/routes.ts` becomes `packages/plugins/mail/`.
The four routes — `POST /api/mail`, `GET /api/mail`,
`GET /api/mail/thread/:threadId`, `POST /api/mail/:mailId/read` — answer from
the plugin; the core directory is deleted.

`mail` is the eighth of twelve `game/*` modules to port and the second-to-last.
Two remain after it: `gangs`. `mail` is chosen before `gangs` because it is
plain: no money path, no BullMQ worker, no lock ordering, no ctx capability
beyond `publishCore`. `gangs` carries lock ordering (the
`lockGangAndPlayerForUpdate` invariant), `InsufficientGangFundsError` (the
gap `bank` deferred), and two gang balances — all of which are better faced
with `mail` done than with two open ports at once.

This is the **closest analog to the `news` port** of any module so far: an
event-driven write with no economy, no jail gate, no job. The comparison is
load-bearing — what `news` proved, `mail` reuses.

## 2. Package shape

`packages/plugins/mail/` → `@gl3/plugin-mail`, manifest id `mail`,
`version: "1.0.0"`, `basePaths: ["/api/mail"]`, four routes.

It declares **no `menu`, no `pages`, no `events`, and no `jobs`**, for the
same two reasons every core plugin already does
(`plugin-manifest-endpoint.test.ts:87`; `buildApp` throws if a core plugin
declares `jobs`). `mail` is no exception and changes neither constraint.

### 2.1 `src/schema.ts` — mirrors, not ownership

Read/write mirrors of two core-owned tables. Column names and types match
`apps/server/src/db/schema/social.ts:74` (`mail_messages`) and
`identity.ts` (`players`) exactly, which is what lets `tx.db.select` /
`.insert` / `.update` type and serialise correctly. Neither is listed in the
manifest's `tables` map and neither gets a migration here — core already owns
and migrates both. This is the established pattern
(`packages/plugins/news/src/schema.ts`, `bullets/src/schema.ts`,
`crimes/src/schema.ts`).

```ts
mailMessages = pgTable("mail_messages", {
  id:         uuid("id").primaryKey(),
  threadId:   uuid("thread_id").notNull(),
  senderId:   uuid("sender_id"),
  recipientId: uuid("recipient_id").notNull(),
  subject:    text("subject").notNull(),
  body:       text("body").notNull(),
  readAt:     timestamp("read_at", { withTimezone: true }),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

players = pgTable("players", {
  id:       uuid("id").primaryKey(),
  username: text("username").notNull(),
})
```

Only the columns this plugin touches are listed. `senderId` is nullable on
the column (system mail) and nullable in the mirror; the DTO resolves
`senderName` to `null` when it is. `readAt` is nullable; `GET` serialises it
to `null` or an ISO string. The two indexes (`mail_recipient_idx`,
`mail_thread_idx`) are core-owned and not mirrored — they affect performance,
not correctness or types.

`mail` is the second port (after `news`) to need a `players` mirror for
**recipient resolution**: the `recipientUsername` body field becomes an
`eq(players.username, ...)` lookup. `news` mirrored `players` for
`authorName`; `mail` mirrors it for both directions of the lookup.

### 2.2 `src/index.ts` — the four routes

Body and params schemas are restated rather than imported (`@gl3/shared` is
off-limits to a plugin package), matching every existing port. Three of the
four routes are read-mostly; one (`POST`) writes and publishes.

```ts
const IdSchema = z.string().uuid();

const SendMailBodySchema = z.object({
  recipientUsername: noNulByte(z.string().min(3).max(30)),
  subject:           noNulByte(z.string().min(1).max(200)),
  body:              noNulByte(z.string().min(1).max(5000)),
  threadId:          IdSchema.optional(),
});

const MailParamsSchema  = z.object({ mailId: IdSchema });
const ThreadParamsSchema = z.object({ threadId: IdSchema });
```

`noNulByte` is restated locally, not imported — no existing plugin restates
it, but the rule is the same: `@gl3/shared` is off-limits, so its
`noNulByte` (`primitives.ts:40`, a `z.ZodString` refinement) is copied
verbatim. **The NUL guard is load-bearing**, not cosmetic: three of
`mail.test.ts`'s cases (`:157`, `:165`, `:173`) assert a 400 on an embedded
NUL in `subject`/`body`/`recipientUsername` instead of a 500 — Postgres
`text` rejects an embedded NUL outright (SQLSTATE 22021), and
`recipientUsername` reaches Postgres as an `eq(players.username, ...)` lookup
parameter, which rejects a NUL too.

`accessInJail` is left at its `true` default on every mail route. Core's
mail routes were not jail-gated, and mail is not an action — a jailed player
may still read and send mail. This matches `bank`, `news`, `ranks`,
`notifications`.

## 3. The four handlers, ordered step for step after core

### 3.1 `POST /api/mail` — send

| # | Step | Notes |
|---|---|---|
| 1 | `playerId = ctx.player?.id`; null → `PluginError("unauthorized", 401)` | ctx is non-null on an `auth: "player"` route; the guard is the type narrowing the loader already relies on |
| 2 | resolve recipient: `select { id } from players where username = recipientUsername`; missing → `PluginError("recipient_not_found", 404)` | Unlocked read — there is no row to lock here |
| 3 | if `body.threadId` present: `select { senderId, recipientId } from mail_messages where threadId and (senderId = player OR recipientId = player)`; no row → `PluginError("forbidden", 403)`; then require the resolved recipient is also a participant, else `forbidden` | The two-check participant gate, with the regression-guarded recipient check (`routes.ts:50-51`) |
| 4 | else `threadId = newId()` | Fresh `threadId` for a new conversation |
| 5 | `id = newId()`; `insert mail_messages` | One row |
| 6 | `tx.events.publishCore({ type: "mail.received", actorId: playerId, actorName: player.username, audience: { kind: "player", playerId: recipient.id }, mailId: id, recipientId: recipient.id, subject })` | Buffered; flushed after commit |
| 7 | re-`select` the inserted row; return `201` with the DTO | `.returning()` could replace the re-select; see §3.5 |

`actorName` comes from `ctx.player.username` — **no `players` read for the
sender**. Core did one (`routes.ts:62`); the ctx has it. The recipient's
username is never needed on this path (the event carries `recipientId`, not
`recipientName`), so the only `players` read is the `:33` lookup.

The two thread-participant checks are preserved verbatim, including the
recipient-side check (`routes.ts:43-51`) whose absence was the regression
this route's tests guard. Dropping either would fail *"403s replying with a
threadId that isn't yours"* or *"403s replying in a real thread to a
recipient who isn't part of it"*.

### 3.2 `GET /api/mail` — inbox

`select * from mail_messages where recipientId = player order by createdAt
desc`, then resolve sender usernames in one batched `players` query (the
`nameById` map). Returns `{ mail: rows.map(toDto) }`. Read-mostly; runs
inside `ctx.transaction` because that is a plugin's only database handle
(the pattern every port inherits from `ranks`).

### 3.3 `GET /api/mail/thread/:threadId` — thread

`params: ThreadParamsSchema` (zod on route params — CLAUDE.md convention).
`select * from mail_messages where threadId = :threadId and (senderId =
player OR recipientId = player) order by createdAt asc`, then the same
sender-name resolution. The participant filter on the `where` clause is the
access control: a non-participant sees an empty list, not someone else's
thread. Sender-name resolution here is **not optional**: the test at
`:247` asserts `thread.json().mail[0].senderName === "Vito"`, which was the
defect the brief's sample introduced by hardcoding `null`.

### 3.4 `POST /api/mail/:mailId/read` — mark read

`params: MailParamsSchema`. `update mail_messages set readAt = now() where
id = :mailId and recipientId = player .returning({ id })`; no row →
`PluginError("mail_not_found", 404)`. Return `204`. The `recipientId =
player` clause is the access control: marking someone else's mail read
affects zero rows and returns 404, not 200.

### 3.5 One deliberate difference: `.returning()` replaces the re-select

Core's `POST` re-`select`s the inserted row after insert (`routes.ts:70`).
Drizzle's `.insert(...).values(...).returning()` yields the same row in one
round trip — `news` did not need it (its POST returns only `{ id }`), but
mail returns the full DTO, so `.returning()` is the natural fit. Same
values, one fewer round trip. This is the same class of difference `bank`
and `bullets` took with their post-commit re-reads.

### 3.6 No lock-order test, deliberately

Mail touches only `mail_messages` plus two `FOR KEY SHARE` locks on
`players.id` taken implicitly when the `sender_id` / `recipient_id` FKs are
checked on insert. No `FOR UPDATE` is taken on any row mail owns or
references, so there is no ABBA surface to regress. Recorded here (cf.
`docs/STATUS.md` §crimes "no lock-order test, deliberately") so a future
reader does not add a `mail-lock-order.test.ts` expecting parity with
bullets/travel/gangs; the constraint changes only if mail grows a
`FOR UPDATE` (a per-message edit lock, say).

## 4. The wire contract — every row unchanged

| Condition | Response | Source |
|---|---|---|
| Send success | `201 { id, threadId, senderId, senderName, recipientId, subject, body, readAt, createdAt }` | handler return |
| Unknown recipient | `404 { error: "recipient_not_found" }` | `PluginError` |
| Reply to a thread you're not in | `403 { error: "forbidden" }` | `PluginError` |
| Reply in a real thread to a recipient not in it | `403 { error: "forbidden" }` | `PluginError` |
| NUL in `subject` / `body` / `recipientUsername` | `400 { error: "invalid_request" }` | loader's zod gate (no `issues` — see §5) |
| Bad `mailId` / `threadId` param | `400 { error: "invalid_request" }` | loader's zod gate |
| Inbox success | `200 { mail: [...] }` | handler return |
| Thread success | `200 { mail: [...] }` | handler return |
| Mark-read success | `204` | handler return |
| Mark someone else's mail read | `404 { error: "mail_not_found" }` | `PluginError` |
| No token | `401` | loader auth |

The `mail.received` event is byte-identical to core's (`routes.ts:63-67`):
`actorId` the sender, `actorName` from `ctx.player.username`, `audience`
`{ kind: "player", playerId: recipient.id }`, plus `mailId`, `recipientId`,
`subject`. `id` and `at` are filled by the SDK at flush, as core filled
them by hand.

## 5. The one wire-shape difference every port takes

A 400 from a bad body carries `{ error: "invalid_request" }` with **no
`issues` array**, because the plugin route layer owns body validation
(`apps/server/src/plugins/routes.ts`) and does not forward zod's `issues`.
Core's mail route forwarded them (`routes.ts:31`). Nothing in `@gl3/web`
reads `issues` on this or any other route — the three NUL-byte 400 tests
assert only `statusCode === 400` — so the suite stays green through the
loss. This is identical to what `news` documented (`news/src/index.ts:10`)
and is a property of the plugin route layer, not of this port.

## 6. No loader change

Unlike `bullets`/`travel`/`crimes` (which found the missing `retry-after`
header on the jail gate) and unlike `crimes` (which found the BullMQ
queue-naming bug and the missing `attempts: 3`), `mail` exercises no loader
path that has not already been proven. No jail gate, no job, no money.
`mail` inherits the loader as-is. This is the consequence of being the
plain port, and it is worth saying plainly: the loader changes this project
has accumulated are all settled, and `mail` adds none.

## 7. Testing

`apps/server/test/mail.test.ts` (269 lines) is **entirely `app.inject`** —
the HTTP contract — plus one real WebSocket connection for the live
`mail.received` notification. **No service-level block, no direct function
imports.** Mail has no extracted `service.ts`; the route handlers are the
only surface. This makes the cutover a single step (register the plugin,
unregister core, delete core) rather than the bullets/bank/crimes shape of
"prove via `callPluginRoute` pre-cutover, then cut over."

The `app.inject` block is **unchanged** and is the proof: it was written
against core and passes against the plugin. Every test covers one row of
§4 — the happy path (send + WS notification), unknown recipient, the three
NUL-byte 400s, thread continuation, the two `forbidden` cases, inbox +
thread + mark-read, and mark-someone-else's-mail 404.

`apps/web/test/mail.test.ts` is pure unit tests on client-side pure
functions (`groupThreads`, `counterpartName`, `unreadCount`) — no HTTP, no
server. Unchanged and unaffected by the port.

There is **no `economy-invariant.test.ts` edit** — mail moves no money, so
the 1000-op `sum(ledger) == balance` sweep does not import it. This is the
first port since `ranks`/`notifications`/`news` with no invariant-sweep
entry, and it is the reason the port is the smallest in surface.

Every test must be demonstrated failing before being accepted — here, that
means the cutover commit (register plugin, unregister core) must be shown
to pass the unchanged suite, and the pre-cutover state (plugin registered,
core still serving) must be shown to fail with a Fastify duplicate-route
error. The suite itself does not change.

## 8. Registration sites

A new plugin package has eight registration sites, three of which fail
silently or only in CI (CLAUDE.md). All eight, with `news` as the template
(same `schema.ts` shape, same single-event publish):

1. `packages/plugins/mail/` — `package.json`, `tsconfig.json`, `src/schema.ts`, `src/index.ts`
2. `apps/server/package.json` — `"@gl3/plugin-mail": "*"`, then `npm install`
3. `apps/server/tsconfig.json` — a `references` entry. **Fails only in CI.**
   Catch locally with `npx tsc --build --force apps/server/tsconfig.json`
4. root `tsconfig.json` — a `references` entry
5. `vitest.workspace.ts` — a `srcAliases` entry. **Fails nothing**;
   silently grades a src-only edit against a stale `dist/`
6. `apps/server/src/plugins/core-plugins.ts` — import and add to `CORE_PLUGINS`
7. `apps/server/src/app.ts:11,62` — delete `registerMailRoutes`
8. `Dockerfile.server` — five COPY sites, one per plugin per line.
   **Fails only in CI.** `grep -c "packages/plugins/mail" Dockerfile.server`
   must equal 5 (matching the count every other port reports).

## 9. Out of scope

- `gangs` — its own spec, after this one. It carries the lock-order
  invariant, `InsufficientGangFundsError`, and the gang bank routes.
- Pagination/bounding of `GET /api/mail`. `docs/STATUS.md` records it as a
  deferred watch item (unbounded, returns full bodies up to 5000 chars).
  Pre-existing, inherited verbatim; not introduced by this port and not
  closed by it.
- The `forbidden` → `issues`-less 400 difference (§5) is a property of the
  plugin route layer, not a mail-specific change.
- Any change to `mail_messages` seeding, the `mail_recipient_idx` /
  `mail_thread_idx` indexes, or the absence of soft-delete. V2 had none and
  GL3 inherits that.
