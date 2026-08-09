# Plugin SDK — Twelve Module Ports (M5 Stage 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port all twelve `apps/server/src/game/*` modules into workspace packages under `packages/plugins/<id>/`, built on `@gl3/plugin-sdk`. After the last port, delete the old `game/*` wiring.

**Architecture:** Strangler, not big-bang. Each module becomes a plugin package, ported one per task, each landing with the full suite green. **Per-module swap, never coexistence:** when module X is ported, the boot *replaces* `registerXRoutes(app)` with X appearing in `AVAILABLE_PLUGINS` — the plugin and legacy handlers for the same path are never registered on one Fastify instance at the same time (that is a duplicate-route collision). Coexistence is *across modules*: some ported (plugin-served), some not yet (legacy-served), on the same instance — which is safe because no two modules own the same path. The acceptance test for every port is strict: **M5 changes no HTTP response** — the existing integration suite passes *unmodified* per port.

**Tech Stack:** `@gl3/plugin-sdk` (ctx, route, definePlugin, PluginError), drizzle-orm 0.45.2, zod 3, BullMQ 5 (crimes only), ioredis 5. Postgres 16, Redis 7.

## The central design tension — cross-module dependencies

Several core modules import from each other today:

| Shared service | Location | Consumed by |
|---|---|---|
| `releaseIfExpired`, `sendToJail` | `game/jail/status.ts` | bullets, crimes, travel (jail gate) |
| `insertNotification(tx, ...)` | `notifications/service.ts` | gangs (invite, transfer) |
| `recordScore(redis, ...)` | `game/leaderboard/service.ts` | bank, crimes (post-commit leaderboard) |
| cooldown helpers | `game/cooldown.ts` | crimes, travel |

A plugin may import only `@gl3/plugin-sdk` + `zod` + `drizzle-orm` — **never another plugin, never `apps/server`**. So these cross-module calls cannot survive a port as direct imports. Resolution:

- **Jail gate, cooldown, leaderboard, notifications are SDK ctx capabilities or core-side services, not plugin-to-plugin imports.** The ctx already exposes `cooldown` (Task 9 of the foundation) and the jail gate is applied by the route loader (`accessInJail: false` → `releaseIfExpired` in `routes.ts`, already implemented). What's missing:
  - **Leaderboard write**: `tx.economy` or a post-commit hook. The cleanest path is a new ctx capability `ctx.leaderboard.record(kind, playerId, score)` that wraps `recordScore` — or, simpler for v1, the leaderboard stays core (it is rebuilt from Postgres on boot, and plugins write balances via `applyBalanceChange` which the boot rebuild already picks up). **Decision: leaderboard stays core.** Plugins do not call `recordScore`; the next boot rebuild captures their balance/exp changes. Real-time leaderboard updates from plugin actions are deferred — the sorted set is eventually-consistent by design.
  - **`sendToJail`**: the crimes plugin needs to jail a player inside its transaction. Core's `sendToJail(tx, playerId, seconds)` (`game/jail/status.ts:71`) takes **seconds (number)**, sets `player_stats.jailedUntil`, and returns the computed `Date`. The ctx mirrors that signature: `tx.jail.sendToJail(playerId, seconds): Promise<Date>`.
  - **`insertNotification`**: core's `insertNotification(tx, { id, playerId, body })` (`notifications/service.ts:11`) requires an `id` (uuid). The ctx generates the id internally so the plugin never has to: `tx.notify(playerId, body): Promise<void>` → `insertNotification(tx, { id: uuidv7(), playerId, body })`. `uuidv7` is already imported in `apps/server/src/plugins/ctx.ts`.
  - **`lockLocationForUpdate`**: `economy/ledger.ts:88` locks a location row. Bullets and travel lock **location before player** (location-then-`applyBalanceChange`). `tx.locks` currently exposes only `player` and `gangAndPlayer`; add `tx.locks.location(locationId: string): Promise<void>` → `lockLocationForUpdate(tx, locationId)`.
  - **`applyExpAndRankUp`**: the crimes worker (`crimes/worker.ts:113`) calls `applyExpAndRankUp(tx, playerId, exp)` (`economy/ranks.ts:27`), which returns `RankUpResult | null` (`{ rankId, rankName, cashReward: bigint, bulletReward, maxHealth }`). `tx.economy.addExp` exists but does **not** rank up. Add `tx.economy.applyExpAndRankUp(playerId, exp): Promise<RankUpResult | null>`, and export a `RankUpResult` interface from the SDK.
  - **`releaseIfExpired`**: already core-side in the route loader. Plugin routes with `accessInJail: false` get it for free. Plugin *workers* (crimes) don't need it — the worker operates post-enqueue.

This means **Task 0 extends the ctx** with four capabilities — `tx.jail.sendToJail`, `tx.notify`, `tx.locks.location`, and `tx.economy.applyExpAndRankUp` (plus the `RankUpResult` SDK type) — before any port begins. These are the only capabilities the twelve ports need that the foundation doesn't already provide.

**Cross-plugin filters** (e.g. `crimes.beforeResolve`): none of the twelve ports consume filters in v1. The filter system exists for future third-party plugins. Ports are straight 1:1 moves.

## Global Constraints

- **M5 changes no HTTP response.** Same paths, status codes, error strings, bodies, headers. The existing integration suite is the proof a port is correct and must pass **unmodified**. A test file edited during a port is a failed port. (Adding new tests for the plugin package's own SDK behavior is fine; changing an existing assertion about an existing endpoint is not.)
- **A plugin may import only `@gl3/plugin-sdk`, `zod`, `drizzle-orm`.** Never `apps/server`, never another plugin. Compiler-enforced (the foundation proved this).
- **Table ownership: plugin tables are `p_<pluginId>_<table>`.** Existing core tables (`players`, `transactions`, `gangs`, `crimes`, …) keep their names. Where a ported module owns a table today (e.g. `crimes`, `player_crime_skill`, `crime_log`), the port renames it to `p_crimes_*` via that plugin's first migration. This is a rename in the plugin's migration, not a core schema change. **However** — see Task 1's note on whether renames are feasible mid-suite. The integration suite seeds `crimes` directly; renaming mid-port breaks those seeds. **Decision: for v1 ports, plugin tables keep their current unprefixed names and are declared in the manifest's `tables` map without the prefix enforcement relaxed, OR the table stays core-owned and the plugin reads it via `tx.db`.** Resolve per-module in the task: if a table is seeded by core (`crimes`, `locations`, `ranks`) it stays core-owned; if a module owns it exclusively (`crime_log`, `mail_messages`, `gang_*`), it can prefix. The prefix rule applies to *new* plugin tables; existing core tables referenced by a ported module are read-only to the plugin via `tx.db.select` (which works — `select` survives the `query` omission).
- **Money is `bigint`, decimal string on the wire.** Every balance movement through `tx.economy.applyBalanceChange`.
- **No `any` in `packages/*`.** ESM only, `.js` extensions on relative imports.
- **Run `npm run verify` locally before committing.** CI does not run the integration suite.
- **Every port's RED proof**: the port is a swap, not an addition. RED means the *new* plugin handler is wrong, so prove it by breaking the plugin handler deliberately (e.g. return a wrong status, or comment out the `definePlugin` route) and confirming the existing test for that endpoint goes red. Restore. Do not prove RED by registering both paths — a Fastify instance cannot serve the same method+url from two handlers.

## File Structure

Each port creates a workspace package `packages/plugins/<id>/`:
- `package.json` (`@gl3/plugin-<id>`, depends on `@gl3/plugin-sdk`, `drizzle-orm`, `zod`)
- `tsconfig.json` (references `@gl3/plugin-sdk`)
- `src/index.ts` (`definePlugin` + routes + jobs + events)
- `src/schema.ts` (drizzle table definitions for the plugin's own tables, if any)
- `src/migrations/` or inline migrations in the manifest

Server-side changes per port:
- `apps/server/src/index.ts` — add the plugin to `AVAILABLE_PLUGINS` + `PLUGIN_IDS`
- `apps/server/src/game/<id>/` — deleted when the port is confirmed green (last step of each task, after the suite proves the plugin path works)

---

### Task 0: Extend ctx with four port prerequisites

The twelve ports need four capabilities the foundation doesn't expose. Add them all here, verified against the real core signatures, before any port begins.

**Files:**
- Modify: `packages/plugin-sdk/src/ctx.ts` (types + `RankUpResult`), `packages/plugin-sdk/src/index.ts` (re-export `RankUpResult`), `apps/server/src/plugins/ctx.ts` (impl)
- Test: `apps/server/test/plugin-ctx-port-prereqs.test.ts`

**Interfaces:**
- Consumes: `sendToJail(tx: Tx, playerId: string, seconds: number): Promise<Date>` (`game/jail/status.ts:71`); `insertNotification(tx: Tx, { id, playerId, body }): Promise<void>` (`notifications/service.ts:11`); `lockLocationForUpdate(tx: Tx, locationId: string): Promise<void>` (`economy/ledger.ts:88`); `applyExpAndRankUp(tx: Tx, playerId: string, expGain: bigint): Promise<RankUpResult | null>` (`economy/ranks.ts:27`). The core `RankUpResult` is `{ rankId: string; rankName: string; cashReward: bigint; bulletReward: number; maxHealth: number }` (`economy/ranks.ts:5`).
- Produces: `PluginTx.jail.sendToJail(playerId, seconds): Promise<Date>`; `PluginTx.notify(playerId, body): Promise<void>`; `PluginTx.locks.location(locationId): Promise<void>`; `PluginTx.economy.applyExpAndRankUp(playerId, exp): Promise<RankUpResult | null>`; and a `RankUpResult` interface exported from `@gl3/plugin-sdk`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/plugin-ctx-port-prereqs.test.ts` — register a player, create a test plugin with one route that, inside `ctx.transaction`, calls all four: `tx.locks.location(locId)`, `tx.economy.applyExpAndRankUp(playerId, 0n)` (assert returns null — no exp), `tx.jail.sendToJail(playerId, 60)` (assert returns a Date ~60s out), and `tx.notify(playerId, "hello")`. After the route returns 200, assert directly against the DB (separate connection, not the tx): `player_stats.jailedUntil` is set, a `notifications` row with `body="hello"` exists for that player, and the location lock didn't deadlock. Follow `plugin-ctx-transaction.test.ts` for the real-Postgres/real-Redis/`bootTestServer` pattern. For the location lock, insert a test location first (the `locations` seed provides known ids — reuse one, or insert one).

- [ ] **Step 2: Run to verify it fails** — `npx vitest run --project @gl3/server plugin-ctx-port-prereqs`. Expected: FAIL — `tx.jail` / `tx.notify` / `tx.locks.location` / `tx.economy.applyExpAndRankUp` undefined.

- [ ] **Step 3: Add types to `packages/plugin-sdk/src/ctx.ts`**

Add the `RankUpResult` interface near the other interfaces:
```ts
export interface RankUpResult {
  rankId: string;
  rankName: string;
  cashReward: bigint;
  bulletReward: number;
  maxHealth: number;
}
```
Extend `PluginTx`:
```ts
readonly economy: {
  applyBalanceChange(change: PluginBalanceChange): Promise<bigint>;
  applyGangBalanceChange(change: PluginGangBalanceChange): Promise<bigint>;
  addExp(playerId: string, amount: bigint): Promise<void>;
  applyExpAndRankUp(playerId: string, expGain: bigint): Promise<RankUpResult | null>;
};
readonly jail: { sendToJail(playerId: string, seconds: number): Promise<Date> };
readonly locks: {
  player(playerIds: string[]): Promise<void>;
  gangAndPlayer(gangId: string, playerId: string): Promise<void>;
  location(locationId: string): Promise<void>;
};
notify(playerId: string, body: string): Promise<void>;
```

- [ ] **Step 4: Implement in `apps/server/src/plugins/ctx.ts`**

Add imports: `sendToJail` from `../game/jail/status.js`, `insertNotification` from `../game/notifications/service.js`, `lockLocationForUpdate` from `../economy/ledger.js` (already imports siblings there), `applyExpAndRankUp` from `../economy/ranks.js`. In the `pluginTx` object inside `transaction`:
```ts
economy: {
  applyBalanceChange: (change) => applyBalanceChange(tx, change),
  applyGangBalanceChange: (change) => applyGangBalanceChange(tx, change),
  addExp: (playerId, amount) => addExp(tx, playerId, amount),
  applyExpAndRankUp: (playerId, expGain) => applyExpAndRankUp(tx, playerId, expGain),
},
jail: { sendToJail: (playerId, seconds) => sendToJail(tx, playerId, seconds) },
locks: {
  player: (playerIds) => lockPlayersForUpdate(tx, playerIds),
  gangAndPlayer: (gangId, playerId) => lockGangAndPlayerForUpdate(tx, gangId, playerId),
  location: (locationId) => lockLocationForUpdate(tx, locationId),
},
notify: (playerId, body) => insertNotification(tx, { id: uuidv7(), playerId, body }),
```
`uuidv7` is already imported at the top of `ctx.ts`. `sendToJail`'s return value (`Date`) propagates through the delegate unchanged.

- [ ] **Step 5: Re-export `RankUpResult` from the SDK barrel** — add to `packages/plugin-sdk/src/index.ts` so `import { RankUpResult } from "@gl3/plugin-sdk"` works for the crimes port.

- [ ] **Step 6: Run to verify it passes** — `npx vitest run --project @gl3/server plugin-ctx-port-prereqs`. Expected PASS.

- [ ] **Step 7: Prove it can fail** — change `tx.notify` to skip the `insertNotification` call (return early); confirm the notification-row assertion goes red. Restore. Then change `tx.jail.sendToJail` to `seconds * 2`; confirm the Date assertion breaks. Restore.

- [ ] **Step 8: Commit**
```bash
npm run verify
git add packages/plugin-sdk apps/server
git commit -m "$(cat <<'EOF'
feat(plugin-sdk): add jail/notify/location-lock/rank-up to the plugin ctx

Four capabilities the module ports need: crimes jails and ranks up inside
its transaction; gangs notifies; bullets and travel lock the location row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Tasks 1-5: Group A — read-mostly ports (ranks, leaderboard, news, notifications, profile)

These are the simplest ports: read or read+write, no jobs, no cooldowns, no cross-module transactions. They prove the route/menu/page plumbing. **Leaderboard and notifications are special**: they export services consumed by other modules. Their *routes* port cleanly; their *services* stay core (leaderboard) or become ctx capabilities (notifications → `tx.notify`, Task 0).

**Per-module port shape (read-mostly):**
1. Create `packages/plugins/<id>/` with `definePlugin({ id, version, basePaths: ["/api/<id>"], routes: [...] })`.
2. Move the route handler bodies into plugin route handlers, replacing `db`/`request.playerId` with `ctx.player?.id` / `ctx.transaction` / `tx.db`.
3. **The swap** — in `apps/server/src/index.ts`: add `<id>` to `AVAILABLE_PLUGINS` and **remove** the corresponding `registerXRoutes(app)` call **and** its import in the same edit. Both registered at once is a duplicate-route collision. Add `<id>` to `PLUGIN_IDS` in the test boot. (For the real boot in `app.ts`/`index.ts`, `loadPlugins` runs when `AVAILABLE_PLUGINS` is non-empty.)
4. Run the suite — the existing `<id>.test.ts` must pass unmodified against the plugin routes (it now hits the plugin path because the legacy call is gone).
5. Delete `apps/server/src/game/<id>/routes.ts` (keep the service file if other modules still import it). The file is already dead after step 3; deletion is cleanup.

**Task 1: ranks** — `GET /api/ranks`. Trivial: one read of `ranks` + `player_stats.rankId`. No tables owned, no events, no jobs. First port — proves the route/menu/page plumbing end to end.

**Task 2: leaderboard** — `GET /api/leaderboard/:kind`. Reads Redis sorted-sets via `recordScore`/`topN`. The *route* ports; `service.ts` stays core (consumed by bank/crimes). The plugin route needs Redis access for reads — but the ctx deliberately omits `redis`. **Resolution:** leaderboard read goes through a new `ctx.leaderboard.topN(kind, n)` read capability, OR the leaderboard route stays core (it's a read-only aggregation, not gameplay). **Decision: leaderboard route stays core for v1.** It is infrastructure (Redis-backed aggregation), not a gameplay module. Skip this port — note in the plan that leaderboard is core infrastructure, not a plugin. The spec's "twelve modules" counts it, but it has no tables, no events, no gameplay logic — it's a read endpoint over Redis. Porting it adds a Redis-read ctx capability for no gameplay benefit. **Defer: document as a deliberate non-port.**

**Task 3: news** — `POST /api/news` (role-gated via `hasModuleAccess`), `GET /api/news` (public). Publishes `news.posted`. The role-gate (`hasModuleAccess`) reads `players.roleId` + `role_module_access`. The plugin handler can read these via `tx.db.select` (tables are core-owned; `select` works). Public route (`auth: "public"`).

**Task 4: notifications** — `GET /api/notifications`, `POST /api/notifications/:id/read`. Reads/writes `notifications` table. The `service.ts` (`insertNotification`) stays core (now exposed as `tx.notify`, Task 0). Route ports cleanly.

**Task 5: profile** — `GET /api/players/:playerId/profile` (public), `PUT /api/profile` (auth). Reads `players`/`player_stats`/`gangs`/`ranks`; writes `player_stats` (bio, avatarUrl). Public route column-safety must be preserved (explicit select, never spread).

---

### Tasks 6-8: Group B — economy + cooldown ports (bank, bullets, travel)

These prove `tx.economy.applyBalanceChange` and `ctx.cooldown`.

**Task 6: bank** — `POST /api/bank/deposit`, `POST /api/bank/withdraw`. Two-leg ledger transaction (cash↔bank). No cooldown, no jail gate. Publishes `bank.transacted`. Leaderboard write (`recordScore`) is **dropped** from the port (decision: leaderboard is eventually-consistent via boot rebuild). Verify the existing `bank.test.ts` passes unmodified — if it asserts leaderboard state, that assertion is about a core rebuild, not the bank route, and still holds.

**Task 7: bullets** — `POST /api/bullets/buy`. Jail-gated (`accessInJail: false`). **Lock order: location before player** — the port reads `player_stats.locationId`, calls `tx.locks.location(locationId)` (Task 0), then re-reads the location under lock, checks stock, and calls `tx.economy.applyBalanceChange`. `applyBalanceChange` internally locks the player; the explicit location lock must precede it (mirrors `performBulletsPurchase`). Error codes to preserve exactly: `no_location` (409), `insufficient_stock` (409, body `{error, available}`), `insufficient_funds` (409). Publishes `bullets.purchased` (audience `{kind:"player"}`, fields `locationId, quantity, cost, cash, bullets`).

**Task 8: travel** — `GET /api/locations`, `POST /api/travel/:locationId`. Jail-gated. Per-location cooldown (`ctx.cooldown.acquire` with TTL from `locations.travelCooldownSeconds`); compensating `ctx.cooldown.release` on failure. Lock order: location before player — same `tx.locks.location` as bullets. Publishes `player.travelled`.

---

### Tasks 9-10: Group C — jobs + RNG ports (jail, crimes)

**Task 9: jail** — `GET /api/jail`. The lazy-release pattern (`releaseIfExpired`). The jail *route* ports; `status.ts` (`releaseIfExpired`, `sendToJail`, `checkJail`) stays core — it is consumed by the route loader (jail gate) and by crimes (`sendToJail` → now `tx.jail.sendToJail`). The route handler calls a read capability. **Resolve:** the jail route is a self-check-and-release. The plugin route can call `ctx.jail.check()` (new read capability) or the route stays core since `releaseIfExpired` is core infrastructure shared with the loader. **Decision: jail route stays core for v1** — it is the central gate, consumed by the loader itself. Porting it gains nothing and risks the gate. The *capabilities* (`sendToJail` via ctx, `releaseIfExpired` via loader) are what matter. **Defer: document as a deliberate non-port.**

**Task 10: crimes** — the hardest port. `GET /api/crimes`, `POST /api/crimes/:crimeId/commit` (enqueues a BullMQ job). The worker: seeded RNG (from `ctx.job.seed`/`ctx.job.rng`), `plugin_job_runs` idempotency (structural via `ctx.transaction`'s first-statement insert), `tx.economy.applyBalanceChange` + `tx.economy.applyExpAndRankUp(playerId, exp)` (returns `RankUpResult | null`, Task 0) + `tx.jail.sendToJail(playerId, seconds)`, three event types (`crime.resolved`, `player.jailed`, `player.rankedUp`). `crime_log.job_id` unique constraint is now redundant (ctx handles idempotency) but kept for belt-and-suspenders. **Rank-up is now in ctx** (Task 0 added `applyExpAndRankUp` + the `RankUpResult` SDK type) — no plugin-internal rank logic needed; match the worker's existing `rankUp` handling (worker.ts:113-221). Tables `crimes`, `player_crime_skill`, `crime_log` — core-seeded (`crimes`) stays core-owned; `crime_log`/`player_crime_skill` can prefix or stay (decision per table-readiness).

---

### Tasks 11-12: Group D — cross-player + locks ports (mail, gangs)

**Task 11: mail** — `POST /api/mail`, `GET /api/mail`, `GET /api/mail/thread/:id`, `POST /api/mail/:id/read`. Thread participation verification (cross-player). Publishes `mail.received`. Plain inserts/updates (no transactions today — but the port should use `ctx.transaction` for consistency). Resolves recipient by username via `tx.db.select` on `players`.

**Task 12: gangs** — the most complex port. 14 routes, 10 transactional. Cross-table lock ordering (`tx.locks.gangAndPlayer` for every (gang, player) mutation). Permission system (`hasGangPermission` — the plugin needs this logic; either a ctx capability or plugin-internal, reading `gang_permissions` + boss/underboss bypass). Notifications → `tx.notify` (Task 0 — generates the uuid internally). Four event types. This port is last because it owns rule 6's regression test (`gang-lock-order.test.ts`), which must pass unmodified. The plugin's routes must use `tx.locks.gangAndPlayer`, matching the exact lock order the core helper enforces.

---

### Task 13: Delete legacy wiring + final verification

After all ports are green, delete the now-dead `apps/server/src/game/<id>/routes.ts` files (services kept where still consumed). Run the full suite — it must be green with plugins as the only route path. Update `docs/STATUS.md` (M5 → complete).

- [ ] Delete each ported module's `routes.ts` (keep `service.ts`/`status.ts` where consumed by core or ctx). Each was already swapped out at its port; this is the batch cleanup of dead files.
- [ ] Confirm no `register*Routes(app)` calls remain for ported modules (the swap removed each at its port; verify none snuck back).
- [ ] `npm run verify` — full suite green.
- [ ] Manual walkthrough: boot with all plugins loaded, exercise every endpoint.
- [ ] Update `docs/STATUS.md`: M5 complete, suite count.

---

## Notes for the implementer

- **Deliberate non-ports:** leaderboard (Task 2) and jail route (Task 9) stay core. They are infrastructure (Redis aggregation; central jail gate), not gameplay. Their *capabilities* are exposed via ctx (`tx.jail.sendToJail`) or kept as loader behavior (`releaseIfExpired`). This reduces twelve ports to ten route-ports. Document this deviation from the spec's "twelve modules" in the completion ledger.
- **Table-prefix relaxation:** core-seeded tables (`crimes`, `locations`, `ranks`) stay core-owned and unprefixed; plugins read them via `tx.db.select`. Plugin-exclusive tables (`crime_log`, `mail_messages`, `gang_*`) *may* prefix via a rename migration, but only if the integration suite's seeds don't break. If renaming a table breaks a seed, keep the name and declare it in `tables` — the prefix rule is a boot-time check that can be satisfied by declaring the table as core-shared (the validator may need a "core-shared table" escape; resolve in the first port that hits it).
- **Lock ordering is per-pair, not global.** Bullets locks location→player; gangs locks gang→player (via helper). Read CLAUDE.md rule 6 and `ledger.ts` before touching any lock.
- **The crimes worker's idempotency is now structural** — `ctx.transaction` inserts `plugin_job_runs` first. The legacy `crime_log.job_id` unique constraint is redundant but harmless. Do not remove it in the port.
- **`applyExpAndRankUp`** is exposed via ctx (`tx.economy.applyExpAndRankUp`, Task 0) and returns `RankUpResult | null` (SDK-exported). The crimes port uses it directly — no plugin-internal rank logic. The worker's `rankUp` handling (worker.ts:113-221) moves in as-is.
- **Per-module swap, never coexistence** (see Architecture). When porting module X, `apps/server/src/index.ts` switches X from the legacy `registerXRoutes(app)` block to `AVAILABLE_PLUGINS`. The two are never registered together on one Fastify instance. Coexistence is *across* modules: ported modules are plugin-served, unported modules are legacy-served, on the same instance. The test boot (`PLUGIN_IDS`) and the real boot both include the same module's plugin once it ports. Legacy `game/<id>/routes.ts` can be deleted at the end of each task (the swap already removed it from the boot) or batched into Task 13; per-task is safer for revertibility.
