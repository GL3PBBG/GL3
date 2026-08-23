# GL3

A modern successor to [Gangster Legends V2](https://github.com/ChristopherDay/Gangster-Legends-V2),
with a one-command migration path for existing V2 games. Documentation lives at
**[docs.gl3.dev](https://docs.gl3.dev)** — tutorials, how-to guides, full API/DTO
reference, and the design-decision record.

**Stack:** Node.js 22 · TypeScript (strict) · Fastify 5 · PostgreSQL 16 · Redis 7
(BullMQ + pub/sub) · WebSockets · React 18 + Vite · a first-party plugin SDK

## Quick start

```bash
npm install
npm run db:up                          # Postgres 16 + Redis 7 via docker-compose.yml
npm --workspace @gl3/server run db:migrate
npm --workspace @gl3/server run dev    # http://localhost:3000
npm --workspace @gl3/web run dev       # http://localhost:5173
```

The server reads plain environment variables — nothing in the repo auto-loads a
`.env` file — so export them first (`.env.example` documents every knob the
server understands):

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
```

`npm run db:up` isn't required — the project is developed against natively
installed Postgres and Redis too. All that matters is that `DATABASE_URL` and
`REDIS_URL` point at a Postgres 16 and Redis 7 instance.

Run `npm run verify` (typecheck + tests) before every commit; integration tests
need Postgres and Redis up (`npm run test:nodb` is the subset that doesn't).

**Run migrations against your dev database, not just in tests.** `npm
--workspace @gl3/server run db:migrate` must be run manually against whatever
`DATABASE_URL` your running server uses. Test databases are created fresh per
test file and migrate automatically, so it's easy to have a fully green test
suite while your dev database is stale — the server boots fine but every
background job (crime resolution, cooldowns, anything going through BullMQ)
silently fails because the tables it needs don't exist yet.

CI publishes the server and web images to GHCR on every push to `main`
(`ghcr.io/rondlite/gl3-server`, `ghcr.io/rondlite/gl3-web`).

## Layout

- `apps/server` — Fastify API, WS gateway, BullMQ workers, plugin loader
- `apps/web` — React client (categorized nav, plugin page renderer, live event feed)
- `apps/migrate` — `gl3-migrate`, the V2 → GL3 migration CLI
- `packages/shared` — zod event contracts and DTOs, shared by both apps
- `packages/plugin-sdk` — the SDK plugins are written against
- `packages/plugins/*` — twenty first-party plugins (see below)
- `examples/hello-plugin` — a minimal, annotated example plugin
- `manual/` — the VitePress source of docs.gl3.dev

## Plugins

Every ported V2 module is a plugin, loaded unconditionally from
`packages/plugins/`: `ranks`, `notifications`, `news`, `bank`, `bullets`,
`travel`, `crimes`, `mail`, `gangs`, plus first-party clusters with no V2
counterpart — `combat` + `inventory` (PvP, hospital, location shops),
`bounties`, `detectives`, `oc` (organized crime), `theft` (car theft + garage),
`properties` (franchises), `forum`, `casino` + `blackjack`, `membership`.

Third-party plugins load through `PLUGIN_IDS` (compiled into the server) and
`PLUGIN_PACKAGES` (imported at boot from outside the build) — `.env.example`
and the [plugin guide](https://docs.gl3.dev/guides/create-a-plugin.html) cover
both. Writing one starts with `examples/hello-plugin`.

## WebSocket authentication

The session token never appears in a URL. A client that wants to open the
WebSocket first calls the authenticated `POST /api/ws/ticket`, which mints a
short-lived (~30s), single-use handshake ticket in Redis. The client then
connects to `/ws?ticket=<ticket>`; the gateway consumes the ticket atomically
and invalidates it on first use, so it can't be replayed even if it leaks into
a proxy or access log. The gateway also validates the `Origin` header against
the CORS allowlist to prevent cross-site WebSocket hijacking.

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

- **M0 Scaffold, M1 Auth + vertical slice, M2 Core loop parity, M3 Social** —
  complete. The economy invariant (`sum(ledger) == balance`) is enforced by
  `apps/server/test/economy-invariant.test.ts`.
- **M4 Migration CLI** — complete: `apps/migrate`, 18 migrators over an
  8-phase pipeline, idempotent via `id_map`.
- **M5 Plugin SDK** — foundation, web page renderer and all nine V2 module
  ports complete; the gameplay clusters listed under **Plugins** above have
  shipped on top of it, along with admin (role → module grants) and a themed,
  categorized game shell.

`docs/STATUS.md` is the living, itemised record — read it before assuming
anything here is the whole story.

## Contributing / picking this up

- `docs/STATUS.md` — where the project stands and how to start the next milestone.
- `docs/ENGINEERING-NOTES.md` — why the code looks the way it does; the constraints and
  traps that have already caused real bugs here.
- `NOTES.md` — the short version of both, plus this machine's environment quirks.
- `manual/` — the docs site source; documentation changes ship in the same PR
  as the code they describe.
