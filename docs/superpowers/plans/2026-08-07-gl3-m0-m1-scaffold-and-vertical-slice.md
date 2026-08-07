# GL3 M0 + M1 — Scaffold and Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the GL3 monorepo and ship one playable end-to-end action — a logged-in player commits a crime and every connected client sees the result live.

**Architecture:** npm-workspaces monorepo (`apps/server`, `apps/web`, `packages/shared`). Fastify 5 HTTP API validates a request, acquires an atomic Redis cooldown, and enqueues a BullMQ job carrying a pre-generated random seed. A worker resolves the outcome inside a single Postgres transaction (balance update + append-only ledger insert), then publishes a zod-validated event to the Redis pub/sub channel `game:events`. A WS gateway subscribed to that channel fans events out to authenticated sockets, and the React client renders a live feed. Randomness lives only in the worker so job retries cannot re-roll.

**Tech Stack:** Node 22 LTS (ESM) · TypeScript strict · Fastify 5 · `ws` · Drizzle ORM + `postgres` driver · PostgreSQL 16 · Redis 7 · BullMQ · zod · argon2 · React 18 + Vite · vitest · Docker Compose.

## Global Constraints

These apply to **every** task in this plan. Do not restate them per task; do not violate them.

- **Stack is fixed. Do not substitute.** Node.js 22 LTS, TypeScript (strict), React 18 + Vite, PostgreSQL 16, Redis 7 (BullMQ + pub/sub), WebSockets.
- **TypeScript strict everywhere.** `"strict": true`. **No `any` in `packages/*`** — none, not even a cast. In `apps/*` prefer `unknown` + a zod parse over `any`.
- **ESM only.** `"type": "module"` in every package.json. Relative imports inside `apps/server` carry a `.js` extension (TS ESM emit requirement).
- **Zod-validate every external boundary:** HTTP request body, HTTP query, WS frame, Redis bus message, and (later) plugin manifest. A boundary without a `.parse()` is a bug.
- **All money and exp are `bigint`** in Postgres and `bigint` in TypeScript. **No floating point anywhere in the economy.** V2 capped at signed 32-bit and real games hit that ceiling; GL3 must not.
- **Every cash/bank/points mutation is an append-only `transactions` ledger insert + a balance update in ONE Postgres transaction.** Never update a balance without a matching ledger row.
- **Any job mutating two players locks rows with `SELECT … FOR UPDATE` in consistent id order** (ascending UUID) to prevent deadlocks and double-spends.
- **Random outcomes use `node:crypto` `randomInt`, never `Math.random`,** and are resolved **in workers only**. The job payload carries a seed generated at enqueue time.
- **PKs are UUIDv7.** Naming is snake_case in Postgres, camelCase in TypeScript. Real FKs with explicit `ON DELETE` rules. `timestamptz` for all times. Index every FK and every leaderboard/sort column.
- **No secrets in the repo.** `.env.example` documents `DATABASE_URL`, `REDIS_URL`, `PORT`, `SESSION_TTL`.
- **Auth endpoints are rate-limited** with a Redis token bucket. CSRF is not needed (bearer tokens); CORS must be strict (explicit origin allowlist, no `*`).
- **Integration tests run against real Postgres + Redis** via docker-compose. **No mocks for DB or queue paths.** Unit tests may mock nothing but pure helpers.
- **Frequent commits.** Every task ends with a commit. Commit messages are Conventional Commits (`feat:`, `test:`, `chore:`, `fix:`).
- **Scope discipline.** M1's slice must be playable before anything from M2 (jail, ranks, bank, travel, leaderboards) is started. Do not implement forum, casino, membership, or migration here.

## Known SPEC gaps (do not fill by guessing)

SPEC.md §3, §4.1, and §4.2/§4.3 are all intact as of the 2026-08-07 04:01 revision and are quoted verbatim wherever this plan depends on them.

**§6 is currently corrupted** — the M0, M1, and M2 milestone bullets have collided into one truncated line. The text this plan relies on was read from an earlier intact revision and is reproduced verbatim at each milestone heading below:

- **M0 Scaffold.** Monorepo, docker-compose, CI (typecheck + test), drizzle migrations apply clean. ✔ `npm run verify` green on fresh clone.
- **M1 Auth + vertical slice.** Register/login (argon2id), sessions, commit-crime slice end-to-end: HTTP → Redis cooldown → BullMQ → Postgres tx → pub/sub → WS → React live feed. ✔ integration test: two concurrent commits, exactly one accepted; WS client receives `crime.resolved`.
- **M2 Core loop parity.** Jail, ranks/exp, bank (deposit/withdraw with ledger), travel, bullets shop, leaderboards. ✔ economy invariant test: sum(ledger) == balance for 1000 randomized ops.

Restore those three bullets in SPEC.md when convenient. Nothing in this plan is blocked on it.

**The `GameEventSchema` union is `at minimum` per §3** — Task 2 implements exactly the sixteen names §3 lists and no more. Later milestones extend it; do not invent event names.

## Decisions taken (spec-permitted, stated for the record)

- Spec §2.5 lists the schema for all milestones at once. **This plan creates the full core schema in one Drizzle migration** — M2–M5 then only add columns rather than tables. Only auth + crimes gameplay is wired in M1; the rest of the tables sit empty, exactly as §5 prescribes ("ship the schema… but stub the gameplay").
- Distribution model is self-host engine (spec §8.1).
- Legacy password columns (`legacy_password_sha256`, `legacy_v2_id`) and the §4.3 login path are built **now, in M1**, not deferred to M4 — §4.3 states the flow is server-side, and M4's acceptance criterion ("legacy user logs in with old password → hash upgraded") requires the server side to already exist.

---

## File Structure

Files that change together live together. Each file below has one responsibility.

**Repo root**
- `package.json` — workspaces declaration, root scripts (`verify`, `dev`, `test`, `typecheck`)
- `tsconfig.base.json` — strict compiler options every package extends
- `docker-compose.yml` — `postgres:16-alpine`, `redis:7-alpine`
- `.env.example` — documented env vars, no values
- `.gitignore`, `vitest.workspace.ts`, `.github/workflows/ci.yml`

**`packages/shared`** — zero runtime deps beyond zod. Consumed by server AND web, so nothing Node-specific may leak in.
- `src/events.ts` — `GameEventSchema` discriminated union + `GameEvent` type
- `src/dto/auth.ts` — `RegisterRequestSchema`, `LoginRequestSchema`, `AuthResponseSchema`
- `src/dto/crime.ts` — `CommitCrimeRequestSchema`, `CrimeDtoSchema`, `CommitCrimeResponseSchema`
- `src/ws.ts` — `ServerFrameSchema` (server→client), `ClientFrameSchema` (client→server)
- `src/index.ts` — barrel re-export

**`apps/server`** — split by responsibility, not by layer.
- `src/config.ts` — env parsing via zod, exported typed `config`
- `src/db/schema.ts` — Drizzle table definitions (full core schema)
- `src/db/client.ts` — `postgres` connection + Drizzle instance
- `src/redis.ts` — Redis clients (one for commands, one dedicated subscriber — a subscribed client cannot run commands)
- `src/auth/password.ts` — argon2id hash/verify + legacy sha256 verify
- `src/auth/session.ts` — create/read/destroy opaque session tokens in Redis
- `src/auth/routes.ts` — `POST /api/auth/register`, `/login`, `/logout`, `GET /api/auth/me`
- `src/auth/rate-limit.ts` — Redis token bucket preHandler
- `src/economy/ledger.ts` — `applyBalanceChange` (the ONLY way money moves)
- `src/game/cooldown.ts` — atomic Redis cooldown acquire/peek/release
- `src/game/rng.ts` — seeded deterministic RNG built on `node:crypto`
- `src/game/crimes/routes.ts` — `GET /api/crimes`, `POST /api/crimes/:id/commit`
- `src/game/crimes/worker.ts` — BullMQ processor resolving a crime
- `src/queue/index.ts` — BullMQ queue + worker registry
- `src/bus/publish.ts` / `src/bus/subscribe.ts` — validated Redis pub/sub
- `src/ws/gateway.ts` — `ws` server on `/ws`, token auth, per-player socket registry
- `src/app.ts` — Fastify factory (routes registered, no `listen`) so tests can boot it
- `src/index.ts` — process entrypoint: boot app + workers + gateway
- `drizzle.config.ts`, `drizzle/*.sql` (generated, committed)
- `test/helpers/db.ts` — truncate-between-tests helper; `test/helpers/server.ts` — boot real app on ephemeral port

**`apps/web`**
- `src/api/client.ts` — fetch wrapper attaching bearer token
- `src/api/queries.ts` — TanStack Query hooks
- `src/ws/useGameEvents.ts` — WS hook feeding the event store
- `src/store/events.ts` — thin event store (last N events)
- `src/pages/Login.tsx`, `src/pages/Crimes.tsx`
- `src/components/EventFeed.tsx`
- `src/main.tsx`, `src/App.tsx`, `vite.config.ts` (proxy `/api` and `/ws`)

---

# M0 — Scaffold

**Milestone acceptance (spec §6):** `npm run verify` green on a fresh clone; drizzle migrations apply clean.

### Task 1: Monorepo skeleton, tooling, and `npm run verify`

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `.github/workflows/ci.yml`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: workspace `@gl3/shared` importable by name; root scripts `npm run typecheck`, `npm run test`, `npm run verify`; env var names `DATABASE_URL`, `REDIS_URL`, `PORT`, `SESSION_TTL`; docker services `postgres` (port 5432) and `redis` (port 6379).

- [ ] **Step 1: Initialise the git repo**

The working directory `/home/dlite/GL3` currently contains only `SPEC.md` and is **not** a git repo. Create one so every later task can commit.

```bash
cd /home/dlite/GL3
git init -b main
```

- [ ] **Step 2: Write the root `package.json`**

`private: true` prevents accidental publish. Workspaces globs match the §2.1 layout. `verify` is the single gate the milestone is judged on.

```json
{
  "name": "gl3",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "typecheck": "tsc --build --force",
    "test": "vitest run",
    "verify": "npm run typecheck && npm run test",
    "db:up": "docker compose up -d --wait",
    "db:down": "docker compose down -v"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.8",
    "@types/node": "^22.9.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.base.json`**

Every package extends this. `strict` plus the four extra flags below are what "TypeScript strict" means for this repo — `noUncheckedIndexedAccess` in particular catches the class of bug the V2 `US_crimes` string-index quirk is made of.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: Write `docker-compose.yml`**

Healthchecks matter: `npm run db:up` uses `--wait`, so integration tests never race a cold database.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: gl3
      POSTGRES_PASSWORD: gl3
      POSTGRES_DB: gl3
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gl3 -d gl3"]
      interval: 2s
      timeout: 3s
      retries: 20
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 20
```

- [ ] **Step 5: Write `.env.example`**

Documents exactly the four vars spec §7 names. No real secrets — this file is committed.

```bash
# Postgres 16 connection string used by the server and drizzle-kit
DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
# Redis 7 connection string used for sessions, cooldowns, BullMQ and pub/sub
REDIS_URL=redis://localhost:6379
# HTTP port the Fastify server binds
PORT=3000
# Session token lifetime in seconds (7 days)
SESSION_TTL=604800
```

- [ ] **Step 6: Write `.gitignore`**

```gitignore
node_modules/
dist/
*.tsbuildinfo
.env
.env.local
coverage/
```

- [ ] **Step 7: Write `vitest.workspace.ts`**

One runner across all workspaces so root `npm test` covers everything.

Vitest resolves **literal** (non-glob) workspace entries eagerly and errors if the
directory is missing, so `apps/server` cannot be listed until Task 3 creates it —
otherwise `npm run verify` fails on a fresh clone of this commit, which is exactly
M0's acceptance criterion. Task 3 adds the entry alongside the package.

```ts
import { defineWorkspace } from "vitest/config";

// apps/server is appended in Task 3, when that package first exists.
export default defineWorkspace(["packages/*"]);
```

- [ ] **Step 8: Create the `@gl3/shared` package**

Spec §2.1: shared has **no runtime deps beyond zod**. Keep it that way — it is imported by the browser bundle too.

`packages/shared/package.json`:

```json
{
  "name": "@gl3/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": { "zod": "^3.23.8" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"]
}
```

`packages/shared/src/index.ts` (barrel — later tasks add re-exports here):

```ts
export const SHARED_PACKAGE_VERSION = "0.0.0";
```

- [ ] **Step 9: Write the failing smoke test**

This test's job is to prove the workspace wiring resolves `@gl3/shared` by package name — the thing most likely to be silently broken.

`packages/shared/test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_VERSION } from "../src/index.js";

describe("@gl3/shared", () => {
  it("exports a version constant", () => {
    expect(SHARED_PACKAGE_VERSION).toBe("0.0.0");
  });
});
```

- [ ] **Step 10: Install dependencies and run the test**

```bash
npm install
npx vitest run packages/shared/test/smoke.test.ts
```

Expected: PASS, 1 test. If it fails to resolve `../src/index.js`, the `.js` extension on a `.ts` source file is correct under `NodeNext` — check `type: "module"` is set instead.

- [ ] **Step 11: Add the root tsconfig project references and verify typecheck**

Create `tsconfig.json` at the repo root:

```json
{
  "files": [],
  "references": [{ "path": "./packages/shared" }]
}
```

Run: `npm run typecheck`
Expected: exits 0, emits `packages/shared/dist/`.

- [ ] **Step 12: Write the CI workflow**

CI runs the same `verify` gate a human runs, plus real services for the integration tests added from Task 6 onward.

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: gl3, POSTGRES_PASSWORD: gl3, POSTGRES_DB: gl3 }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U gl3 -d gl3" --health-interval 2s
          --health-timeout 3s --health-retries 20
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping" --health-interval 2s
          --health-timeout 3s --health-retries 20
    env:
      DATABASE_URL: postgres://gl3:gl3@localhost:5432/gl3
      REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: "npm" }
      - run: npm ci
      - run: npm run verify
```

- [ ] **Step 13: Run the full verify gate**

Run: `npm run verify`
Expected: typecheck exits 0, vitest reports 1 passed. This is M0's acceptance criterion in miniature.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "chore: scaffold gl3 monorepo, docker-compose, and verify gate"
```

---

### Task 2: Event contracts and WS frames in `@gl3/shared`

Spec §3: a single zod discriminated union validated **on both ends** of the Redis bus. This is the contract every later task publishes into, so it lands before any server code.

**Files:**
- Create: `packages/shared/src/primitives.ts`
- Create: `packages/shared/src/events.ts`
- Create: `packages/shared/src/ws.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/events.test.ts`

**Interfaces:**
- Consumes: the `@gl3/shared` package from Task 1.
- Produces:
  - `MoneySchema: z.ZodType<string>` and `type Money = string` — a bigint serialised as a decimal string.
  - `GameEventSchema: z.ZodDiscriminatedUnion<"type", …>` and `type GameEvent = z.infer<typeof GameEventSchema>`. **Every member carries `id`, `at`, `actorId`, `actorName`, `audience`** — later tasks read the acting player off `actorId`, never a per-event `playerId`.
  - `AudienceSchema` / `type Audience` — `{kind:"global"} | {kind:"player", playerId:string} | {kind:"gang", gangId:string}`.
  - `ServerFrameSchema` / `type ServerFrame`, `ClientFrameSchema` / `type ClientFrame`.

**Straight from §3, non-negotiable:**
- *"Every event carries `at` (ISO string) and the acting player's id + display name."* → `at`, `actorId`, `actorName` live in the shared base of every union member.
- *"The WS gateway validates before fan-out; the client validates before rendering. Never send unvalidated JSON over the bus."* → `publishEvent` parses, `subscribeToEvents` parses, and the browser parses again in Task 11.
- *"Events are **facts, not commands** — published only *after* the Postgres transaction commits."* → the Task 9 worker publishes strictly after `db.transaction(...)` resolves. Never inside it.

**Two design decisions this task adds (not spelled out in §3, required to make it work):**
1. **`bigint` crosses the wire as a decimal string.** Global constraints forbid floating point in the economy and JSON has no bigint. `MoneySchema` is a regex-validated string; server converts at the edge with `BigInt(...)`.
2. **Every event carries an `audience`.** The WS gateway must know who may see an event; without it the gateway would have to re-derive recipients per event type, which is exactly the coupling §5 forbids.

Because `actorId` is in the base, per-event payloads never repeat it — `crime.resolved` has no separate `playerId` field, the actor *is* the player who committed the crime. For events with no human actor (a system kill, an automated news post), the actor is the player the event is about.

- [ ] **Step 1: Write the failing test**

Covers the three things most likely to break: the discriminator rejects unknown types, money rejects floats, and a round-trip through `JSON.stringify` survives (it must — it goes through Redis pub/sub).

`packages/shared/test/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GameEventSchema, MoneySchema, ServerFrameSchema } from "../src/index.js";

const crimeResolved = {
  id: "018f8e2a-0000-7000-8000-000000000001",
  type: "crime.resolved",
  at: "2026-08-07T00:00:00.000Z",
  actorId: "018f8e2a-0000-7000-8000-000000000002",
  actorName: "Vito",
  audience: { kind: "player", playerId: "018f8e2a-0000-7000-8000-000000000002" },
  crimeId: "018f8e2a-0000-7000-8000-000000000003",
  crimeName: "Pickpocket",
  success: true,
  payout: "250",
  bullets: "0",
  exp: "5",
  jailedUntil: null,
} as const;

describe("GameEventSchema", () => {
  it("accepts a crime.resolved event", () => {
    expect(GameEventSchema.parse(crimeResolved)).toMatchObject({ type: "crime.resolved" });
  });

  it("survives a JSON round-trip through the bus", () => {
    const wire = JSON.stringify(crimeResolved);
    expect(GameEventSchema.parse(JSON.parse(wire))).toEqual(crimeResolved);
  });

  it("rejects an unknown event type", () => {
    expect(() => GameEventSchema.parse({ ...crimeResolved, type: "crime.exploded" })).toThrow();
  });

  it("requires the acting player's id and display name on every event (SPEC §3)", () => {
    const { actorId: _id, ...noActorId } = crimeResolved;
    expect(() => GameEventSchema.parse(noActorId)).toThrow();
    const { actorName: _name, ...noActorName } = crimeResolved;
    expect(() => GameEventSchema.parse(noActorName)).toThrow();
  });

  it("covers all sixteen event names listed in SPEC §3", () => {
    expect(new Set(GameEventSchema.options.map((o) => o.shape.type.value))).toEqual(new Set([
      "crime.resolved", "player.jailed", "player.released", "player.travelled",
      "player.attacked", "player.killed", "bounty.placed", "bounty.claimed",
      "gang.created", "gang.memberJoined", "gang.memberLeft", "mail.received",
      "notification.created", "news.posted", "chat.message", "player.joined",
    ]));
  });

  it("rejects a payout that is not an integer string", () => {
    expect(() => MoneySchema.parse("250.5")).toThrow();
    expect(() => MoneySchema.parse(250)).toThrow();
    expect(MoneySchema.parse("-250")).toBe("-250");
  });

  it("wraps events in a server frame", () => {
    const frame = ServerFrameSchema.parse({ kind: "event", event: crimeResolved });
    expect(frame.kind).toBe("event");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/test/events.test.ts`
Expected: FAIL — `GameEventSchema` is not exported from `../src/index.js`.

- [ ] **Step 3: Write `primitives.ts`**

```ts
import { z } from "zod";

/** UUIDv7 is still a uuid by format; zod's uuid check accepts it. */
export const IdSchema = z.string().uuid();
export type Id = z.infer<typeof IdSchema>;

/**
 * A Postgres `bigint` serialised for transport. JSON has no bigint and the
 * economy forbids floating point, so money crosses process boundaries as a
 * decimal string and is converted with `BigInt(...)` at the edge.
 */
export const MoneySchema = z.string().regex(/^-?\d+$/, "must be an integer string");
export type Money = z.infer<typeof MoneySchema>;

export const TimestampSchema = z.string().datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Who is allowed to receive an event. The WS gateway routes on this alone. */
export const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("player"), playerId: IdSchema }),
  z.object({ kind: z.literal("gang"), gangId: IdSchema }),
]);
export type Audience = z.infer<typeof AudienceSchema>;
```

- [ ] **Step 4: Write `events.ts`**

Every event name here is quoted from SPEC §3. The union is `at minimum` per spec — later milestones extend it; do not add names not listed there.

```ts
import { z } from "zod";
import { AudienceSchema, IdSchema, MoneySchema, TimestampSchema } from "./primitives.js";

/**
 * SPEC §3: every event carries `at` (ISO string) and the acting player's id +
 * display name. Payloads therefore never repeat the actor.
 */
const base = {
  id: IdSchema,
  at: TimestampSchema,
  actorId: IdSchema,
  actorName: z.string(),
  audience: AudienceSchema,
};

export const GameEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("crime.resolved"),
    crimeId: IdSchema,
    crimeName: z.string(),
    success: z.boolean(),
    payout: MoneySchema,
    bullets: MoneySchema,
    exp: MoneySchema,
    jailedUntil: TimestampSchema.nullable(),
  }),
  // actor = the jailed player.
  z.object({ ...base, type: z.literal("player.jailed"), until: TimestampSchema, reason: z.string() }),
  z.object({ ...base, type: z.literal("player.released") }),
  z.object({ ...base, type: z.literal("player.travelled"), fromLocationId: IdSchema, toLocationId: IdSchema }),
  // actor = the attacker.
  z.object({ ...base, type: z.literal("player.attacked"), targetId: IdSchema, targetName: z.string(), damage: z.number().int().nonnegative() }),
  // actor = the killer, or the victim when the kill has no human killer.
  z.object({ ...base, type: z.literal("player.killed"), victimId: IdSchema, victimName: z.string() }),
  // actor = the player who placed the bounty.
  z.object({ ...base, type: z.literal("bounty.placed"), bountyId: IdSchema, targetId: IdSchema, targetName: z.string(), amount: MoneySchema }),
  // actor = the player who claimed it.
  z.object({ ...base, type: z.literal("bounty.claimed"), bountyId: IdSchema, targetId: IdSchema, targetName: z.string(), amount: MoneySchema }),
  // actor = the founding boss.
  z.object({ ...base, type: z.literal("gang.created"), gangId: IdSchema, gangName: z.string() }),
  // actor = the member who joined / left.
  z.object({ ...base, type: z.literal("gang.memberJoined"), gangId: IdSchema }),
  z.object({ ...base, type: z.literal("gang.memberLeft"), gangId: IdSchema }),
  // actor = the sender, or the recipient for system mail.
  z.object({ ...base, type: z.literal("mail.received"), mailId: IdSchema, recipientId: IdSchema, subject: z.string() }),
  // actor = the notified player.
  z.object({ ...base, type: z.literal("notification.created"), notificationId: IdSchema, body: z.string() }),
  // actor = the author.
  z.object({ ...base, type: z.literal("news.posted"), newsId: IdSchema, title: z.string() }),
  // actor = the speaker; actorName is the display name, so no separate username field.
  z.object({ ...base, type: z.literal("chat.message"), body: z.string() }),
  // actor = the player who just joined.
  z.object({ ...base, type: z.literal("player.joined") }),
]);

export type GameEvent = z.infer<typeof GameEventSchema>;
export type GameEventType = GameEvent["type"];
```

- [ ] **Step 5: Write `ws.ts`**

Both directions are validated. The client sends almost nothing — auth is a query param on the upgrade (spec §2.2) — but a ping frame keeps proxies from idling the socket out.

```ts
import { z } from "zod";
import { GameEventSchema } from "./events.js";

export const ServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), playerId: z.string().uuid() }),
  z.object({ kind: z.literal("event"), event: GameEventSchema }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({ kind: z.literal("pong") }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("ping") })]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
```

- [ ] **Step 6: Re-export from the barrel**

Replace `packages/shared/src/index.ts` with:

```ts
export const SHARED_PACKAGE_VERSION = "0.0.0";
export * from "./primitives.js";
export * from "./events.js";
export * from "./ws.js";
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/shared/test/events.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Verify the whole gate is still green**

Run: `npm run verify`
Expected: exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add GameEventSchema union and validated WS frames"
```

---

### Task 3: Server package, typed config, and bootable Fastify app

The app factory returns a Fastify instance **without calling `listen`**. That single decision is what lets every integration test from Task 6 onward boot a real server on an ephemeral port instead of mocking HTTP.

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/index.ts`
- Modify: `tsconfig.json` (add the server project reference)
- Modify: `vitest.workspace.ts` — append `"apps/server"`, which Task 1 deliberately left out because the directory did not exist yet:

```ts
export default defineWorkspace(["packages/*", "apps/server"]);
```
- Test: `apps/server/test/config.test.ts`, `apps/server/test/health.test.ts`

**Interfaces:**
- Consumes: `@gl3/shared` (Task 2).
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): Config` and `type Config = { databaseUrl: string; redisUrl: string; port: number; sessionTtlSeconds: number; corsOrigins: string[]; nodeEnv: "development"|"test"|"production" }`.
  - `buildApp(config: Config): Promise<FastifyInstance>` — routes registered, not listening.
  - `GET /health` → `200 {"status":"ok"}`.

- [ ] **Step 1: Create the server package**

`apps/server/package.json`. `argon2` and `bullmq` are installed now so no later task has to stop and re-run `npm install`.

```json
{
  "name": "@gl3/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc --build",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts"
  },
  "dependencies": {
    "@gl3/shared": "*",
    "argon2": "^0.41.1",
    "bullmq": "^5.34.2",
    "drizzle-orm": "^0.45.2",
    "fastify": "^5.1.0",
    "@fastify/cors": "^10.0.1",
    "ioredis": "^5.4.1",
    "postgres": "^3.4.5",
    "uuidv7": "^1.0.2",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/ws": "^8.5.13",
    "drizzle-kit": "^0.31.10",
    "tsx": "^4.19.2"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../../packages/shared" }]
}
```

Add the reference to the root `tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "./packages/shared" }, { "path": "./apps/server" }]
}
```

Then run `npm install`.

- [ ] **Step 2: Write the failing config test**

Config is an external boundary, so it is zod-parsed like any other. The test pins the two behaviours that cause silent production breakage: a missing var must throw loudly at boot, and `SESSION_TTL` must arrive as a number, not the string `"604800"`.

`apps/server/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgres://gl3:gl3@localhost:5432/gl3",
  REDIS_URL: "redis://localhost:6379",
  PORT: "3000",
  SESSION_TTL: "604800",
  NODE_ENV: "test",
};

describe("loadConfig", () => {
  it("coerces numeric vars to numbers", () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(3000);
    expect(config.sessionTtlSeconds).toBe(604800);
  });

  it("throws when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it("defaults CORS origins to the vite dev server and never to a wildcard", () => {
    expect(loadConfig(valid).corsOrigins).toEqual(["http://localhost:5173"]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/server/test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 4: Write `config.ts`**

```ts
import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_TTL: z.coerce.number().int().positive().default(604800),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Comma-separated allowlist. Strict CORS per spec §7 — never a wildcard. */
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
});

export interface Config {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  sessionTtlSeconds: number;
  corsOrigins: string[];
  nodeEnv: "development" | "test" | "production";
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    port: parsed.PORT,
    sessionTtlSeconds: parsed.SESSION_TTL,
    corsOrigins: parsed.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
    nodeEnv: parsed.NODE_ENV,
  };
}
```

- [ ] **Step 5: Run the config test to verify it passes**

Run: `npx vitest run apps/server/test/config.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Write the failing health test**

`fastify.inject()` exercises the real routing stack without opening a socket.

`apps/server/test/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
  DATABASE_URL: "postgres://gl3:gl3@localhost:5432/gl3",
  REDIS_URL: "redis://localhost:6379",
  NODE_ENV: "test",
});

describe("GET /health", () => {
  it("reports ok", async () => {
    const app = await buildApp(config);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run apps/server/test/health.test.ts`
Expected: FAIL — cannot resolve `../src/app.js`.

- [ ] **Step 8: Write `app.ts`**

```ts
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.nodeEnv !== "test" });

  await app.register(cors, { origin: config.corsOrigins, credentials: true });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
```

- [ ] **Step 9: Run the health test to verify it passes**

Run: `npx vitest run apps/server/test/health.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 10: Write the process entrypoint**

`apps/server/src/index.ts`. Later tasks extend this to start workers and the WS gateway.

```ts
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const app = await buildApp(config);

await app.listen({ port: config.port, host: "0.0.0.0" });
```

- [ ] **Step 11: Run the full gate**

Run: `npm run verify`
Expected: exits 0, with tests reported from **both** `packages/shared` and `apps/server`. If no `apps/server` tests appear, the `vitest.workspace.ts` edit above did not take.

- [ ] **Step 12: Commit**

```bash
git add apps/server tsconfig.json vitest.workspace.ts package-lock.json
git commit -m "feat(server): add typed config loader and bootable fastify app"
```

---

### Task 4: Full core schema in Drizzle, migration generated and applied

Spec §2.5 verbatim. Every table lands now so M2–M5 only add columns. Only auth + crimes get gameplay in M1; the rest sit empty (§5: "ship the schema… but stub the gameplay").

**Files:**
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/src/db/schema/enums.ts`, `identity.ts`, `content.ts`, `economy.ts`, `social.ts`, `migration.ts`, `index.ts`
- Create: `apps/server/src/db/migrate.ts`
- Create: `apps/server/drizzle.config.ts`
- Create: `apps/server/drizzle/0000_*.sql` (generated, **committed** per spec §2.2)
- Test: `apps/server/test/helpers/db.ts`, `apps/server/test/schema.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 3.
- Produces:
  - `createDb(databaseUrl: string): { db: NodePgDatabase; sql: postgres.Sql }`
  - Every table object exported from `src/db/schema/index.js` — later tasks import e.g. `import { players, playerStats, transactions } from "../db/schema/index.js"`.
  - `resetDb(db): Promise<void>` test helper that truncates all game tables.

**AMENDMENTS (applied during execution — these are now part of the requirements):**

1. **Bigint defaults must be written `` .default(sql`0`) ``, never `.default(0n)`.** drizzle-kit's serialiser crashes on a literal `BigInt` with `TypeError: Do not know how to serialize a BigInt` — a known open upstream bug (drizzle-orm #1879 / #2382 / #3609) unfixed in every stable 0.x. Import `sql` from `drizzle-orm` in each schema file. `mode: "bigint"` governs the read/write mapping, not the DDL default, so the emitted SQL is identical (`DEFAULT 0`) and the V2 signed-32-bit ceiling is not reintroduced. **Never change a column's `mode` to work around a tooling problem** — that is the one mistake this whole schema exists to prevent. 15 columns are affected.
2. **`drizzle-orm` must be `^0.45.2` or newer** regardless of tooling: versions below that carry high-severity SQL-injection advisory GHSA-gpj5-g38j-94v9.
3. **Every command in Step 11 needs `REDIS_URL` as well as `DATABASE_URL`**, because `migrate.ts` calls `loadConfig`, which validates the whole environment including Redis.
4. **Resetting to a clean database must drop BOTH schemas.** Drizzle's bookkeeping table lives in the `drizzle` schema and survives `DROP SCHEMA public CASCADE`, after which the migrator silently no-ops and you test nothing:
   `DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
5. **drizzle-kit auto-names the generated migration** (e.g. `0000_eminent_red_ghost.sql`). Renaming it to `0000_core_schema.sql` is fine, but `meta/_journal.json`'s `tag` must be updated to match or the migrator will not find it.
6. **Add a bigint round-trip test** alongside the column-type assertions: insert a `player_stats` row, read the defaulted `cash` back *through the query builder*, and assert `typeof === "bigint"` and `=== 0n` — not `== 0`, which passes for a number. Then update to a value above 2^31-1 and re-assert. Column-type introspection alone does not catch a regressed `mode`.

**Three schema notes that are easy to get wrong:**
1. **Circular foreign keys.** `players.round_id → rounds`, `player_stats.gang_id → gangs`, and `gangs.boss_player_id → players` form a cycle. Drizzle needs an explicit `AnyPgColumn` return-type annotation on the callback for the back-reference or TS infers `any` — which the no-`any` rule forbids anyway.
2. **UUIDv7 is generated in the application**, not by Postgres — Postgres 16 has no v7 function. Columns are plain `uuid` with no default; every insert supplies `uuidv7()`. The `id_map` table exists so the M4 migrator can keep V2 integer ids resolvable.
3. **`citext` for username and email** (spec §2.5) requires `CREATE EXTENSION IF NOT EXISTS citext` to run before the tables. It goes in the generated migration by hand — see Step 8.

- [ ] **Step 1: Write the enums and identity tables**

`apps/server/src/db/schema/enums.ts`:

```ts
import { pgEnum } from "drizzle-orm/pg-core";

/** Which balance a ledger row moves. Spec §2.5 transactions.balance_kind. */
export const balanceKind = pgEnum("balance_kind", ["cash", "bank", "points"]);
```

`apps/server/src/db/schema/identity.ts`:

```ts
import { relations } from "drizzle-orm";
import {
  type AnyPgColumn, bigint, customType, index, integer, pgTable,
  primaryKey, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { gangs } from "./social.js";
import { crimes, items, locations } from "./content.js";

/** citext: case-insensitive text, so `Bob` and `bob` collide on the unique index. */
export const citext = customType<{ data: string }>({ dataType: () => "citext" });

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color"),
});

/** V2 roleAccess: module referenced by string name, `*` = admin wildcard. Preserved. */
export const roleModuleAccess = pgTable("role_module_access", {
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  moduleKey: text("module_key").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.roleId, t.moduleKey] }) }));

export const rounds = pgTable("rounds", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: citext("username").notNull(),
  email: citext("email"),
  /** Null immediately after migration; filled on first legacy login (spec §4.3). */
  passwordHash: text("password_hash"),
  /** V2 `users.U_password` copied verbatim: sha256(U_id . plaintext). */
  legacyPasswordSha256: text("legacy_password_sha256"),
  /** Required by the §4.3 formula — it hashes the V2 *integer* id, not the uuid. */
  legacyV2Id: integer("legacy_v2_id"),
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
  roundId: uuid("round_id").references(() => rounds.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
}, (t) => ({
  usernameUnique: uniqueIndex("players_username_unique").on(t.username),
  emailUnique: uniqueIndex("players_email_unique").on(t.email),
  legacyV2IdUnique: uniqueIndex("players_legacy_v2_id_unique").on(t.legacyV2Id),
  roleIdx: index("players_role_idx").on(t.roleId),
  roundIdx: index("players_round_idx").on(t.roundId),
}));

/** 1:1 with players, kept split for hot-row separation (spec §2.5). */
export const playerStats = pgTable("player_stats", {
  playerId: uuid("player_id").primaryKey().references(() => players.id, { onDelete: "cascade" }),
  cash: bigint("cash", { mode: "bigint" }).notNull().default(0n),
  bank: bigint("bank", { mode: "bigint" }).notNull().default(0n),
  points: bigint("points", { mode: "bigint" }).notNull().default(0n),
  bullets: bigint("bullets", { mode: "bigint" }).notNull().default(0n),
  exp: bigint("exp", { mode: "bigint" }).notNull().default(0n),
  health: integer("health").notNull().default(100),
  backfire: integer("backfire").notNull().default(0),
  rankId: uuid("rank_id").references(() => ranks.id, { onDelete: "set null" }),
  gangId: uuid("gang_id").references((): AnyPgColumn => gangs.id, { onDelete: "set null" }),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
  weaponItemId: uuid("weapon_item_id").references(() => items.id, { onDelete: "set null" }),
  armorItemId: uuid("armor_item_id").references(() => items.id, { onDelete: "set null" }),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  /** Promoted out of generic timers because they gate actions (spec §2.5). */
  jailedUntil: timestamp("jailed_until", { withTimezone: true }),
  hospitalUntil: timestamp("hospital_until", { withTimezone: true }),
}, (t) => ({
  cashIdx: index("player_stats_cash_idx").on(t.cash),
  expIdx: index("player_stats_exp_idx").on(t.exp),
  gangIdx: index("player_stats_gang_idx").on(t.gangId),
  rankIdx: index("player_stats_rank_idx").on(t.rankId),
  locationIdx: index("player_stats_location_idx").on(t.locationId),
}));

/** Mirrors V2 userTimers: open-ended key→time. Custom module keys must survive. */
export const playerTimers = pgTable("player_timers", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.playerId, t.key] }) }));

/** V2 US_crimes dash-string exploded into rows (spec §1.2 quirk). */
export const playerCrimeSkill = pgTable("player_crime_skill", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  crimeId: uuid("crime_id").notNull().references(() => crimes.id, { onDelete: "cascade" }),
  chance: numericChance("chance").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.playerId, t.crimeId] }) }));

export const ranks = pgTable("ranks", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  expRequired: bigint("exp_required", { mode: "bigint" }).notNull(),
  cashReward: bigint("cash_reward", { mode: "bigint" }).notNull().default(0n),
  bulletReward: integer("bullet_reward").notNull().default(0),
  maxHealth: integer("max_health").notNull().default(100),
}, (t) => ({ expIdx: index("ranks_exp_idx").on(t.expRequired) }));

export const moneyRanks = pgTable("money_ranks", {
  id: uuid("id").primaryKey(),
  label: text("label").notNull(),
  threshold: bigint("threshold", { mode: "bigint" }).notNull(),
});

/** V2 settings key/value, migrated verbatim (spec §1.2). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const playersRelations = relations(players, ({ one }) => ({
  stats: one(playerStats, { fields: [players.id], references: [playerStats.playerId] }),
  role: one(roles, { fields: [players.roleId], references: [roles.id] }),
}));
```

Add the `numericChance` helper at the top of the same file (spec §2.5 specifies `numeric(5,2)`):

```ts
import { numeric } from "drizzle-orm/pg-core";
const numericChance = (name: string) => numeric(name, { precision: 5, scale: 2 });
```

- [ ] **Step 2: Write the content tables**

`apps/server/src/db/schema/content.ts`. These are the admin-editable V2 tables — data, not code.

```ts
import { bigint, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const crimes = pgTable("crimes", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  cooldownSeconds: integer("cooldown_seconds").notNull(),
  minPayout: bigint("min_payout", { mode: "bigint" }).notNull(),
  maxPayout: bigint("max_payout", { mode: "bigint" }).notNull(),
  minBullets: integer("min_bullets").notNull().default(0),
  maxBullets: integer("max_bullets").notNull().default(0),
  expReward: bigint("exp_reward", { mode: "bigint" }).notNull().default(0n),
  minRank: integer("min_rank").notNull().default(0),
  sort: integer("sort").notNull().default(0),
}, (t) => ({ sortIdx: index("crimes_sort_idx").on(t.sort) }));

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  travelCost: bigint("travel_cost", { mode: "bigint" }).notNull().default(0n),
  travelCooldownSeconds: integer("travel_cooldown_seconds").notNull().default(0),
  bulletStock: integer("bullet_stock").notNull().default(0),
  bulletCost: bigint("bullet_cost", { mode: "bigint" }).notNull().default(0n),
});

export const cars = pgTable("cars", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  value: bigint("value", { mode: "bigint" }).notNull(),
  /** V2 CA_theftChance is a weight, not a percentage (spec §1.2). */
  theftWeight: integer("theft_weight").notNull().default(1),
});

export const theftTiers = pgTable("theft_tiers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  successChance: integer("success_chance").notNull(),
  maxDamage: integer("max_damage").notNull(),
  /** V2 T_worstCar/T_bestCar are cash bounds, not car ids (spec §1.2). */
  minCarValue: bigint("min_car_value", { mode: "bigint" }).notNull(),
  maxCarValue: bigint("max_car_value", { mode: "bigint" }).notNull(),
});

export const weapons = pgTable("weapons", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  accuracy: integer("accuracy").notNull(),
});

/** V2 itemEffects/itemMeta EAV collapsed to JSONB (spec §1.2, §2.5). */
export const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  itemType: text("item_type").notNull(),
  effects: jsonb("effects").notNull().default({}),
  meta: jsonb("meta").notNull().default({}),
});
```

- [ ] **Step 3: Write the economy tables**

`apps/server/src/db/schema/economy.ts`. `transactions` is the spine of every economy invariant in this project.

```ts
import { bigint, boolean, index, integer, pgTable, text, timestamp, uuid, primaryKey } from "drizzle-orm/pg-core";
import { balanceKind } from "./enums.js";
import { players } from "./identity.js";
import { cars, crimes, items, locations } from "./content.js";

/** Append-only. Never updated, never deleted. sum(amount) per kind == balance. */
export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  balanceKind: balanceKind("balance_kind").notNull(),
  reason: text("reason").notNull(),
  refId: uuid("ref_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  playerIdx: index("transactions_player_idx").on(t.playerId),
  playerKindIdx: index("transactions_player_kind_idx").on(t.playerId, t.balanceKind),
}));

export const playerItems = pgTable("player_items", {
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  qty: integer("qty").notNull().default(0),
}, (t) => ({ pk: primaryKey({ columns: [t.playerId, t.itemId] }) }));

/** Cars are location-bound in V2 (spec §1.2 garage). */
export const garage = pgTable("garage", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  carId: uuid("car_id").notNull().references(() => cars.id, { onDelete: "cascade" }),
  damage: integer("damage").notNull().default(0),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
}, (t) => ({ playerIdx: index("garage_player_idx").on(t.playerId) }));

/** V2 PR_module is a string naming the implementing module → plugin_id (spec §1.2). */
export const properties = pgTable("properties", {
  id: uuid("id").primaryKey(),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  pluginId: text("plugin_id").notNull(),
  ownerPlayerId: uuid("owner_player_id").references(() => players.id, { onDelete: "set null" }),
  cost: bigint("cost", { mode: "bigint" }).notNull().default(0n),
  profit: bigint("profit", { mode: "bigint" }).notNull().default(0n),
}, (t) => ({ locationIdx: index("properties_location_idx").on(t.locationId) }));

export const crimeLog = pgTable("crime_log", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  crimeId: uuid("crime_id").notNull().references(() => crimes.id, { onDelete: "cascade" }),
  success: boolean("success").notNull(),
  payout: bigint("payout", { mode: "bigint" }).notNull().default(0n),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ playerIdx: index("crime_log_player_idx").on(t.playerId, t.createdAt) }));
```

- [ ] **Step 4: Write the social tables**

`apps/server/src/db/schema/social.ts`. Two V2 model changes are load-bearing here: `US_gang` int becomes the `gang_members` join table, and `gangPermissions` gains the real `gang_id` it never had (spec §1.2 — V2 implied the gang from the user's `US_gang`).

```ts
import { bigint, boolean, index, integer, pgTable, primaryKey, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { players } from "./identity.js";
import { locations } from "./content.js";

export const gangs = pgTable("gangs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  info: text("info").notNull().default(""),
  /** V2 kept two balances (G_bank and G_money); both preserved. */
  bank: bigint("bank", { mode: "bigint" }).notNull().default(0n),
  cash: bigint("cash", { mode: "bigint" }).notNull().default(0n),
  bullets: bigint("bullets", { mode: "bigint" }).notNull().default(0n),
  level: integer("level").notNull().default(1),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
  bossPlayerId: uuid("boss_player_id").references((): AnyPgColumn => players.id, { onDelete: "set null" }),
  underbossPlayerId: uuid("underboss_player_id").references((): AnyPgColumn => players.id, { onDelete: "set null" }),
});

/** Replaces V2's US_gang integer column. */
export const gangMembers = pgTable("gang_members", {
  gangId: uuid("gang_id").notNull().references(() => gangs.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.gangId, t.playerId] }),
  playerIdx: index("gang_members_player_idx").on(t.playerId),
}));

export const gangPermissions = pgTable("gang_permissions", {
  gangId: uuid("gang_id").notNull().references(() => gangs.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.gangId, t.playerId, t.permission] }) }));

export const gangInvites = pgTable("gang_invites", {
  id: uuid("id").primaryKey(),
  gangId: uuid("gang_id").notNull().references(() => gangs.id, { onDelete: "cascade" }),
  invitedPlayerId: uuid("invited_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  invitedByPlayerId: uuid("invited_by_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ invitedIdx: index("gang_invites_invited_idx").on(t.invitedPlayerId) }));

/** Append-only gang audit log. */
export const gangLogs = pgTable("gang_logs", {
  id: uuid("id").primaryKey(),
  gangId: uuid("gang_id").notNull().references(() => gangs.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ gangIdx: index("gang_logs_gang_idx").on(t.gangId, t.createdAt) }));

export const bounties = pgTable("bounties", {
  id: uuid("id").primaryKey(),
  placedBy: uuid("placed_by").notNull().references(() => players.id, { onDelete: "cascade" }),
  target: uuid("target").notNull().references(() => players.id, { onDelete: "cascade" }),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedBy: uuid("claimed_by").references(() => players.id, { onDelete: "set null" }),
}, (t) => ({ targetIdx: index("bounties_target_idx").on(t.target) }));

export const detectiveSearches = pgTable("detective_searches", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  targetPlayerId: uuid("target_player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  detectives: integer("detectives").notNull().default(1),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  succeeded: boolean("succeeded"),
});

/** V2 threaded PMs via M_parent → thread_id (spec §2.5). */
export const mailMessages = pgTable("mail_messages", {
  id: uuid("id").primaryKey(),
  threadId: uuid("thread_id").notNull(),
  senderId: uuid("sender_id").references(() => players.id, { onDelete: "set null" }),
  recipientId: uuid("recipient_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  recipientIdx: index("mail_recipient_idx").on(t.recipientId, t.createdAt),
  threadIdx: index("mail_thread_idx").on(t.threadId),
}));

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  playerId: uuid("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ playerIdx: index("notifications_player_idx").on(t.playerId, t.createdAt) }));

export const gameNews = pgTable("game_news", {
  id: uuid("id").primaryKey(),
  authorId: uuid("author_id").references(() => players.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 5: Write the migration-support table and the barrel**

`apps/server/src/db/schema/migration.ts` — written by the M4 migrator only, but the table ships now so M4 needs no schema change. It is what makes a re-run idempotent (spec §4.2.3).

```ts
import { integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";

export const idMap = pgTable("id_map", {
  v2Table: text("v2_table").notNull(),
  v2Id: integer("v2_id").notNull(),
  v3Id: uuid("v3_id").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.v2Table, t.v2Id] }) }));
```

`apps/server/src/db/schema/index.ts`:

```ts
export * from "./enums.js";
export * from "./identity.js";
export * from "./content.js";
export * from "./economy.js";
export * from "./social.js";
export * from "./migration.js";
```

- [ ] **Step 6: Write the database client**

`apps/server/src/db/client.ts`. `max: 10` keeps the pool small enough that a stuck worker can't starve the API.

```ts
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(databaseUrl: string): { db: Db; sql: postgres.Sql } {
  const sql = postgres(databaseUrl, { max: 10 });
  return { db: drizzle(sql, { schema }), sql };
}
```

- [ ] **Step 7: Write the drizzle-kit config**

`apps/server/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://gl3:gl3@localhost:5432/gl3" },
});
```

- [ ] **Step 8: Generate the migration and hand-add the citext extension**

```bash
npm --workspace @gl3/server run db:generate
```

Then open the generated `apps/server/drizzle/0000_*.sql` and insert this as the **first** statement — `citext` columns cannot be created before the extension exists:

```sql
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
```

The `--> statement-breakpoint` marker is required; drizzle's migrator splits the file on it.

- [ ] **Step 9: Write the migration runner**

`apps/server/src/db/migrate.ts`:

```ts
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "../config.js";
import { createDb } from "./client.js";

const config = loadConfig(process.env);
const { db, sql } = createDb(config.databaseUrl);
await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
await sql.end();
```

- [ ] **Step 10: Write the failing schema test and the reset helper**

This is M0's real acceptance test: migrations apply clean against a real Postgres 16, and the economy columns are genuinely `bigint` — not `integer`, which is the exact ceiling V2 hit.

`apps/server/test/helpers/db.ts`:

```ts
import { sql } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";

export function testDb(): ReturnType<typeof createDb> {
  return createDb(loadConfig(process.env).databaseUrl);
}

/** Wipes game data between tests. Excludes drizzle's own bookkeeping table. */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`
    DO $$
    DECLARE t text;
    BEGIN
      FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
      LOOP
        EXECUTE format('TRUNCATE TABLE %I CASCADE', t);
      END LOOP;
    END $$;
  `);
}
```

`apps/server/test/schema.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();

const columnType = async (table: string, column: string): Promise<string | undefined> => {
  const rows = await db.execute<{ data_type: string }>(sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `);
  return rows[0]?.data_type;
};

describe("core schema", () => {
  beforeAll(async () => {
    // Migrations must already be applied: `npm run db:up && npm --workspace @gl3/server run db:migrate`
  });
  afterAll(async () => { await conn.end(); });

  it("creates every table named in spec §2.5", async () => {
    const rows = await db.execute<{ tablename: string }>(sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `);
    const names = new Set(rows.map((r) => r.tablename));
    for (const expected of [
      "players", "player_stats", "player_timers", "player_crime_skill", "transactions",
      "crimes", "locations", "cars", "theft_tiers", "weapons", "items", "player_items",
      "garage", "gangs", "gang_members", "gang_permissions", "gang_invites", "gang_logs",
      "properties", "bounties", "detective_searches", "mail_messages", "notifications",
      "game_news", "ranks", "money_ranks", "roles", "role_module_access", "rounds",
      "settings", "crime_log", "id_map",
    ]) {
      expect(names, `missing table ${expected}`).toContain(expected);
    }
  });

  it("stores money as bigint, never integer", async () => {
    expect(await columnType("player_stats", "cash")).toBe("bigint");
    expect(await columnType("player_stats", "bank")).toBe("bigint");
    expect(await columnType("player_stats", "exp")).toBe("bigint");
    expect(await columnType("transactions", "amount")).toBe("bigint");
    expect(await columnType("gangs", "bank")).toBe("bigint");
  });

  it("makes usernames case-insensitively unique", async () => {
    expect(await columnType("players", "username")).toBe("USER-DEFINED"); // citext
  });

  it("keeps the legacy password columns required by spec §4.3", async () => {
    expect(await columnType("players", "legacy_password_sha256")).toBe("text");
    expect(await columnType("players", "legacy_v2_id")).toBe("integer");
  });
});
```

- [ ] **Step 11: Bring the services up, apply migrations, run the test**

```bash
npm run db:up   # skip where Docker is unavailable and Postgres 16 / Redis 7 run natively
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm --workspace @gl3/server run db:migrate
npx vitest run apps/server/test/schema.test.ts
```

Expected: migration prints no error; 5 tests PASS (4 introspection + the bigint round-trip from Amendment 6). If `citext` errors, Step 8's extension statement is missing or not first. If the migrator does nothing on what you believe is a clean database, you dropped only `public` — see Amendment 4.

- [ ] **Step 12: Run the full gate and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add apps/server
git commit -m "feat(server): add full core drizzle schema and initial migration"
```

**M0 is now complete** — `npm run verify` is green on a fresh clone and migrations apply clean (spec §6 M0 acceptance).

---

# M1 — Auth + Vertical Slice

**Milestone acceptance (spec §6):** register/login with argon2id, sessions, and the commit-crime slice end-to-end — HTTP → Redis cooldown → BullMQ → Postgres tx → pub/sub → WS → React live feed. Integration test: two concurrent commits, **exactly one accepted**; a WS client receives `crime.resolved`.

### Task 5: Redis clients and the password module (argon2id + V2 legacy path)

The legacy verification formula is quoted verbatim from SPEC §4.3 and §1.1. Get it wrong and every migrated V2 account is permanently locked out, so it gets its own test with a hand-computed fixture.

**Files:**
- Create: `apps/server/src/redis.ts`
- Create: `apps/server/src/auth/password.ts`
- Test: `apps/server/test/password.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 3).
- Produces:
  - `createRedis(url: string): Redis` and `createSubscriber(url: string): Redis`
  - `hashPassword(plaintext: string): Promise<string>`
  - `verifyPassword(hash: string, plaintext: string): Promise<boolean>`
  - `legacyHash(legacyV2Id: number, plaintext: string): string`
  - `verifyLegacyPassword(storedHash: string, legacyV2Id: number, plaintext: string): boolean`

- [ ] **Step 1: Write `redis.ts`**

Two clients, deliberately. A Redis connection in subscriber mode **cannot issue normal commands** — sharing one client between the bus and cooldowns is the classic bug here. BullMQ additionally requires `maxRetriesPerRequest: null`.

```ts
import { Redis } from "ioredis";

/** For commands: sessions, cooldowns, rate limits, publishing. */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/** Dedicated subscriber — a subscribed client cannot run other commands. */
export function createSubscriber(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
```

- [ ] **Step 2: Write the failing password test**

The fixture below is the V2 formula applied by hand: `sha256("42" + "hunter2")`. Compute it once with `node -e 'console.log(require("crypto").createHash("sha256").update("42hunter2").digest("hex"))'` and paste the literal — a test that recomputes the value using the same code it is testing proves nothing.

`apps/server/test/password.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, legacyHash, verifyLegacyPassword, verifyPassword } from "../src/auth/password.js";

describe("argon2id passwords", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "hunter2")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword(hash, "hunter3")).toBe(false);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "hunter2")).toBe(false);
  });
});

describe("V2 legacy passwords (SPEC §1.1 / §4.3)", () => {
  // V2 class/user.php::encrypt() — sha256(U_id . plaintext), unsalted beyond the id.
  const expected = createHash("sha256").update("42hunter2").digest("hex");

  it("reproduces the V2 formula: sha256(U_id . plaintext)", () => {
    expect(legacyHash(42, "hunter2")).toBe(expected);
  });

  it("concatenates the id as a string prefix, not as an added number", () => {
    // Guards against a `legacyV2Id + plaintext` numeric-coercion bug.
    expect(legacyHash(42, "hunter2")).not.toBe(createHash("sha256").update("hunter242").digest("hex"));
  });

  it("verifies a stored V2 hash", () => {
    expect(verifyLegacyPassword(expected, 42, "hunter2")).toBe(true);
    expect(verifyLegacyPassword(expected, 42, "wrong")).toBe(false);
    expect(verifyLegacyPassword(expected, 43, "hunter2")).toBe(false);
  });

  it("compares case-insensitively against uppercase hex from a MySQL dump", () => {
    expect(verifyLegacyPassword(expected.toUpperCase(), 42, "hunter2")).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run apps/server/test/password.test.ts`
Expected: FAIL — cannot resolve `../src/auth/password.js`.

- [ ] **Step 4: Write `password.ts`**

```ts
import argon2 from "argon2";
import { createHash, timingSafeEqual } from "node:crypto";

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    // A malformed or truncated hash must read as "wrong password", not a 500.
    return false;
  }
}

/**
 * V2 `class/user.php::encrypt()`: sha256(U_id . plaintext).
 * Unsalted beyond the user id, no work factor. SPEC §1.1.
 * The id is concatenated as a *string*, and it is the V2 integer id — not the GL3 uuid.
 */
export function legacyHash(legacyV2Id: number, plaintext: string): string {
  return createHash("sha256").update(`${legacyV2Id}${plaintext}`).digest("hex");
}

export function verifyLegacyPassword(storedHash: string, legacyV2Id: number, plaintext: string): boolean {
  const computed = legacyHash(legacyV2Id, plaintext);
  // MySQL dumps may hold uppercase hex; normalise before comparing.
  const stored = storedHash.trim().toLowerCase();
  if (stored.length !== computed.length) return false;
  return timingSafeEqual(Buffer.from(stored, "utf8"), Buffer.from(computed, "utf8"));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/server/test/password.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/redis.ts apps/server/src/auth apps/server/test/password.test.ts
git commit -m "feat(server): add argon2id hashing and V2 legacy password verification"
```

---

### Task 6: Sessions, rate limiting, and auth routes

Sessions are opaque tokens in Redis with a 7-day TTL (spec §2.2). The login handler implements SPEC §4.3's legacy upgrade in full, because M4's acceptance criterion depends on it already working.

**Files:**
- Create: `packages/shared/src/dto/auth.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/auth/session.ts`
- Create: `apps/server/src/auth/rate-limit.ts`
- Create: `apps/server/src/auth/routes.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/helpers/server.ts`, `apps/server/test/auth.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword`, `verifyLegacyPassword` (Task 5); `players`, `playerStats` (Task 4).
- Produces:
  - `RegisterRequestSchema`, `LoginRequestSchema`, `AuthResponseSchema`, `MeResponseSchema` from `@gl3/shared`.
  - `createSession(redis, playerId, ttl): Promise<string>`, `readSession(redis, token): Promise<string | null>`, `destroySession(redis, token): Promise<void>`
  - `requireAuth` — a Fastify `preHandler` that sets `request.playerId: string`
  - `tokenBucket(redis, opts)` — a Fastify `preHandler` factory
  - Routes: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
  - `buildApp` now takes `(config, deps)` where `deps = { db: Db; redis: Redis }` — **every later task's route registration goes through this same shape.**

- [ ] **Step 1: Write the auth DTOs in shared**

`packages/shared/src/dto/auth.ts`:

```ts
import { z } from "zod";
import { IdSchema } from "../primitives.js";

/** V2 capped usernames at 30 chars (SPEC §1.2 users.U_name); GL3 keeps that ceiling. */
export const RegisterRequestSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only"),
  email: z.string().email().optional(),
  password: z.string().min(8).max(200),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(30),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthResponseSchema = z.object({
  token: z.string(),
  playerId: IdSchema,
  username: z.string(),
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const MeResponseSchema = z.object({
  playerId: IdSchema,
  username: z.string(),
  cash: z.string(),
  bank: z.string(),
  bullets: z.string(),
  exp: z.string(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
```

Append to `packages/shared/src/index.ts`:

```ts
export * from "./dto/auth.js";
```

- [ ] **Step 2: Write `session.ts`**

```ts
import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

const key = (token: string): string => `session:${token}`;

export async function createSession(redis: Redis, playerId: string, ttlSeconds: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await redis.set(key(token), playerId, "EX", ttlSeconds);
  return token;
}

export async function readSession(redis: Redis, token: string): Promise<string | null> {
  return redis.get(key(token));
}

export async function destroySession(redis: Redis, token: string): Promise<void> {
  await redis.del(key(token));
}
```

- [ ] **Step 3: Write `rate-limit.ts`**

Spec §7 requires a Redis token bucket on auth endpoints. `INCR` + `EXPIRE` on first hit is the cheap correct form — a fixed window, atomic without Lua because `INCR` returning 1 uniquely identifies the window's first request.

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export interface TokenBucketOptions {
  /** Bucket name, e.g. "login". */
  name: string;
  limit: number;
  windowSeconds: number;
}

export function tokenBucket(redis: Redis, opts: TokenBucketOptions) {
  return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const bucketKey = `ratelimit:${opts.name}:${request.ip}`;
    const hits = await redis.incr(bucketKey);
    if (hits === 1) await redis.expire(bucketKey, opts.windowSeconds);
    if (hits > opts.limit) {
      const ttl = await redis.ttl(bucketKey);
      reply.header("retry-after", String(Math.max(ttl, 1)));
      await reply.code(429).send({ error: "rate_limited" });
    }
  };
}
```

- [ ] **Step 4: Write the failing auth test**

Five behaviours, and the legacy-upgrade pair is the one that must never regress.

`apps/server/test/helpers/server.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createDb } from "../../src/db/client.js";
import { createRedis } from "../../src/redis.js";

export async function bootTestServer(): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const config = loadConfig({ ...process.env, NODE_ENV: "test" });
  const { db, sql } = createDb(config.databaseUrl);
  const redis = createRedis(config.redisUrl);
  const app = await buildApp(config, { db, redis });
  return {
    app,
    close: async () => { await app.close(); await sql.end(); redis.disconnect(); },
  };
}
```

`apps/server/test/auth.test.ts`:

```ts
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { legacyHash } from "../src/auth/password.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
});
afterAll(async () => { await closeServer(); await conn.end(); });

describe("POST /api/auth/register", () => {
  it("creates a player with stats and returns a session token", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Vito", password: "hunter2hunter2" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.username).toBe("Vito");
    expect(body.token).toEqual(expect.any(String));

    const stats = await db.select().from(playerStats);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.cash).toBe(0n);
  });

  it("rejects a duplicate username case-insensitively", async () => {
    await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "vito", password: "hunter2hunter2" } });
    expect(res.statusCode).toBe(409);
  });

  it("rejects a short password with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "short" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/auth/login — legacy V2 upgrade (SPEC §4.3)", () => {
  const legacyPlayerId = uuidv7();

  beforeEach(async () => {
    await db.insert(players).values({
      id: legacyPlayerId,
      username: "OldTimer",
      passwordHash: null,
      legacyPasswordSha256: legacyHash(42, "oldpassword"),
      legacyV2Id: 42,
    });
    await db.insert(playerStats).values({ playerId: legacyPlayerId });
  });

  it("logs in with the V2 password and upgrades the hash to argon2id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "OldTimer", password: "oldpassword" },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(players).where(sql`${players.id} = ${legacyPlayerId}`);
    expect(row?.passwordHash?.startsWith("$argon2id$")).toBe(true);
    expect(row?.legacyPasswordSha256).toBeNull();
  });

  it("accepts the same password on the second login, now via argon2id", async () => {
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "OldTimer", password: "oldpassword" } });
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "OldTimer", password: "oldpassword" } });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong legacy password without clearing the legacy column", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "OldTimer", password: "nope" } });
    expect(res.statusCode).toBe(401);
    const [row] = await db.select().from(players).where(sql`${players.id} = ${legacyPlayerId}`);
    expect(row?.legacyPasswordSha256).not.toBeNull();
  });
});

describe("GET /api/auth/me", () => {
  it("returns the player behind a bearer token and 401 without one", async () => {
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
    const { token } = reg.json();

    const ok = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().cash).toBe("0");

    const anon = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(anon.statusCode).toBe(401);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm run db:up && npx vitest run apps/server/test/auth.test.ts`
Expected: FAIL — `buildApp` does not accept a second argument.

- [ ] **Step 6: Write `routes.ts`**

Note the two deliberate choices: registration inserts player + stats in **one transaction** (a player without stats is unusable), and both failure branches of login return the same 401 body so the endpoint can't be used to enumerate usernames.

```ts
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { LoginRequestSchema, RegisterRequestSchema } from "@gl3/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { players, playerStats } from "../db/schema/index.js";
import { hashPassword, verifyLegacyPassword, verifyPassword } from "./password.js";
import { tokenBucket } from "./rate-limit.js";
import { createSession, destroySession, readSession } from "./session.js";

declare module "fastify" {
  interface FastifyRequest { playerId?: string }
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export function registerAuthRoutes(app: FastifyInstance, config: Config, db: Db, redis: Redis): void {
  const requireAuth = async (request: FastifyRequest, reply: { code: (n: number) => { send: (b: unknown) => Promise<void> } }): Promise<void> => {
    const token = bearer(request);
    const playerId = token ? await readSession(redis, token) : null;
    if (!playerId) { await reply.code(401).send({ error: "unauthorized" }); return; }
    request.playerId = playerId;
  };
  app.decorate("requireAuth", requireAuth);

  app.post("/api/auth/register", {
    preHandler: tokenBucket(redis, { name: "register", limit: 5, windowSeconds: 3600 }),
  }, async (request, reply) => {
    const parsed = RegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });

    const existing = await db.select({ id: players.id }).from(players).where(eq(players.username, parsed.data.username));
    if (existing.length > 0) return reply.code(409).send({ error: "username_taken" });

    const playerId = uuidv7();
    const passwordHash = await hashPassword(parsed.data.password);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(players).values({
          id: playerId,
          username: parsed.data.username,
          email: parsed.data.email ?? null,
          passwordHash,
        });
        await tx.insert(playerStats).values({ playerId });
      });
    } catch {
      // Unique index is the real arbiter; the pre-check above only saves a hash round.
      return reply.code(409).send({ error: "username_taken" });
    }

    const token = await createSession(redis, playerId, config.sessionTtlSeconds);
    return reply.code(201).send({ token, playerId, username: parsed.data.username });
  });

  app.post("/api/auth/login", {
    preHandler: tokenBucket(redis, { name: "login", limit: 10, windowSeconds: 900 }),
  }, async (request, reply) => {
    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const [player] = await db.select().from(players).where(eq(players.username, parsed.data.username));
    if (!player) return reply.code(401).send({ error: "invalid_credentials" });

    let authenticated = false;

    if (player.passwordHash) {
      authenticated = await verifyPassword(player.passwordHash, parsed.data.password);
    } else if (player.legacyPasswordSha256 !== null && player.legacyV2Id !== null) {
      // SPEC §4.3: verify against the V2 formula, then rehash with argon2id and null the legacy column.
      authenticated = verifyLegacyPassword(player.legacyPasswordSha256, player.legacyV2Id, parsed.data.password);
      if (authenticated) {
        const upgraded = await hashPassword(parsed.data.password);
        await db.update(players)
          .set({ passwordHash: upgraded, legacyPasswordSha256: null })
          .where(eq(players.id, player.id));
        request.log.info({ event: "auth.legacy_upgraded", playerId: player.id });
      }
    }

    if (!authenticated) return reply.code(401).send({ error: "invalid_credentials" });

    const token = await createSession(redis, player.id, config.sessionTtlSeconds);
    return reply.code(200).send({ token, playerId: player.id, username: player.username });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = bearer(request);
    if (token) await destroySession(redis, token);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const [row] = await db.select({
      username: players.username,
      cash: playerStats.cash, bank: playerStats.bank,
      bullets: playerStats.bullets, exp: playerStats.exp,
    }).from(players)
      .innerJoin(playerStats, eq(playerStats.playerId, players.id))
      .where(eq(players.id, playerId));

    if (!row) return reply.code(404).send({ error: "player_not_found" });

    return reply.send({
      playerId, username: row.username,
      cash: row.cash.toString(), bank: row.bank.toString(),
      bullets: row.bullets.toString(), exp: row.exp.toString(),
    });
  });
}
```

- [ ] **Step 7: Wire the routes into `app.ts`**

Replace `apps/server/src/app.ts`:

```ts
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { registerAuthRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";

export interface AppDeps { db: Db; redis: Redis }

export async function buildApp(config: Config, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: config.nodeEnv !== "test" });
  await app.register(cors, { origin: config.corsOrigins, credentials: true });

  app.get("/health", async () => ({ status: "ok" }));
  registerAuthRoutes(app, config, deps.db, deps.redis);

  return app;
}
```

Update `apps/server/src/index.ts` to build the deps:

```ts
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createRedis } from "./redis.js";

const config = loadConfig(process.env);
const { db } = createDb(config.databaseUrl);
const redis = createRedis(config.redisUrl);
const app = await buildApp(config, { db, redis });

await app.listen({ port: config.port, host: "0.0.0.0" });
```

Update `apps/server/test/health.test.ts` to pass deps — it currently calls `buildApp(config)` and will no longer typecheck. Replace its body with a `bootTestServer()` call from the helper written in Step 4.

- [ ] **Step 8: Run the auth tests to verify they pass**

Run: `npx vitest run apps/server/test/auth.test.ts`
Expected: PASS, 8 tests. If the two legacy tests fail, re-check that `legacyV2Id` is read from the DB row and not confused with `players.id`.

- [ ] **Step 9: Run the full gate and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add packages/shared apps/server
git commit -m "feat(server): add sessions, rate-limited auth routes, and legacy V2 login upgrade"
```

---

### Task 7: Atomic cooldowns and worker-side seeded RNG

These are the two primitives that make the M1 acceptance test possible. The cooldown is what guarantees "two concurrent commits, exactly one accepted". The RNG is what guarantees a BullMQ retry cannot re-roll a favourable outcome (spec §7).

**Files:**
- Create: `apps/server/src/game/cooldown.ts`
- Create: `apps/server/src/game/rng.ts`
- Test: `apps/server/test/cooldown.test.ts`, `apps/server/test/rng.test.ts`

**Interfaces:**
- Consumes: `createRedis` (Task 5).
- Produces:
  - `acquireCooldown(redis, key, ttlSeconds): Promise<boolean>` — true iff this caller won it
  - `peekCooldown(redis, key): Promise<number>` — seconds remaining, 0 if free
  - `releaseCooldown(redis, key): Promise<void>` — for compensating a failed enqueue
  - `cooldownKey(playerId, action): string` — `cooldown:<action>:<playerId>`
  - `newSeed(): string` — 32 hex chars from `node:crypto`
  - `createRng(seed: string): { int(minInclusive: number, maxExclusive: number): number; bigint(min: bigint, max: bigint): bigint }`

- [ ] **Step 1: Write the failing cooldown test**

`apps/server/test/cooldown.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { acquireCooldown, cooldownKey, peekCooldown, releaseCooldown } from "../src/game/cooldown.js";
import { loadConfig } from "../src/config.js";
import { createRedis } from "../src/redis.js";

const redis = createRedis(loadConfig(process.env).redisUrl);
const key = cooldownKey("018f8e2a-0000-7000-8000-000000000002", "crime");

beforeEach(async () => { await redis.del(key); });
afterAll(() => { redis.disconnect(); });

describe("cooldowns", () => {
  it("builds a namespaced key", () => {
    expect(key).toBe("cooldown:crime:018f8e2a-0000-7000-8000-000000000002");
  });

  it("grants the first acquire and denies the second", async () => {
    expect(await acquireCooldown(redis, key, 60)).toBe(true);
    expect(await acquireCooldown(redis, key, 60)).toBe(false);
  });

  it("grants exactly one winner under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => acquireCooldown(redis, key, 60)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("reports remaining seconds and 0 when free", async () => {
    expect(await peekCooldown(redis, key)).toBe(0);
    await acquireCooldown(redis, key, 60);
    expect(await peekCooldown(redis, key)).toBeGreaterThan(0);
  });

  it("releases so a compensating path can retry immediately", async () => {
    await acquireCooldown(redis, key, 60);
    await releaseCooldown(redis, key);
    expect(await acquireCooldown(redis, key, 60)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/server/test/cooldown.test.ts`
Expected: FAIL — cannot resolve `../src/game/cooldown.js`.

- [ ] **Step 3: Write `cooldown.ts`**

`SET … NX EX` is a single atomic Redis operation, which is the whole point — a read-then-write would let two requests both observe "free" (spec §2.2).

```ts
import type { Redis } from "ioredis";

export function cooldownKey(playerId: string, action: string): string {
  return `cooldown:${action}:${playerId}`;
}

/**
 * Atomically claim a cooldown. Returns true only for the caller that won it.
 * Long timers (jail, hospital) additionally live in Postgres columns so a Redis
 * flush cannot free prisoners — see spec §2.2.
 */
export async function acquireCooldown(redis: Redis, key: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}

/** Seconds remaining, or 0 when the cooldown is free. */
export async function peekCooldown(redis: Redis, key: string): Promise<number> {
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : 0;
}

/** Compensating action: call this when an enqueue fails after acquiring. */
export async function releaseCooldown(redis: Redis, key: string): Promise<void> {
  await redis.del(key);
}
```

- [ ] **Step 4: Run the cooldown test to verify it passes**

Run: `npx vitest run apps/server/test/cooldown.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing RNG test**

Determinism is the property under test: the same seed must produce the same sequence, because that is what makes a retried job safe.

`apps/server/test/rng.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRng, newSeed } from "../src/game/rng.js";

describe("seeded rng", () => {
  it("produces 32 hex chars per seed and never repeats", () => {
    const a = newSeed();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(newSeed());
  });

  it("is deterministic for a given seed — a retried job re-rolls identically", () => {
    const seed = "0123456789abcdef0123456789abcdef";
    const first = Array.from({ length: 10 }, () => createRng(seed).int(0, 100));
    const second = Array.from({ length: 10 }, () => createRng(seed).int(0, 100));
    expect(first).toEqual(second);
  });

  it("advances within a single rng instance", () => {
    const rng = createRng("0123456789abcdef0123456789abcdef");
    const draws = Array.from({ length: 20 }, () => rng.int(0, 1_000_000));
    expect(new Set(draws).size).toBeGreaterThan(1);
  });

  it("respects bounds, min inclusive and max exclusive", () => {
    const rng = createRng(newSeed());
    for (let i = 0; i < 500; i += 1) {
      const n = rng.int(5, 10);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThan(10);
    }
  });

  it("draws bigints inclusively for money payouts", () => {
    const rng = createRng(newSeed());
    for (let i = 0; i < 200; i += 1) {
      const n = rng.bigint(100n, 200n);
      expect(n).toBeGreaterThanOrEqual(100n);
      expect(n).toBeLessThanOrEqual(200n);
    }
  });

  it("returns the bound when min equals max", () => {
    expect(createRng(newSeed()).bigint(7n, 7n)).toBe(7n);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run apps/server/test/rng.test.ts`
Expected: FAIL — cannot resolve `../src/game/rng.js`.

- [ ] **Step 7: Write `rng.ts`**

The seed comes from `node:crypto` (spec §7 bans `Math.random`). Expansion is a SHA-256 counter stream — deterministic, uniform enough for game outcomes, and rejection-sampled so no modulo bias favours low rolls.

```ts
import { createHash, randomBytes } from "node:crypto";

/** Generated at enqueue time and carried in the job payload (spec §7). */
export function newSeed(): string {
  return randomBytes(16).toString("hex");
}

export interface Rng {
  /** min inclusive, max exclusive. */
  int(minInclusive: number, maxExclusive: number): number;
  /** Both bounds inclusive — payout ranges in V2 are inclusive. */
  bigint(min: bigint, max: bigint): bigint;
}

export function createRng(seed: string): Rng {
  let counter = 0;
  let buffer = Buffer.alloc(0);
  let offset = 0;

  const refill = (): void => {
    buffer = createHash("sha256").update(`${seed}:${counter}`).digest();
    counter += 1;
    offset = 0;
  };

  const nextUint32 = (): number => {
    if (offset + 4 > buffer.length) refill();
    const value = buffer.readUInt32BE(offset);
    offset += 4;
    return value;
  };

  const int = (minInclusive: number, maxExclusive: number): number => {
    const range = maxExclusive - minInclusive;
    if (range <= 0) return minInclusive;
    // Rejection sampling removes modulo bias.
    const limit = Math.floor(0x1_0000_0000 / range) * range;
    let draw = nextUint32();
    while (draw >= limit) draw = nextUint32();
    return minInclusive + (draw % range);
  };

  const bigintDraw = (min: bigint, max: bigint): bigint => {
    if (max <= min) return min;
    const range = max - min + 1n;
    let bits = 0n;
    let acc = 0n;
    while ((1n << bits) < range) bits += 32n;
    do {
      acc = 0n;
      for (let i = 0n; i < bits; i += 32n) acc = (acc << 32n) | BigInt(nextUint32());
    } while (acc >= (1n << bits) - ((1n << bits) % range));
    return min + (acc % range);
  };

  return { int, bigint: bigintDraw };
}
```

- [ ] **Step 8: Run the RNG test to verify it passes**

Run: `npx vitest run apps/server/test/rng.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/game apps/server/test/cooldown.test.ts apps/server/test/rng.test.ts
git commit -m "feat(server): add atomic redis cooldowns and deterministic seeded rng"
```

---

### Task 8: The ledger — the only way money moves

Spec §2.3, non-negotiable: balance update **and** append-only ledger insert in one Postgres transaction, `bigint` throughout, `SELECT … FOR UPDATE` in consistent id order for multi-player mutations.

**Files:**
- Create: `apps/server/src/economy/ledger.ts`
- Test: `apps/server/test/ledger.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 4), `transactions`/`playerStats` tables.
- Produces:
  - `type BalanceKind = "cash" | "bank" | "points"`
  - `applyBalanceChange(tx, change: BalanceChange): Promise<bigint>` — returns the new balance; **must be called inside an existing transaction**
  - `interface BalanceChange { playerId: string; amount: bigint; kind: BalanceKind; reason: string; refId?: string }`
  - `lockPlayersForUpdate(tx, playerIds: string[]): Promise<void>` — locks in ascending id order
  - `InsufficientFundsError` — thrown when a debit would take a balance negative

- [ ] **Step 1: Write the failing ledger test**

The last test is the economy invariant from spec §6 M2, run small here so the property is enforced from the first day rather than retrofitted.

`apps/server/test/ledger.test.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyBalanceChange, InsufficientFundsError } from "../src/economy/ledger.js";
import { players, playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 100n });
});
afterAll(async () => { await conn.end(); });

const balance = async (): Promise<bigint> => {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
  return row?.cash ?? -1n;
};

describe("applyBalanceChange", () => {
  it("credits and writes exactly one ledger row", async () => {
    const next = await db.transaction((tx) =>
      applyBalanceChange(tx, { playerId, amount: 250n, kind: "cash", reason: "crime.payout" }));
    expect(next).toBe(350n);
    expect(await balance()).toBe(350n);

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(250n);
    expect(rows[0]?.reason).toBe("crime.payout");
  });

  it("debits when funds suffice", async () => {
    await db.transaction((tx) =>
      applyBalanceChange(tx, { playerId, amount: -40n, kind: "cash", reason: "travel.cost" }));
    expect(await balance()).toBe(60n);
  });

  it("rejects an overdraft and leaves no ledger row behind", async () => {
    await expect(
      db.transaction((tx) =>
        applyBalanceChange(tx, { playerId, amount: -101n, kind: "cash", reason: "travel.cost" })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await balance()).toBe(100n);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it("handles values beyond V2's signed 32-bit ceiling", async () => {
    const huge = 5_000_000_000n; // > 2^31-1, the exact wall real V2 games hit
    await db.transaction((tx) =>
      applyBalanceChange(tx, { playerId, amount: huge, kind: "bank", reason: "test.bigint" }));
    const [row] = await db.select({ bank: playerStats.bank }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.bank).toBe(huge);
  });

  it("keeps sum(ledger) == balance across 200 randomised ops", async () => {
    for (let i = 0; i < 200; i += 1) {
      const amount = BigInt(((i * 37) % 21) - 10); // -10..10, deterministic
      if (amount === 0n) continue;
      try {
        await db.transaction((tx) =>
          applyBalanceChange(tx, { playerId, amount, kind: "cash", reason: "test.churn" }));
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
      }
    }
    const [ledger] = await db.select({
      total: sql<string>`coalesce(sum(${transactions.amount}), 0)`,
    }).from(transactions).where(eq(transactions.balanceKind, "cash"));

    expect(await balance()).toBe(100n + BigInt(ledger?.total ?? "0"));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/server/test/ledger.test.ts`
Expected: FAIL — cannot resolve `../src/economy/ledger.js`.

- [ ] **Step 3: Write `ledger.ts`**

```ts
import { asc, eq, inArray, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../db/client.js";
import { playerStats, transactions } from "../db/schema/index.js";

export type BalanceKind = "cash" | "bank" | "points";

export interface BalanceChange {
  playerId: string;
  /** Signed: positive credits, negative debits. Always bigint — never a number. */
  amount: bigint;
  kind: BalanceKind;
  reason: string;
  refId?: string;
}

export class InsufficientFundsError extends Error {
  constructor(readonly playerId: string, readonly kind: BalanceKind) {
    super(`insufficient ${kind} for player ${playerId}`);
    this.name = "InsufficientFundsError";
  }
}

/** Drizzle's transaction callback type. Every mutation takes this, never the root Db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const column = { cash: playerStats.cash, bank: playerStats.bank, points: playerStats.points } as const;

/**
 * Lock several players' stat rows in ascending id order.
 * Consistent ordering is what prevents deadlocks when two jobs touch the same
 * pair of players in opposite order (spec §2.3).
 */
export async function lockPlayersForUpdate(tx: Tx, playerIds: string[]): Promise<void> {
  const unique = [...new Set(playerIds)].sort();
  if (unique.length === 0) return;
  await tx.select({ playerId: playerStats.playerId })
    .from(playerStats)
    .where(inArray(playerStats.playerId, unique))
    .orderBy(asc(playerStats.playerId))
    .for("update");
}

/**
 * The ONLY sanctioned way to move money. Writes the ledger row and the balance
 * in the caller's transaction — never call this outside `db.transaction(...)`.
 * Returns the new balance.
 */
export async function applyBalanceChange(tx: Tx, change: BalanceChange): Promise<bigint> {
  await lockPlayersForUpdate(tx, [change.playerId]);

  const target = column[change.kind];
  const [current] = await tx.select({ value: target })
    .from(playerStats)
    .where(eq(playerStats.playerId, change.playerId));

  if (!current) throw new Error(`player_stats missing for ${change.playerId}`);

  const next = current.value + change.amount;
  if (next < 0n) throw new InsufficientFundsError(change.playerId, change.kind);

  await tx.update(playerStats)
    .set({ [change.kind]: next })
    .where(eq(playerStats.playerId, change.playerId));

  await tx.insert(transactions).values({
    id: uuidv7(),
    playerId: change.playerId,
    amount: change.amount,
    balanceKind: change.kind,
    reason: change.reason,
    refId: change.refId ?? null,
  });

  return next;
}

/** Credit exp — not money, but bigint and same overflow concern (spec §1.1). */
export async function addExp(tx: Tx, playerId: string, amount: bigint): Promise<void> {
  if (amount === 0n) return;
  await tx.update(playerStats)
    .set({ exp: sql`${playerStats.exp} + ${amount}` })
    .where(eq(playerStats.playerId, playerId));
}
```

- [ ] **Step 4: Run the ledger test to verify it passes**

Run: `npx vitest run apps/server/test/ledger.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full gate and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add apps/server/src/economy apps/server/test/ledger.test.ts
git commit -m "feat(server): add append-only ledger as the sole path for balance changes"
```

---

### Task 9: The crime slice — bus, queue, route, worker

This is the milestone's spine: HTTP validates and acquires the cooldown, BullMQ carries a seed, the worker resolves in one Postgres transaction, and a validated event goes onto `game:events`.

**Files:**
- Create: `packages/shared/src/dto/crime.ts`; Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/bus/publish.ts`, `apps/server/src/bus/subscribe.ts`
- Create: `apps/server/src/queue/index.ts`
- Create: `apps/server/src/game/crimes/routes.ts`
- Create: `apps/server/src/game/crimes/worker.ts`
- Create: `apps/server/src/db/seed.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/index.ts`
- Test: `apps/server/test/crimes.test.ts`

**Interfaces:**
- Consumes: cooldowns + RNG (Task 7), ledger (Task 8), `requireAuth` (Task 6), `GameEventSchema` (Task 2).
- Produces:
  - `CrimeDtoSchema`, `CrimeListResponseSchema`, `CommitCrimeResponseSchema` from `@gl3/shared`
  - `publishEvent(redis, event: GameEvent): Promise<void>` and `subscribeToEvents(subscriber, handler): Promise<void>`; channel constant `GAME_EVENTS_CHANNEL = "game:events"`
  - `createCrimeQueue(redis): Queue<CrimeJobData>`; `interface CrimeJobData { playerId: string; crimeId: string; seed: string }`
  - `startCrimeWorker(deps): Worker<CrimeJobData>`
  - `seedCrimes(db): Promise<void>` — three starter crimes so the slice is playable
  - Routes: `GET /api/crimes`, `POST /api/crimes/:crimeId/commit`

- [ ] **Step 1: Write the crime DTOs**

`packages/shared/src/dto/crime.ts`:

```ts
import { z } from "zod";
import { IdSchema, MoneySchema } from "../primitives.js";

export const CrimeDtoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string(),
  cooldownSeconds: z.number().int().nonnegative(),
  minPayout: MoneySchema,
  maxPayout: MoneySchema,
  /** This player's current success chance, as a percentage string, e.g. "35.00". */
  chance: z.string(),
  /** Seconds until this player may commit again; 0 when ready. */
  cooldownRemaining: z.number().int().nonnegative(),
});
export type CrimeDto = z.infer<typeof CrimeDtoSchema>;

export const CrimeListResponseSchema = z.object({ crimes: z.array(CrimeDtoSchema) });
export type CrimeListResponse = z.infer<typeof CrimeListResponseSchema>;

/** 202 Accepted — the outcome arrives over WS, not in this response body. */
export const CommitCrimeResponseSchema = z.object({ jobId: z.string(), accepted: z.literal(true) });
export type CommitCrimeResponse = z.infer<typeof CommitCrimeResponseSchema>;
```

Append to `packages/shared/src/index.ts`:

```ts
export * from "./dto/crime.js";
```

- [ ] **Step 2: Write the bus**

Validated on both ends, per spec §2.2. Publishing an event that fails its own schema is a programming error and must throw loudly at the publisher rather than corrupt every subscriber.

`apps/server/src/bus/publish.ts`:

```ts
import { GameEventSchema, type GameEvent } from "@gl3/shared";
import type { Redis } from "ioredis";

export const GAME_EVENTS_CHANNEL = "game:events";

export async function publishEvent(redis: Redis, event: GameEvent): Promise<void> {
  const validated = GameEventSchema.parse(event);
  await redis.publish(GAME_EVENTS_CHANNEL, JSON.stringify(validated));
}
```

`apps/server/src/bus/subscribe.ts`:

```ts
import { GameEventSchema, type GameEvent } from "@gl3/shared";
import type { Redis } from "ioredis";
import { GAME_EVENTS_CHANNEL } from "./publish.js";

export type EventHandler = (event: GameEvent) => void;

/** Requires a client created with `createSubscriber` — a subscribed client runs no other commands. */
export async function subscribeToEvents(subscriber: Redis, handler: EventHandler): Promise<void> {
  await subscriber.subscribe(GAME_EVENTS_CHANNEL);
  subscriber.on("message", (channel, raw) => {
    if (channel !== GAME_EVENTS_CHANNEL) return;
    const parsed = GameEventSchema.safeParse(JSON.parse(raw));
    // A malformed frame from another instance must not take this process down.
    if (parsed.success) handler(parsed.data);
  });
}
```

- [ ] **Step 3: Write the queue registry**

`apps/server/src/queue/index.ts`. `removeOnComplete` keeps Redis from growing without bound; `attempts: 3` is safe precisely because the seed lives in the payload.

```ts
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const CRIME_QUEUE = "crime";

export interface CrimeJobData {
  playerId: string;
  crimeId: string;
  /** Generated at enqueue time so retries resolve identically (spec §7). */
  seed: string;
}

export function createCrimeQueue(redis: Redis): Queue<CrimeJobData> {
  return new Queue<CrimeJobData>(CRIME_QUEUE, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}
```

- [ ] **Step 4: Write the seed data**

`apps/server/src/db/seed.ts`. Three crimes so the slice is actually playable; values mirror V2's early ladder.

```ts
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.js";
import { crimes } from "./schema/index.js";

export async function seedCrimes(db: Db): Promise<void> {
  const existing = await db.select({ id: crimes.id }).from(crimes).limit(1);
  if (existing.length > 0) return;

  await db.insert(crimes).values([
    { id: uuidv7(), name: "Pickpocket", description: "Lift a wallet in a crowd.", cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n, minBullets: 0, maxBullets: 0, expReward: 5n, minRank: 0, sort: 10 },
    { id: uuidv7(), name: "Rob a Store", description: "Hold up the corner shop.", cooldownSeconds: 60, minPayout: 200n, maxPayout: 900n, minBullets: 0, maxBullets: 2, expReward: 12n, minRank: 0, sort: 20 },
    { id: uuidv7(), name: "Armoured Van", description: "Take the van on the freeway.", cooldownSeconds: 300, minPayout: 2000n, maxPayout: 9000n, minBullets: 1, maxBullets: 5, expReward: 40n, minRank: 0, sort: 30 },
  ]);
}
```

- [ ] **Step 5: Write the failing crime test**

The two behaviours the milestone is judged on: exactly one of two concurrent commits is accepted, and a `crime.resolved` event lands on the bus.

`apps/server/test/crimes.test.ts`:

```ts
import { GameEventSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { crimes, playerStats, transactions } from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;
let crimeId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  await seedCrimes(db);

  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "Vito", password: "hunter2hunter2" },
  });
  ({ token, playerId } = reg.json());

  const [first] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
  crimeId = first!.id;
});

afterAll(async () => { await closeServer(); await conn.end(); subscriber.disconnect(); });

const auth = { authorization: `Bearer ${token}` };

const waitForEvent = (): Promise<unknown> =>
  new Promise((resolve) => {
    subscriber.once("message", (channel, raw) => {
      if (channel === GAME_EVENTS_CHANNEL) resolve(JSON.parse(raw));
    });
  });

describe("GET /api/crimes", () => {
  it("lists crimes with this player's chance and cooldown", async () => {
    const res = await app.inject({ method: "GET", url: "/api/crimes", headers: auth });
    expect(res.statusCode).toBe(200);
    const { crimes: list } = res.json();
    expect(list).toHaveLength(3);
    expect(list[0].cooldownRemaining).toBe(0);
    expect(list[0].chance).toMatch(/^\d+\.\d{2}$/);
  });

  it("401s without a token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/crimes" })).statusCode).toBe(401);
  });
});

describe("POST /api/crimes/:crimeId/commit", () => {
  it("accepts exactly one of two concurrent commits", async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: { authorization: `Bearer ${token}` } }),
      app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: { authorization: `Bearer ${token}` } }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([202, 429]);
  });

  it("404s for an unknown crime and does not burn the cooldown", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/crimes/018f8e2a-0000-7000-8000-0000000000ff/commit", headers: auth,
    });
    expect(res.statusCode).toBe(404);
    const ok = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(ok.statusCode).toBe(202);
  });

  it("resolves in a worker, ledgers the payout, and publishes crime.resolved", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = waitForEvent();

    const res = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(res.statusCode).toBe(202);

    const event = GameEventSchema.parse(await received);
    expect(event.type).toBe("crime.resolved");
    if (event.type !== "crime.resolved") throw new Error("unreachable");
    expect(event.actorId).toBe(playerId);
    expect(event.actorName).toBe("Vito");
    expect(event.crimeName).toBe("Pickpocket");

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    if (event.success) {
      expect(stats?.cash).toBe(BigInt(event.payout));
      const ledger = await db.select().from(transactions);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.reason).toBe("crime.payout");
    } else {
      expect(stats?.cash).toBe(0n);
      expect(await db.select().from(transactions)).toHaveLength(0);
    }
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run apps/server/test/crimes.test.ts`
Expected: FAIL — `/api/crimes` returns 404, the route does not exist.

- [ ] **Step 7: Write the routes**

`apps/server/src/game/crimes/routes.ts`. Note the compensating `releaseCooldown` on enqueue failure — without it a Redis-up/BullMQ-down blip silently jails the player behind a cooldown for nothing.

```ts
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { Db } from "../../db/client.js";
import { crimes, playerCrimeSkill } from "../../db/schema/index.js";
import { acquireCooldown, cooldownKey, peekCooldown, releaseCooldown } from "../cooldown.js";
import { newSeed } from "../rng.js";
import type { CrimeJobData } from "../../queue/index.js";

/** V2 shipped a default ladder starting at 35% (spec §1.2 US_crimes default string). */
export const DEFAULT_CRIME_CHANCE = "35.00";

export function registerCrimeRoutes(
  app: FastifyInstance, db: Db, redis: Redis, queue: Queue<CrimeJobData>,
  requireAuth: (request: FastifyRequest, reply: never) => Promise<void>,
): void {
  app.get("/api/crimes", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const rows = await db.select().from(crimes).orderBy(asc(crimes.sort));
    const skills = await db.select().from(playerCrimeSkill).where(eq(playerCrimeSkill.playerId, playerId));
    const skillByCrime = new Map(skills.map((s) => [s.crimeId, s.chance]));
    const remaining = await peekCooldown(redis, cooldownKey(playerId, "crime"));

    return reply.send({
      crimes: rows.map((crime) => ({
        id: crime.id,
        name: crime.name,
        description: crime.description,
        cooldownSeconds: crime.cooldownSeconds,
        minPayout: crime.minPayout.toString(),
        maxPayout: crime.maxPayout.toString(),
        chance: skillByCrime.get(crime.id) ?? DEFAULT_CRIME_CHANCE,
        cooldownRemaining: remaining,
      })),
    });
  });

  app.post("/api/crimes/:crimeId/commit", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const { crimeId } = request.params as { crimeId: string };

    // Look the crime up BEFORE claiming the cooldown so a typo costs nothing.
    const [crime] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
    if (!crime) return reply.code(404).send({ error: "crime_not_found" });

    const key = cooldownKey(playerId, "crime");
    const won = await acquireCooldown(redis, key, crime.cooldownSeconds);
    if (!won) {
      const retryAfter = await peekCooldown(redis, key);
      reply.header("retry-after", String(Math.max(retryAfter, 1)));
      return reply.code(429).send({ error: "on_cooldown", retryAfter });
    }

    try {
      const job = await queue.add("commit", { playerId, crimeId, seed: newSeed() });
      return reply.code(202).send({ jobId: job.id ?? "", accepted: true });
    } catch (error) {
      await releaseCooldown(redis, key); // don't strand the player behind a cooldown
      throw error;
    }
  });
}
```

- [ ] **Step 8: Write the worker**

`apps/server/src/game/crimes/worker.ts`. Everything random happens here, seeded from the payload. The balance change and the crime-log insert share one transaction with the ledger write.

```ts
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { crimeLog, crimes, playerCrimeSkill, players } from "../../db/schema/index.js";
import { addExp, applyBalanceChange } from "../../economy/ledger.js";
import { CRIME_QUEUE, type CrimeJobData } from "../../queue/index.js";
import { createRng } from "../rng.js";
import { DEFAULT_CRIME_CHANCE } from "./routes.js";

export interface CrimeWorkerDeps { db: Db; connection: Redis; publisher: Redis }

export function startCrimeWorker({ db, connection, publisher }: CrimeWorkerDeps): Worker<CrimeJobData> {
  return new Worker<CrimeJobData>(CRIME_QUEUE, async (job) => {
    const { playerId, crimeId, seed } = job.data;

    const [crime] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
    if (!crime) return; // crime deleted between enqueue and resolve — drop the job

    // SPEC §3: every event carries the acting player's id *and display name*.
    const [actor] = await db.select({ username: players.username })
      .from(players).where(eq(players.id, playerId));
    if (!actor) return; // player deleted between enqueue and resolve

    const [skill] = await db.select().from(playerCrimeSkill)
      .where(eq(playerCrimeSkill.playerId, playerId));
    const chance = Number(skill?.chance ?? DEFAULT_CRIME_CHANCE);

    // All randomness lives here, derived from the enqueue-time seed (spec §7).
    const rng = createRng(seed);
    const roll = rng.int(0, 10_000); // two decimals of precision
    const success = roll < Math.round(chance * 100);

    const payout = success ? rng.bigint(crime.minPayout, crime.maxPayout) : 0n;
    const bullets = success ? BigInt(rng.int(crime.minBullets, crime.maxBullets + 1)) : 0n;
    const exp = success ? crime.expReward : 0n;

    await db.transaction(async (tx) => {
      if (payout > 0n) {
        await applyBalanceChange(tx, {
          playerId, amount: payout, kind: "cash", reason: "crime.payout", refId: crimeId,
        });
      }
      if (exp > 0n) await addExp(tx, playerId, exp);
      await tx.insert(crimeLog).values({
        id: uuidv7(), playerId, crimeId, success, payout,
      });
    });

    // SPEC §3: events are facts, not commands — published only AFTER the
    // transaction above commits. Never publish inside db.transaction(...).
    const event: GameEvent = {
      id: uuidv7(),
      type: "crime.resolved",
      at: new Date().toISOString(),
      actorId: playerId,
      actorName: actor.username,
      audience: { kind: "player", playerId },
      crimeId,
      crimeName: crime.name,
      success,
      payout: payout.toString(),
      bullets: bullets.toString(),
      exp: exp.toString(),
      jailedUntil: null, // jail lands in M2
    };
    await publishEvent(publisher, event);
  }, { connection, concurrency: 5 });
}
```

- [ ] **Step 9: Wire crimes into the app and the entrypoint**

In `apps/server/src/app.ts`, extend `AppDeps` and register the routes:

```ts
export interface AppDeps { db: Db; redis: Redis; crimeQueue: Queue<CrimeJobData> }
```

and inside `buildApp`, after `registerAuthRoutes(...)`:

```ts
const requireAuth = app.requireAuth as (request: FastifyRequest, reply: never) => Promise<void>;
registerCrimeRoutes(app, deps.db, deps.redis, deps.crimeQueue, requireAuth);
```

Add the matching declaration next to the existing `FastifyRequest` augmentation in `auth/routes.ts`:

```ts
declare module "fastify" {
  interface FastifyInstance { requireAuth: (request: FastifyRequest, reply: never) => Promise<void> }
}
```

In `apps/server/src/index.ts`, create the queue, start the worker, and seed:

```ts
const crimeQueue = createCrimeQueue(createRedis(config.redisUrl));
await seedCrimes(db);
startCrimeWorker({ db, connection: createRedis(config.redisUrl), publisher: createRedis(config.redisUrl) });
const app = await buildApp(config, { db, redis, crimeQueue });
```

Update `apps/server/test/helpers/server.ts` the same way, and start the worker there too — the crime test needs a live worker, and spec §6 forbids mocking the queue path.

- [ ] **Step 10: Run the crime tests to verify they pass**

Run: `npx vitest run apps/server/test/crimes.test.ts`
Expected: PASS, 5 tests. The concurrency test is the milestone criterion — if both requests return 202, `acquireCooldown` is not using `NX`.

- [ ] **Step 11: Run the full gate and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add packages/shared apps/server
git commit -m "feat(server): add crime slice with cooldown, queue, worker, and event bus"
```

---

### Task 10: WebSocket gateway

Spec §2.2: `ws` attached to the Fastify server on `/ws`, authenticated by session token in the query string. The gateway subscribes to `game:events` and routes purely on the event's `audience` — it knows nothing about crimes, gangs, or any other feature, which is what keeps §5's "core may not reach into a plugin" boundary honest.

**Files:**
- Create: `apps/server/src/ws/gateway.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/ws.test.ts`

**Interfaces:**
- Consumes: `readSession` (Task 6), `subscribeToEvents` + `createSubscriber` (Tasks 5, 9), `ServerFrameSchema` (Task 2), `gangMembers` (Task 4).
- Produces: `attachGateway(server: http.Server, deps: GatewayDeps): Promise<GatewayHandle>` where `GatewayDeps = { db: Db; redis: Redis; subscriber: Redis }` and `GatewayHandle = { close(): Promise<void>; connectionCount(): number }`.

- [ ] **Step 1: Write the failing gateway test**

`apps/server/test/ws.test.ts`. This test uses a **real listening server** — `inject` cannot perform a WS upgrade.

```ts
import type { AddressInfo } from "node:net";
import { ServerFrameSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crimes } from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let baseUrl: string;
let token: string;
let crimeId: string;

beforeAll(async () => {
  ({ app, close: closeServer } = await bootTestServer());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}/ws`;
});

beforeEach(async () => {
  await resetDb(db);
  await seedCrimes(db);
  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "Vito", password: "hunter2hunter2" },
  });
  ({ token } = reg.json());
  const [first] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
  crimeId = first!.id;
});

afterAll(async () => { await closeServer(); await conn.end(); });

const open = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

const nextFrame = (socket: WebSocket): Promise<unknown> =>
  new Promise((resolve) => socket.once("message", (raw) => resolve(JSON.parse(raw.toString()))));

describe("/ws gateway", () => {
  it("rejects a connection with no token", async () => {
    await expect(open(baseUrl)).rejects.toThrow();
  });

  it("rejects a connection with a bogus token", async () => {
    await expect(open(`${baseUrl}?token=not-a-real-token`)).rejects.toThrow();
  });

  it("sends a ready frame naming the authenticated player", async () => {
    const socket = await open(`${baseUrl}?token=${token}`);
    const frame = ServerFrameSchema.parse(await nextFrame(socket));
    expect(frame.kind).toBe("ready");
    socket.close();
  });

  it("answers ping with pong", async () => {
    const socket = await open(`${baseUrl}?token=${token}`);
    await nextFrame(socket); // ready
    socket.send(JSON.stringify({ kind: "ping" }));
    const frame = ServerFrameSchema.parse(await nextFrame(socket));
    expect(frame.kind).toBe("pong");
    socket.close();
  });

  it("delivers crime.resolved to the acting player", async () => {
    const socket = await open(`${baseUrl}?token=${token}`);
    await nextFrame(socket); // ready
    const incoming = nextFrame(socket);

    const res = await app.inject({
      method: "POST", url: `/api/crimes/${crimeId}/commit`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(202);

    const frame = ServerFrameSchema.parse(await incoming);
    expect(frame.kind).toBe("event");
    if (frame.kind !== "event") throw new Error("unreachable");
    expect(frame.event.type).toBe("crime.resolved");
    socket.close();
  });

  it("does not leak another player's event", async () => {
    const other = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Sonny", password: "hunter2hunter2" },
    });
    const socket = await open(`${baseUrl}?token=${other.json().token}`);
    await nextFrame(socket); // ready

    let leaked = false;
    socket.on("message", (raw) => {
      const frame = ServerFrameSchema.parse(JSON.parse(raw.toString()));
      if (frame.kind === "event" && frame.event.type === "crime.resolved") leaked = true;
    });

    await app.inject({
      method: "POST", url: `/api/crimes/${crimeId}/commit`,
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(leaked).toBe(false);
    socket.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/server/test/ws.test.ts`
Expected: FAIL — every connection is refused; there is no `/ws` handler.

- [ ] **Step 3: Write `gateway.ts`**

Two details worth care: `noServer: true` plus a manual `upgrade` handler is what lets the token be rejected **before** the socket completes its handshake, and the per-player socket registry is a `Map<string, Set<WebSocket>>` because one player may have several tabs open.

```ts
import type { Server } from "node:http";
import { ServerFrameSchema, ClientFrameSchema, type GameEvent, type ServerFrame } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { WebSocketServer, type WebSocket } from "ws";
import { readSession } from "../auth/session.js";
import { subscribeToEvents } from "../bus/subscribe.js";
import type { Db } from "../db/client.js";
import { gangMembers } from "../db/schema/index.js";

export interface GatewayDeps { db: Db; redis: Redis; subscriber: Redis }
export interface GatewayHandle { close(): Promise<void>; connectionCount(): number }

export async function attachGateway(server: Server, deps: GatewayDeps): Promise<GatewayHandle> {
  const wss = new WebSocketServer({ noServer: true });
  /** One player may hold several sockets (multiple tabs). */
  const sockets = new Map<string, Set<WebSocket>>();

  const send = (socket: WebSocket, frame: ServerFrame): void => {
    socket.send(JSON.stringify(ServerFrameSchema.parse(frame)));
  };

  const sendToPlayer = (playerId: string, frame: ServerFrame): void => {
    for (const socket of sockets.get(playerId) ?? []) send(socket, frame);
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return;

    const token = url.searchParams.get("token");
    void (async () => {
      const playerId = token ? await readSession(deps.redis, token) : null;
      if (!playerId) {
        // Reject before the handshake completes — no half-open authed socket.
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const existing = sockets.get(playerId) ?? new Set<WebSocket>();
        existing.add(ws);
        sockets.set(playerId, existing);

        ws.on("message", (raw) => {
          const parsed = ClientFrameSchema.safeParse(JSON.parse(raw.toString()));
          if (!parsed.success) { send(ws, { kind: "error", message: "invalid_frame" }); return; }
          if (parsed.data.kind === "ping") send(ws, { kind: "pong" });
        });

        ws.on("close", () => {
          const set = sockets.get(playerId);
          set?.delete(ws);
          if (set && set.size === 0) sockets.delete(playerId);
        });

        send(ws, { kind: "ready", playerId });
      });
    })();
  });

  /** Routing is driven entirely by event.audience — the gateway knows no game rules. */
  const route = async (event: GameEvent): Promise<void> => {
    const frame: ServerFrame = { kind: "event", event };
    switch (event.audience.kind) {
      case "global":
        for (const set of sockets.values()) for (const socket of set) send(socket, frame);
        return;
      case "player":
        sendToPlayer(event.audience.playerId, frame);
        return;
      case "gang": {
        const members = await deps.db.select({ playerId: gangMembers.playerId })
          .from(gangMembers).where(eq(gangMembers.gangId, event.audience.gangId));
        for (const member of members) sendToPlayer(member.playerId, frame);
        return;
      }
    }
  };

  await subscribeToEvents(deps.subscriber, (event) => { void route(event); });

  return {
    connectionCount: () => [...sockets.values()].reduce((n, set) => n + set.size, 0),
    close: async () => {
      for (const set of sockets.values()) for (const socket of set) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
```

- [ ] **Step 4: Attach the gateway in the entrypoint and the test helper**

In `apps/server/src/index.ts`, after `app.listen(...)`:

```ts
await attachGateway(app.server, { db, redis, subscriber: createSubscriber(config.redisUrl) });
```

In `apps/server/test/helpers/server.ts`, attach it in `bootTestServer` and close it in `close()` — the WS test's `beforeAll` calls `app.listen` itself, and `attachGateway` only needs `app.server`, which exists before listening.

- [ ] **Step 5: Run the gateway tests to verify they pass**

Run: `npx vitest run apps/server/test/ws.test.ts`
Expected: PASS, 6 tests. If the leak test fails, `route` is ignoring `audience` and broadcasting.

- [ ] **Step 6: Run the full gate and commit**

Run: `npm run verify`
Expected: exits 0.

```bash
git add apps/server
git commit -m "feat(server): add authenticated websocket gateway with audience routing"
```

---

### Task 11: React client — login, crimes, live feed

Spec §2.4: React 18 + Vite, TanStack Query for REST plus a thin WS hook feeding an event store, single dark theme, CSS modules, dev proxy for `/api` and `/ws`.

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `src/App.tsx`, `src/theme.css`
- Create: `apps/web/src/api/client.ts`, `src/api/queries.ts`
- Create: `apps/web/src/store/events.ts`, `src/ws/useGameEvents.ts`
- Create: `apps/web/src/pages/Login.tsx`, `src/pages/Crimes.tsx`, `src/components/EventFeed.tsx`
- Create: `apps/web/src/pages/Crimes.module.css`

**Interfaces:**
- Consumes: every DTO and `GameEvent` from `@gl3/shared`; the REST + WS surface from Tasks 6, 9, 10.
- Produces: a running dev client at `http://localhost:5173` that registers, logs in, lists crimes, commits one, and renders the resulting `crime.resolved` live.

**Note on this task's tests:** the browser layer is verified by the M1 acceptance test in Task 12 (which drives the same HTTP + WS contract headlessly) plus manual verification in Step 8. Do not add jsdom component tests here — spec §6 spends its testing budget on real Postgres/Redis integration paths.

- [ ] **Step 1: Create the web package**

`apps/web/package.json`:

```json
{
  "name": "@gl3/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --build && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@gl3/shared": "*",
    "@tanstack/react-query": "^5.62.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.3"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "composite": false,
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../../packages/shared" }]
}
```

Run `npm install`.

- [ ] **Step 2: Write the Vite config with the dev proxy**

`apps/web/vite.config.ts`. `ws: true` on the `/ws` entry is what makes the upgrade pass through the dev server.

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GL3</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Write the API client**

`apps/web/src/api/client.ts`. The token lives in `localStorage` because the auth scheme is bearer tokens, not cookies (spec §7 — no CSRF surface by design).

```ts
const TOKEN_KEY = "gl3.token";

export const tokenStore = {
  get: (): string | null => localStorage.getItem(TOKEN_KEY),
  set: (token: string): void => localStorage.setItem(TOKEN_KEY, token),
  clear: (): void => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? "unknown_error");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
```

- [ ] **Step 4: Write the query hooks**

`apps/web/src/api/queries.ts`. Every response is parsed with the shared schema — the client trusts the network no more than the server does.

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AuthResponseSchema, CommitCrimeResponseSchema, CrimeListResponseSchema, MeResponseSchema,
  type CrimeListResponse, type MeResponse,
} from "@gl3/shared";
import { api, tokenStore } from "./client.js";

export function useMe() {
  return useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: async () => MeResponseSchema.parse(await api("/api/auth/me")),
    retry: false,
  });
}

export function useCrimes() {
  return useQuery<CrimeListResponse>({
    queryKey: ["crimes"],
    queryFn: async () => CrimeListResponseSchema.parse(await api("/api/crimes")),
  });
}

export function useAuth(mode: "login" | "register") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { username: string; password: string }) => {
      const body = AuthResponseSchema.parse(
        await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify(input) }),
      );
      tokenStore.set(body.token);
      return body;
    },
    onSuccess: () => { void queryClient.invalidateQueries(); },
  });
}

export function useCommitCrime() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (crimeId: string) =>
      CommitCrimeResponseSchema.parse(
        await api(`/api/crimes/${crimeId}/commit`, { method: "POST" }),
      ),
    // The outcome arrives over WS; refresh the cooldown list immediately.
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["crimes"] }); },
  });
}
```

- [ ] **Step 5: Write the event store and the WS hook**

`apps/web/src/store/events.ts` — deliberately thin, per spec §2.4. Capped so a long session cannot grow without bound.

```ts
import { useSyncExternalStore } from "react";
import type { GameEvent } from "@gl3/shared";

const MAX_EVENTS = 50;
let events: GameEvent[] = [];
const listeners = new Set<() => void>();

export const eventStore = {
  push(event: GameEvent): void {
    events = [event, ...events].slice(0, MAX_EVENTS);
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot: (): GameEvent[] => events,
};

export function useEvents(): GameEvent[] {
  return useSyncExternalStore(eventStore.subscribe, eventStore.snapshot);
}
```

`apps/web/src/ws/useGameEvents.ts`:

```ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ServerFrameSchema } from "@gl3/shared";
import { tokenStore } from "../api/client.js";
import { eventStore } from "../store/events.js";

export function useGameEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const token = tokenStore.get();
    if (!token) return;

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws?token=${token}`);

    socket.addEventListener("message", (message) => {
      const parsed = ServerFrameSchema.safeParse(JSON.parse(message.data as string));
      if (!parsed.success || parsed.data.kind !== "event") return;
      eventStore.push(parsed.data.event);
      // A resolved crime changed cash and cooldowns — pull the fresh numbers.
      if (parsed.data.event.type === "crime.resolved") {
        void queryClient.invalidateQueries({ queryKey: ["me"] });
        void queryClient.invalidateQueries({ queryKey: ["crimes"] });
      }
    });

    const ping = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: "ping" }));
    }, 30_000);

    return () => { clearInterval(ping); socket.close(); };
  }, [queryClient]);
}
```

- [ ] **Step 6: Write the pages**

`apps/web/src/pages/Login.tsx`:

```tsx
import { useState } from "react";
import { useAuth } from "../api/queries.js";

export function Login(): JSX.Element {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const auth = useAuth(mode);

  return (
    <form
      onSubmit={(event) => { event.preventDefault(); auth.mutate({ username, password }); }}
    >
      <h1>GL3</h1>
      <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" autoComplete="username" />
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" autoComplete="current-password" />
      <button type="submit" disabled={auth.isPending}>{mode === "login" ? "Log in" : "Register"}</button>
      <button type="button" onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "Need an account?" : "Have an account?"}
      </button>
      {auth.isError ? <p role="alert">{auth.error.message}</p> : null}
    </form>
  );
}
```

`apps/web/src/pages/Crimes.tsx`:

```tsx
import { useCommitCrime, useCrimes, useMe } from "../api/queries.js";
import { EventFeed } from "../components/EventFeed.js";
import styles from "./Crimes.module.css";

export function Crimes(): JSX.Element {
  const me = useMe();
  const crimes = useCrimes();
  const commit = useCommitCrime();

  if (crimes.isLoading || me.isLoading) return <p>Loading…</p>;

  return (
    <main className={styles.layout}>
      <section>
        <h2>{me.data?.username}</h2>
        <p>Cash: ${me.data?.cash} · Bank: ${me.data?.bank} · Exp: {me.data?.exp}</p>

        <ul className={styles.crimeList}>
          {crimes.data?.crimes.map((crime) => (
            <li key={crime.id} className={styles.crime}>
              <div>
                <strong>{crime.name}</strong>
                <span> — {crime.chance}% · ${crime.minPayout}–${crime.maxPayout}</span>
              </div>
              <button
                type="button"
                disabled={crime.cooldownRemaining > 0 || commit.isPending}
                onClick={() => commit.mutate(crime.id)}
              >
                {crime.cooldownRemaining > 0 ? `${crime.cooldownRemaining}s` : "Commit"}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <EventFeed />
    </main>
  );
}
```

`apps/web/src/components/EventFeed.tsx`:

```tsx
import type { GameEvent } from "@gl3/shared";
import { useEvents } from "../store/events.js";

function describe(event: GameEvent): string {
  switch (event.type) {
    case "crime.resolved":
      return event.success
        ? `${event.crimeName}: succeeded, +$${event.payout} (+${event.exp} exp)`
        : `${event.crimeName}: failed`;
    default:
      return event.type;
  }
}

export function EventFeed(): JSX.Element {
  const events = useEvents();
  return (
    <aside>
      <h3>Live feed</h3>
      {events.length === 0 ? <p>Nothing yet.</p> : null}
      <ul>
        {events.map((event) => (
          <li key={event.id}>
            <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time> {describe(event)}
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

`apps/web/src/pages/Crimes.module.css`:

```css
.layout { display: grid; grid-template-columns: 2fr 1fr; gap: 2rem; padding: 2rem; }
.crimeList { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.crime {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.75rem 1rem; border: 1px solid #2a2a30; border-radius: 6px; background: #17171c;
}
```

- [ ] **Step 7: Write the app shell and entrypoint**

`apps/web/src/theme.css` — the single dark theme spec §2.4 calls for:

```css
:root { color-scheme: dark; --bg: #101014; --fg: #e6e6ea; --accent: #c8963e; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
button { background: var(--accent); color: #17171c; border: 0; border-radius: 4px; padding: 0.4rem 0.9rem; cursor: pointer; }
button:disabled { opacity: 0.45; cursor: default; }
input { background: #17171c; color: var(--fg); border: 1px solid #2a2a30; border-radius: 4px; padding: 0.4rem 0.6rem; }
```

`apps/web/src/App.tsx`:

```tsx
import { useMe } from "./api/queries.js";
import { Crimes } from "./pages/Crimes.js";
import { Login } from "./pages/Login.js";
import { useGameEvents } from "./ws/useGameEvents.js";

export function App(): JSX.Element {
  const me = useMe();
  useGameEvents();
  return me.isSuccess ? <Crimes /> : <Login />;
}
```

`apps/web/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./theme.css";

const queryClient = new QueryClient();
const container = document.getElementById("root");
if (!container) throw new Error("#root missing from index.html");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 8: Verify the slice by hand**

```bash
npm run db:up
DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3 npm --workspace @gl3/server run db:migrate
npm --workspace @gl3/server run dev   # terminal 1
npm --workspace @gl3/web run dev      # terminal 2
```

Open `http://localhost:5173`, register a user, click **Commit** on Pickpocket. Expected: the button greys out with a countdown, and within a second a `crime.resolved` line appears in the live feed and the cash figure updates. That is the M1 slice, visible.

- [ ] **Step 9: Typecheck and commit**

Add `{ "path": "./apps/web" }` to the root `tsconfig.json` references.

Run: `npm run verify`
Expected: exits 0.

```bash
git add apps/web tsconfig.json package-lock.json
git commit -m "feat(web): add login, crimes page, and live websocket event feed"
```

---

### Task 12: M1 acceptance test

Spec §6 states M1's criterion exactly: *"integration test: two concurrent commits, exactly one accepted; WS client receives `crime.resolved`."* Tasks 9 and 10 each proved half of that against their own surface. This test asserts the whole chain in one run, so the milestone has a single gate that fails loudly if any link regresses.

**Files:**
- Create: `apps/server/test/acceptance/m1-vertical-slice.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–10. Produces no new code — this is a pure verification task.

- [ ] **Step 1: Write the acceptance test**

`apps/server/test/acceptance/m1-vertical-slice.test.ts`:

```ts
import type { AddressInfo } from "node:net";
import { ServerFrameSchema, type GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crimeLog, crimes, playerStats, transactions } from "../../src/db/schema/index.js";
import { seedCrimes } from "../../src/db/seed.js";
import { resetDb, testDb } from "../helpers/db.js";
import { bootTestServer } from "../helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let wsBase: string;

beforeAll(async () => {
  ({ app, close: closeServer } = await bootTestServer());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  wsBase = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => { await closeServer(); await conn.end(); });
beforeEach(async () => { await resetDb(db); await seedCrimes(db); });

async function register(username: string): Promise<{ token: string; playerId: string }> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}?token=${token}`);
    socket.once("error", reject);
    socket.once("message", (raw) => {
      const frame = ServerFrameSchema.parse(JSON.parse(raw.toString()));
      if (frame.kind === "ready") resolve(socket);
    });
  });
}

function awaitCrimeResolved(socket: WebSocket, timeoutMs = 5000): Promise<GameEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for crime.resolved")), timeoutMs);
    socket.on("message", (raw) => {
      const frame = ServerFrameSchema.parse(JSON.parse(raw.toString()));
      if (frame.kind === "event" && frame.event.type === "crime.resolved") {
        clearTimeout(timer);
        resolve(frame.event);
      }
    });
  });
}

describe("M1 acceptance — commit-crime vertical slice", () => {
  it("accepts exactly one of two concurrent commits and delivers crime.resolved over WS", async () => {
    const { token, playerId } = await register("Vito");
    const socket = await connect(token);
    const resolved = awaitCrimeResolved(socket);

    const [pickpocket] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
    const url = `/api/crimes/${pickpocket!.id}/commit`;
    const headers = { authorization: `Bearer ${token}` };

    // HTTP → Redis cooldown: two simultaneous requests, one winner.
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url, headers }),
      app.inject({ method: "POST", url, headers }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 429]);

    // BullMQ → Postgres tx → pub/sub → WS.
    const event = await resolved;
    if (event.type !== "crime.resolved") throw new Error("unreachable");
    expect(event.actorId).toBe(playerId);
    expect(event.actorName).toBe("Vito");
    expect(event.crimeName).toBe("Pickpocket");

    // Exactly one job ran, so exactly one crime_log row exists.
    expect(await db.select().from(crimeLog)).toHaveLength(1);

    // Economy invariant: the ledger explains the balance, with no row on a failure.
    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    const ledger = await db.select().from(transactions);
    if (event.success) {
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.amount).toBe(BigInt(event.payout));
      expect(stats?.cash).toBe(BigInt(event.payout));
    } else {
      expect(ledger).toHaveLength(0);
      expect(stats?.cash).toBe(0n);
    }

    socket.close();
  });

  it("keeps two different players independent — each gets only their own outcome", async () => {
    const vito = await register("Vito");
    const sonny = await register("Sonny");
    const [vitoSocket, sonnySocket] = await Promise.all([connect(vito.token), connect(sonny.token)]);

    const vitoEvent = awaitCrimeResolved(vitoSocket);
    const sonnyEvent = awaitCrimeResolved(sonnySocket);

    const [pickpocket] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
    const url = `/api/crimes/${pickpocket!.id}/commit`;

    // A cooldown is per player, so both are accepted.
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url, headers: { authorization: `Bearer ${vito.token}` } }),
      app.inject({ method: "POST", url, headers: { authorization: `Bearer ${sonny.token}` } }),
    ]);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);

    const [forVito, forSonny] = await Promise.all([vitoEvent, sonnyEvent]);
    if (forVito.type !== "crime.resolved" || forSonny.type !== "crime.resolved") throw new Error("unreachable");
    expect(forVito.actorId).toBe(vito.playerId);
    expect(forSonny.actorId).toBe(sonny.playerId);

    expect(await db.select().from(crimeLog)).toHaveLength(2);

    vitoSocket.close();
    sonnySocket.close();
  });
});
```

- [ ] **Step 2: Run the acceptance test**

Run: `npx vitest run apps/server/test/acceptance/m1-vertical-slice.test.ts`
Expected: PASS, 2 tests.

Debugging guide if it hangs on `timed out waiting for crime.resolved`, in the order worth checking: (1) the worker is not started in `bootTestServer`; (2) `publishEvent` is using the subscriber client instead of a command client; (3) `attachGateway` was passed the same Redis instance for `redis` and `subscriber`.

- [ ] **Step 3: Run the full gate and commit**

Run: `npm run verify`
Expected: exits 0, all suites green.

```bash
git add apps/server/test/acceptance
git commit -m "test: add M1 acceptance test for the commit-crime vertical slice"
```

---

### Task 13: README documenting the deliberate V2 model changes

Spec §2.5 explicitly requires this: *"Deliberate model changes vs V2 (document these in the README)."* It is the artefact the V2 community reads first, so it ships with M1 rather than being backfilled.

**Files:**
- Create: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write `README.md`**

```markdown
# GL3

A modern successor to [Gangster Legends V2](https://github.com/ChristopherDay/Gangster-Legends-V2),
with a one-command migration path for existing V2 games.

**Stack:** Node.js 22 · TypeScript (strict) · Fastify 5 · PostgreSQL 16 · Redis 7 (BullMQ + pub/sub) · WebSockets · React 18 + Vite

## Quick start

```bash
npm install
npm run db:up
DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3 npm --workspace @gl3/server run db:migrate
npm --workspace @gl3/server run dev   # http://localhost:3000
npm --workspace @gl3/web run dev      # http://localhost:5173
```

Copy `.env.example` to `.env` and adjust as needed. Run `npm run verify` (typecheck + tests)
before every commit; integration tests need Postgres and Redis up.

## Layout

- `apps/server` — Fastify API, WS gateway, BullMQ workers
- `apps/web` — React client
- `packages/shared` — zod event contracts and DTOs, shared by both

## Deliberate model changes vs V2

GL3 is not a schema copy. These changes are intentional, and the migration CLI maps across them:

| V2 | GL3 | Why |
|---|---|---|
| `users` + `userStats` | `players` + `player_stats` | Same 1:1 split, kept for hot-row separation |
| `int(11)` money (signed 32-bit) | `bigint` everywhere | Long-running V2 games hit the ~2.14B ceiling |
| unix-epoch `int(11)` timestamps | `timestamptz` | Real dates, real time zones |
| `AUTO_INCREMENT` integer PKs | UUIDv7 PKs | The migrator keeps an `id_map` for cross-references |
| no foreign keys anywhere | real FKs with `ON DELETE` rules | Orphans become impossible rather than merely common |
| `userStats.US_gang` integer | `gang_members` join table | A player's gang is a relationship, not a column |
| `userStats.US_crimes` dash-delimited string | `player_crime_skill` rows | Indexed by crime id, not by string position |
| `items` + `itemEffects` + `itemMeta` EAV | `items.effects` / `items.meta` JSONB | One row per item instead of three tables |
| `gangPermissions` with no gang column | `gang_permissions` with a real `gang_id` | V2 implied the gang from the member's `US_gang` |
| `properties.PR_module` varchar | `properties.plugin_id` varchar | Same string coupling, renamed to GL3's vocabulary |
| all timers in `userTimers` | typed `jailed_until` / `hospital_until` + generic `player_timers` | Action-gating timers get columns; everything else stays open-ended |
| `sha256(U_id . password)` passwords | argon2id, lazily upgraded | No forced resets — see below |

## Passwords for migrated players

V2 stored `sha256(U_id . plaintext)`, unsalted beyond the user id and with no work factor.
Migration copies that hash verbatim into `players.legacy_password_sha256` and leaves
`password_hash` null. On the first successful login GL3 verifies against the legacy formula,
rehashes the password with argon2id, and nulls the legacy column. Players never notice, and
nobody is forced to reset.

## Status

- **M0 Scaffold** — done
- **M1 Auth + vertical slice** — done (register/login, sessions, commit-crime end to end)
- **M2 Core loop parity** — next (jail, ranks/exp, bank, travel, bullets, leaderboards)
- **M3 Social**, **M4 Migration CLI**, **M5 Plugin SDK** — planned

Casino, forum, membership, detectives, bounties, kill/hospital, properties, and car theft
have schema but no gameplay yet, by design.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document deliberate v2 model changes and quick start"
```

**M1 is now complete** — spec §6's acceptance criterion passes end to end.

---

## Out of scope for this plan

Deliberately not built here, in spec order. Each gets its own plan.

- **M2 Core loop parity** — jail, ranks/exp, bank deposit/withdraw, travel, bullets shop, leaderboards (Redis sorted sets rebuilt from Postgres on boot). Acceptance: `sum(ledger) == balance` across 1000 randomised ops.
- **M3 Social** — gangs (create/invite/roles/bank/logs), mail, notifications, profile, game news.
- **M4 Migration CLI** — all of spec §4, now fully specified. The interface per §4.1 is `gl3-migrate --mysql mysql://user:pass@host/db --pg postgres://... [--dry-run] [--report report.json]`, plus `--sql-dump dump.sql` (which per §4.1 requires loading into a scratch MySQL — no dump parser). This plan already lays its two foundations: the `id_map` table (idempotent re-runs, §4.2.3) and the §4.3 legacy login path.
- **M5 Plugin SDK** — loader, ctx API, crimes and bank refactored into plugins, an example third-party plugin.
- Forum, casino, and membership gameplay — schema only, per spec §7.

---

## Plan self-review

Checked against SPEC.md with fresh eyes.

**Spec coverage.** §2.1 layout → Tasks 1, 3, 11. §2.2 server runtime, HTTP, WS, DB, auth, queue, bus, cooldowns → Tasks 3–10 (leaderboards deferred to M2 with the rest of §2.2's sorted-set work). §2.3 economy invariants → Task 8, all three clauses (single transaction, `bigint`, ordered `FOR UPDATE`). §2.4 client → Task 11. §2.5 schema → Task 4, all 32 tables, with the model changes documented in Task 13 as §2.5 requires. §3 event contracts → Task 2. §4.3 legacy password flow → Tasks 5 and 6. §6 M0 and M1 acceptance → Tasks 4 and 12. §7 guardrails → Global Constraints, enforced concretely in Tasks 3 (CORS, config), 6 (rate limits), 7 (seeded RNG in workers only), 8 (ledger).

**§3's three server-side rules are each pinned to a task.** Actor id + display name on every event → Task 2's base object, with a test that rejects an event missing either. Validate before fan-out and before rendering → `publishEvent`/`subscribeToEvents` (Task 9) and the browser's `ServerFrameSchema.safeParse` (Task 11). Facts, not commands — publish only after commit → Task 9's worker, commented at the publish site.

**Known gaps, stated rather than papered over.** SPEC §6's M0/M1/M2 bullets are corrupted in the current revision; their verbatim text is preserved at the top of this plan and at each milestone heading. §5's plugin SDK is untouched by design — spec §6 sequences it at M5, and §7 says M1's slice must be playable before M2 starts.

**Type consistency.** `buildApp` changes signature twice (Task 3 → Task 6 → Task 9); both changes are called out in the task that makes them, along with the test file that must be updated. `AppDeps` is the single shape every later route registration flows through. `Tx` from `ledger.ts` is the transaction type used by the worker in Task 9. `DEFAULT_CRIME_CHANCE` is defined in `crimes/routes.ts` and imported by `crimes/worker.ts` — one definition, two consumers.
