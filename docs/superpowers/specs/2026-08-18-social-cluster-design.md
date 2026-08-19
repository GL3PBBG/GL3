# Social cluster — email verification, presence, player links, forum

Date: 2026-08-18. Status: approved (brainstorm review complete).

## 0. What this is

Four features under one spec, porting the last of V2's social surface plus
the one capability V2 faked with `mail()`: **email verification via Resend**
(with password reset riding along), an **online users** page, **clickable
player names** everywhere a name renders, and a **forum plugin**. V2 sources:
`modules/installed/users` (activation form + resend), `usersOnline` (`laston`
timer windows), `forum` (forums → topics → posts), `forgotPassword`;
`class/user.php` (status 2 gating, activation codes, `laston`).

Decisions made in review:

| Question | Decision |
|---|---|
| Split | One spec, one branch, all four features |
| Verification gate | **Hard for new players**: email required at registration, play locked until verified. Existing and migrated-verified players grandfathered |
| Verify UX | Link **and** typeable code — one token serves as both |
| Sender | `EMAIL_FROM` default `noreply@gl3.dev`; `EMAIL_DRIVER=log\|resend` |
| Password reset | Included (V2 `forgotPassword` port) |
| Online list | Game-wide, V2's two windows (5 min / 1 hour), location column. Players standing in a `combat_mode='underground'` town show **no location** (initially deferred while the combat-modes branch was in flight; that branch merged to main before implementation started, so it ships in v1) |
| Forum v1 | Public forums only. Gang forums (V2's negative-id hack) deferred to their own design. Mute deferred |
| Architecture | Verify/reset/presence in **core** (env config, auth hook, players table — plugin-unreachable). Forum is a **plugin** owning its tables |

## 1. Email verification + password reset (core)

### Mail driver

`MailDriver` interface in `apps/server/src/mail/` mirroring `StorageDriver`'s
two-real-backends shape:

- `log` — default; prints recipient, subject, link and code to stdout. What
  dev and the whole test suite use; the suite never talks to Resend.
- `resend` — plain `fetch` POST to `https://api.resend.com/emails` with
  `Authorization: Bearer <key>`. **No SDK dependency.** Non-2xx logs and
  reports failure; callers treat send failure as non-fatal (registration
  still succeeds — the player lands on the verify screen with a resend
  button).

Env (in `config.ts`'s `EnvSchema`, `superRefine` exactly like
`ASSET_DRIVER=s3` → `S3_*`): `EMAIL_DRIVER` (`log` default), `RESEND_API_KEY`
(required iff `resend`), `EMAIL_FROM` (default `noreply@gl3.dev`),
`APP_BASE_URL` for link construction — no base-URL config exists today
(verified: `config.ts` has none), so add it with default
`http://localhost:5173` (the dev web origin).

### Schema

New core migration (next free number): `players.email_verified_at
timestamptz` nullable, **backfilled `now()` for every existing row** —
grandfathering is explicit and total; nobody playing today is ever gated.
`schema.test.ts` counts restated if indexes/FKs change (this column adds
neither).

`RegisterRequestSchema`: `email` becomes **required**, keeps `.email()`, adds
the explicit NUL-byte guard (closes the STATUS.md watch item). Breaking DTO
shape → `@gl3/shared` bump (see §6).

`apps/migrate` (`players.ts` migrator): V2 `U_status = 1` → `email_verified_at
= ` migration time; `U_status = 2` → `NULL` (arrives gated, verifies against
their V2 email). Rows with no email and status 1 still get the timestamp —
grandfathered like natives; the gate only ever asks "is `email_verified_at`
null".

### Token

One token, link and code: 12-char uppercase base32 (~60 bits), stored
`emailverify:<token> → playerId`, `SET EX 86400`. Verification is **`GETDEL`**
— single-use by construction, no check-then-act (rule 2). A wrong token GETDELs
nothing and burns nothing. Multiple outstanding tokens per player are fine;
EX is the cleanup.

Routes (all in `auth/routes.ts`):

- `POST /api/auth/verify { code }` — normalises case, GETDEL, on hit sets
  `email_verified_at = now()` and returns 200; on miss 400 `invalid_code`.
  Rate-limited (tokenBucket, 10/15min per IP) — at ~60 bits brute force is
  irrelevant even before the limiter.
- `POST /api/auth/verify/resend` — authenticated, 3/hr, generates a fresh
  token and sends. This is V2's `method_resend`.
- Registration sends the first token after commit (event-ordering rule
  applies to mail too: send after the transaction, never inside).

Email body carries `<APP_BASE_URL>/verify?code=<token>` plus the code as
text; the web `/verify` page auto-submits from the query param and offers a
paste field.

### Gate

`requireAuth` (the decorator every authed route already passes through)
gains: if the resolved player's `email_verified_at` is null → 403
`email_unverified`, **except** for `/api/auth/verify`, `/api/auth/verify/resend`,
`/api/auth/logout`, `/api/auth/me`. Implementation must not add a per-request
DB query: the verified bit rides wherever the session→player resolution
already reads the player row, or as a Redis flag `verified:<playerId>` set at
login/verify and deleted never (verification is one-way). Exact mechanism is
the implementer's choice; the constraint is **zero additional per-request DB
round trips**.

Web: API client treats 403 `email_unverified` like it treats 401 — redirect,
but to `/verify`. `/verify` shows the paste field + resend button + logout.

### Password reset (V2 `forgotPassword` port)

- `POST /api/auth/forgot { email }` — **always 200** (no account
  enumeration), rate-limited by IP and by email key. If the email matches a
  player whose `email_verified_at` is non-null, send a reset link:
  `pwreset:<token> → playerId`, `SET EX 3600`, GETDEL on use. Unverified
  emails never receive reset mail (an unverified address is unproven).
- `POST /api/auth/reset { token, password }` — GETDEL, validate password by
  the registration rules, write argon2id hash, **revoke every session**.
- Session revocation needs a reverse index that doesn't exist: `session.ts`
  gains `playersessions:<playerId>` (Redis SET; SADD on create, SREM on
  logout/expiry-tolerant — members may point at expired sessions, deletion
  tolerates that). Reset SMEMBERS + DEL each `session:<token>` + DEL the set.
- Web: `/forgot` (email form) and `/reset?token=` (new password form) pages,
  link from login page.

## 2. Presence + online users (core)

### Write path

In `requireAuth` after successful resolution:

- `ZADD presence <now_ms> <playerId>` — every authed request, one O(log n)
  Redis op, no throttle.
- Revive the dead `players.last_seen_at` column: write it only when the
  guard `SET lastseenmark:<playerId> "1" NX EX 60` succeeds (rule-2 shape —
  the NX outcome *is* the decision). At most one UPDATE per player per
  minute; powers persistent "last seen" on profiles.

WS traffic does not touch presence in v1 — every page the SPA renders calls
authed HTTP APIs, which is signal enough at these window sizes.

### Read path

`GET /api/online` (authenticated):

1. `ZREMRANGEBYSCORE presence -inf <now - 1h>` — lazy trim, no cron.
2. `ZRANGEBYSCORE presence <now - 1h> +inf WITHSCORES`.
3. One `inArray` Postgres query hydrates username + location name.

Response `{ onlineNow, lastHour }` (5-minute and 1-hour windows, disjoint),
entries `{ playerId, username, locationName, lastActiveAt }`. New
`dto/online.ts` in `@gl3/shared`.

**Underground hiding**: the hydration query reads `locations.combat_mode`
(merged to main in `0013`); a player standing in an `underground` town gets
`locationName: null` — name and last-active still listed, town concealed.
Same plain-SELECT read combat's targets route uses; no lock taken.

Profile: `ProfileDto` gains optional `lastSeenAt` (additive), rendered on the
profile pages — V2's profile showed last-online.

### Web

`/online` page (two sections, names via `PlayerLink`), nav entry in
`Shell.tsx`.

## 3. Clickable player names (web + one DTO gap)

- `apps/web/src/components/PlayerLink.tsx`: `{ playerId, username }` →
  `<Link to={/players/${playerId}}>`. Styling consistent with the gang
  roster's existing link.
- Applied at: Combat targets, Bounties (both names), News author, Gang
  roster (replace inline link), Online page, Forum pages, hospital/jail
  local rosters if they render names.
- Bounties DTOs carry usernames but no ids — add `targetPlayerId` /
  `placerPlayerId` (additive shared change, bounties plugin hydrates).
- **Watch-item fix in passing**: `GET /api/players/:playerId/profile` — the
  app's only unauthenticated, un-rate-limited route — gets a tokenBucket
  limit. It stays public (profiles are public data); it stops being free to
  hammer.

## 4. Forum plugin

### Package + tables

`@gl3/plugin-forum` (`packages/plugins/forum/`), workspace-local → **all
eight registration sites** plus per-test-file `vitest.workspace.ts` includes.
Plugin migrations (bounties pattern):

- `p_forum_forums` — id uuid PK, name text, sort int.
- `p_forum_topics` — id, forum_id FK→forums cascade, author_id FK→players
  **set null**, subject, status (`open|locked`), type (`normal|sticky`),
  created_at, last_post_at, post_count int. Index `(forum_id, type,
  last_post_at)` for the listing.
- `p_forum_posts` — id, topic_id FK→topics cascade, author_id FK→players set
  null, body, created_at. Index `(topic_id, created_at)`.

Rule-6 audit: inserting a topic/post takes FOR KEY SHARE on the players row
(author FK) and the parent rows. **No forum route takes any explicit lock**
(no money moves — counters are plain UPDATEs), so no ordering exists to
invert; no new lock-graph edge, no lock-order test. Plugin migration count:
nine of nineteen (was eight of eighteen).

### Routes

Player-facing, auth `"user"` (registered players are already
verified-or-grandfathered by §1's gate — no extra check here):

- `GET /api/forum` — forums with topic counts.
- `GET /api/forum/:forumId/topics?page=` — 20/page, sticky first then
  `last_post_at` desc. **Paginated, never unbounded** (the mail/notifications
  watch item is the cautionary tale).
- `POST /api/forum/:forumId/topics` — subject ≥ 6 chars, body; cooldown
  `SET forumtopic:<playerId> NX EX 60` (rule 2; V2's 60s).
- `GET /api/forum/topics/:topicId?page=` — posts, 20/page, ascending.
- `POST /api/forum/topics/:topicId/posts` — body ≥ 6 chars; 409 on locked;
  cooldown `SET forumpost:<playerId> NX EX 15`; `tx.notify` to the topic
  author (not self). **No GameEvent** — per-post events flood the feed; no
  new variant anywhere in this cluster, the four-places trap never opens.
- Moderation (still under `/api/forum`, gated in-handler by
  `hasPermission("forum")` — an ABAC `forum` grant *is* moderator, V2's
  admin-or-mod collapsed onto the existing authz): lock/unlock topic, set
  type, delete post, delete topic.

Quote is client-side prefill; no server surface. Mute deferred.

### Admin + web

- `adminPages`: forums table + create/rename/sort forms; routes under
  `/api/admin/forum`, `auth: "admin"`. `test/admin-ids-hidden.test.ts`
  extended.
- Hand-written pages `Forum.tsx`, `ForumTopic.tsx` (threading UI outgrows
  the manifest view vocabulary; precedent: mail, properties). Nav entry.

## 4b. M4 forum migrator

V2 forum content is currently **dropped** by `apps/migrate` — the only forum
trace is three timer keys in `timers.ts`. Add a `forum.ts` migrator:

- V2 `forums` → `p_forum_forums`, `topics` → `p_forum_topics`, `posts` →
  `p_forum_posts`; ids through `id_map` (UUIDv7), authors resolved to
  migrated players (missing author → NULL, report entry).
- **Gang forums (negative `F_id`) skipped with a report entry** — gang forums
  are deferred; their topics/posts are not silently reparented.
- `T_status`/`T_type` mapped to the enums; `post_count`/`last_post_at`
  recomputed from migrated posts, not trusted from V2.
- Table shapes mirrored in `apps/migrate/src/pg/plugin-tables.ts` (theft
  precedent). Idempotency census grows from 26 to 29 tables; the three-run
  idempotency test must cover them. Forum cooldown/mute timers stay
  unmigrated (15s/60s cooldowns are noise; mute is deferred).
- Migrator count 18 → 19; pipeline phase placement after players.

## 5. Testing

TDD throughout; every guard shown red first.

- **Verify**: register (email now required) → any game route 403
  `email_unverified` → verify with logged code → 200. Token single-use
  (second GETDEL fails). Resend rate limit. Grandfather: pre-migration row
  plays untouched.
- **Reset**: forgot on unverified email sends nothing; on verified sends;
  token single-use; reset kills every session (`playersessions` set).
  Enumeration: forgot returns 200 both ways.
- **Presence**: authed request ZADDs; windows split at 5min/1h; trim works;
  `last_seen_at` written at most once per NX window.
- **Forum**: pagination bounds both tiers; cooldowns; locked-topic 409;
  moderation gated by ABAC grant (granted role passes, plain player 403);
  set-null on author delete.
- **Migrator**: forum rows land, gang forums reported-skipped, three-run
  idempotency over the 29-table census.
- Suite hygiene: new test files added to `vitest.workspace.ts` includes
  (ninth site); files driving the forum plugin without `bootTestServer` run
  `runPluginMigrations` themselves.

## 6. Cross-cutting

- **Shared/SDK bumps**: `@gl3/shared` is `0.1.13` in-repo today and other
  sessions are moving it — bump additively **on top of whatever is current
  at execution time**, republish shared-first. Surface: required `email` in
  `RegisterRequestSchema` (shape-breaking, shipped under the established
  0.x-additive-patch convention), `dto/online.ts`, forum DTOs, bounty ids,
  `lastSeenAt` on ProfileDto, verify/forgot/reset DTOs. `@gl3/plugin-sdk`
  likely needs **no** bump (no manifest/ctx change — forum uses only
  existing SDK surface).
- **No new GameEvent variant. No new explicit lock edge.**
- **Concurrent session discipline**: combat-modes is being built in this
  repo right now. All work in a separate worktree; before any full
  `npm run verify`: `pgrep -fa vitest` and check for foreign `gl3_tmpl_*`
  databases; a run overlapping another session is **void, not failing**.
- Merge gate: bare `npm run verify`, exit code read from the process.

## 7. Deferred / follow-ups

- Gang forums (own design; migrator already reports what it skipped).
- Forum mute.
- WS-based presence precision (v1 is HTTP-request-driven).
