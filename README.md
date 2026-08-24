# GL3

A modern platform for persistent browser games, and the gangster game built
on it. One codebase, two faces: `GL3_PROFILE=full` (the default) is the
successor to [Gangster Legends V2](https://github.com/ChristopherDay/Gangster-Legends-V2);
`GL3_PROFILE=framework` is the game-agnostic engine, the same module shape
as [openPBBG](https://github.com/ChristopherDay/openPBBG) (the GL2 framework
without the gangster game). Existing databases of either kind migrate in one
command, players and passwords included. Documentation lives at
**[docs.gl3.dev](https://docs.gl3.dev)**: tutorials, how-to guides, full API/DTO
reference, and the design-decision record. A live demo runs at
**[game.gl3.dev](https://game.gl3.dev)**.

The whole GL2/MCCodes lineage is aging the same way, openPBBG included:
`int(11)` money columns overflowing past ~2.14B on long-running games, and
`sha256` password hashes with no work factor. GL3 is the move-off path for
that installed base: bigint money, argon2id, real foreign keys
(see [Migrating from V2 or openPBBG](#migrating-from-v2-or-openpbbg) and the
[V2 comparison](https://docs.gl3.dev/gl3-vs-v2.html)).

**Stack:** Node.js 22 · TypeScript (strict) · Fastify 5 · PostgreSQL 16 · Redis 7
(BullMQ + pub/sub) · WebSockets · React 18 + Vite · a first-party plugin SDK

## First boot (Docker)

```bash
docker compose --profile app up
```

That single command stands up the whole game from the published images:
Postgres and Redis (internal to the compose network), a one-shot migrate
container that asserts the schema, the server (starter content seeded at
boot), the web bundle, and an nginx router keeping the browser same-origin
(`deploy/nginx.conf`). Open http://localhost:8080 and register; the first
player becomes Administrator. With `EMAIL_DRIVER` at its default, the email
verification link prints to `docker compose --profile app logs server`.
Hosting elsewhere: set `GL3_PUBLIC_ORIGIN` (the URL players reach the game
at, which feeds the CORS allowlist the WebSocket gateway also checks) and
`GL3_PORT`; nothing needs editing. Want the engine without the gangster
game? `GL3_PROFILE=framework` boots the openPBBG-shaped platform instead
(see [The framework profile](https://docs.gl3.dev/operators/framework-profile.html)).

The same file without the profile is the development database pair:
`docker compose up -d` (what `npm run db:up` runs) starts only Postgres and
Redis. CI publishes the images to GHCR on every push to `main`
(`ghcr.io/gl3pbbg/gl3-server`, `ghcr.io/gl3pbbg/gl3-web`).

## Quick start (from source)

```bash
npm install
npm run db:up                          # Postgres 16 + Redis 7 via docker-compose.yml
npm --workspace @gl3/server run db:migrate
npm --workspace @gl3/server run dev    # http://localhost:3000
npm --workspace @gl3/web run dev       # http://localhost:5173
```

The server reads plain environment variables (nothing in the repo auto-loads
a `.env` file), so export them first. `.env.example` documents every knob the
server understands:

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
```

`npm run db:up` isn't required; the project is developed against natively
installed Postgres and Redis too. All that matters is that `DATABASE_URL` and
`REDIS_URL` point at a Postgres 16 and Redis 7 instance.

Run `npm run verify` (typecheck + tests) before every commit; integration tests
need Postgres and Redis up (`npm run test:nodb` is the subset that doesn't).

**Run migrations against your dev database, not just in tests.** `npm
--workspace @gl3/server run db:migrate` must be run manually against whatever
`DATABASE_URL` your running server uses. Test databases are created fresh per
test file and migrate automatically, so it's easy to have a fully green test
suite while your dev database is stale: the server boots fine but every
background job (crime resolution, cooldowns, anything going through BullMQ)
silently fails because the tables it needs don't exist yet.

## Layout

- `apps/server`: Fastify API, WS gateway, BullMQ workers, plugin loader
- `apps/web`: React client (categorized nav, plugin page renderer, live event feed)
- `apps/migrate`: `gl3-migrate`, the V2 → GL3 migration CLI
- `packages/shared`: zod event contracts and DTOs, shared by both apps
- `packages/plugin-sdk`: the SDK plugins are written against
- `packages/plugins/*`: twenty first-party plugins, split framework/gameplay by `GL3_PROFILE` (see below)
- `examples/hello-plugin`: a minimal, annotated example plugin
- `deploy/`: the nginx router config the compose `app` profile mounts
- `manual/`: the VitePress source of docs.gl3.dev

## Plugins

Every ported V2 module is a plugin in `packages/plugins/`, split into two
sets by `GL3_PROFILE`:

- **framework** (every profile): the game-agnostic engine, openPBBG's
  module list: `ranks`, `notifications`, `news`, `bank`, `mail`, `forum`,
  `inventory`, `membership`.
- **gameplay** (`full`, the default): the gangster game on top:
  `crimes`, `bullets`, `travel`, `gangs`, `combat`, `bounties`, `detectives`,
  `oc`, `theft`, `properties`, `casino`, `blackjack`. A `framework` boot also
  skips jail/hospital, the sentence sweeper, the wealth tax and the gameplay
  seeds, and gameplay plugins can be added back individually with
  `PLUGIN_IDS` (`GL3_PROFILE=framework PLUGIN_IDS=crimes`). Cross-plugin
  requirements (`combat` needs `detectives`, ...) are declared on the
  manifests and enforced at boot.

Third-party plugins load through `PLUGIN_IDS` (compiled into the server) and
`PLUGIN_PACKAGES` (imported at boot from outside the build); `.env.example`
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

## Migrating from V2 or openPBBG

`gl3-migrate` converts a live Gangster Legends V2 MySQL database into a GL3
PostgreSQL one (players, passwords, cash, gangs, inventories) in one command:

```bash
gl3-migrate --mysql mysql://user:pass@host/v2db --pg postgres://user:pass@host/gl3db
```

`--dry-run` runs every migrator inside a transaction that always rolls back
(use this first against a production V2 database); `--report report.json`
writes the full per-table machine-readable report; `--town-combat-mode
open|underground` picks V2's everybody-hidden combat rules up front. The
target needs a booted GL3 schema first (core migrations + one server boot for
plugin tables); see `apps/migrate/README.md` and the
[operator guide](https://docs.gl3.dev/operators/) for the walkthrough.

openPBBG databases are the same story with less data: the account tables are
byte-identical to V2's, and the game tables (`crimes`, `gangs`, `cars`, ...)
simply do not exist. The same CLI handles them, skipping every games phase
with a report entry, and pairs naturally with a `GL3_PROFILE=framework`
target, whose absent `p_*` plugin tables are skipped the same way. See
[The framework profile](https://docs.gl3.dev/operators/framework-profile.html)
for the walkthrough.

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
| `userStats.US_crimes` dash-delimited string | `player_crime_skill` rows | V2 indexed the string by `C_id - 1`, not row order; GL3 makes that explicit as `(player, crime, chance)` rows |
| `items` + `itemEffects` + `itemMeta` EAV | `items.effects` / `items.meta` JSONB | One row per item instead of three tables |
| `gangPermissions` with no gang column | `gang_permissions` with a real `gang_id` | V2 implied the gang from the member's `US_gang`; GL3 stores it directly |
| `properties.PR_module` varchar | `properties.plugin_id` varchar | Same string coupling, renamed to GL3's vocabulary |
| all timers in `userTimers` | typed `jailed_until` / `hospital_until` columns + generic `player_timers` | Action-gating timers are promoted to real columns; everything else stays open-ended, since custom V2 modules add arbitrary timer keys |
| `sha256(U_id . password)` passwords | argon2id, lazily upgraded | No forced resets (see below) |

## Passwords for migrated players

V2 stored `sha256(U_id . plaintext)`, unsalted beyond the user id, with no work factor. Migration
copies that hash verbatim into `players.legacy_password_sha256` and the V2 integer id into
`players.legacy_v2_id`, leaving `players.password_hash` null. On the first successful login GL3
verifies the password against the legacy formula, rehashes it with argon2id into `password_hash`,
and nulls `legacy_password_sha256`. Players never notice, and nobody is forced to reset.

## Status

- **M0 Scaffold, M1 Auth + vertical slice, M2 Core loop parity, M3 Social**:
  complete. The economy invariant (`sum(ledger) == balance`) is enforced by
  `apps/server/test/economy-invariant.test.ts`.
- **M4 Migration CLI**: complete. `apps/migrate` runs 18 migrators over an
  8-phase pipeline, idempotent via `id_map`.
- **M5 Plugin SDK**: foundation, web page renderer and all nine V2 module
  ports complete; the gameplay clusters listed under **Plugins** above have
  shipped on top of it, along with admin (role → module grants) and a themed,
  categorized game shell.
- **Framework profile**: `GL3_PROFILE=framework` runs the engine without the
  gangster game (openPBBG parity, plugin-shaped gameplay, boot-enforced
  cross-plugin `requires`), and `gl3-migrate` accepts openPBBG sources and
  framework targets.

`docs/STATUS.md` is the living, itemised record; read it before assuming
anything here is the whole story.

## Contributing / picking this up

- `docs/STATUS.md`: where the project stands and how to start the next milestone.
- `docs/ENGINEERING-NOTES.md`: why the code looks the way it does; the constraints and
  traps that have already caused real bugs here.
- `NOTES.md`: the short version of both, plus this machine's environment quirks.
- `manual/`: the docs site source; documentation changes ship in the same PR
  as the code they describe.

## License

MIT. See [LICENSE](LICENSE).
