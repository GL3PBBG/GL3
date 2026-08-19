# Premium Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port V2's premium membership as `@gl3/plugin-membership` (20th plugin): points-bought timed status, three consumer-owned benefits (crimes/travel/theft), benefit filter registry, gifting, lazy expiry notification, M4 migrator.

**Architecture:** New SDK `tx.timers` API over core `player_timers` (where migrated V2 membership rows already sit). Membership plugin owns only `p_membership_packages`. Consumers depend on membership's exported `isMember` and subscribe to its `membership.benefits` filter point (the `casino.games` shape). Plugin events only — no `GameEvent` widening.

**Tech Stack:** TypeScript strict ESM, drizzle, zod, Fastify plugin loader, vitest against real Postgres+Redis.

**Spec:** `docs/superpowers/specs/2026-08-20-membership-design.md`

## Global Constraints

- `export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3` and `export REDIS_URL=redis://localhost:6379` before any test run. `apps/migrate` tests also need `MYSQL_ADMIN_URL` (see `.env.example`).
- Branch: `feat/membership` off `main`. Conventional Commits.
- No `any` in `packages/*`. ESM `.js` import extensions. Money/points are `bigint`; wire as decimal strings.
- **Every new `apps/server/test/*.test.ts` file MUST be added to the matching project's `include` list in `vitest.workspace.ts`** — an unlisted file silently never runs (`npx vitest run <path>` says "No test files found" → that means you forgot this).
- Scoped runs while iterating (`npx vitest run <file>` after registering it); the bare `npm run verify` is the merge gate only (Task 11).
- Read exit codes from the process: `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"` — never append `; echo` to the same command you take status from, never pipe verify through grep/tail.
- Before any full-suite run: `pgrep -fa vitest` and `psql -c "select datname from pg_database where datname like 'gl3_tmpl%'"` must show no concurrent runs (cross-talk = void run, not failure).
- Never run `FLUSHALL`/`FLUSHDB`. Never two full suites at once.
- **Version-number drift is expected**: the spec was written when `@gl3/shared` was 0.1.14 / SDK 0.1.7; the tree now has shared `0.1.16`, SDK `0.1.9`. This plan bumps **only the SDK**, `0.1.9` → `0.1.10` (for `tx.timers`), unpublished until user approves. `@gl3/shared` is **untouched** (deviation from spec §"Shared DTOs": manifest-page plugins like theft ship no shared DTOs — page tables render generic `{rows: [...strings]}`; Task 11 amends the spec).

---

### Task 1: SDK `tx.timers` API

**Files:**
- Modify: `packages/plugin-sdk/src/ctx.ts` (PluginTx interface, near `locks`)
- Modify: `packages/plugin-sdk/package.json` (version `0.1.9` → `0.1.10`)
- Modify: `apps/server/src/plugins/ctx.ts` (implement inside `pluginTx`)
- Create: `apps/server/test/plugin-tx-timers.test.ts`
- Modify: `vitest.workspace.ts` (add the test file to the default `@gl3/server` project's `include` — the project that already lists `test/plugin-ctx-core-events.test.ts`)

**Interfaces:**
- Produces: `tx.timers.get(playerId: string, key: string): Promise<Date | null>`, `tx.timers.set(playerId: string, key: string, expiresAt: Date): Promise<void>` (upsert), `tx.timers.clear(playerId: string, key: string): Promise<boolean>` (true iff a row was deleted — the atomic claim Task 3's expiry notification needs).

- [ ] **Step 1: Write the failing test.** Open `apps/server/test/plugin-ctx-core-events.test.ts` and copy its harness (how it obtains a `PluginCtx`/boots, its helpers, its teardown) into `apps/server/test/plugin-tx-timers.test.ts`. Register a player (use `registerVerifiedPlayer` from `./helpers/register.js` if the harness boots a server, or insert a `players` + `player_stats` row via `db.execute(sql\`...\`)` if it builds ctx directly). Test cases, each inside `ctx.transaction`:

```ts
it("get returns null for an absent key", ...)        // expect null
it("set then get round-trips, set again overwrites", ...)  // upsert via the (player_id, key) PK
it("clear returns true once, then false", ...)       // first clear true, second false, get now null
```

- [ ] **Step 2: Run it, verify it fails.** `npx vitest run apps/server/test/plugin-tx-timers.test.ts` — expected: TS error / `tx.timers` undefined. (If "No test files found": you skipped the `vitest.workspace.ts` include.)

- [ ] **Step 3: Add the type.** In `packages/plugin-sdk/src/ctx.ts`, inside `PluginTx` after the `locks` block:

```ts
  /**
   * Per-player key→expiry timers over core's `player_timers` — the table V2's
   * open-ended `userTimers` migrated into, so a plugin can read keys a V2
   * custom module wrote. `set` is an upsert on the (player, key) primary key.
   * `clear` reports whether a row was actually deleted, which is what lets a
   * caller use the DELETE as an atomic once-only claim (membership's lazy
   * expiry notification) instead of a check-then-act.
   *
   * Rule-6 note: the upsert's FK takes FOR KEY SHARE on the players row.
   * Every write path must already hold that player FOR UPDATE (via
   * `economy.applyBalanceChange` or `locks.player`) before calling `set`.
   */
  readonly timers: {
    get(playerId: string, key: string): Promise<Date | null>;
    set(playerId: string, key: string, expiresAt: Date): Promise<void>;
    clear(playerId: string, key: string): Promise<boolean>;
  };
```

- [ ] **Step 4: Implement.** In `apps/server/src/plugins/ctx.ts`: add `playerTimers` to the existing `import { players, playerStats, pluginJobRuns } from "../db/schema/index.js"` line and `and` to the drizzle import. Inside the `pluginTx` object (after `locks`):

```ts
          timers: {
            get: async (playerId, key) => {
              const [row] = await tx
                .select({ expiresAt: playerTimers.expiresAt })
                .from(playerTimers)
                .where(and(eq(playerTimers.playerId, playerId), eq(playerTimers.key, key)));
              return row?.expiresAt ?? null;
            },
            set: async (playerId, key, expiresAt) => {
              await tx
                .insert(playerTimers)
                .values({ playerId, key, expiresAt })
                .onConflictDoUpdate({
                  target: [playerTimers.playerId, playerTimers.key],
                  set: { expiresAt },
                });
            },
            clear: async (playerId, key) => {
              const deleted = await tx
                .delete(playerTimers)
                .where(and(eq(playerTimers.playerId, playerId), eq(playerTimers.key, key)))
                .returning({ playerId: playerTimers.playerId });
              return deleted.length > 0;
            },
          },
```

Bump `packages/plugin-sdk/package.json` version to `0.1.10`. Do NOT publish.

- [ ] **Step 5: Run test → PASS.** Also `npm run typecheck` (loader implements the widened interface everywhere `PluginTx` is constructed — only `apps/server/src/plugins/ctx.ts` constructs one; if others fail, implement there too).

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(sdk): tx.timers over player_timers"`

---

### Task 2: `@gl3/plugin-membership` scaffold + migration + registration sites

**Files:**
- Create: `packages/plugins/membership/package.json`, `tsconfig.json`, `src/index.ts`, `src/schema.ts`, `src/migrations.ts`
- Modify: `apps/server/package.json` (dep `"@gl3/plugin-membership": "*"`), `apps/server/tsconfig.json` + root `tsconfig.json` (references), `vitest.workspace.ts` (srcAliases + test include), `apps/server/src/plugins/core-plugins.ts`, `Dockerfile.server` (5 COPY lines)
- Create: `apps/server/test/membership-plugin.test.ts` (starts here, grows in Tasks 3–4)

**Interfaces:**
- Produces: manifest default export `id: "membership"`, table `p_membership_packages`, drizzle mirror `membershipPackages` (fields `id`, `name`, `costPoints: bigint`, `durationSeconds: number`), mirror `players` (id, username).

- [ ] **Step 1: Copy detectives' shape.** `packages/plugins/membership/package.json` — copy `packages/plugins/detectives/package.json`, rename to `@gl3/plugin-membership`. `tsconfig.json` — copy detectives'. `src/migrations.ts`:

```ts
/**
 * Unlike bounties/detectives this table was never core-owned: V2's
 * `premiumMembership` was listed in SPEC §"Game content" but no core
 * migration ever created it, so there is nothing to relinquish. No foreign
 * keys — like `p_inventory_shop_stock`, deliberately: an FK is a lock
 * (CLAUDE.md rule 6) and nothing needs one (packages are content rows).
 * One statement per migration (bounties' reasoning).
 */
export const MEMBERSHIP_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_packages",
    sql: `CREATE TABLE p_membership_packages (
      id               uuid    PRIMARY KEY,
      name             text    NOT NULL,
      cost_points      bigint  NOT NULL,
      duration_seconds integer NOT NULL
    )`,
  },
];
```

`src/schema.ts`:

```ts
import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/** Owned and migrated by this plugin (migrations.ts). */
export const membershipPackages = pgTable("p_membership_packages", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  costPoints: bigint("cost_points", { mode: "bigint" }).notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
});

/** Read-only mirror of the core-owned table (bounties' pattern). */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});
```

`src/index.ts` (minimal; Tasks 3–6 grow it):

```ts
import { definePlugin } from "@gl3/plugin-sdk";
import { MEMBERSHIP_MIGRATIONS } from "./migrations.js";

export default definePlugin({
  id: "membership",
  version: "1.0.0",
  basePaths: ["/api/membership", "/api/admin/membership"],
  tables: { packages: "p_membership_packages" },
  migrations: MEMBERSHIP_MIGRATIONS,
  routes: [],
});
```

- [ ] **Step 2: All registration sites** (CLAUDE.md's eight — check each off):
  1. package dir (Step 1)
  2. `apps/server/package.json` dependencies: `"@gl3/plugin-membership": "*"`, then `npm install`
  3. `apps/server/tsconfig.json` `references`: add `{ "path": "../../packages/plugins/membership" }` (mirror the theft entry)
  4. root `tsconfig.json` `references`: same
  5. `vitest.workspace.ts` `srcAliases`: `"@gl3/plugin-membership": fileURLToPath(new URL("./packages/plugins/membership/src/index.ts", import.meta.url))`
  6. `apps/server/src/plugins/core-plugins.ts`: `import membershipPlugin from "@gl3/plugin-membership";` + append `membershipPlugin` to `CORE_PLUGINS`
  7. `Dockerfile.server`: 5 COPY lines mirroring theft's at lines 72, 112–113, 181, 211 (`grep -n "packages/plugins/theft" Dockerfile.server` shows the pattern; after editing, `grep -c "packages/plugins/membership" Dockerfile.server` must print 5)
  8. `npm run plugins:generate` — commit `apps/server/src/plugins/installed-plugins.ts` only if it changed.

- [ ] **Step 3: Failing migration test.** Start `apps/server/test/membership-plugin.test.ts` (register in `vitest.workspace.ts` default `@gl3/server` project include), mirroring `apps/server/test/theft-tiers.test.ts`'s first describe:

```ts
import membershipPlugin from "@gl3/plugin-membership";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
afterAll(async () => { await conn.end(); });

describe("membership migrations", () => {
  it("creates p_membership_packages", async () => {
    await runPluginMigrations(db, [membershipPlugin]);
    const tables = await db.execute(sql`
      SELECT tablename FROM pg_tables WHERE tablename = 'p_membership_packages'`);
    expect(tables).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run → PASS** (`npx vitest run apps/server/test/membership-plugin.test.ts`), plus `npx tsc --build --force apps/server/tsconfig.json` (the exact command CI's image build runs — catches a missed reference locally).

- [ ] **Step 5: Commit.** `git commit -m "feat(membership): plugin scaffold, packages table, registration sites"`

---

### Task 3: Exports — `isMember`, lazy expiry notification, benefits filter point

**Files:**
- Create: `packages/plugins/membership/src/api.ts`
- Modify: `packages/plugins/membership/src/index.ts` (re-export; declare `provides: [benefits]`)
- Modify: `apps/server/test/membership-plugin.test.ts`

**Interfaces:**
- Consumes: Task 1's `tx.timers`.
- Produces: `MEMBERSHIP_TIMER_KEY = "membership"`; `membershipUntil(tx: PluginTx, playerId: string): Promise<Date | null>`; `isMember(tx: PluginTx, playerId: string): Promise<boolean>`; `interface BenefitDecl { title: string; description: string }`; `benefits: FilterPoint<BenefitDecl[]>` named `"membership.benefits"`.

- [ ] **Step 1: Failing tests** (grow `membership-plugin.test.ts`; boot with `bootTestServer()` like theft-tiers' second describe, register a player with `registerVerifiedPlayer`):
  - live timer (insert `player_timers` row via `db.execute(sql\`INSERT INTO player_timers (player_id, key, expires_at) VALUES (${id}, 'membership', now() + interval '1 hour')\`)`) → drive `isMember` through any route that calls it once Task 4 lands; at THIS task, test through a direct `ctx` obtained the way `plugin-tx-timers.test.ts` does, calling `membershipUntil(tx, id)` inside `ctx.transaction` → returns a Date.
  - expired timer (`now() - interval '1 hour'`) → `membershipUntil` returns null, the row is GONE, and exactly one `notifications` row for that player exists (`SELECT count(*) FROM notifications WHERE player_id = ...`).
  - second call after expiry → still null, still exactly one notification (the DELETE-as-claim).
  - no row → null, zero notifications.

- [ ] **Step 2: Run → FAIL** (module not found).

- [ ] **Step 3: Implement** `src/api.ts`:

```ts
import { filterPoint, type PluginTx } from "@gl3/plugin-sdk";

export const MEMBERSHIP_TIMER_KEY = "membership";

export interface BenefitDecl { title: string; description: string }

/** Consumers subscribe with `on(benefits, ...)` to add display copy (casino.games shape). */
export const benefits = filterPoint<BenefitDecl[]>("membership.benefits");

/**
 * The live expiry, or null — and the lazy expiry notifier. An expired row is
 * deleted here, in the caller's transaction; `clear` returning true is the
 * atomic once-only claim (a concurrent caller's DELETE finds no row and
 * returns false), so exactly one "expired" notification is ever sent per
 * lapse. No cron, no Redis marker (CLAUDE.md rule 2 satisfied structurally).
 */
export async function membershipUntil(tx: PluginTx, playerId: string): Promise<Date | null> {
  const until = await tx.timers.get(playerId, MEMBERSHIP_TIMER_KEY);
  if (until === null) return null;
  if (until.getTime() > Date.now()) return until;
  const claimed = await tx.timers.clear(playerId, MEMBERSHIP_TIMER_KEY);
  if (claimed) await tx.notify(playerId, "Your premium membership has expired.");
  return null;
}

export async function isMember(tx: PluginTx, playerId: string): Promise<boolean> {
  return (await membershipUntil(tx, playerId)) !== null;
}
```

In `src/index.ts`: `export { MEMBERSHIP_TIMER_KEY, benefits, isMember, membershipUntil, type BenefitDecl } from "./api.js";` and add `provides: [benefits]` to the manifest (casino's documentation-parity idiom).

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(membership): isMember/membershipUntil with lazy expiry notification, benefits filter point"`

---

### Task 4: Player routes — status, packages, benefits, buy

**Files:**
- Modify: `packages/plugins/membership/src/index.ts` (or split routes into `src/routes.ts` if index passes ~300 lines)
- Modify: `apps/server/test/membership-plugin.test.ts`

**Interfaces:**
- Consumes: Task 3's exports, Task 1's timers, `isInsufficientFundsError` from `@gl3/plugin-sdk` (never `instanceof` across the plugin/core boundary).
- Produces: `GET /api/membership/status|packages|benefits` (all `{ rows: [...] }`, every value a string — they are `table.source`s and the buy form's `optionsSource`), `POST /api/membership/buy`.

- [ ] **Step 1: Failing tests** (bootTestServer + inject, theft-tiers style):
  - `GET /api/membership/packages` lists a seeded package (seed via `db.execute(sql\`INSERT INTO p_membership_packages ...\`)`).
  - `GET /api/membership/status`: no timer → `rows: [{ status: "Not a member", expiresAt: "—" }]`; live timer → status "Active" and an ISO `expiresAt`.
  - `GET /api/membership/status` with an EXPIRED timer → "Not a member" AND the notification row appears (proves the page visit drives `membershipUntil`).
  - `GET /api/membership/benefits` → `rows: []` for now (consumers subscribe in Tasks 7–9).
  - `POST /api/membership/buy`: seed player points via `db.execute(sql\`UPDATE player_stats SET points = 1000 WHERE player_id = ${id}\`)` (own-file DB, invariant test unaffected). Buy → 200, points now `1000 - cost` (SELECT), `player_timers.membership` ≈ now + duration.
  - buy again while active → expiry ≈ first expiry + duration (stacking).
  - insufficient points → 409 `insufficient_points`, timer unchanged.
  - unknown packageId → 404 `package_not_found`.

- [ ] **Step 2: Run → FAIL** (404s).

- [ ] **Step 3: Implement.** In the plugin:

```ts
function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days > 0) return days === 1 ? "1 day" : `${days} days`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return hours === 1 ? "1 hour" : `${hours} hours`;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
```

- `statusRoute` GET `/api/membership/status`: `ctx.transaction(async (tx) => { const until = await membershipUntil(tx, player.id); ... })` → `{ rows: [ until ? { status: "Active", expiresAt: until.toISOString() } : { status: "Not a member", expiresAt: "—" } ] }`.
- `packagesRoute` GET `/api/membership/packages`: select all ordered by `durationSeconds` asc (V2 ordered `PM_seconds ASC`) → `rows: [{ id, name, costPoints: p.costPoints.toString(), duration: formatDuration(p.durationSeconds) }]`.
- `benefitsRoute` GET `/api/membership/benefits`: `const list = await ctx.filters.apply(benefits, []);` → `rows: list` (title/description are already strings).
- `buyRoute` POST `/api/membership/buy`, `body: z.object({ packageId: z.string().uuid() })`:

```ts
    return ctx.transaction(async (tx) => {
      const [pkg] = await tx.db.select().from(membershipPackages)
        .where(eq(membershipPackages.id, body.packageId));
      if (!pkg) throw new PluginError("package_not_found", 404);
      try {
        await tx.economy.applyBalanceChange({
          playerId: player.id, amount: -pkg.costPoints, kind: "points",
          reason: "membership.buy", refId: pkg.id,
        });
      } catch (error) {
        if (isInsufficientFundsError(error)) throw new PluginError("insufficient_points", 409);
        throw error;
      }
      // Stacking, V2's exact rule: extend from the live expiry, else from now.
      // applyBalanceChange above already holds this player FOR UPDATE, so the
      // upsert's KEY SHARE nests under it (SDK timers doc, rule 6).
      const current = await tx.timers.get(player.id, MEMBERSHIP_TIMER_KEY);
      const base = current !== null && current.getTime() > Date.now() ? current.getTime() : Date.now();
      const until = new Date(base + pkg.durationSeconds * 1000);
      await tx.timers.set(player.id, MEMBERSHIP_TIMER_KEY, until);
      await tx.events.publish({
        name: "purchased",
        actorId: player.id, actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { packageName: pkg.name, until: until.toISOString() },
      });
      return { status: 200, body: { until: until.toISOString() } };
    });
```

Event declarations for the manifest `events` array (theft's `resolvedEvent` shape):

```ts
const purchasedEvent = {
  name: "purchased",
  payload: z.object({ packageName: z.string(), until: z.string() }),
  describe: "{actorName} bought {packageName}",
  invalidates: ["membership", "me"],
};
```

Copy the exact `PluginEventInput` field set from theft's `tx.events.publish` call if the shape above drifts (theft is the reference implementation).

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(membership): status/packages/benefits/buy routes"`

---

### Task 5: Gift route

**Files:**
- Modify: `packages/plugins/membership/src/index.ts`
- Create: `apps/server/test/membership-gift.test.ts` (+ `vitest.workspace.ts` include, default `@gl3/server` project)

**Interfaces:**
- Consumes: Tasks 1/3/4. `players` mirror from `src/schema.ts`.
- Produces: `POST /api/membership/gift` `{ packageId, recipientName }`.

- [ ] **Step 1: Failing tests:** register buyer + recipient (`registerVerifiedPlayer` twice). Seed buyer points.
  - gift → 200; buyer points down by cost; RECIPIENT's `player_timers.membership` set; buyer's unset; a `notifications` row for the recipient mentioning the buyer's username.
  - gift to own username → 400 `cannot_gift_self`, points unchanged.
  - unknown recipientName → 404 `player_not_found`.
  - insufficient points → 409 `insufficient_points`, recipient timer unset.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (`body: z.object({ packageId: z.string().uuid(), recipientName: z.string().min(1).max(100) })`):

```ts
    return ctx.transaction(async (tx) => {
      const [pkg] = await tx.db.select().from(membershipPackages)
        .where(eq(membershipPackages.id, body.packageId));
      if (!pkg) throw new PluginError("package_not_found", 404);
      const [recipient] = await tx.db.select({ id: players.id, username: players.username })
        .from(players).where(eq(players.username, body.recipientName));
      if (!recipient) throw new PluginError("player_not_found", 404);
      if (recipient.id === player.id) throw new PluginError("cannot_gift_self", 400);

      // BOTH players, sorted, in ONE call, BEFORE any balance change — the
      // player↔player edge combat owns (rule 6). No new lock-order test:
      // participants share the helper, so a test would prove only the
      // already-safe case (CLAUDE.md rule-6 corollary).
      await tx.locks.player([player.id, recipient.id]);

      try {
        await tx.economy.applyBalanceChange({
          playerId: player.id, amount: -pkg.costPoints, kind: "points",
          reason: "membership.gift", refId: recipient.id,
        });
      } catch (error) {
        if (isInsufficientFundsError(error)) throw new PluginError("insufficient_points", 409);
        throw error;
      }
      const current = await tx.timers.get(recipient.id, MEMBERSHIP_TIMER_KEY);
      const base = current !== null && current.getTime() > Date.now() ? current.getTime() : Date.now();
      const until = new Date(base + pkg.durationSeconds * 1000);
      await tx.timers.set(recipient.id, MEMBERSHIP_TIMER_KEY, until);
      await tx.notify(recipient.id, `${player.username} gifted you ${pkg.name}.`);
      await tx.events.publish({
        name: "gifted",
        actorId: player.id, actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { packageName: pkg.name, recipientName: recipient.username },
      });
      return { status: 200, body: { until: until.toISOString() } };
    });
```

Add `giftedEvent` (describe `"{actorName} gifted {packageName} to {recipientName}"`, invalidates `["membership", "me"]`) to the manifest `events`.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(membership): gift a package to another player"`

---

### Task 6: Pages (player + admin) and admin CRUD

**Files:**
- Create: `packages/plugins/membership/src/pages.ts`
- Modify: `packages/plugins/membership/src/index.ts` (admin routes; `pages`/`adminPages` manifest fields)
- Create: `apps/server/test/admin-membership.test.ts` (+ workspace include, default project)
- Modify: `apps/server/test/admin-ids-hidden.test.ts` (floor 12 → 13)

**Interfaces:**
- Consumes: Task 4's GET routes as `source`/`optionsSource`.
- Produces: `GET /api/admin/membership/packages`, `POST /api/admin/membership/packages`, `POST /api/admin/membership/packages/update`, `DELETE /api/admin/membership/packages/:id` — all `auth: "admin"` (the loader's tier enforces the role→module grant; no in-handler permission code, theft precedent).

- [ ] **Step 1: Failing tests** (mirror the structure of `apps/server/test/admin-theft.test.ts`): admin CRUD round-trip (create → list shows it → update name+cost → delete → gone), non-admin gets 403, `DELETE` of unknown id → 404. Also bump the ids-hidden floor: in `admin-ids-hidden.test.ts` change `toBeGreaterThanOrEqual(12)` to `13` — it will fail until the admin page ships.

- [ ] **Step 2: Run both files → FAIL.**

- [ ] **Step 3: Implement.** Admin routes copy theft's tier CRUD verbatim with these substitutions — table `membershipPackages`, paths `/api/admin/membership/packages...`, zod:

```ts
const PackageCreateSchema = z.object({
  name: z.string().min(1).max(255),
  costPoints: z.coerce.number().int().min(0),
  durationSeconds: z.coerce.number().int().min(60),
});
const PackageUpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  costPoints: z.coerce.number().int().min(0),
  durationSeconds: z.coerce.number().int().min(60),
});
```

(`costPoints` inserts as `BigInt(body.costPoints)`.) Admin list route returns `rows: [{ id, name, costPoints: String, durationSeconds: String }]`.

`src/pages.ts` — player page:

```ts
import type { PageSchema } from "@gl3/plugin-sdk";

export const membershipPage: PageSchema = {
  id: "membership.index",
  path: "/membership",
  menu: { label: "Membership", order: 60 },
  view: {
    kind: "panel",
    title: "Premium membership",
    children: [
      { kind: "table", source: "GET /api/membership/status", columns: [
        { key: "status", label: "Status" },
        { key: "expiresAt", label: "Expires" },
      ] },
      { kind: "panel", title: "Benefits", children: [
        { kind: "table", source: "GET /api/membership/benefits", columns: [
          { key: "title", label: "Benefit" },
          { key: "description", label: "" },
        ] },
      ] },
      { kind: "panel", title: "Packages", children: [
        { kind: "table", source: "GET /api/membership/packages", columns: [
          { key: "name", label: "Package" },
          { key: "costPoints", label: "Cost (points)" },
          { key: "duration", label: "Duration" },
        ] },
        { kind: "form", action: "POST /api/membership/buy", submitLabel: "Buy", fields: [
          { name: "packageId", label: "Package", type: "select",
            optionsSource: "GET /api/membership/packages", valueKey: "id", labelKey: "name" },
        ] },
        { kind: "form", action: "POST /api/membership/gift", submitLabel: "Gift", fields: [
          { name: "packageId", label: "Package", type: "select",
            optionsSource: "GET /api/membership/packages", valueKey: "id", labelKey: "name" },
          { name: "recipientName", label: "Recipient username", type: "text" },
        ] },
      ] },
    ],
  },
};
```

Admin page (`adminPage`, id `"membership-admin"`, path `/admin/membership`): copy theft's admin tiers panel — table over `GET /api/admin/membership/packages` with columns name/costPoints/durationSeconds and a Delete `rowAction` (`DELETE /api/admin/membership/packages/:id`, confirm "Delete this package?"), an Add form (`POST /api/admin/membership/packages`; fields name text, costPoints number, durationSeconds number), an Update form (`POST .../update`; id select over the admin list with `labelKey: "name"`, then the same three fields, name labelled "Rename to (optional)"). **No UUID column anywhere.** Wire `pages: [membershipPage]`, `adminPages: [adminPage]` into the manifest.

- [ ] **Step 4: Run both files → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(membership): player page, admin page, package CRUD"`

---

### Task 7: Consumer — crimes (Getaway Driver)

**Files:**
- Modify: `packages/plugins/crimes/package.json` (dep `"@gl3/plugin-membership": "*"` + `npm install`), `packages/plugins/crimes/tsconfig.json` (add a reference to `../membership`, mirroring how `packages/plugins/combat/tsconfig.json` references detectives)
- Modify: `packages/plugins/crimes/src/index.ts`
- Create: `apps/server/test/membership-benefits.test.ts` (+ workspace include, default project; Tasks 8–9 grow it)

**Interfaces:**
- Consumes: `isMember(tx, playerId)`, `benefits` + `on` from the SDK.
- Produces: member crime cooldown = `Math.ceil(base * 0.75)` in BOTH the listing DTO and the Redis TTL `cooldown.acquire` claims.

- [ ] **Step 1: Failing tests** (bootTestServer; helper `grantMembership(db, playerId)` = insert the `player_timers` row with `now() + interval '1 day'`, shared by Tasks 8–9 — define it at the top of the file):
  - seed a crime with `cooldownSeconds: 100` (via existing crimes seed path or direct SQL into the `crimes` core table). Member: `GET /api/crimes` shows `cooldownSeconds: 75`; non-member: 100.
  - member commits crime → immediately `GET /api/crimes` → `cooldownRemaining <= 75` and `> 0` (proves the acquire used the discounted TTL).
  - `GET /api/membership/benefits` now contains a row titled "Getaway Driver".

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** In crimes:

```ts
import { benefits as membershipBenefits, isMember } from "@gl3/plugin-membership";
import { on } from "@gl3/plugin-sdk"; // merge into existing sdk import

/** V2 crimes.hooks.php: ceil(C_cooldown * 0.75) while the membership timer runs. */
function memberCooldown(base: number, member: boolean): number {
  return member ? Math.ceil(base * 0.75) : base;
}

const declareBenefit = on(membershipBenefits, (_ctx, list) => [
  ...list,
  { title: "Getaway Driver", description: "All crime cooldowns are reduced by 25%" },
]);
```

- Listing route: inside its existing transaction add `const member = await isMember(tx, player.id);` and emit `cooldownSeconds: memberCooldown(crime.cooldownSeconds, member)`.
- Commit route: fold the member read into the existing pre-lookup transaction — `const pre = await ctx.transaction(async (tx) => { const [row] = ...; return { crime: row ?? null, member: await isMember(tx, player.id) }; });` — then `ctx.cooldown.acquire("crime", player.id, memberCooldown(crime.cooldownSeconds, pre.member))`.
- Manifest: add `filters: [declareBenefit]` (or append if a `filters` array exists).

- [ ] **Step 4: Run new tests + `npx vitest run apps/server/test/crimes*.test.ts` (pre-existing crimes files; non-members see unchanged numbers, so they must stay green) → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(crimes): membership Getaway Driver (-25% cooldowns)"`

---

### Task 8: Consumer — travel (Frequent Flyer Discount)

**Files:**
- Modify: `packages/plugins/travel/package.json` + `tsconfig.json` (dep + reference, as Task 7)
- Modify: `packages/plugins/travel/src/index.ts`
- Modify: `apps/server/test/membership-benefits.test.ts`

**Interfaces:**
- Consumes: `isMember`, `membershipBenefits`.
- Produces: member fare = `(travelCost + 3n) / 4n` (= V2 `ceil(L_cost * 0.25)`) in the listing `travelCost`, the ledger charge, and the `player.travelled` event's `cost`.

- [ ] **Step 1: Failing tests:** seed two locations, `travel_cost` 1000 on the destination; player has cash.
  - member: `GET /api/travel` (the listing route's path — confirm in the file) shows the destination's `travelCost: "250"`; non-member `"1000"`.
  - member travels → cash drops by exactly 250 (check `player_stats.cash` or the ledger row for `reason = 'travel.cost'`).
  - odd fare rounds UP: cost 999 → member pays 250 (`ceil(999/4) = 250`).
  - benefits registry gains "Frequent Flyer Discount".

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** In travel:

```ts
/** V2 travel.hooks.php: ceil(L_cost * 0.25) while the membership timer runs — ceiling division in bigint. */
function memberFare(cost: bigint, member: boolean): bigint {
  return member ? (cost + 3n) / 4n : cost;
}

const declareBenefit = on(membershipBenefits, (_ctx, list) => [
  ...list,
  { title: "Frequent Flyer Discount", description: "All travel costs are reduced by 75%" },
]);
```

- Listing: the existing transaction already runs before `ctx.filters.apply(locationsListed, ...)`; read `const member = await isMember(tx, player.id)` there and return it alongside `rows`/`currentLocationId`; in the final response map, emit `travelCost: memberFare(l.travelCost, member).toString()`. (Apply AFTER the `locationsListed` filter so bullets' price decoration still sees the raw row.)
- `attemptTravel`: after the locked destination read, `const member = await isMember(tx, player.id); const fare = memberFare(destination.travelCost, member);` — use `fare` in the `> 0n` guard, the `applyBalanceChange` amount, and the event's `cost: fare.toString()`.
- Manifest `filters: [declareBenefit]`.

- [ ] **Step 4: Run new tests + pre-existing travel test files → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(travel): membership Frequent Flyer Discount (-75% fares)"`

---

### Task 9: Consumer — theft (Slide Hammer)

**Files:**
- Modify: `packages/plugins/theft/package.json` + `tsconfig.json` (dep + reference)
- Modify: `packages/plugins/theft/src/resolve.ts` (pure helper), `packages/plugins/theft/src/index.ts`
- Modify: `apps/server/test/membership-benefits.test.ts`; add a unit case to `apps/server/test/theft-resolve.test.ts` (already registered in the `@gl3/server:unit` project)

**Interfaces:**
- Consumes: `isMember`, `membershipBenefits`.
- Produces: `boostedChance(chance: number, member: boolean): number` — `member ? Math.min(100, Math.floor(chance * 1.1)) : chance` (V2 theft.hooks.php exactly).

- [ ] **Step 1: Failing tests:**
  - unit (`theft-resolve.test.ts`): `boostedChance(50, true) === 55`, `boostedChance(95, true) === 100` (cap), `boostedChance(59, true) === 64` (floor of 64.9), `boostedChance(50, false) === 50`.
  - integration (`membership-benefits.test.ts`): seed a tier with `success_chance = 50`; member sees `successChance: "55"` in `GET /api/theft/tiers`, non-member `"50"`. Registry gains "Slide Hammer".

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** In `resolve.ts`:

```ts
/** V2 theft.hooks.php: floor(T_chance * 1.1), capped at 100, while the membership timer runs. */
export function boostedChance(chance: number, member: boolean): number {
  return member ? Math.min(100, Math.floor(chance * 1.1)) : chance;
}
```

In `index.ts`: benefit subscription (`{ title: "Slide Hammer", description: "You use a slide hammer to increase your chances of stealing a car by 10%" }` — V2's copy) into `filters`. Tiers listing: `const member = await isMember(tx, player.id)` inside the existing tx; `successChance: String(boostedChance(tier.successChance, member))`. Steal route: inside the transaction, AFTER `tx.locks.location` + `tx.locks.player` + the location re-check, `const member = await isMember(tx, player.id); const effectiveTier = { ...tier, successChance: boostedChance(tier.successChance, member) };` and pass `effectiveTier` to `resolveTheft` (bracket math uses only value bounds, which are unchanged).

- [ ] **Step 4: Run unit + integration + pre-existing theft files → PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(theft): membership Slide Hammer (+10% steal chance)"`

---

### Task 10: M4 — migrate `premiumMembership`

**Files:**
- Modify: `apps/migrate/src/mysql/fingerprint.ts` (`KNOWN_TABLES` gains `"premiumMembership"`)
- Modify: `apps/migrate/test/fixtures/v2-schema.sql` (fix `PM_name` → `PM_desc` — the real V2 column, verified against `install/schema.sql` of `ChristopherDay/Gangster-Legends-V2@master`; the fixture was reconstructed wrong, the `PR_owner` defect class again; rewrite the "deliberately NOT migrated" comment) and `apps/migrate/test/fixtures/v2-seed.sql` (same rename in the INSERT)
- Modify: `apps/migrate/src/pg/plugin-tables.ts` (add `membershipPackages` mirror), `apps/migrate/src/orchestrator.ts`, `apps/migrate/test/helpers/fixtures.ts` (`runPluginMigrations` list + comment: nine → ten plugin-owned target tables), `apps/migrate/test/orchestrator-idempotency.test.ts` (`ALL_TABLES` + import)
- Modify: `apps/migrate/src/migrators/settings.ts` (skip `membershipLinkName`/`membershipName` with a report "skipped" bump — follow the file's existing idiom for special-cased keys; if none fits, a two-key `Set` checked in the loop)
- Modify: `apps/migrate/test/mysql/fingerprint.test.ts` + `apps/migrate/test/cli.test.ts` (expected unknown tables become `["blackjackHands"]`)
- Create: `apps/migrate/src/migrators/membership.ts`, `apps/migrate/test/migrators/membership.test.ts`

**Interfaces:**
- Consumes: `membershipPackages` drizzle shape from Task 2 (mirrored, not imported — migrate mirrors plugin tables in `plugin-tables.ts`).
- Produces: `migrateMembership(pool, exec, report)`.

- [ ] **Step 1: Failing test** (`membership.test.ts`, mirroring `apps/migrate/test/migrators/roles.test.ts`'s harness): fixture-seeded packages land in `p_membership_packages` with `name = PM_desc`, `cost_points = PM_cost`, `duration_seconds = PM_seconds`; run twice → same row count (idempotent via `onConflictDoUpdate`).

- [ ] **Step 2: Run → FAIL.** (`npx vitest run apps/migrate/test/migrators/membership.test.ts` — check the migrate project's include list in `vitest.workspace.ts` and register the file where its siblings are.) Requires `MYSQL_ADMIN_URL`.

- [ ] **Step 3: Implement.** `plugin-tables.ts` mirror (same field spelling as Task 2's schema). Migrator (properties migrator is the template):

```ts
interface MembershipRow { PM_id: number; PM_desc: string; PM_seconds: number; PM_cost: number }

export async function migrateMembership(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void> {
  const [rows] = await pool.query<(MembershipRow & mysql.RowDataPacket)[]>(
    "SELECT PM_id, PM_desc, PM_seconds, PM_cost FROM premiumMembership",
  );
  for (const row of rows) {
    bumpTable(report, "premiumMembership", "read");
    const { v3Id } = await getOrCreateV3Id(exec, "premiumMembership", row.PM_id);
    const values = {
      id: v3Id, name: row.PM_desc,
      costPoints: BigInt(row.PM_cost), durationSeconds: row.PM_seconds,
    };
    await exec.insert(membershipPackages).values(values)
      .onConflictDoUpdate({ target: membershipPackages.id, set: values });
    bumpTable(report, "premiumMembership", "written");
  }
}
```

Orchestrator: add `await migrateMembership(pool, tx, report);` to the FIRST content phase (the one running `migrateWeapons/migrateItems/migrateCrimes` — packages are content with no dependencies). Fingerprint: add to `KNOWN_TABLES`. Fixtures helper: add `membershipPlugin` to the `runPluginMigrations` array. Settings migrator: skip the two dead keys with report entries. Update the two test expectations. (`report.test.ts` uses `premiumMembership` as synthetic sample data — leave it alone.)

- [ ] **Step 4: Run the migrate project's affected files** (`membership`, `fingerprint`, `cli`, `orchestrator-idempotency`, `settings`) **→ PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat(migrate): premiumMembership -> p_membership_packages, fixture PM_desc fix"`

---

### Task 11: Docs, spec amendment, merge gate

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-membership-design.md`, `docs/STATUS.md`, `CLAUDE.md`, `SPEC.md` (§"Game content" premiumMembership row: note it now migrates)

- [ ] **Step 1: Amend the spec in place** (drift found at planning): shared DTO section — no `dto/membership.ts`, `@gl3/shared` untouched (manifest pages render generic rows; theft precedent); version numbers — SDK `0.1.9 → 0.1.10` only, unpublished; note the fixture `PM_name → PM_desc` defect found and fixed.
- [ ] **Step 2: STATUS.md** — add the membership cluster section in the running style: 20th plugin, 10th with migrations, `tx.timers`, three consumer edges (6th–8th), lazy expiry notify, gift on the existing player↔player edge, M4 phase change, fixture defect, no shared bump, SDK 0.1.10 pending publish. **CLAUDE.md** — update the "Current state" paragraph and the counts it tracks (plugins 19→20, migrations-declaring 9→10, dependency edges list, SDK version note "0.1.10 unpublished pending approval").
- [ ] **Step 3: Cross-talk check** — `pgrep -fa vitest` (expect nothing foreign) and `psql "$DATABASE_URL" -c "select datname from pg_database where datname like 'gl3_tmpl%'"`.
- [ ] **Step 4: THE MERGE GATE — bare full run:**

```bash
npm run verify > /tmp/verify-membership.log 2>&1
echo "exit=$?"
```

Run `echo "exit=$?"` as a SEPARATE command immediately after (never appended with `;` to the verify line). Non-zero exit = failure even if the summary reads all-passed (unhandled rejections). Any file reporting `(0 test)` with zero failures = void run (cross-talk), not green — re-check step 3 and re-run. Fix anything red (systematic-debugging skill), re-run until exit=0.
- [ ] **Step 5: Commit docs.** `git commit -m "docs: membership cluster status + spec amendments"`
- [ ] **Step 6:** Report to the user: suite result (exact counts + exit code), SDK publish decision pending their approval (registry check first: `npm view @gl3/plugin-sdk versions --registry https://npm.gl3.dev`), and merge/PR choice (superpowers:finishing-a-development-branch).

## Self-review notes

- Spec coverage: state/ownership → T1–2; buy/gift/expiry → T3–5; registry+consumers → T3, T7–9; admin/M4/web/tests → T6, T10; versions/docs → T11. Spec's shared-bump requirement deliberately dropped — T11 amends the spec (planning-time finding, theft precedent).
- Every route/table/test name used in later tasks is defined in an earlier task's Interfaces block.
- V2 magnitudes pinned: ceil(×0.75) crimes, ceil(×0.25) travel = `(c+3n)/4n`, floor(×1.1) cap 100 theft — each with its V2 source file named in a comment.
