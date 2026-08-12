# Organized Crime (Heists) Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `oc` plugin — invite-based four-role heists with buy-in escrow, a leader-fired seeded BullMQ job resolving one shared outcome (equal split on success, mass jail on failure) — plus an `/oc` web page.

**Architecture:** A new `packages/plugins/oc` package owns two plugin-migrated tables (`p_oc_heists`, `p_oc_members`, **no foreign keys** — an FK is a lock) and eight routes. One-active-heist-per-player is a partial unique index, not a check. The lock order is a new root that shares no edge with the existing three: **heist row FOR UPDATE first, then `tx.locks.player([...])` ascending**. Execution is the crimes-worker pattern: one `ctx.transaction`, `plugin_job_runs` idempotency, seeded roll, events buffered and flushed post-commit. Spec: `docs/superpowers/specs/2026-08-12-organized-crime-design.md`.

**Tech Stack:** TypeScript strict ESM, Fastify + drizzle + zod via `@gl3/plugin-sdk`, BullMQ via `manifest.jobs`, real Postgres/Redis integration tests via vitest, React 18 + TanStack Query web.

## Global Constraints

- Branch: all work on `feat/organized-crime`, created from `main` before Task 1. Merge to `main` only after the final full-suite verify.
- **`@gl3/shared` is off-limits to a plugin package** — restate the money regex `/^-?\d+$/` and `IdSchema` (`z.string().uuid()`) inline (pattern: `packages/plugins/bounties/src/index.ts:13-16`, `packages/plugins/crimes/src/index.ts:20`).
- No `any` in `packages/*` — none, not even a cast. ESM imports carry `.js` extensions despite `.ts` sources.
- Money is `bigint` in TS/Postgres, decimal **string** on the wire. Never a JSON number.
- Every balance movement goes through `tx.economy.applyBalanceChange`. Ledger reasons for this plugin: `oc.buyin`, `oc.refund`, `oc.payout`.
- Events only via `tx.events.publishCore` / `tx.notify` inside `ctx.transaction` — the loader buffers and flushes after commit (CLAUDE.md rule 5).
- **Lock order for this plugin:** any transaction that reads heist/slot state to decide takes the `p_oc_heists` row `FOR UPDATE` **first**, then (if it touches player rows beyond what `applyBalanceChange` locks internally) `tx.locks.player([...])`. `POST /api/oc` is the one exemption — it INSERTs its own heist row under a fresh uuidv7, the same argument as `POST /api/gangs` (STATUS.md). `p_oc_heists`/`p_oc_members` carry **no FKs**, so no OC insert takes an implicit `FOR KEY SHARE` on core rows.
- **A job handler may open exactly one `ctx.transaction`** — a second call self-collides on `plugin_job_runs` (crimes-port finding; the failure is silent success).
- Tests asserting on `game:events` filter by their own `actorId` (`awaitOwnEvent`, `test/helpers/events.ts`, or an inline `actorId` filter as in `crime-worker-idempotency.test.ts`).
- New test files MUST be added to `vitest.workspace.ts` include lists, and `@gl3/plugin-oc` MUST be added to its `srcAliases` — both failure modes are silent (a missing alias grades src edits against stale `dist/`).
- Run targeted tests per task (`npx vitest run --project @gl3/server path/to/file`); full `npm run verify` only in the final task. **Never two suites at once.** Read exit codes, not summaries: `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"`.
- `DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3`, `REDIS_URL=redis://localhost:6379` must be exported.
- Conventional Commits; commit at the end of every task.

---

### Task 1: Package scaffold, migrations, all eight registration sites

**Files:**
- Create: `packages/plugins/oc/package.json`
- Create: `packages/plugins/oc/tsconfig.json`
- Create: `packages/plugins/oc/src/schema.ts`
- Create: `packages/plugins/oc/src/migrations.ts`
- Create: `packages/plugins/oc/src/index.ts` (routeless manifest with migrations)
- Modify: `apps/server/package.json` (add `"@gl3/plugin-oc": "*"` — note `@gl3/plugin-news` is missing there, a recorded pre-existing gap; do NOT repeat it)
- Modify: `apps/server/tsconfig.json` (add reference `../../packages/plugins/oc`)
- Modify: root `tsconfig.json` (add reference `packages/plugins/oc`)
- Modify: `vitest.workspace.ts` (add `@gl3/plugin-oc` to `srcAliases`)
- Modify: `apps/server/src/plugins/core-plugins.ts` (import + append to `CORE_PLUGINS`)
- Modify: `Dockerfile.server` (five COPY lines, mirroring the five `bounties` lines at 64, 98, 99, 147, 169)

**Interfaces:**
- Produces: `@gl3/plugin-oc` importable everywhere; drizzle objects exported from `schema.ts`: `ocHeists`, `ocMembers` (own tables), `players`, `playerStats` (core mirrors); `OC_MIGRATIONS` from `migrations.ts`; default-export manifest `{ id: "oc", basePaths: ["/api/oc"], migrations: OC_MIGRATIONS }`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull && git checkout -b feat/organized-crime
```

- [ ] **Step 2: Package scaffold**

`packages/plugins/oc/package.json` (copy the exact dependency version specifiers from `packages/plugins/bounties/package.json` — do not guess):

```json
{
  "name": "@gl3/plugin-oc",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": { "@gl3/plugin-sdk": "*", "drizzle-orm": "^0.45.2", "uuidv7": "^1.0.2", "zod": "^3.23.8" }
}
```

`packages/plugins/oc/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../plugin-sdk" }]
}
```

- [ ] **Step 3: Schema — own tables plus core mirrors**

`packages/plugins/oc/src/schema.ts`:

```ts
import { bigint, boolean, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Own tables — created by this plugin's migrations (Task 1), NO foreign
 * keys: an FK is a lock (CLAUDE.md rule 6), and OC must add no implicit
 * FOR KEY SHARE edges against players/player_stats/locations. Same
 * decision `p_inventory_shop_stock` recorded (item-economy design §4.1).
 */
export const ocHeists = pgTable("p_oc_heists", {
  id: uuid("id").primaryKey(),
  leaderId: uuid("leader_id").notNull(),
  locationId: uuid("location_id").notNull(),
  status: text("status").notNull(), // open | executing | done | failed | cancelled
  buyIn: bigint("buy_in", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
});

export const ocMembers = pgTable(
  "p_oc_members",
  {
    heistId: uuid("heist_id").notNull(),
    playerId: uuid("player_id").notNull(),
    role: text("role").notNull(), // mastermind | driver | gunman | hacker
    state: text("state").notNull(), // invited | accepted
    released: boolean("released").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.heistId, t.playerId] })],
);

/**
 * Read-only mirrors of core-owned tables — the pattern
 * `packages/plugins/bounties/src/schema.ts` documents. Core owns and
 * migrates both; only touched columns listed.
 */
export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});

export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey(),
  locationId: uuid("location_id"),
  jailedUntil: timestamp("jailed_until", { withTimezone: true }),
  hospitalUntil: timestamp("hospital_until", { withTimezone: true }),
});
```

- [ ] **Step 4: Migrations — one statement per entry**

`packages/plugins/oc/src/migrations.ts`. Three entries, not one: `runPluginMigrations` issues exactly one `tx.execute(sql.raw(...))` per declared migration and postgres.js rejects multi-statement strings (the constraint `packages/plugins/inventory/src/migrations.ts` documents at length — read its header comment before editing this file).

```ts
export const OC_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_heists",
    sql: `CREATE TABLE p_oc_heists (
      id          uuid        PRIMARY KEY,
      leader_id   uuid        NOT NULL,
      location_id uuid        NOT NULL,
      status      text        NOT NULL,
      buy_in      bigint      NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      executed_at timestamptz
    )`,
  },
  {
    name: "0002_members",
    sql: `CREATE TABLE p_oc_members (
      heist_id  uuid    NOT NULL,
      player_id uuid    NOT NULL,
      role      text    NOT NULL,
      state     text    NOT NULL,
      released  boolean NOT NULL DEFAULT false,
      PRIMARY KEY (heist_id, player_id)
    )`,
  },
  {
    // One active heist per player is a DB constraint, not a check-then-act
    // (spec §2). Binds on ACCEPTED rows only — multiple pending invites are
    // fine. The accept/create routes catch 23505 on THIS constraint name.
    name: "0003_active_member_idx",
    sql: `CREATE UNIQUE INDEX p_oc_members_active_player
      ON p_oc_members (player_id)
      WHERE NOT released AND state = 'accepted'`,
  },
];
```

- [ ] **Step 5: Routeless manifest**

`packages/plugins/oc/src/index.ts`:

```ts
import { definePlugin } from "@gl3/plugin-sdk";
import { OC_MIGRATIONS } from "./migrations.js";

export default definePlugin({
  id: "oc",
  version: "1.0.0",
  basePaths: ["/api/oc"],
  routes: [],
  migrations: OC_MIGRATIONS,
  // No menu, pages or events: plugin-manifest-endpoint.test.ts asserts a
  // no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }.
});
```

- [ ] **Step 6: All eight registration sites**

1. `apps/server/package.json` — add `"@gl3/plugin-oc": "*"` to dependencies, then `npm install`.
2. `apps/server/tsconfig.json` — add `{ "path": "../../packages/plugins/oc" }` to references.
3. Root `tsconfig.json` — add `{ "path": "packages/plugins/oc" }` to references.
4. `vitest.workspace.ts` — add to `srcAliases`, matching the existing entries at lines 60-62:

```ts
"@gl3/plugin-oc": fileURLToPath(
  new URL("./packages/plugins/oc/src/index.ts", import.meta.url),
),
```

5. `apps/server/src/plugins/core-plugins.ts` — `import ocPlugin from "@gl3/plugin-oc";` and append `ocPlugin` to `CORE_PLUGINS`.
6. `Dockerfile.server` — five COPY lines. Find each of the five `packages/plugins/bounties` lines (64, 98, 99, 147, 169) and add the `oc` equivalent directly below each.

- [ ] **Step 7: Verify registration**

```bash
grep -c "packages/plugins/oc" Dockerfile.server   # MUST print 5
npx tsc --build --force apps/server/tsconfig.json # the exact command CI's image build runs
npm run typecheck
```

- [ ] **Step 8: Verify the migrations run**

```bash
npx vitest run --project @gl3/server:db apps/server/test/plugin-migrate.test.ts
```

Expected: PASS (the migration runner test boots all core plugins; `oc`'s three migrations run and record in `plugin_migrations`). If that file's project name differs, find it in `vitest.workspace.ts`'s include lists first.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(oc): scaffold plugin package, tables and all eight registration sites"
```

---

### Task 2: Core event variants `oc.updated` and `oc.resolved`

**Files:**
- Modify: `packages/shared/src/events.ts` (two new `GameEventSchema` variants)
- Modify: `apps/server/test/plugin-ctx-core-events.test.ts` (corpus entries, if the corpus enumerates variants — check first)
- Modify: `apps/web/src/lib/eventCopy.ts` (human copy for both)
- Test: existing `packages/shared` + `@gl3/plugin-sdk` projects (the view-schema/drift guards)

**Interfaces:**
- Produces: two `GameEvent` variants reachable from any plugin via `tx.events.publishCore` (no SDK edit needed — `CoreEventInput` is derived from `GameEventSchema`):
  - `{ type: "oc.updated", heistId: string, status: "open"|"executing"|"done"|"failed"|"cancelled" }` + base fields
  - `{ type: "oc.resolved", heistId: string, success: boolean, share: string (Money), jailSeconds: number }` + base fields
- Consumed by: Tasks 3-6 (publish), Task 9 (web invalidation + copy).

- [ ] **Step 1: Add the variants**

In `packages/shared/src/events.ts`, alongside the `bounty.placed` variant at line 40:

```ts
z.object({ ...base, type: z.literal("oc.updated"), heistId: IdSchema, status: z.enum(["open", "executing", "done", "failed", "cancelled"]) }),
z.object({ ...base, type: z.literal("oc.resolved"), heistId: IdSchema, success: z.boolean(), share: MoneySchema, jailSeconds: z.number().int().nonnegative() }),
```

(Match the file's actual `base`/`IdSchema`/`MoneySchema` local names — read the file, follow the `bounty.placed` line's shape exactly.)

- [ ] **Step 2: Check the drift-guard corpus**

Read `apps/server/test/plugin-ctx-core-events.test.ts`. If its corpus enumerates every variant (the STATUS.md description suggests it covers the set), add one accept entry per new variant, following whatever shape the `bounty.placed` corpus entry has. If the corpus is a sample rather than an enumeration, no edit.

- [ ] **Step 3: Event copy**

In `apps/web/src/lib/eventCopy.ts`, following the file's existing switch/map pattern for `bounty.placed`:

- `oc.updated` → no toast (state-refresh signal only — return whatever the file's "silent" convention is; if every event must produce copy, use `"Heist update."` and note it)
- `oc.resolved` → success: `` `Heist succeeded — your share: $${share}.` ``; failure: `` `Heist failed — you were jailed.` ``

- [ ] **Step 4: Run the guards**

```bash
npx vitest run --project @gl3/shared
npx vitest run --project @gl3/plugin-sdk
npx vitest run --project @gl3/web
```

Expected: PASS. If `plugin-ctx-core-events.test.ts` fails on a variant count, that is the enumeration case from Step 2 — add the entries.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shared): oc.updated and oc.resolved core event variants"
```

---

### Task 3: Create + state routes (`POST /api/oc`, `GET /api/oc`)

**Files:**
- Create: `packages/plugins/oc/src/settings.ts`
- Modify: `packages/plugins/oc/src/index.ts` (create/state routes, shared constants)
- Create: `apps/server/test/oc.test.ts`
- Modify: `vitest.workspace.ts` (add `test/oc.test.ts` to the full-stack project's include list — the one containing `test/bounties.test.ts`)

**Interfaces:**
- Consumes: Task 1 schema exports; Task 2 event variants.
- Produces:
  - `ROLES = ["mastermind", "driver", "gunman", "hacker"] as const`, `LEADER_ROLE = "mastermind"`, `CREW_SIZE = 4` exported from `index.ts` for later tasks in this same file.
  - `readBigintSetting(settings, key, fallback): bigint` and `readNumberSetting(settings, key, fallback): number` from `settings.ts`.
  - `isActiveHeistConflict(err: unknown): boolean` in `index.ts`.
  - `POST /api/oc` `{buyIn: string}` → 201 `{heistId, cash}`; 409 `already_in_heist` / `below_minimum` / `insufficient_funds` / `on_cooldown` (429); 400 `amount_must_be_positive`.
  - `GET /api/oc` → 200 `{heist: {...} | null, invites: [...]}` (shape in Step 3).

- [ ] **Step 1: Write the failing tests**

Append to a new `apps/server/test/oc.test.ts`. Boot shape: copy the top of `apps/server/test/bounties.test.ts` verbatim (its `bootTestServer`/register-players/login helpers), adjusting names. Settings rows: insert into the `settings` table **before** boot (they are read once at boot — combat precedent), keys `oc.buy_in_min`, `oc.cooldown_seconds`.

Test cases (each an `app.inject` against the booted server):

```ts
it("creates a heist: 201, leader escrowed, mastermind slot accepted", async () => {
  const res = await inject("POST", "/api/oc", leaderToken, { buyIn: "5000" });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.heistId).toMatch(/^[0-9a-f-]{36}$/);
  // escrow: exactly one ledger row, reason oc.buyin, amount -5000
  const rows = await db.select().from(transactions)
    .where(and(eq(transactions.playerId, leaderId), eq(transactions.reason, "oc.buyin")));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.amount).toBe(-5000n);
  // GET reflects it
  const state = (await inject("GET", "/api/oc", leaderToken)).json();
  expect(state.heist.status).toBe("open");
  expect(state.heist.members).toEqual([
    expect.objectContaining({ playerId: leaderId, role: "mastermind", state: "accepted" }),
  ]);
});

it("refuses a second active heist with 409 already_in_heist and NO ledger row", async () => {
  await inject("POST", "/api/oc", leaderToken, { buyIn: "5000" });
  const res = await inject("POST", "/api/oc", leaderToken, { buyIn: "5000" });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: "already_in_heist" });
  const rows = await db.select().from(transactions)
    .where(and(eq(transactions.playerId, leaderId), eq(transactions.reason, "oc.buyin")));
  expect(rows).toHaveLength(1); // only the first create's escrow — rollback ate the second's
});

it("refuses buyIn below oc.buy_in_min with 409 below_minimum", async () => { /* buyIn: "1" against min 1000 */ });
it("refuses a non-positive buyIn with 400", async () => { /* buyIn: "0" and buyIn: "-5" */ });
it("refuses insufficient funds with 409 and no ledger row", async () => { /* poor player, buyIn > cash */ });
it("GET /api/oc returns {heist: null, invites: []} for an uninvolved player", async () => { /* ... */ });
```

- [ ] **Step 2: Register the test file and run it — expect FAIL**

Add `"test/oc.test.ts"` to the full-stack project's include list in `vitest.workspace.ts` (the list containing `test/bounties.test.ts`).

```bash
npx vitest run --project @gl3/server apps/server/test/oc.test.ts
```

Expected: FAIL — 404s (routes don't exist).

- [ ] **Step 3: Implement**

`packages/plugins/oc/src/settings.ts`:

```ts
/** Settings are read via ctx.settings.get(key), which resolves DB row `oc.<key>`. */
export interface SettingsReader { get(key: string): string | null; }

export function readBigintSetting(settings: SettingsReader, key: string, fallback: bigint): bigint {
  const raw = settings.get(key);
  if (raw === null) return fallback;
  return /^\d+$/.test(raw) ? BigInt(raw) : fallback;
}

export function readNumberSetting(settings: SettingsReader, key: string, fallback: number): number {
  const raw = settings.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
```

Defaults as module constants in `index.ts`: `DEFAULT_BUY_IN_MIN = 1000n`, `DEFAULT_SUCCESS_CHANCE = 0.35`, `DEFAULT_PAYOUT_MULTIPLIER = 3n`, `DEFAULT_JAIL_SECONDS = 600`, `DEFAULT_COOLDOWN_SECONDS = 1800`.

Create route, in `index.ts`:

```ts
const CreateBodySchema = z.object({
  buyIn: z.string().regex(/^-?\d+$/, "must be an integer string"),
});

const ROLES = ["mastermind", "driver", "gunman", "hacker"] as const;
const LEADER_ROLE = "mastermind";
const CREW_SIZE = 4;

/** Duck-typed 23505 check narrowed by constraint name (CLAUDE.md's create-gang note). */
function isActiveHeistConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint_name?: string };
  return e.code === "23505" && e.constraint_name === "p_oc_members_active_player";
}

const createRoute = route({
  method: "POST",
  path: "/api/oc",
  accessInJail: false,
  accessInHospital: false,
  body: CreateBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const buyIn = BigInt(body.buyIn);
    if (buyIn <= 0n) throw new PluginError("amount_must_be_positive", 400);
    if (buyIn < readBigintSetting(ctx.settings, "buy_in_min", DEFAULT_BUY_IN_MIN)) {
      throw new PluginError("below_minimum", 409);
    }

    // Cooldown gates JOINING the next heist (create and accept), set by the
    // resolve job post-commit. peek is advisory-read-only by design: the
    // worst race lets a player in a second early, it cannot lock anyone out
    // (the rule-2 shapes to avoid are lost-update/permanent-lockout).
    const cd = await ctx.cooldown.peek("oc", player.id);
    if (cd > 0) {
      throw new PluginError("on_cooldown", 429, { retryAfter: cd }, { "retry-after": String(Math.max(cd, 1)) });
    }

    try {
      return await ctx.transaction(async (tx) => {
        // No heist lock: this INSERTs its own heist row under a fresh
        // uuidv7 — the POST /api/gangs exemption (Global Constraints).
        const [stats] = await tx.db
          .select({ locationId: playerStats.locationId })
          .from(playerStats).where(eq(playerStats.playerId, player.id));
        if (!stats?.locationId) throw new PluginError("no_location", 409);

        let cash: bigint;
        try {
          cash = await tx.economy.applyBalanceChange({
            playerId: player.id, amount: -buyIn, kind: "cash", reason: "oc.buyin",
          });
        } catch (err) {
          if (err instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
          throw err;
        }

        const heistId = uuidv7();
        await tx.db.insert(ocHeists).values({
          id: heistId, leaderId: player.id, locationId: stats.locationId,
          status: "open", buyIn,
        });
        // The partial unique index fires HERE if the player already has an
        // accepted, unreleased row anywhere — rolling back the debit above.
        await tx.db.insert(ocMembers).values({
          heistId, playerId: player.id, role: LEADER_ROLE, state: "accepted",
        });

        await tx.events.publishCore({
          type: "oc.updated", actorId: player.id, actorName: player.username,
          audience: { kind: "player", playerId: player.id },
          heistId, status: "open",
        });

        return { status: 201, body: { heistId, cash: cash.toString() } };
      });
    } catch (err) {
      if (isActiveHeistConflict(err)) throw new PluginError("already_in_heist", 409);
      throw err;
    }
  },
});
```

State route:

```ts
const stateRoute = route({
  method: "GET",
  path: "/api/oc",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // My accepted, unreleased membership (unique by the partial index).
      const [mine] = await tx.db.select().from(ocMembers).where(and(
        eq(ocMembers.playerId, player.id), eq(ocMembers.state, "accepted"), eq(ocMembers.released, false),
      ));

      let heist = null;
      if (mine) {
        const [h] = await tx.db.select().from(ocHeists).where(eq(ocHeists.id, mine.heistId));
        if (h) {
          const members = await tx.db
            .select({
              playerId: ocMembers.playerId, role: ocMembers.role,
              state: ocMembers.state, username: players.username,
            })
            .from(ocMembers)
            .innerJoin(players, eq(players.id, ocMembers.playerId))
            .where(eq(ocMembers.heistId, h.id));
          heist = {
            id: h.id, status: h.status, buyIn: h.buyIn.toString(),
            locationId: h.locationId, leaderId: h.leaderId, members,
          };
        }
      }

      const inviteRows = await tx.db
        .select({
          heistId: ocMembers.heistId, role: ocMembers.role,
          buyIn: ocHeists.buyIn, leaderUsername: players.username,
        })
        .from(ocMembers)
        .innerJoin(ocHeists, eq(ocHeists.id, ocMembers.heistId))
        .innerJoin(players, eq(players.id, ocHeists.leaderId))
        .where(and(
          eq(ocMembers.playerId, player.id), eq(ocMembers.state, "invited"),
          eq(ocMembers.released, false), eq(ocHeists.status, "open"),
        ));

      return {
        status: 200,
        body: {
          heist,
          invites: inviteRows.map((r) => ({
            heistId: r.heistId, role: r.role,
            buyIn: r.buyIn.toString(), leaderUsername: r.leaderUsername,
          })),
        },
      };
    });
  },
});
```

Register both in the manifest's `routes` array. Imports needed: `InsufficientFundsError`, `PluginError`, `route` from `@gl3/plugin-sdk`; `and`, `eq` from `drizzle-orm`; `uuidv7`; `z`.

- [ ] **Step 4: Run — expect PASS**

```bash
npx vitest run --project @gl3/server apps/server/test/oc.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(oc): create and state routes with escrow at creation"
```

---

### Task 4: Invite + decline routes

**Files:**
- Modify: `packages/plugins/oc/src/index.ts`
- Modify (test): `apps/server/test/oc.test.ts`

**Interfaces:**
- Consumes: Task 3's `ROLES`, `LEADER_ROLE`, heist-lock pattern.
- Produces:
  - `lockHeist(tx, heistId)` helper used by every later mutating route: `SELECT * FROM p_oc_heists WHERE id = $ FOR UPDATE`, returns row or null.
  - `POST /api/oc/:heistId/invite` `{targetUsername: string, role: string}` → 201; 403 `not_leader`; 404 `heist_not_found` / `target_not_found`; 409 `heist_not_open` / `invalid_role` / `role_taken` / `already_invited` / `self_invite`.
  - `POST /api/oc/:heistId/decline` → 200; 404 `not_invited`.
- **Deviation from spec §3, recorded here:** the invite body is `{targetUsername, role}` not `{playerId, role}` — the web form takes a username and the bounties place route set the username-resolution precedent (`bounties/src/index.ts:43-47`). Spec §6's form description already says username.
- **Design decision, recorded here:** invite checks the role against **accepted** rows only — two invitees may hold invites for the same seat, first to accept wins (this is what makes Task 7's slot race a real race). `already_invited` guards the same player being invited twice to the same heist (the PK enforces it; the route answers 409 before the PK fires).

- [ ] **Step 1: Write the failing tests**

Append to `oc.test.ts`:

```ts
it("leader invites a player to an open role; invitee is notified and sees the invite", async () => {
  // create heist as leader, then:
  const res = await inject("POST", `/api/oc/${heistId}/invite`, leaderToken,
    { targetUsername: driverName, role: "driver" });
  expect(res.statusCode).toBe(201);
  const notif = await db.select().from(notifications).where(eq(notifications.playerId, driverId));
  expect(notif.some((n) => n.body.includes("heist"))).toBe(true);
  const state = (await inject("GET", "/api/oc", driverToken)).json();
  expect(state.invites).toEqual([expect.objectContaining({ heistId, role: "driver" })]);
});

it("non-leader cannot invite: 403 not_leader", async () => { /* driver invites gunman */ });
it("mastermind role cannot be invited: 409 invalid_role", async () => { /* role: "mastermind" */ });
it("unknown role: 409 invalid_role", async () => { /* role: "getaway-pilot" */ });
it("two invites for one seat are allowed (first-to-accept-wins is Task 7's race)", async () => {
  // invite driverA and driverB both as "driver" — second invite also 201
});
it("inviting the same player twice to one heist: 409 already_invited", async () => { /* ... */ });
it("decline deletes the invited row", async () => {
  const res = await inject("POST", `/api/oc/${heistId}/decline`, driverToken);
  expect(res.statusCode).toBe(200);
  expect((await inject("GET", "/api/oc", driverToken)).json().invites).toEqual([]);
});
it("decline with no invite: 404 not_invited", async () => { /* ... */ });
```

Run: `npx vitest run --project @gl3/server apps/server/test/oc.test.ts` — expect FAIL (404s).

- [ ] **Step 2: Implement**

```ts
const IdSchema = z.string().uuid();
const HeistParamsSchema = z.object({ heistId: IdSchema });
const InviteBodySchema = z.object({
  targetUsername: z.string().min(1).max(30),
  role: z.string().min(1).max(20),
});

/**
 * The plugin's lock-order root (spec §5): the heist row FOR UPDATE, taken
 * FIRST by every transaction that reads slot state to decide. Player locks
 * (tx.locks.player) come after, never before.
 */
async function lockHeist(tx: PluginTx, heistId: string) {
  const [heist] = await tx.db.select().from(ocHeists)
    .where(eq(ocHeists.id, heistId)).for("update");
  return heist ?? null;
}

const inviteRoute = route({
  method: "POST",
  path: "/api/oc/:heistId/invite",
  accessInJail: false,
  accessInHospital: false,
  params: HeistParamsSchema,
  body: InviteBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    if (body.role === LEADER_ROLE || !ROLES.includes(body.role as (typeof ROLES)[number])) {
      throw new PluginError("invalid_role", 409);
    }

    return ctx.transaction(async (tx) => {
      const heist = await lockHeist(tx, params.heistId);
      if (!heist) throw new PluginError("heist_not_found", 404);
      if (heist.leaderId !== player.id) throw new PluginError("not_leader", 403);
      if (heist.status !== "open") throw new PluginError("heist_not_open", 409);

      const [target] = await tx.db.select({ id: players.id }).from(players)
        .where(eq(players.username, body.targetUsername));
      if (!target) throw new PluginError("target_not_found", 404);
      if (target.id === player.id) throw new PluginError("self_invite", 409);

      const existing = await tx.db.select().from(ocMembers)
        .where(and(eq(ocMembers.heistId, heist.id), eq(ocMembers.playerId, target.id)));
      if (existing.length > 0) throw new PluginError("already_invited", 409);

      // Role check against ACCEPTED rows only — overlapping invites for one
      // seat are deliberate (first to accept wins; see Task 7).
      const taken = await tx.db.select().from(ocMembers).where(and(
        eq(ocMembers.heistId, heist.id), eq(ocMembers.role, body.role), eq(ocMembers.state, "accepted"),
      ));
      if (taken.length > 0) throw new PluginError("role_taken", 409);

      await tx.db.insert(ocMembers).values({
        heistId: heist.id, playerId: target.id, role: body.role, state: "invited",
      });
      await tx.notify(target.id,
        `${player.username} invited you to a heist as ${body.role} (buy-in $${heist.buyIn.toString()}).`);

      return { status: 201, body: { invited: true } };
    });
  },
});

const declineRoute = route({
  method: "POST",
  path: "/api/oc/:heistId/decline",
  params: HeistParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // No heist lock: decline reads no slot state to decide — it deletes
      // the caller's own invited row unconditionally (spec §5).
      const deleted = await tx.db.delete(ocMembers).where(and(
        eq(ocMembers.heistId, params.heistId), eq(ocMembers.playerId, player.id),
        eq(ocMembers.state, "invited"),
      )).returning({ playerId: ocMembers.playerId });
      if (deleted.length === 0) throw new PluginError("not_invited", 404);
      return { status: 200, body: { declined: true } };
    });
  },
});
```

Add `PluginTx` to the `@gl3/plugin-sdk` type imports. If drizzle's `.for("update")` is not available on `PluginDbTx`'s select builder, the fallback is `tx.db.execute(sql\`SELECT ... FOR UPDATE\`)` — check how `apps/server/src/economy/ledger.ts` issues its `FOR UPDATE` statements and mirror that mechanism through `tx.db`.

Register both routes.

- [ ] **Step 3: Run — expect PASS, then commit**

```bash
npx vitest run --project @gl3/server apps/server/test/oc.test.ts
git add -A
git commit -m "feat(oc): invite and decline routes"
```

---

### Task 5: Accept + leave + cancel routes

**Files:**
- Modify: `packages/plugins/oc/src/index.ts`
- Modify (test): `apps/server/test/oc.test.ts`

**Interfaces:**
- Consumes: `lockHeist`, `isActiveHeistConflict`, event variants.
- Produces:
  - `POST /api/oc/:heistId/accept` → 200 `{cash}`; 404 `not_invited` / `heist_not_found`; 409 `heist_not_open` / `role_taken` / `already_in_heist` / `insufficient_funds`; 429 `on_cooldown`.
  - `POST /api/oc/:heistId/leave` → 200 `{cash}` (refund); 403 `leader_cannot_leave`; 404 `not_member`; 409 `heist_not_open`.
  - `POST /api/oc/:heistId/cancel` → 200; 403 `not_leader`; 404 `heist_not_found`; 409 `heist_not_open`. Refunds every accepted member including the leader, sets `cancelled`, releases all rows.
  - `publishHeistUpdate(tx, actor, heist, memberIds)` helper: one `oc.updated` per member (audience `player` — `AudienceSchema` has no multi-player kind, the bounties-claim reasoning).

- [ ] **Step 1: Write the failing tests**

```ts
it("accept escrows the buy-in and fills the slot", async () => {
  const res = await inject("POST", `/api/oc/${heistId}/accept`, driverToken);
  expect(res.statusCode).toBe(200);
  const rows = await db.select().from(transactions)
    .where(and(eq(transactions.playerId, driverId), eq(transactions.reason, "oc.buyin")));
  expect(rows).toHaveLength(1);
  const state = (await inject("GET", "/api/oc", driverToken)).json();
  expect(state.heist.members).toContainEqual(
    expect.objectContaining({ playerId: driverId, role: "driver", state: "accepted" }));
});

it("accept clears the player's other pending invites (gang-invite precedent)", async () => {
  // invite driver to TWO heists, accept one, assert the other invite row is gone
});
it("accept while already in another heist: 409 already_in_heist, no second buyin row", async () => { /* ... */ });
it("accept with insufficient funds: 409, invite row still invited, no ledger row", async () => { /* ... */ });
it("leave refunds and frees the slot", async () => {
  const res = await inject("POST", `/api/oc/${heistId}/leave`, driverToken);
  expect(res.statusCode).toBe(200);
  const refunds = await db.select().from(transactions)
    .where(and(eq(transactions.playerId, driverId), eq(transactions.reason, "oc.refund")));
  expect(refunds).toHaveLength(1);
});
it("leader cannot leave: 403 leader_cannot_leave", async () => { /* ... */ });
it("cancel refunds every accepted member and releases all rows", async () => {
  // leader + driver accepted, gunman invited; cancel as leader:
  // - leader and driver each have one oc.refund row, gunman has none
  // - heist status cancelled; all member rows released
  // - driver can now create their own heist (the partial index no longer binds)
});
it("non-leader cannot cancel: 403 not_leader", async () => { /* ... */ });
```

Run — expect FAIL.

- [ ] **Step 2: Implement**

```ts
async function publishHeistUpdate(
  tx: PluginTx,
  actor: { id: string; username: string },
  heistId: string,
  status: "open" | "executing" | "done" | "failed" | "cancelled",
  memberIds: string[],
): Promise<void> {
  for (const playerId of memberIds) {
    await tx.events.publishCore({
      type: "oc.updated", actorId: actor.id, actorName: actor.username,
      audience: { kind: "player", playerId }, heistId, status,
    });
  }
}

const acceptRoute = route({
  method: "POST",
  path: "/api/oc/:heistId/accept",
  accessInJail: false,
  accessInHospital: false,
  params: HeistParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const cd = await ctx.cooldown.peek("oc", player.id);
    if (cd > 0) {
      throw new PluginError("on_cooldown", 429, { retryAfter: cd }, { "retry-after": String(Math.max(cd, 1)) });
    }

    try {
      return await ctx.transaction(async (tx) => {
        const heist = await lockHeist(tx, params.heistId);          // heist FIRST
        if (!heist) throw new PluginError("heist_not_found", 404);
        if (heist.status !== "open") throw new PluginError("heist_not_open", 409);

        const [invite] = await tx.db.select().from(ocMembers).where(and(
          eq(ocMembers.heistId, heist.id), eq(ocMembers.playerId, player.id),
          eq(ocMembers.state, "invited"),
        ));
        if (!invite) throw new PluginError("not_invited", 404);

        // Under the heist lock: is the seat still free among ACCEPTED rows?
        const taken = await tx.db.select().from(ocMembers).where(and(
          eq(ocMembers.heistId, heist.id), eq(ocMembers.role, invite.role),
          eq(ocMembers.state, "accepted"),
        ));
        if (taken.length > 0) throw new PluginError("role_taken", 409);

        let cash: bigint;
        try {
          cash = await tx.economy.applyBalanceChange({
            playerId: player.id, amount: -heist.buyIn, kind: "cash", reason: "oc.buyin",
          });
        } catch (err) {
          if (err instanceof InsufficientFundsError) throw new PluginError("insufficient_funds", 409);
          throw err;
        }

        // Flipping to accepted is what arms the partial unique index.
        await tx.db.update(ocMembers).set({ state: "accepted" }).where(and(
          eq(ocMembers.heistId, heist.id), eq(ocMembers.playerId, player.id),
        ));
        // Accepting clears the player's other pending invites (gang precedent).
        await tx.db.delete(ocMembers).where(and(
          eq(ocMembers.playerId, player.id), eq(ocMembers.state, "invited"),
        ));

        const memberIds = (await tx.db.select({ playerId: ocMembers.playerId }).from(ocMembers)
          .where(and(eq(ocMembers.heistId, heist.id), eq(ocMembers.state, "accepted"))))
          .map((r) => r.playerId);
        await publishHeistUpdate(tx, player, heist.id, "open", memberIds);

        return { status: 200, body: { cash: cash.toString() } };
      });
    } catch (err) {
      if (isActiveHeistConflict(err)) throw new PluginError("already_in_heist", 409);
      throw err;
    }
  },
});
```

`leave`: same shape — `lockHeist` first, 409 unless `open`, find the caller's `accepted` row, 403 `leader_cannot_leave` if `heist.leaderId === player.id`, 404 `not_member` if absent, credit `heist.buyIn` with reason `"oc.refund"`, DELETE the row, `publishHeistUpdate` to remaining accepted members, return `{cash}`.

`cancel`: `lockHeist` first, 403 `not_leader` unless leader, 409 unless `open`; select all `accepted` rows; loop credits (`applyBalanceChange`, `+heist.buyIn`, `"oc.refund"`) — one per accepted member including the leader; `UPDATE p_oc_members SET released = true WHERE heist_id = $`; `UPDATE p_oc_heists SET status = 'cancelled'`; `publishHeistUpdate(..., "cancelled", acceptedIds)`; return `{cancelled: true}`.

Note on lock order in cancel/leave: `applyBalanceChange` locks each player's own stats row internally, *after* the heist lock — heist→player, the declared order. No explicit `tx.locks.player` needed here because no route-level read of `player_stats` happens; the execute route (Task 6) is where the explicit multi-player lock appears.

Register all three routes.

- [ ] **Step 3: Run — expect PASS, then commit**

```bash
npx vitest run --project @gl3/server apps/server/test/oc.test.ts
git add -A
git commit -m "feat(oc): accept, leave and cancel with escrow and refunds"
```

---

### Task 6: Execute route + resolve job

**Files:**
- Modify: `packages/plugins/oc/src/index.ts` (execute route, `resolveJob`, manifest `jobs`)
- Create: `apps/server/test/oc-worker.test.ts`
- Modify (test): `apps/server/test/oc.test.ts` (execute-route contract cases)
- Modify: `vitest.workspace.ts` (include `test/oc-worker.test.ts` in the same project as `test/crime-worker-idempotency.test.ts`)

**Interfaces:**
- Consumes: everything above; `runPluginJob` from `apps/server/src/plugins/jobs.js` (test-side, the `crime-worker-idempotency.test.ts` harness).
- Produces:
  - `POST /api/oc/:heistId/execute` → 202 `{jobId}`; 403 `not_leader`; 404 `heist_not_found`; 409 `heist_not_open` (status terminal) / `crew_incomplete` / `crew_not_assembled` (body lists `absent: [username]`).
  - `resolveJob(ctx, data)` handler registered as `jobs: { resolve: resolveJob }`; job data `{heistId: string}`.
- **Decision, recorded here:** execute is allowed when status is `open` **or** `executing`. Re-firing while `executing` is the crash-recovery path (commit succeeded, enqueue failed/crashed): the second job serializes on the heist `FOR UPDATE` and no-ops if the first already resolved. This replaces the spec §4's implicit stuck-forever window; STATUS should record it (Task 10).
- **`plugin_job_runs` PK watch item does not bite:** this plugin declares exactly one job (`resolve`), so the `(plugin_id, job_id)` key collision between two queues of one plugin (STATUS.md open item) is not reachable here. Do not declare a second job.

- [ ] **Step 1: Write the failing route tests** (append to `oc.test.ts`)

```ts
it("execute with a full, co-located crew: 202 with a jobId; status becomes executing", async () => { /* ... */ });
it("execute with an unfilled slot: 409 crew_incomplete", async () => { /* 3 of 4 accepted */ });
it("execute with a member elsewhere: 409 crew_not_assembled naming them", async () => {
  // move gunman to another location by direct playerStats UPDATE (no travel
  // fare/cooldown noise), then:
  const res = await inject("POST", `/api/oc/${heistId}/execute`, leaderToken);
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: "crew_not_assembled", absent: [gunmanName] });
});
it("non-leader cannot execute: 403", async () => { /* ... */ });
```

- [ ] **Step 2: Write the failing worker tests** (`apps/server/test/oc-worker.test.ts`)

Harness: copy `apps/server/test/crime-worker-idempotency.test.ts`'s structure — direct `runPluginJob(deps, ocPlugin, "resolve", job)` calls against `testDb()`, no HTTP boot. `deps.settings` carries the chance: `{ "oc.success_chance": "1" }` forces success, `"0"` forces failure (the `playerCrimeSkill chance: "100.00"` trick, adapted). Seed fixture: insert heist row (`status: "executing"`), four member rows (`accepted`), four players + stats co-located, and give each player a starting cash balance **through the ledger** (use whatever helper `oc.test.ts`'s fixture uses — balances not created via `applyBalanceChange` would fail the sum check in Task 8).

```ts
it("success: pot × multiplier split equally, remainder to the leader", async () => {
  // buyIn 1000, multiplier 3 (default): pot 4000, payout 12000, share 3000 each.
  // Then a remainder case: buyIn 999 → pot 3996 × 3 = 11988; 11988 / 4 = 2997 exactly —
  // so use multiplier setting "3" with buyIn "1001": pot 4004 ×3 = 12012, /4 = 3003 exact.
  // Force a true remainder with a 3-vs-4 divisible pot: buyIn such that total % 4 !== 0
  // is impossible while pot = buyIn*4 — pot×mult is always divisible by 4 when mult is
  // an integer. ASSERT that and simplify: with integer multipliers the remainder is
  // provably 0; keep the leader-remainder line in code (bigint division is truncating
  // and a future fractional-multiplier setting would silently burn money without it)
  // and assert shares are EQUAL here.
  await runPluginJob(deps({ "oc.success_chance": "1" }), ocPlugin, "resolve",
    { id: "oc-job-1", data: { heistId, seed: "fixed-seed-success" } });
  // each member: one oc.payout ledger row of +3000; status done; rows released
});

it("failure: no payout rows, all four jailed, status failed", async () => {
  await runPluginJob(deps({ "oc.success_chance": "0" }), ocPlugin, "resolve",
    { id: "oc-job-2", data: { heistId, seed: "fixed-seed-fail" } });
  // per member: zero oc.payout rows; playerStats.jailedUntil in the future;
  // heist.status === "failed"; all member rows released
});

it("a BullMQ retry applies nothing twice (plugin_job_runs)", async () => {
  const job = { id: "oc-retry-1", data: { heistId, seed: "s" } };
  await runPluginJob(deps({ "oc.success_chance": "1" }), ocPlugin, "resolve", job);
  await runPluginJob(deps({ "oc.success_chance": "1" }), ocPlugin, "resolve", job); // swallowed
  // exactly ONE oc.payout row per member, not two
});

it("a stale job against a resolved heist no-ops", async () => {
  // set status "done" by hand, run the job with a FRESH id — no ledger rows, no jail
});

it("resolve sets the per-member oc cooldown", async () => {
  await runPluginJob(deps({ "oc.success_chance": "1" }), ocPlugin, "resolve",
    { id: "oc-cd-1", data: { heistId, seed: "s" } });
  for (const id of memberIds) {
    expect(await redis.ttl(`cooldown:oc:${id}`)).toBeGreaterThan(0); // match the actual key shape ctx.cooldown uses — read apps/server/src/plugins/ctx.ts first
  }
});
```

Register the file in `vitest.workspace.ts` (same project include list as `crime-worker-idempotency.test.ts`). Run both files — expect FAIL.

- [ ] **Step 3: Implement the execute route**

```ts
const executeRoute = route({
  method: "POST",
  path: "/api/oc/:heistId/execute",
  accessInJail: false,
  accessInHospital: false,
  params: HeistParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    await ctx.transaction(async (tx) => {
      const heist = await lockHeist(tx, params.heistId);            // heist FIRST
      if (!heist) throw new PluginError("heist_not_found", 404);
      if (heist.leaderId !== player.id) throw new PluginError("not_leader", 403);
      // "executing" is allowed: re-fire after a commit-then-crash (Interfaces note).
      if (heist.status !== "open" && heist.status !== "executing") {
        throw new PluginError("heist_not_open", 409);
      }

      const members = await tx.db.select().from(ocMembers).where(and(
        eq(ocMembers.heistId, heist.id), eq(ocMembers.state, "accepted"),
      ));
      if (members.length !== CREW_SIZE) throw new PluginError("crew_incomplete", 409);

      // players SECOND — the declared heist→player order (spec §5).
      const memberIds = members.map((m) => m.playerId);
      await tx.locks.player(memberIds);

      const stats = await tx.db
        .select({
          playerId: playerStats.playerId, locationId: playerStats.locationId,
          jailedUntil: playerStats.jailedUntil, hospitalUntil: playerStats.hospitalUntil,
          username: players.username,
        })
        .from(playerStats)
        .innerJoin(players, eq(players.id, playerStats.playerId))
        .where(inArray(playerStats.playerId, memberIds));

      const now = new Date();
      const absent = stats
        .filter((s) =>
          s.locationId !== heist.locationId ||
          (s.jailedUntil !== null && s.jailedUntil > now) ||
          (s.hospitalUntil !== null && s.hospitalUntil > now))
        .map((s) => s.username);
      if (absent.length > 0) {
        throw new PluginError("crew_not_assembled", 409, { absent });
      }

      await tx.db.update(ocHeists).set({ status: "executing" }).where(eq(ocHeists.id, heist.id));
      await publishHeistUpdate(tx, player, heist.id, "executing", memberIds);
    });

    // Enqueue AFTER commit — a job that ran before commit would read status
    // "open" and no-op, stranding the heist. On enqueue failure, compensate
    // by reverting to open (the crimes cooldown-release shape); the re-fire
    // rule above covers the crash-between-commit-and-enqueue window.
    try {
      const jobId = await ctx.jobs.enqueue("resolve", { heistId: params.heistId });
      return { status: 202, body: { jobId } };
    } catch (error) {
      try {
        await ctx.transaction(async (tx) => {
          await tx.db.update(ocHeists).set({ status: "open" })
            .where(and(eq(ocHeists.id, params.heistId), eq(ocHeists.status, "executing")));
        });
      } catch (revertError) {
        ctx.log.error("failed to revert heist to open after enqueue failure",
          { err: String(revertError), heistId: params.heistId });
      }
      throw error;
    }
  },
});
```

Add `inArray` to the drizzle imports.

- [ ] **Step 4: Implement the resolve job**

```ts
async function resolveJob(ctx: PluginCtx, data: Record<string, unknown>): Promise<void> {
  const heistId = String(data["heistId"]);
  const rng = ctx.job?.rng;
  if (rng === undefined) throw new Error("resolve job ran without a seeded rng");

  const successChance = readNumberSetting(ctx.settings, "success_chance", DEFAULT_SUCCESS_CHANCE);
  const multiplier = readBigintSetting(ctx.settings, "payout_multiplier", DEFAULT_PAYOUT_MULTIPLIER);
  const jailSeconds = Math.trunc(readNumberSetting(ctx.settings, "jail_seconds", DEFAULT_JAIL_SECONDS));
  const cooldownSeconds = Math.trunc(readNumberSetting(ctx.settings, "cooldown_seconds", DEFAULT_COOLDOWN_SECONDS));

  let cooldownIds: string[] = [];

  // ONE ctx.transaction — a second self-collides on plugin_job_runs
  // (Global Constraints; the crimes-port finding).
  await ctx.transaction(async (tx) => {
    const heist = await lockHeist(tx, heistId);                     // heist FIRST
    if (!heist || heist.status !== "executing") return;             // stale job: no-op

    const members = await tx.db.select().from(ocMembers).where(and(
      eq(ocMembers.heistId, heist.id), eq(ocMembers.state, "accepted"),
    ));
    if (members.length !== CREW_SIZE) return;                       // defensive; execute proved it

    const memberIds = members.map((m) => m.playerId);
    await tx.locks.player(memberIds);                               // players SECOND

    const namedRows = await tx.db.select({ id: players.id, username: players.username })
      .from(players).where(inArray(players.id, memberIds));
    const nameById = new Map(namedRows.map((r) => [r.id, r.username]));
    const leaderName = nameById.get(heist.leaderId) ?? "unknown";

    // One shared roll (spec §4): same scale as crimes' (routes 0..10000).
    const roll = rng.int(0, 10_000);
    const success = roll < Math.round(successChance * 10_000);

    if (success) {
      const pot = heist.buyIn * BigInt(CREW_SIZE);
      const total = pot * multiplier;
      const share = total / BigInt(CREW_SIZE);
      const remainder = total - share * BigInt(CREW_SIZE); // 0 for integer multipliers; kept so a future fractional setting cannot silently burn money (bigint division truncates)
      for (const m of members) {
        const amount = m.playerId === heist.leaderId ? share + remainder : share;
        await tx.economy.applyBalanceChange({
          playerId: m.playerId, amount, kind: "cash", reason: "oc.payout", refId: heist.id,
        });
      }
    } else {
      for (const m of members) {
        await tx.jail.sendToJail(m.playerId, jailSeconds);
      }
    }

    const status = success ? "done" : "failed";
    await tx.db.update(ocHeists)
      .set({ status, executedAt: new Date() })
      .where(eq(ocHeists.id, heist.id));
    await tx.db.update(ocMembers).set({ released: true }).where(eq(ocMembers.heistId, heist.id));

    const share = success ? (heist.buyIn * BigInt(CREW_SIZE) * multiplier) / BigInt(CREW_SIZE) : 0n;
    for (const m of members) {
      await tx.events.publishCore({
        type: "oc.resolved",
        actorId: heist.leaderId, actorName: leaderName,
        audience: { kind: "player", playerId: m.playerId },
        heistId: heist.id, success,
        share: share.toString(),
        jailSeconds: success ? 0 : jailSeconds,
      });
    }

    cooldownIds = memberIds;
  });

  // Post-commit, best-effort: SET NX EX per member (rule 2 — atomic, no
  // check-then-act). A crash here loses at most some cooldowns — a
  // convenience guard, never money (spec §4; the bounties-sweep class).
  for (const id of cooldownIds) {
    await ctx.cooldown.acquire("oc", id, cooldownSeconds);
  }
}
```

Manifest gains `jobs: { resolve: resolveJob }`. Add `PluginCtx` to the type imports.

- [ ] **Step 5: Run both files — expect PASS**

```bash
npx vitest run --project @gl3/server apps/server/test/oc.test.ts
npx vitest run --project @gl3/server apps/server/test/oc-worker.test.ts
```

(Adjust `--project` per each file's actual workspace project.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(oc): execute route and seeded resolve job with shared fate"
```

---

### Task 7: Concurrency + lock-order regression tests (red first)

**Files:**
- Create: `apps/server/test/oc-concurrency.test.ts`
- Create: `apps/server/test/oc-lock-order.test.ts`
- Modify: `vitest.workspace.ts` (both files, same project as `test/combat-concurrency.test.ts` / `test/combat-lock-order.test.ts`)

**Interfaces:**
- Consumes: all routes and the job from Tasks 3-6; `bootTestServer`.
- Produces: regression coverage only.

**Every test in this task must be demonstrated red before it is accepted** — a concurrency test that has never failed proves nothing (CLAUDE.md working method; the corollary under rule 6).

- [ ] **Step 1: Slot race**

Two invitees for one seat (Task 4's overlapping-invite design), both accept concurrently:

```ts
it("two accepts race one seat: exactly one 200, one 409 role_taken, one accepted row", async () => {
  // heist with driverA and driverB both invited as "driver"
  const [a, b] = await Promise.all([
    inject("POST", `/api/oc/${heistId}/accept`, tokenA),
    inject("POST", `/api/oc/${heistId}/accept`, tokenB),
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  expect(codes).toEqual([200, 409]);
  const accepted = await db.select().from(ocMembers).where(and(
    eq(ocMembers.heistId, heistId), eq(ocMembers.role, "driver"), eq(ocMembers.state, "accepted")));
  expect(accepted).toHaveLength(1);
  // the loser has NO oc.buyin ledger row (their debit rolled back with role_taken)
});
```

**Red demonstration:** comment out `lockHeist` in the accept route (replace with a plain un-locked select), rerun ~20 iterations — both accepts succeed at least once (two accepted rows for one seat). Restore, rerun 20 iterations green. Record the red output in the task summary.

- [ ] **Step 2: Execute-vs-leave race**

```ts
it("execute racing leave: never both a payout-eligible crew and a refund", async () => {
  const [ex, lv] = await Promise.all([
    inject("POST", `/api/oc/${heistId}/execute`, leaderToken),
    inject("POST", `/api/oc/${heistId}/leave`, driverToken),
  ]);
  // Legal outcomes, serialized by the heist lock:
  //   execute wins: ex 202, lv 409 heist_not_open — driver is IN the heist, no refund row
  //   leave wins:   lv 200, ex 409 crew_incomplete — driver refunded, nothing enqueued
  const executed = ex.statusCode === 202;
  const left = lv.statusCode === 200;
  expect(executed !== left).toBe(true); // exactly one wins
  const refunds = await db.select().from(transactions)
    .where(and(eq(transactions.playerId, driverId), eq(transactions.reason, "oc.refund")));
  expect(refunds).toHaveLength(left ? 1 : 0);
});
```

Run it in a loop (`for i in $(seq 20); do npx vitest run ... || break; done`) — both interleavings must be observed across runs (log which won).

- [ ] **Step 3: Lock-order regression (`oc-lock-order.test.ts`)**

Construction: follow `apps/server/test/combat-lock-order.test.ts`'s barrier pattern — read that file's header comment first and mirror its mechanism. The forced interleaving: transaction A is the real **execute** path (heist FOR UPDATE → players ascending); transaction B is the real **leave** path for a member (heist FOR UPDATE → that member's stats row via `applyBalanceChange`). Both are heist-first, so under the shipped code they serialize — assert both complete, no `40P01`.

**Red demonstration:** invert `leave` to lock the player row before the heist row (temporarily insert `await tx.locks.player([player.id])` above `lockHeist` and move the refund before it), run the barrier test — a real `40P01` must appear (check `/var/log/postgresql/postgresql-16-main.log`), surfacing as an HTTP 500. Restore the shipped order, test green. If the barrier cannot force the window with the real routes (the travel-lock-order problem), fall back to that file's raw-SQL-adversary construction and document why at the top of the test file, as `travel-lock-order.test.ts` does.

- [ ] **Step 4: Register both files, run, commit**

```bash
npx vitest run --project @gl3/server apps/server/test/oc-concurrency.test.ts apps/server/test/oc-lock-order.test.ts
git add -A
git commit -m "test(oc): slot-race, execute-vs-leave and heist-first lock-order regressions"
```

---

### Task 8: Ledger reconciliation

**Files:**
- Create: `apps/server/test/oc-ledger.test.ts`
- Modify: `vitest.workspace.ts` (same project as `test/hospital.test.ts`)

**Interfaces:**
- Consumes: full flow from Tasks 3-6.
- Produces: the `sum(ledger) == balance` proof for every member, both outcomes.

This is a **dedicated file, hospital-style**: the resolve job is async and `economy-invariant.test.ts`'s synchronous `callPluginRoute` sweep cannot drive it — state that in the file's header comment, exactly as `hospital.test.ts` is described doing (STATUS.md, PvP section). Do NOT edit `economy-invariant.test.ts`.

- [ ] **Step 1: Write the test**

Full flow per outcome via `app.inject` + `runPluginJob` for the resolve step (deterministic seed, chance forced via settings rows inserted before boot — `oc.success_chance` = `1` for the success case's boot, a second boot or settings override for `0`; if one boot must serve both, drive resolve through `runPluginJob` with per-call `deps.settings`, which `crime-worker-idempotency.test.ts` proves works):

```ts
async function assertReconciled(playerId: string) {
  const [stat] = await db.select({ cash: playerStats.cash }).from(playerStats)
    .where(eq(playerStats.playerId, playerId));
  const rows = await db.select({ amount: transactions.amount }).from(transactions)
    .where(and(eq(transactions.playerId, playerId), eq(transactions.kind, "cash")));
  const sum = rows.reduce((s, r) => s + r.amount, 0n);
  expect(sum).toBe(stat!.cash);
}
// (Match economy-invariant.test.ts's actual reconciliation query — copy its
// column names and any registration-credit handling rather than this sketch.)

it("success outcome: every member reconciles", async () => {
  // create → invite×3 → accept×3 → execute → resolve(chance 1)
  for (const id of memberIds) await assertReconciled(id);
  // and the shape: each member has buyin(-B) and payout(+3B) rows for B×3 multiplier
});

it("failure outcome: every member reconciles (buy-in gone, nothing else)", async () => {
  for (const id of memberIds) await assertReconciled(id);
});

it("cancel outcome: every member reconciles (buyin + refund net zero)", async () => {
  for (const id of memberIds) await assertReconciled(id);
});
```

- [ ] **Step 2: Register, run — expect PASS** (this task's tests are proven by Tasks 3-6's code; if any fails, the bug is in those tasks, fix there)

```bash
npx vitest run --project @gl3/server apps/server/test/oc-ledger.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(oc): sum(ledger) == balance for all members across all outcomes"
```

---

### Task 9: `/oc` web page

**Files:**
- Create: `apps/web/src/pages/OrganizedCrime.tsx`
- Modify: `apps/web/src/App.tsx` (route `oc`)
- Modify: `apps/web/src/components/Shell.tsx` (nav entry `["/oc", "Heists"]`)
- Modify: `apps/web/src/api/queries.ts` (the `GET /api/oc` query + mutations)
- Modify: `apps/web/src/ws/invalidation.ts` (`oc.updated` / `oc.resolved` → invalidate the oc query)
- Modify (test): `apps/web/test/invalidation.test.ts` (entries for both events, following its `bounty.*` cases)

**Interfaces:**
- Consumes: `GET /api/oc` response shape (Task 3), all mutation routes (Tasks 3-6), event variants (Task 2 — `eventCopy` entries already landed there).
- Produces: user-visible page. **Follow the file conventions of `apps/web/src/pages/Bounties.tsx`** — same query/mutation/invalidations/form patterns, money as decimal strings end to end.

- [ ] **Step 1: Queries + invalidation (with failing web test first)**

Add `oc.updated`/`oc.resolved` cases to `apps/web/test/invalidation.test.ts` mirroring its `bounty.placed` case (event in → expect the oc query key invalidated). Run `npx vitest run --project @gl3/web` — FAIL. Then add the query (key `["oc"]`, fetch `GET /api/oc`) and the invalidation mapping. PASS.

- [ ] **Step 2: The page**

`OrganizedCrime.tsx`, driven entirely by the `["oc"]` query:

- **No heist, no invites:** create form — buy-in input (integer string), submit → `POST /api/oc`.
- **Invites present:** invite cards (leader, role, buy-in) with Accept / Decline buttons.
- **In a heist:** slot grid (four roles; filled slots show username + state, empty slots show an invite form — username + role select — leader only). Buttons by viewer: leader sees Execute (enabled only when 4/4 accepted) + Cancel; non-leader member sees Leave. Status line for `executing`.
- **Outcome:** `oc.resolved` arrives over the WS as event copy (Task 2) and the invalidation empties the heist — render last-event banner only if the page's existing event-feed pattern (check how `Bounties.tsx` surfaces `bounty.claimed`) supports it; otherwise the toast copy from `eventCopy.ts` is the outcome surface and this page adds nothing.
- Per-control in-flight disable on every mutation (the established pattern).
- All error bodies surfaced as inline text (`error` code string is enough — match `Bounties.tsx`).

- [ ] **Step 3: Verify + commit**

```bash
npx vitest run --project @gl3/web
npm run typecheck
git add -A
git commit -m "feat(web): heists page with slot grid, invites and execute flow"
```

---

### Task 10: Docs, full verify, wrap-up

**Files:**
- Modify: `docs/STATUS.md` (new "Organized crime" section + suite-count line + watch items)
- Modify: `CLAUDE.md` (current-state paragraph: one sentence recording the plugin)
- Modify: `docs/superpowers/plans/2026-08-12-organized-crime.md` (check off all boxes)

**Interfaces:** none — documentation and verification only.

- [ ] **Step 1: Full verify — exit code, not summary**

```bash
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Any non-zero exit is a failure even if every test passed (the gateway `.catch` lesson). Run it twice back to back; both must be exit=0. **Ensure no agent or other suite is running first.**

- [ ] **Step 2: STATUS.md**

Add an "Organized crime — heists" section after the detectives section, covering: the plugin and its two no-FK tables + partial unique index; the heist-first lock order and why it shares no edge with the existing three; the escrow/refund/payout ledger reasons; the execute-while-executing re-fire decision (crash recovery for the commit-then-crash window); the one-job constraint (why the `plugin_job_runs` PK watch item doesn't bite); test files added. Update the suite-count line with the real numbers from Step 1's log. New watch items to record:

- Overlapping invites for one seat are by design (first to accept wins); a declined loser's invite row lingers until decline/accept-elsewhere.
- The cooldown `peek` gate on create/accept is advisory (documented in code); the SET happens post-commit in the worker and a crash there loses cooldowns, never money.
- `GET /api/oc` returns no resolved-heist history; the outcome surface is the `oc.resolved` event only.

- [ ] **Step 3: CLAUDE.md**

Extend the current-state paragraph with one sentence: organized crime shipped on `feat/organized-crime` (four-role heists, buy-in escrow, shared-fate seeded job; heist-first lock order). Update the suite count.

- [ ] **Step 4: Commit and hand off**

```bash
git add -A
git commit -m "docs: record the organized-crime plugin in STATUS and CLAUDE"
```

Then merge per the repo's finishing flow (superpowers:finishing-a-development-branch).

---

## Self-review notes (resolved during planning)

- **Spec §3 invite body deviation** (`targetUsername` for `playerId`) — recorded in Task 4's Interfaces block with rationale.
- **Spec §4 remainder-to-leader:** with `pot = buyIn × 4` and an integer multiplier, `total` is always divisible by 4, so the remainder is provably 0n today. The leader-remainder line ships anyway (guards a future fractional multiplier against silently burning money) and Task 6's test asserts equal shares.
- **Spec §4 stuck-executing window:** closed by allowing execute on `executing` (re-fire), serialized by the heist lock and the worker's status check. Recorded in Task 6 and STATUS (Task 10).
- **Spec §7's `oc-concurrency` "never both payout and refund"** is expressed as the execute-vs-leave test's refund assertion — the payout half is implied by `crew_incomplete` blocking the enqueue when leave wins.
- **`accessInJail`/`accessInHospital` defaults:** STATUS says no plugin *before crimes* set `accessInJail: false`, implying the default is permissive — so every mutating OC route sets both flags to `false` explicitly; `GET /api/oc` stays readable from jail/hospital.
