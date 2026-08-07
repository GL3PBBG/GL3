# GL3

A modern successor to [Gangster Legends V2](https://github.com/ChristopherDay/Gangster-Legends-V2),
with a one-command migration path for existing V2 games.

**Stack:** Node.js 22 · TypeScript (strict) · Fastify 5 · PostgreSQL 16 · Redis 7 (BullMQ + pub/sub) · WebSockets · React 18 + Vite

## Quick start

```bash
npm install
npm run db:up
npm --workspace @gl3/server run db:migrate
npm --workspace @gl3/server run dev   # http://localhost:3000
npm --workspace @gl3/web run dev      # http://localhost:5173
```

`npm run db:up` starts Postgres 16 and Redis 7 via the included `docker-compose.yml`, but Docker
isn't required — this project is developed against natively-installed Postgres and Redis too. All
that actually matters is that `DATABASE_URL` and `REDIS_URL` (see `.env.example`) point at a
Postgres 16 and Redis 7 instance.

Copy `.env.example` to `.env` and adjust as needed. Run `npm run verify` (typecheck + tests)
before every commit; integration tests need Postgres and Redis up.

**Run migrations against your dev database, not just in tests.** `npm --workspace @gl3/server run
db:migrate` must be run manually against whatever `DATABASE_URL` your running server uses. Test
databases are created fresh per test file and migrate automatically, so it's easy to have a fully
green test suite while your dev database is stale — the server boots fine but every background
job (crime resolution, cooldowns, anything going through BullMQ) silently fails because the
tables it needs don't exist yet.

## Layout

- `apps/server` — Fastify API, WS gateway, BullMQ workers
- `apps/web` — React client
- `packages/shared` — zod event contracts and DTOs, shared by both

## WebSocket authentication

The session token never appears in a URL. A client that wants to open the WebSocket first calls
the authenticated `POST /api/ws/ticket`, which mints a short-lived (~30s), single-use handshake
ticket in Redis. The client then connects to `/ws?ticket=<ticket>`; the gateway consumes the
ticket atomically and invalidates it on first use, so it can't be replayed even if it leaks into a
proxy or access log. The gateway also validates the `Origin` header against the CORS allowlist to
prevent cross-site WebSocket hijacking.

## Deliberate model changes vs V2

GL3 is not a schema copy. These changes are intentional, and the migration CLI maps across them:

| V2 | GL3 | Why |
|---|---|---|
| `users` + `userStats` | `players` + `player_stats` | Same 1:1 split, kept for hot-row separation |
| `int(11)` money (signed 32-bit) | `bigint` everywhere | Long-running V2 games hit the ~2.14B ceiling |
| unix-epoch `int(11)` timestamps | `timestamptz` | Real dates, real time zones |
| `AUTO_INCREMENT` integer PKs | UUIDv7 PKs | The migrator keeps an `id_map` table for cross-references and idempotent re-runs |
| no foreign keys anywhere | real FKs with `ON DELETE` rules | Orphans become impossible rather than merely common |
| `userStats.US_gang` integer | `gang_members` join table | A player's gang is a relationship, not a column |
| `userStats.US_crimes` dash-delimited string | `player_crime_skill` rows | V2 indexed the string by `C_id - 1`, not row order — GL3 makes that explicit as `(player, crime, chance)` rows |
| `items` + `itemEffects` + `itemMeta` EAV | `items.effects` / `items.meta` JSONB | One row per item instead of three tables |
| `gangPermissions` with no gang column | `gang_permissions` with a real `gang_id` | V2 implied the gang from the member's `US_gang`; GL3 stores it directly |
| `properties.PR_module` varchar | `properties.plugin_id` varchar | Same string coupling, renamed to GL3's vocabulary |
| all timers in `userTimers` | typed `jailed_until` / `hospital_until` columns + generic `player_timers` | Action-gating timers are promoted to real columns; everything else stays open-ended, since custom V2 modules add arbitrary timer keys |
| `sha256(U_id . password)` passwords | argon2id, lazily upgraded | No forced resets — see below |

## Passwords for migrated players

V2 stored `sha256(U_id . plaintext)` — unsalted beyond the user id, with no work factor. Migration
copies that hash verbatim into `players.legacy_password_sha256` and the V2 integer id into
`players.legacy_v2_id`, leaving `players.password_hash` null. On the first successful login GL3
verifies the password against the legacy formula, rehashes it with argon2id into `password_hash`,
and nulls `legacy_password_sha256`. Players never notice, and nobody is forced to reset.

## Status

- **M0 Scaffold** — done
- **M1 Auth + vertical slice** — done: register/login with argon2id, sessions, and the full
  commit-crime slice end to end (HTTP → Redis cooldown → BullMQ → Postgres transaction → pub/sub →
  WebSocket → React live feed), verified manually in a browser.
- **M2 Core loop parity** — done: jail, exp-driven ranks, bank deposit/withdraw, travel, the
  bullets shop, and Redis leaderboards. The economy invariant (`sum(ledger) == balance` across
  1000 randomized ops) is enforced by `apps/server/test/economy-invariant.test.ts`.
- **M3 Social** — not built yet; a 10-task implementation plan exists under
  `offline-notes/plans/`.
- **M4 Migration CLI** — not built yet; a 33-task plan exists. Its tests need a MySQL-compatible
  server for the V2 fixture (see `docs/STATUS.md`).
- **M5 Plugin SDK** — not built yet, and not yet planned.

Suite: 22 files / 126 tests.

Casino, forum, membership, detectives, bounties, kill/hospital, properties, and car theft have
schema but no gameplay yet, by design.

## Contributing / picking this up

- `docs/STATUS.md` — where the project stands and how to start the next milestone.
- `docs/ENGINEERING-NOTES.md` — why the code looks the way it does; the constraints and
  traps that have already caused real bugs here.
- `NOTES.md` — the short version of both, plus this machine's environment quirks.
