# GL3 — Build Specification for the coding agent

**Project:** Modern successor to Gangster Legends V2 (PBBG engine) with a one-command migration path for existing V2 games.
**Stack (fixed, do not substitute):** Node.js 22 LTS · TypeScript (strict) · React 18 + Vite · PostgreSQL 16 · Redis 7 (BullMQ job queue + pub/sub message bus) · WebSockets.
**Audience of this document:** the coding agent, executing the build. Sections are ordered so that each milestone is independently verifiable.

---

## 0. Context and goals

Gangster Legends V2 (https://github.com/ChristopherDay/Gangster-Legends-V2) is a PHP 5.6-era mafia PBBG engine: procedural PHP, MySQL, no framework, server-rendered pages, a homegrown module/hook system, and a large installed base of small games. It works, but the stack is EOL and the architecture predates realtime, queues, and typed contracts.

GL3 is a ground-up reimplementation with three hard requirements:

1. **Feature parity with V2's core loop** — crimes, jail, ranks, cash/bank, gangs, inventory, mail, notifications, leaderboards — before any new features.
2. **A migration CLI** that converts a live V2 MySQL database into a working GL3 game: players keep accounts, passwords (via lazy rehash), cash, gangs, and inventories.
3. **A typed plugin API** that mirrors V2's hook system closely enough that the community's mental model (and eventually their modules) transfers.

Non-goals for v1: PHP module transpilation, theme conversion, multi-tenancy/SaaS, mobile apps, the casino/forum/premium modules (stubs acceptable — see §6).

---

## 1. V2 schema audit (source of truth for the migration)

Audited from `install/schema.sql`, `install/data.sql`, per-module `schema.sql` files, and PHP source at commit HEAD of the public repo. All findings verified against actual source, not documentation.

### 1.1 Global characteristics (these drive migration design)

- **No foreign keys anywhere.** All relationships are bare `int(11)` columns joined by convention (`GA_uid` → `users.U_id`, etc.). Expect orphaned rows in real databases; the migrator must tolerate and report them, not crash.
- **Prefixed column names** (`U_`, `US_`, `G_`…) — a per-table Hungarian prefix, mapped away in GL3.
- **All timestamps are unix-epoch `int(11)`**, not SQL dates. Convert to `timestamptz`.
- **All money is `int(11)` (signed 32-bit)** — max ~2.14B. Long-running V2 games hit this cap. GL3 uses `bigint` everywhere money or exp appears.
- **Mixed storage engines** (some tables InnoDB, most default/MyISAM) and `utf8` (not `utf8mb4`) charset — real dumps may contain mojibake; migrator must read as `utf8mb4` with fallback.
- **Passwords:** `users.U_password = sha256(U_id . plaintext)` (see `class/user.php::encrypt()`). Unsalted beyond the user id, no work factor. Migration: copy hash verbatim into `legacy_password_sha256`; on first successful login verify against legacy formula, then rehash with argon2id and null the legacy column. No forced resets.
- **`AUTO_INCREMENT` integer PKs** throughout → GL3 uses UUIDv7 PKs; the migrator maintains an `id_map(v2_table, v2_id, v3_uuid)` table for cross-references and idempotent re-runs.

### 1.2 Table catalog

**Identity & progression**

| V2 table | Purpose | Notable columns / quirks |
|---|---|---|
| `users` | Auth + account | `U_name` (30ch), `U_email`, `U_password` (legacy sha256), `U_userLevel` (1=user, admin levels), `U_status`, `U_round` (added by rounds module) |
| `userStats` | Gameplay state, 1:1 with users, PK = user id | `US_money`, `US_bank`, `US_bullets`, `US_exp`, `US_health`, `US_backfire`, `US_points` (premium currency), `US_weapon`/`US_armor` (item refs), `US_rank`, `US_gang` (0 = none), `US_location`, `US_pic`, `US_bio`, `US_shotBy`, and `US_crimes` — see quirk below |
| `userTimers` | Open-ended per-user key→unix-time cooldowns; rows auto-created on first use | Observed keys in source: `jail`, `hospital`, `crime`, `membership`, `sentMail`, `signup`, `killed`, `superMax`, `laston`, `forumMute`, `forumTopic`, `forumPost`, `glDirVote`, `count`. Custom modules add arbitrary keys — migrate ALL rows, known or not |
| `ranks` | Rank ladder | `R_exp` threshold, `R_cashReward`, `R_bulletReward`, `R_health` |
| `moneyRanks` | Display labels for wealth brackets | pure content |
| `userRoles` / `roleAccess` | Role → module-name ACL; `RA_module='*'` = admin wildcard | module referenced by string name |
| `rounds` | Seasonal resets; users carry `U_round` | `R_start`/`R_end` unix ints |

**⚠ Quirk — `US_crimes`:** per-player crime success chances stored as a dash-delimited varchar (default `'35-25-15-5-5-…'`), **indexed by `C_id - 1`** (verified in `crimes.inc.php`: `$crimePercs[($crimeID-1)]`) — NOT by row order. If crimes were ever deleted, id gaps leave dead positions in the string; that is expected. Chances increase with play (progression-by-use). Migrator must explode this string into `(player, crime, chance)` rows using `chance = parts[C_id - 1]` for each existing crime id; positions with no matching crime id are dropped with a report entry, and missing positions fall back to the crime's base chance.

**Game content (admin-editable in V2 = data, not code)**

| V2 table | Purpose | Notes |
|---|---|---|
| `crimes` | Crime definitions | `C_cooldown` (sec), `C_money`/`C_maxMoney` payout range, `C_bullets`/`C_maxBullets`, `C_exp`, `C_level` gate |
| `locations` | Cities | travel `L_cost`, `L_cooldown`, bullet shop stock `L_bullets` + `L_bulletCost` |
| `cars` | Car catalog | `CA_theftChance` (weight, not %) |
| `theft` | Car-theft tiers | `T_chance` %, `T_maxDamage`, `T_worstCar`/`T_bestCar` are **value bounds in cash**, not car ids |
| `weapons` | Weapon catalog | `W_accuracy` only; damage lives in kill module logic |
| `items` + `itemEffects` + `itemMeta` | Inventory item defs | EAV pattern: `itemEffects(IE_effect, IE_item, IE_value)` e.g. effect rows for heal/armor; `itemMeta` freeform. GL3: JSONB `effects`/`meta` on `items` |
| `premiumMembership` | Membership tiers | duration `PM_seconds`, cost in points |
| `settings` | Key-value game config | e.g. `pointsName`, `gangName`, `detectiveReport` — migrate verbatim to `settings(key, value)` |

**Social & economy state**

| V2 table | Purpose | Notes |
|---|---|---|
| `gangs` | Gang core | `G_boss`/`G_underboss` user refs, `G_bank`+`G_money` two balances, `G_level`, `G_location` |
| `gangPermissions` | Per-member permission strings | **No gang column** — only `GP_user` + `GP_access`; the gang is implied by the user's `US_gang`. Migrator derives `gang_id` from membership at migration time; permissions of gangless users are dropped with a report entry |
| `gangInvites`, `gangLogs` | Invites; append-only gang audit log | `GL_time` unix int |
| `userInventory` | (user, item, qty) composite PK | straightforward |
| `garage` | Player cars | `GA_damage` %, `GA_location` — cars are location-bound |
| `properties` | Ownable per-location businesses | **`PR_module` varchar names the module implementing the property** — string coupling to plugin ids; keep as `plugin_id` string in GL3 |
| `bounties` | Open contracts | `B_user` placer, `B_userToKill`, `B_cost` |
| `detectives` | Searches for hiding players | `D_start`/`D_end` window, `D_success` |
| `mail` | PMs, threaded via `M_parent` | `M_type`, `M_read` int-bools |
| `notifications` | Per-user feed | `N_read` int-bool |
| `gameNews` | Broadcast news posts | author user ref |
| `forums`, `forumAccess`, `topics`, `posts`, `topicReads` | Forum | `T_type` sticky, `T_status` locked; `forumAccess` role-gated |

### 1.3 Module/hook system (drives the GL3 plugin API)

Each V2 module = directory under `modules/installed/<name>/` containing `module.json` (manifest: name, version, author, `pageName`, `requireLogin`, `accessInJail`, admin menu entries), `<name>.inc.php` (page methods), `<name>.tpl.php` (Handlebars-style template), optional `<name>.hooks.php`, `<name>.admin.php`, `schema.sql`.

46 core modules ship with V2 (crimes, jail, gangs, bank, blackjack, blackmarket, bullets, bounties, cars/garage/theft/policeChase, detectives, hospital, inventory, kill, mail, membership, notifications, travel, forum, leaderboards, profile, search, stats, admin, users, userRoles, rounds, propertyManagement, glDirectory, usersOnline, …).

Hook names observed in source (register with `new Hook(name, fn)`): `userInformation`, `actionMenu`, `accountMenu`, `moneyMenu`, `pointsMenu`, `casinoMenu`, `gangMenu`, `killMenu`, `locationMenu`, `loginMenu`, `customMenus`, `menus`, `moduleLoad`, `alterModuleData`, `userAction`, `userKilled`, `gangPermission`, `profileLink`, `adminWidget`, `membershipBenefit`. Two patterns: **menu contribution** (return a link descriptor) and **data filter** (`alterModuleData` receives and returns module data — e.g. membership shortens crime cooldowns 25%). GL3's plugin API must cover both patterns (§5).

---

## 2. Target architecture

### 2.1 Repository layout (npm workspaces monorepo)

```
gl3/
  package.json              # workspaces: apps/*, packages/*
  docker-compose.yml        # postgres:16-alpine, redis:7-alpine
  apps/
    server/                 # Fastify API + WS gateway + BullMQ workers
    web/                    # React 18 + Vite client
    migrate/                # V2 → GL3 migration CLI
  packages/
    shared/                 # zod schemas, event contracts, DTOs (no runtime deps beyond zod)
    plugin-sdk/             # typed plugin API surface (hooks, content-pack types)
```

### 2.2 Server (`apps/server`)

- **Runtime:** Node 22 LTS, ESM, TypeScript strict, `tsx` for dev, `tsc` build.
- **HTTP:** Fastify 5. **WS:** `ws` attached to the Fastify server on `/ws` (auth v    avatar_url, bio, jailed_until timestamptz, hospital_until timestamptz
player_timers      (player_id, key) PK, expires_at timestamptz   -- open-ended, mirrors userTimers
player_crime_skill (player_id, crime_id) PK, chance numeric(5,2) -- exploded US_crimes
transactions       id, player_id FK, amount bigint (signed), balance_kind enum(cash|bank|points),
                   reason varchar, ref_id uuid nullable, created_at
crimes             id, name, description, cooldown_seconds, min_payout, max_payout,
                   min_bullets, max_bullets, exp_reward, min_rank int, sort int
locations          id, name, travel_cost, travel_cooldown_seconds, bullet_stock, bullet_cost
cars               id, name, value bigint, theft_weight int
theft_tiers        id, name, success_chance, max_damage, min_car_value, max_car_value
weapons            id, name, accuracy
items              id, name, item_type, effects jsonb, meta jsonb
player_items       (player_id, item_id) PK, qty
garage             id, player_id FK, car_id FK, damage int, location_id FK
gangs              id, name(unique), description, info, bank bigint, cash bigint,
                   bullets bigint, level int, location_id FK,
                   boss_player_id FK, underboss_player_id FK nullable
gang_members       (gang_id, player_id) PK, joined_at            -- replaces US_gang int
gang_permissions   (gang_id, player_id, permission) PK
gang_invites       id, gang_id FK, invited_player_id FK, invited_by_player_id FK, created_at
gang_logs          id, gang_id FK, player_id FK nullable, message, created_at
properties         id, location_id FK, plugin_id varchar, owner_player_id FK nullable,
                   cost bigint, profit bigint
bounties           id, placed_by FK, target FK, amount bigint, created_at, claimed_by FK nullable
detective_searches id, player_id FK, target_player_id FK, detectives int,
                   started_at, ends_at, succeeded bool nullable
mail_messages      id, thread_id uuid, sender_id FK nullable, recipient_id FK,
                   subject, body, read_at nullable, created_at
notifications      id, player_id FK, body, read_at nullable, created_at
game_news          id, author_id FK, title, body, created_at
ranks              id, name, exp_required bigint, cash_reward bigint, bullet_reward, max_health
money_ranks        id, label, threshold bigint
roles              id, name, color
role_module_access (role_id, module_key) PK                      -- '*' wildcard preserved
rounds             id, name, starts_at, ends_at
settings           key PK, value text
crime_log          id, player_id FK, crime_id FK, success bool, payout bigint, created_at
id_map             (v2_table, v2_id) PK, v3_id uuid              -- written by migrator only
```

Deliberate model changes vs V2 (document these in the README): `users`+`userStats` merged into `players`+`player_stats` (kept 1:1 split for hot-row separation); `US_gang` int replaced by `gang_members` join table; `US_crimes` varchar exploded into `player_crime_skill`; item EAV → JSONB; all timers that gate actions (jail/hospital) promoted to typed columns, everything else stays in generic `player_timers`.

---

## 3. Event contracts (`packages/shared`)

Single zod discriminated union `GameEventSchema` covering at minimum: `crime.resolved`, `player.jailed`, `player.released`, `player.travelled`, `player.attacked`, `player.killed`, `bounty.placed`, `bounty.claimed`, `gang.created`, `gang.memberJoined`, `gang.memberLeft`, `mail.received`, `notification.created`, `news.posted`, `chat.message`, `player.joined`. Every event carries `at` (ISO string) and the acting player's id + display name. The WS gateway validates before fan-out; the client validates before rendering. Never send unvalidated JSON over the bus.

Server-side rule: events are **facts, not commands** — published only *after* the Postgres transaction commits.

## 4. Migration CLI (`apps/migrate`)

### 4.1 Interface

```
gl3-migrate --mysql mysql://user:pass@host/db --pg postgres://... [--dry-run] [--report report.json]
```

Also accepts `--sql-dump dump.sql` (spin up the parse against a dump file via mysql2's parser is NOT required — instead document that dump mode requires loading into a scratch MySQL; keep scope tight).

### 4.2 Behaviour

1. Preflight: connect to both DBs, verify V2 schema fingerprint (presence + column check of `users`, `userStats`, `userTimers`; warn on unknown extra tables — list them in the report as "custom module tables, not migrated").
2. Migrate in dependency order: roles → rounds → content tables (ranks, crimes, locations, cars, theft, weapons, items) → players (+stats, timers, crime-skill explode) → gangs (+members, permissions, invites, logs) → inventory/garage/properties → social (mail, notifications, news, bounties, detectives) → settings.
3. Everything runs inside batched transactions; the whole run is **idempotent** — re-running upserts via `id_map` instead of duplicating.
4. Orphan policy: rows referencing missing users/gangs/items are skipped and counted in the report, never fatal.
5. `US_gang > 0` becomes a `gang_members` row; boss/underboss cross-checked (a boss not in his own gang gets a report entry and a membership row created).
6. Timers: `userTimers` rows with `UT_time` in the past are dropped; future ones map to `player_timers` (or the typed jail/hospital columns for those two keys).
7. Report (JSON + human summary): per-table counts (read/written/skipped), orphan lists, unknown tables, unknown timer keys, `US_crimes` positions dropped, duration.

### 4.3 Legacy password flow (server-side, but specified here)

- `players.legacy_password_sha256` holds the V2 hash; `password_hash` is null after migration.
- Login: if `password_hash` is null and legacy is set → compute `sha256(legacy_v2_id + password)`; on match, hash password with argon2id into `password_hash`, null the legacy column, log `auth.legacy_upgraded`. On mismatch → normal auth failure.
- **Note the legacy formula uses the V2 integer id**, so `legacy_v2_id` must be stored on `players`.

## 5. Plugin API (`packages/plugin-sdk`) — v1 scope

A GL3 plugin is an npm package (or local folder) exporting a typed manifest:

```ts
export default definePlugin({
  id: "crimes", version: "1.0.0",
  pages: [...],                 // route + React component (client) or data endpoints (server)
  hooks: {
    // menu contribution (V2: actionMenu, moneyMenu, …)
    "menu.actions": (ctx) => [{ label: "Crimes", href: "/crimes", sort: 100, timerKey: "crime" }],
    // data filter (V2: alterModuleData) — pure function, must return the data
    "crimes.beforeResolve": (ctx, crime) => ({ ...crime, cooldownSeconds: ctx.player.hasMembership ? crime.cooldownSeconds * 0.75 : crime.cooldownSeconds }),
    // event listener (V2: userKilled etc.)
    "player.killed": async (ctx, event) => { ... },
  },
  jobs: {...},                  // BullMQ processors the plugin owns
  migrations: [...],            // drizzle migrations namespaced to the plugin
})
```

v1 requirement: the SDK types + loader + the **core modules themselves implemented as plugins** (crimes, jail, bank, travel, gangs, inventory, mail, notifications, leaderboards, profile). Casino games, forum, membership, detectives, bounties, kill/hospital, properties, car theft are v1.1 — ship the schema (§2.5 already includes their tables) but stub the gameplay. Nothing in core may reach into a plugin's tables directly; plugins talk to core via the ctx API (economy, timers, events, settings).

## 6. Milestones — build in this order, each independently verifiable

- **M0 Scaffold.** Monorepo, dockeerboards. ✔ economy invariant test: sum(ledger) == balance for 1000 randomized ops.
- **M3 Social.** Gangs (create/invite/roles/bank/logs), mail, notifications, profile, game news. ✔ gang bank transfers ledgered; WS notifies invitees live.
- **M4 Migration CLI.** Full §4 behaviour against a seeded V2 database (build a fixture from `install/schema.sql` + `install/data.sql` + generated players). ✔ migrate → boot GL3 → legacy user logs in with old password → hash upgraded; re-run migrator → zero duplicates.
- **M5 Plugin SDK.** Loader + ctx API; crimes and bank refactored to be plugins; example third-party plugin in `examples/`. ✔ engine boots with the example plugin adding a menu entry and a working page.

Testing: vitest; integration tests run against real Postgres+Redis via docker-compose (no mocks for DB/queue paths). Every milestone lands with its tests.

## 7. Conventions & guardrails for the implementing agent

- TypeScript strict; no `any` in `packages/*`. Zod-validate every external boundary (HTTP body, WS frame, bus message, plugin manifest).
- No secrets in the repo; `.env.example` documents `DATABASE_URL`, `REDIS_URL`, `PORT`, `SESSION_TTL`.
- Rate-limit auth endpoints (Redis token bucket). CSRF not needed (bearer tokens), but set strict CORS.
- Random outcomes: use `node:crypto` randomInt, never `Math.random`, and resolve them **in workers only** so retries can't re-roll a favorable outcome (job payload carries a seed generated at enqueue time).
- Do not implement forum, casino, membership gameplay in v1 — schema only. Resist scope creep; M1's slice must be playable before M2 starts.

## 8. Open questions (safe defaults chosen; flag, don't block)

1. Distribution model (self-host engine vs hosted platform) — spec assumes **self-host engine**; nothing here precludes multi-tenancy later.
2. Rounds/seasons semantics on migration: default = migrate current-round data only, archive others in the report.
3. V2 games with custom premium modules will have unknown tables; the report surfaces them for manual/AI-assisted porting — out of scope here.
