# Multiplayer Blackjack Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shared blackjack tables — up to 5 seats, one dealer, turn-based play, seats persisting across hands — with the table machinery generic in the casino hub.

**Architecture:** The hub (`@gl3/plugin-casino`) grows two tables (`p_casino_tables`, `p_casino_seats`), a `TableGameDef` contract on a new `casino.tableGames` filter point, five routes under `/api/casino/table`, and a lazy clock (no scheduler exists — `ensureCurrentRound` shape). Blackjack stays pure rules and moves from the solo registry to the table registry. The solo engine stays, tested via a synthetic game.

**Tech Stack:** TypeScript strict ESM, drizzle + postgres.js, zod, Fastify via the plugin loader, vitest against real Postgres/Redis, React + react-query.

**Spec:** `docs/superpowers/specs/2026-08-20-blackjack-tables-design.md` — read it first. Task 0 amends it; the amended spec governs.

## Global Constraints

- Money is `bigint`; on the wire it is a decimal string (`MoneySchema`). Never a JSON number.
- Every balance movement goes through `tx.economy.applyBalanceChange` or `payOwner` (rule 3).
- Lock order for every mutating table path: `tx.locks.location(table.location_id)` → ONE sorted `tx.locks.player([...])` over **all seated players + the house owner (+ the caller for `sit`)** → the table row `FOR UPDATE`. Splitting the player call is the ABBA cycle (rule 6).
- Seat membership reads that feed the player-lock set happen **after** the location lock — every sit/leave takes it first, so the set is stable there.
- All four `TableGameDef` handlers are pure and wrapped in `guardGame` — a game throw is a 400 `game_error`, never a 500.
- Events: **none**. The table page polls. Do not add a `GameEvent` variant or a plugin event.
- No new plugin packages, so the eight registration sites do not apply. New **test files** must be added to `vitest.workspace.ts`'s explicit `include` lists (the ninth site) or they silently never run.
- New test files that boot no server but drive plugin routes run `runPluginMigrations(db, [casinoPlugin, propertiesPlugin])` themselves.
- Iterate with `npm run verify:related`; the merge gate is a bare `npm run verify` read from the process exit code, after checking `pgrep -fa vitest` and `select datname from pg_database where datname like 'gl3_tmpl%'` for concurrent runs.
- Commits: Conventional Commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Do NOT publish `@gl3/shared`; bump the manifest only (Task 15). Publishing needs the user's approval after a registry check.

---

### Task 0: Spec amendments

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-blackjack-tables-design.md`

The dossier work after spec approval surfaced three corrections. Amend the spec in place so it stays the source of truth.

- [ ] **Step 1: Replace §8's first bullet (the per-player events bullet) with:**

```markdown
- No events. Every plugin event renders in the game feed through its
  `describe` template, so per-transition events to five players would flood
  five feeds per hand — the exact reason casino has never published an event
  per hand. Instead the table page POLLS: `useCasinoTable` sets
  `refetchInterval: 2500` while the caller is seated. Polling doubles as the
  lazy clock's heartbeat — any read past `deadline_at` advances the table.
```

- [ ] **Step 2: In §3's `p_casino_tables` table, add a row after `phase`:**

```markdown
| `turn_seat` | smallint NULL | the seat whose turn it is, persisted from the last `TableStep.turn`; the hub cannot answer 409 `not_your_turn` from opaque jsonb without it |
```

- [ ] **Step 3: Replace §5's "Location mismatch" sentence (in the `GET /` bullet) with:**

```markdown
  **Travelling away while seated**: `bet` and `act` compare the caller's
  current location to the table's and answer 409 `wrong_location` without
  acting. `sit` answers 409 `already_seated` while any seat exists anywhere —
  the player frees it with `leave`, which needs no location match because it
  locks the SEAT'S table's location, not the caller's town. No route ever
  composes two location locks in one transaction. An abandoned in-hand seat
  auto-stands on the turn clock, settles normally, and is freed at hand end
  by the `leaving` flag `leave` sets.
```

- [ ] **Step 4: In §5's betting-phase bullet, replace the "Non-bettors get `idle_hands + 1`" sentence with:**

```markdown
  Non-bettors' `idle_hands` increments AT DEAL TIME (a deadline exists only
  once someone bet, so a wholly idle table accrues nothing and just sits);
  at `table_idle_kick_hands` the seat is freed at that deal.
```

- [ ] **Step 5: In §5's lazy-clock paragraph, replace the parenthetical "(or, with zero bettors, `idle_hands++` sweep/kicks and clear `deadline_at`)" with "(a lapse with zero bettors just clears `deadline_at` — the idle sweep runs only at a real deal, per the amended betting bullet)".**

- [ ] **Step 6: In §5's leave bullet, replace "(their turns auto-stand via the lazy clock or immediately if it is currently their turn)" with "(their turns auto-stand via the lazy clock)".**

- [ ] **Step 7: In §6's first bullet, replace "house cash + the incoming wager must cover the **sum over all in-hand seats**" with "the house owner's cash (read live, so already-escrowed wagers count toward it) must cover the **sum over all in-hand seats**" — the solo `assertHouseCanCover` comparison, summed, with no incoming-wager addend.**

- [ ] **Step 8: In §8's second bullet, delete the sentence "`keys.casino()` invalidation arrives via the plugin-event invalidation path (`pluginInvalidationKeys`) that already exists." — with no events there is no such path; the poll from the amended first bullet is the refresh mechanism.**

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/specs/2026-08-20-blackjack-tables-design.md
git commit -m "docs: amend blackjack-tables spec (polling, turn_seat, leave-first travel)"
```

---

### Task 1: Table settings readers

**Files:**
- Modify: `packages/plugins/casino/src/settings.ts`
- Modify: `packages/plugins/casino/src/index.ts` (re-exports)
- Test: `apps/server/test/casino-settings.test.ts` (extend, already in `@gl3/server:unit`)

**Interfaces:**
- Produces: `readTableBetSeconds(s): number`, `readTableTurnSeconds(s): number`, `readTableIdleKickHands(s): number`, `readTableMaxSeats(s): number` — all over the existing `SettingsReader` shape; `MAX_TABLE_SEATS = 5`.

- [ ] **Step 1: Write the failing tests** — append to `apps/server/test/casino-settings.test.ts`:

```ts
import {
  MAX_TABLE_SEATS, readTableBetSeconds, readTableIdleKickHands,
  readTableMaxSeats, readTableTurnSeconds,
} from "@gl3/plugin-casino";

const settingsOf = (rows: Record<string, string>) => ({
  get: (key: string): string | null => rows[key] ?? null,
});

describe("table settings", () => {
  it("defaults: 20s betting, 30s turns, 3 idle hands, 5 seats", () => {
    const s = settingsOf({});
    expect(readTableBetSeconds(s)).toBe(20);
    expect(readTableTurnSeconds(s)).toBe(30);
    expect(readTableIdleKickHands(s)).toBe(3);
    expect(readTableMaxSeats(s)).toBe(5);
  });

  it("reads configured values", () => {
    const s = settingsOf({
      table_bet_seconds: "45", table_turn_seconds: "10",
      table_idle_kick_hands: "1", table_max_seats: "3",
    });
    expect(readTableBetSeconds(s)).toBe(45);
    expect(readTableTurnSeconds(s)).toBe(10);
    expect(readTableIdleKickHands(s)).toBe(1);
    expect(readTableMaxSeats(s)).toBe(3);
  });

  it("clamps max seats to the hard ceiling and floors it at 1", () => {
    expect(readTableMaxSeats(settingsOf({ table_max_seats: "9" }))).toBe(MAX_TABLE_SEATS);
    expect(readTableMaxSeats(settingsOf({ table_max_seats: "0" }))).toBe(5);
  });

  it("falls back on malformed and non-positive values", () => {
    expect(readTableBetSeconds(settingsOf({ table_bet_seconds: "1.5" }))).toBe(20);
    expect(readTableTurnSeconds(settingsOf({ table_turn_seconds: "0" }))).toBe(30);
    expect(readTableIdleKickHands(settingsOf({ table_idle_kick_hands: "-2" }))).toBe(3);
  });
});
```

(`settingsOf` may already exist in the file under another name — reuse whatever fixture idiom the file has rather than duplicating one.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project @gl3/server:unit apps/server/test/casino-settings.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement** — append to `packages/plugins/casino/src/settings.ts`:

```ts
export const DEFAULT_TABLE_BET_SECONDS = 20;
export const DEFAULT_TABLE_TURN_SECONDS = 30;
export const DEFAULT_TABLE_IDLE_KICK_HANDS = 3;
/** Hard ceiling; also the CHECK constraint's bound in migration 0003. */
export const MAX_TABLE_SEATS = 5;

function readPositiveInt(s: SettingsReader, key: string, fallback: number): number {
  const raw = s.get(key);
  if (raw === null || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  if (!(parsed > 0)) return fallback;
  return parsed;
}

export function readTableBetSeconds(s: SettingsReader): number {
  return readPositiveInt(s, "table_bet_seconds", DEFAULT_TABLE_BET_SECONDS);
}
export function readTableTurnSeconds(s: SettingsReader): number {
  return readPositiveInt(s, "table_turn_seconds", DEFAULT_TABLE_TURN_SECONDS);
}
export function readTableIdleKickHands(s: SettingsReader): number {
  return readPositiveInt(s, "table_idle_kick_hands", DEFAULT_TABLE_IDLE_KICK_HANDS);
}
/** Clamped into [1, MAX_TABLE_SEATS]: the seat_no CHECK is the backstop. */
export function readTableMaxSeats(s: SettingsReader): number {
  const parsed = readPositiveInt(s, "table_max_seats", MAX_TABLE_SEATS);
  return Math.min(parsed, MAX_TABLE_SEATS);
}
```

Add to `packages/plugins/casino/src/index.ts`'s settings re-export block:

```ts
export {
  MAX_SESSION_EXPIRY_MINUTES, MAX_TABLE_SEATS, readExpiryMinutes, readMaxBet, readMinBet,
  readTableBetSeconds, readTableIdleKickHands, readTableMaxSeats, readTableTurnSeconds,
} from "./settings.js";
```

- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/casino/src/settings.ts packages/plugins/casino/src/index.ts apps/server/test/casino-settings.test.ts
git commit -m "feat(casino): table settings readers"
```

---

### Task 2: Tables and seats migrations + drizzle handles

**Files:**
- Modify: `packages/plugins/casino/src/migrations.ts`
- Modify: `packages/plugins/casino/src/schema.ts`
- Modify: `packages/plugins/casino/src/index.ts` (export handles, `tables` manifest field)
- Modify: `apps/server/test/helpers/plugin-tables.ts` — this file does NOT re-export from plugin packages: it hand-declares mirror `pgTable`s kept in step with the plugin's migrations by hand (see its header and its `casinoSessions` mirror). Declare `casinoTables` and `casinoSeats` mirrors the same way.
- Test: `apps/server/test/casino-boot.test.ts` (extend; project `@gl3/server`)

**Interfaces:**
- Produces: drizzle handles `casinoTables`, `casinoSeats` (exported from `@gl3/plugin-casino`), tables `p_casino_tables` / `p_casino_seats` created by `CASINO_MIGRATIONS`.

- [ ] **Step 1: Write the failing test** — extend `apps/server/test/casino-boot.test.ts` (read it first; follow its existing assertions' idiom) with checks that after boot:

```ts
it("creates p_casino_tables and p_casino_seats with their indexes", async () => {
  const tables = await conn<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('p_casino_tables', 'p_casino_seats')`;
  expect(tables.map((r) => r.table_name).sort()).toEqual(["p_casino_seats", "p_casino_tables"]);

  const indexes = await conn<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'p_casino_seats'`;
  const names = indexes.map((r) => r.indexname);
  expect(names).toContain("p_casino_seats_table_seat");
  expect(names).toContain("p_casino_seats_one_seat");
});

it("refuses a seat_no outside 0..4 with the CHECK, not an FK", async () => {
  // Both FK parents must be REAL rows, or the insert dies on 23503 before
  // the CHECK is ever the reason and this test passes with the CHECK
  // deleted. Seed a location, a player and a table row first, then assert
  // the SQLSTATE is check_violation.
  const locationId = await seedLocation();           // file's existing helper
  const { playerId } = await register();
  const tableId = uuidv7();
  await conn`INSERT INTO p_casino_tables (id, game_id, location_id, seed)
             VALUES (${tableId}::uuid, 'blackjack', ${locationId}::uuid, 'x')`;
  const err: unknown = await conn`
    INSERT INTO p_casino_seats (id, table_id, player_id, seat_no)
    VALUES (${uuidv7()}::uuid, ${tableId}::uuid, ${playerId}::uuid, 5)
  `.catch((e: unknown) => e);
  expect((err as { code?: string }).code).toBe("23514");
  // Control: seat_no 4 with the same parents succeeds.
  await conn`
    INSERT INTO p_casino_seats (id, table_id, player_id, seat_no)
    VALUES (${uuidv7()}::uuid, ${tableId}::uuid, ${playerId}::uuid, 4)`;
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project @gl3/server apps/server/test/casino-boot.test.ts`
Expected: FAIL — tables missing.

- [ ] **Step 3: Implement.** Append to `CASINO_MIGRATIONS` (one statement per entry — the runner rejects multi-statement strings):

```ts
  {
    // The shared table a multi-seat hand lives at. `property_id` has NO FK
    // (frozen house, pins the row not the person — the sessions precedent).
    // `state` is NULLABLE, unlike sessions: between hands there is no game
    // state at all. `turn_seat` is hub-owned: `state` is opaque jsonb, so
    // without it the hub could not answer 409 not_your_turn.
    name: "0003_tables",
    sql: `CREATE TABLE p_casino_tables (
      id           uuid PRIMARY KEY,
      game_id      text NOT NULL,
      location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      property_id  uuid,
      phase        text NOT NULL DEFAULT 'betting',
      turn_seat    smallint,
      deadline_at  timestamptz,
      hand_no      integer NOT NULL DEFAULT 0,
      state        jsonb,
      seed         text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    // A player's chair. `wager > 0` means "in the current hand"; it is reset
    // to 0 at settle. Both FKs cascade; both rows are already held FOR UPDATE
    // by every inserting transaction (rule 6 — see the lock order in
    // table-routes.ts), so the FOR KEY SHARE they take conflicts with nothing
    // new. seat_no's CHECK is the hard five-seat ceiling.
    name: "0004_seats",
    sql: `CREATE TABLE p_casino_seats (
      id           uuid PRIMARY KEY,
      table_id     uuid NOT NULL REFERENCES p_casino_tables(id) ON DELETE CASCADE,
      player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      seat_no      smallint NOT NULL CHECK (seat_no BETWEEN 0 AND 4),
      wager        bigint NOT NULL DEFAULT 0,
      leaving      boolean NOT NULL DEFAULT false,
      idle_hands   integer NOT NULL DEFAULT 0,
      joined_at    timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: "0005_seat_no_unique",
    sql: `CREATE UNIQUE INDEX p_casino_seats_table_seat ON p_casino_seats (table_id, seat_no)`,
  },
  {
    // One seat per player game-wide — the table-flow sibling of
    // p_casino_sessions_one_open. Plain unique (seat rows are deleted, not
    // status-flagged), so no WHERE clause.
    name: "0006_one_seat_per_player",
    sql: `CREATE UNIQUE INDEX p_casino_seats_one_seat ON p_casino_seats (player_id)`,
  },
```

Append to `packages/plugins/casino/src/schema.ts` (keep in step with the DDL BY HAND, as the file header demands; note `.default(sql`0`)`, never `.default(0n)`):

```ts
import { boolean, integer, smallint } from "drizzle-orm/pg-core"; // merge into the existing import

export const casinoTables = pgTable("p_casino_tables", {
  id: uuid("id").primaryKey(),
  gameId: text("game_id").notNull(),
  locationId: uuid("location_id").notNull(),
  propertyId: uuid("property_id"),
  phase: text("phase").notNull().default("betting"),
  turnSeat: smallint("turn_seat"),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  handNo: integer("hand_no").notNull().default(0),
  state: jsonb("state"),
  seed: text("seed").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casinoSeats = pgTable("p_casino_seats", {
  id: uuid("id").primaryKey(),
  tableId: uuid("table_id").notNull(),
  playerId: uuid("player_id").notNull(),
  seatNo: smallint("seat_no").notNull(),
  wager: bigint("wager", { mode: "bigint" }).notNull().default(sql`0`),
  leaving: boolean("leaving").notNull().default(false),
  idleHands: integer("idle_hands").notNull().default(0),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});
```

In `packages/plugins/casino/src/index.ts`: add `export { casinoSeats, casinoTables } from "./schema.js";` and extend the manifest's `tables` field to `tables: { sessions: "p_casino_sessions", tables: "p_casino_tables", seats: "p_casino_seats" }`. In `apps/server/test/helpers/plugin-tables.ts`, hand-declare `casinoTables` and `casinoSeats` MIRRORS (FKs omitted) alongside the existing `casinoSessions` mirror, per that file's own kept-in-step-by-hand rule.

- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS (including the pre-existing cases).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/casino/src/migrations.ts packages/plugins/casino/src/schema.ts packages/plugins/casino/src/index.ts apps/server/test/helpers/plugin-tables.ts apps/server/test/casino-boot.test.ts
git commit -m "feat(casino): p_casino_tables and p_casino_seats migrations"
```

---

### Task 3: `TableGameDef` contract and registry

**Files:**
- Modify: `packages/plugins/casino/src/games.ts`
- Modify: `packages/plugins/casino/src/index.ts` (re-exports, `provides`)
- Test: `apps/server/test/casino-registry.test.ts` (extend; `@gl3/server:unit`)

**Interfaces:**
- Produces (all exported from `@gl3/plugin-casino`):

```ts
export interface TableSeatInput { seat: number; wager: bigint }
export interface TableStep<S> {
  state: S;
  done: boolean;
  /** The seat whose turn it now is; null when the hand is done. */
  turn: number | null;
  /** A raise (double). `seat` must be the seat that just acted; `amount` > 0. */
  wagerDelta?: { seat: number; amount: bigint };
}
export interface TableGameDef<S = unknown> {
  id: string;
  name: string;
  maxPayoutMultiplier: number;
  action: z.ZodType<unknown>;
  deal(input: { seats: TableSeatInput[]; seed: string }): TableStep<S>;
  act(state: S, seat: number, action: unknown): TableStep<S>;
  /** What happens to a seat whose turn timer lapsed. Pure, like the rest. */
  autoAct(state: S, seat: number): TableStep<S>;
  /** Per-seat render. `viewer` null = a seated spectator not in this hand. */
  view(state: S, viewer: number | null): ViewNode;
  /** TOTAL returned per seat. A seat absent from the array is paid 0. */
  settle(state: S): { seat: number; payout: bigint }[];
}
export const tableGames = filterPoint<TableGameDef[]>("casino.tableGames");
export async function buildTableRegistry(
  ctx: Pick<PluginCtx, "filters">, installedPluginIds: ReadonlySet<string>,
): Promise<Map<string, TableGameDef>>;
```

- [ ] **Step 1: Write the failing tests** — extend `apps/server/test/casino-registry.test.ts`, mirroring its three existing cases against `buildTableRegistry`/`tableGames` (collects a declared game; rejects an id that is not an installed plugin id; rejects a duplicate id). Copy the file's existing fixture idiom — it builds a `ctx.filters.apply` stub; do the same with a minimal `TableGameDef`:

```ts
const TABLE_STUB: TableGameDef<unknown> = {
  id: "blackjack", name: "Stub", maxPayoutMultiplier: 2.5, action: z.unknown(),
  deal: () => ({ state: {}, done: false, turn: 0 }),
  act: () => ({ state: {}, done: true, turn: null }),
  autoAct: () => ({ state: {}, done: true, turn: null }),
  view: () => ({ kind: "text", value: "stub" }),
  settle: () => [],
};
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project @gl3/server:unit apps/server/test/casino-registry.test.ts`
Expected: FAIL — `buildTableRegistry` does not exist.

- [ ] **Step 3: Implement** in `games.ts`: the types above, `export const tableGames = filterPoint<TableGameDef[]>("casino.tableGames");`, and `buildTableRegistry` as a structural copy of `buildRegistry` (same installed-id and duplicate checks, message prefix `casino table game`). Re-export from `index.ts` (`export { games, buildRegistry, tableGames, buildTableRegistry, type GameDef, type GameStep, type TableGameDef, type TableStep, type TableSeatInput } from "./games.js";`) and extend the manifest to `provides: [games, tableGames]`.

- [ ] **Step 4: Run to verify pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/casino/src/games.ts packages/plugins/casino/src/index.ts apps/server/test/casino-registry.test.ts
git commit -m "feat(casino): TableGameDef contract and casino.tableGames registry"
```

---

### Task 4: Blackjack multi-seat rules

**Files:**
- Create: `packages/plugins/blackjack/src/multi.ts`
- Test: `apps/server/test/blackjack-table-rules.test.ts` (new; add to `@gl3/server:unit` include in `vitest.workspace.ts`)

**Interfaces:**
- Consumes: `shuffle`, `handValue`, `isNatural`, `type Card` from `./rules.js`; `TableSeatInput`, `TableStep` types from `@gl3/plugin-casino`.
- Produces:

```ts
export type SeatPhase = "playing" | "stood" | "bust" | "natural" | "doubled";
export interface BjSeatHand { seat: number; cards: Card[]; wager: bigint; phase: SeatPhase }
export interface BjTableState {
  shoe: Card[]; cursor: number; hands: BjSeatHand[]; dealer: Card[];
  turn: number | null; done: boolean;
}
export function dealTable(seats: TableSeatInput[], seed: string): BjTableState;
export function actSeat(state: BjTableState, seat: number, action: "hit" | "stand" | "double"): { state: BjTableState; wagerDelta?: { seat: number; amount: bigint } };
export function settleTable(state: BjTableState): { seat: number; payout: bigint }[];
```

- [ ] **Step 1: Write the failing tests** — `apps/server/test/blackjack-table-rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  dealTable, actSeat, settleTable, type BjTableState, type BjSeatHand,
} from "@gl3/plugin-blackjack";
import { shuffle, handValue } from "@gl3/plugin-blackjack";

const W = 100_000n;

/** Hand-built state, `blackjack-rules.test.ts`'s baseState idiom. */
function state(hands: Partial<BjSeatHand>[], dealer: string[], over?: Partial<BjTableState>): BjTableState {
  return {
    shoe: shuffle("fixture"), cursor: 4, dealer,
    hands: hands.map((h, i) => ({ seat: i, cards: [], wager: W, phase: "playing", ...h })),
    turn: 0, done: false, ...over,
  };
}

describe("dealTable", () => {
  it("deals two cards per seat and two to the dealer, in casino order", () => {
    const s = dealTable([{ seat: 0, wager: W }, { seat: 2, wager: W }], "seed-a");
    const shoe = shuffle("seed-a");
    // Round one: seat 0, seat 2, dealer up-card. Round two: seat 0, seat 2, hole.
    expect(s.hands[0]!.cards).toEqual([shoe[0], shoe[3]]);
    expect(s.hands[1]!.cards).toEqual([shoe[1], shoe[4]]);
    expect(s.dealer).toEqual([shoe[2], shoe[5]]);
    expect(s.cursor).toBe(6);
  });

  it("gives the turn to the lowest playing seat", () => {
    const s = dealTable([{ seat: 1, wager: W }, { seat: 4, wager: W }], "no-natural");
    expect(s.done).toBe(false);
    expect(s.turn).toBe(1);
  });

  it("auto-stands a dealt natural and skips its turn", () => {
    // Constructive: find a seed dealing seat 0 a natural with ≥2 seats by
    // scanning — deterministic once found, the "natural-22" precedent.
    let seed = "";
    for (let i = 0; i < 500; i++) {
      const probe = dealTable([{ seat: 0, wager: W }, { seat: 1, wager: W }], `probe-${i}`);
      if (probe.hands[0]!.phase === "natural" && probe.hands[1]!.phase === "playing") { seed = `probe-${i}`; break; }
    }
    expect(seed).not.toBe("");
    const s = dealTable([{ seat: 0, wager: W }, { seat: 1, wager: W }], seed);
    expect(s.turn).toBe(1);
  });

  it("plays the dealer and finishes at the deal when every seat naturals", () => {
    let found: BjTableState | null = null;
    for (let i = 0; i < 5000 && found === null; i++) {
      const probe = dealTable([{ seat: 0, wager: W }], `solo-${i}`);
      if (probe.hands[0]!.phase === "natural") found = probe;
    }
    expect(found).not.toBeNull();
    expect(found!.done).toBe(true);
    expect(found!.turn).toBeNull();
  });
});

describe("actSeat", () => {
  it("refuses an act out of turn", () => {
    const s = state([{ cards: ["S9", "S8"] }, { cards: ["H9", "H8"] }], ["Dk", "D9"]);
    expect(() => actSeat(s, 1, "hit")).toThrow(/turn/i);
  });

  it("hit draws one card at the cursor and keeps the turn on a live hand", () => {
    const s = state([{ cards: ["S2", "S3"] }, { cards: ["H9", "H8"] }], ["Dk", "D9"]);
    const { state: next } = actSeat(s, 0, "hit");
    expect(next.hands[0]!.cards).toHaveLength(3);
    expect(next.cursor).toBe(5);
    expect(next.turn).toBe(0);
  });

  it("a stand passes the turn to the next playing seat", () => {
    const st = state([{ cards: ["Sk", "Sq"] }, { cards: ["H9", "H8"] }], ["Dk", "D9"]);
    const { state: next } = actSeat(st, 0, "stand");
    expect(next.hands[0]!.phase).toBe("stood");
    expect(next.turn).toBe(1);
  });

  it("the last stand plays the dealer (stands on all 17) and finishes", () => {
    const s = state([{ cards: ["Sk", "S9" ] }], ["Dk", "C7"]);
    const { state: next } = actSeat(s, 0, "stand");
    expect(next.done).toBe(true);
    expect(next.turn).toBeNull();
    expect(next.dealer).toHaveLength(2); // 17: no draw
  });

  it("the dealer only reveals, never draws, when every seat busted", () => {
    const s = state([{ cards: ["Sk", "Sq" ] }], ["D6", "C5"]); // dealer 11 would draw
    const { state: mid } = actSeat(s, 0, "hit"); // Sk Sq + next card is always a bust
    expect(mid.hands[0]!.phase).toBe("bust");
    expect(mid.done).toBe(true);
    expect(mid.dealer).toHaveLength(2); // nobody to beat — no draw
  });

  it("double draws one card, doubles that seat's wager and asks the hub for the delta", () => {
    const s = state([{ cards: ["S5", "H6"] }, { cards: ["H9", "H8"] }], ["Dk", "D9"]);
    const { state: next, wagerDelta } = actSeat(s, 0, "double");
    expect(wagerDelta).toEqual({ seat: 0, amount: W });
    expect(next.hands[0]!.wager).toBe(W * 2n);
    expect(next.hands[0]!.cards).toHaveLength(3);
    expect(next.turn).toBe(1);
  });

  it("refuses double after the first two cards", () => {
    const s = state([{ cards: ["S5", "H6", "D2"] }], ["Dk", "D9"]);
    expect(() => actSeat(s, 0, "double")).toThrow(/double/i);
  });
});

describe("settleTable", () => {
  const settled = (hands: Partial<BjSeatHand>[], dealer: string[]) =>
    settleTable(state(hands, dealer, { done: true, turn: null }));

  it("pays each seat independently against the one dealer", () => {
    const payouts = settled([
      { cards: ["Sk", "Sq"], phase: "stood" },          // 20 beats 19 → 2×
      { cards: ["H9", "H8"], phase: "stood" },          // 17 loses → 0
      { cards: ["Sa", "Hk"], phase: "natural" },        // natural → 2.5×
      { cards: ["Dk", "Dq", "D5"], phase: "bust" },     // bust → 0
      { cards: ["C9", "Ck"], phase: "stood" },          // 19 push → 1×
    ].map((h, i) => ({ ...h, seat: i })), ["Hk", "H9"]); // dealer 19
    expect(payouts).toEqual([
      { seat: 0, payout: W * 2n },
      { seat: 1, payout: 0n },
      { seat: 2, payout: (W * 5n) / 2n },
      { seat: 3, payout: 0n },
      { seat: 4, payout: W },
    ]);
  });

  it("a doubled win pays 2× the doubled wager", () => {
    const payouts = settleTable(state(
      [{ seat: 0, cards: ["S5", "H6", "Sk"], wager: W * 2n, phase: "doubled" }],
      ["Hk", "H9"], { done: true, turn: null },
    ));
    expect(payouts).toEqual([{ seat: 0, payout: W * 4n }]);
  });

  it("dealer bust pays every standing seat", () => {
    const payouts = settled(
      [{ seat: 0, cards: ["S9", "H8"], phase: "stood" }],
      ["Dk", "Dq", "D5"],
    );
    expect(payouts).toEqual([{ seat: 0, payout: W * 2n }]);
  });

  it("both natural is a push at 1×", () => {
    const payouts = settled(
      [{ seat: 0, cards: ["Sa", "Sk"], phase: "natural" }],
      ["Da", "Dk"],
    );
    expect(payouts).toEqual([{ seat: 0, payout: W }]);
  });
});
```

- [ ] **Step 2: Register the file** in `vitest.workspace.ts` under `@gl3/server:unit`'s `include` (alongside `test/blackjack-rules.test.ts`), then run:

Run: `npx vitest run --project @gl3/server:unit apps/server/test/blackjack-table-rules.test.ts`
Expected: FAIL — module missing. (If it says "No test files found", the workspace entry is missing — that is the ninth-registration-site trap.)

- [ ] **Step 3: Implement `packages/plugins/blackjack/src/multi.ts`:**

```ts
import { handValue, isNatural, shuffle, type Card } from "./rules.js";
import type { TableSeatInput } from "@gl3/plugin-casino";

export type SeatPhase = "playing" | "stood" | "bust" | "natural" | "doubled";

export interface BjSeatHand { seat: number; cards: Card[]; wager: bigint; phase: SeatPhase }

export interface BjTableState {
  shoe: Card[];
  cursor: number;
  hands: BjSeatHand[];
  dealer: Card[];
  turn: number | null;
  done: boolean;
}

/** Lowest-numbered seat still to act, or null. */
function nextTurn(hands: readonly BjSeatHand[]): number | null {
  const open = hands.find((h) => h.phase === "playing");
  return open === undefined ? null : open.seat;
}

/**
 * Dealer plays iff at least one seat STOOD (incl. doubled) — a table of
 * busts and naturals has nobody to beat, so the dealer only reveals.
 * Stands on all 17, `rules.ts`'s playDealer rule over the table state shape.
 */
function finishHand(state: BjTableState): BjTableState {
  const contested = state.hands.some((h) => h.phase === "stood" || h.phase === "doubled");
  const dealer = [...state.dealer];
  let cursor = state.cursor;
  if (contested) {
    while (handValue(dealer) < 17) dealer.push(state.shoe[cursor++]!);
  }
  return { ...state, dealer, cursor, turn: null, done: true };
}

function advance(state: BjTableState): BjTableState {
  const turn = nextTurn(state.hands);
  if (turn === null) return finishHand(state);
  return { ...state, turn };
}

export function dealTable(seats: TableSeatInput[], seed: string): BjTableState {
  if (seats.length === 0) throw new Error("cannot deal to an empty table");
  const shoe = shuffle(seed);
  const ordered = [...seats].sort((a, b) => a.seat - b.seat);
  let cursor = 0;
  const first = ordered.map(() => shoe[cursor++]!);
  const upCard = shoe[cursor++]!;
  const second = ordered.map(() => shoe[cursor++]!);
  const hole = shoe[cursor++]!;
  const hands: BjSeatHand[] = ordered.map((s, i) => {
    const cards = [first[i]!, second[i]!];
    return { seat: s.seat, cards, wager: s.wager, phase: isNatural(cards) ? "natural" : "playing" };
  });
  return advance({ shoe, cursor, hands, dealer: [upCard, hole], turn: null, done: false });
}

function withHand(state: BjTableState, seat: number, hand: BjSeatHand, cursor?: number): BjTableState {
  return {
    ...state,
    cursor: cursor ?? state.cursor,
    hands: state.hands.map((h) => (h.seat === seat ? hand : h)),
  };
}

export function actSeat(
  state: BjTableState, seat: number, action: "hit" | "stand" | "double",
): { state: BjTableState; wagerDelta?: { seat: number; amount: bigint } } {
  if (state.done) throw new Error("hand is already finished");
  if (state.turn !== seat) throw new Error("not this seat's turn");
  const hand = state.hands.find((h) => h.seat === seat);
  if (hand === undefined || hand.phase !== "playing") throw new Error("seat is not in play");

  if (action === "hit") {
    const cards = [...hand.cards, state.shoe[state.cursor]!];
    const bust = handValue(cards) > 21;
    const next = withHand(state, seat, { ...hand, cards, phase: bust ? "bust" : "playing" }, state.cursor + 1);
    return { state: bust ? advance(next) : next };
  }

  if (action === "double") {
    if (hand.cards.length !== 2) throw new Error("can only double on the first two cards");
    const cards = [...hand.cards, state.shoe[state.cursor]!];
    const phase: SeatPhase = handValue(cards) > 21 ? "bust" : "doubled";
    const next = withHand(state, seat, { ...hand, cards, wager: hand.wager * 2n, phase }, state.cursor + 1);
    // The hub debits the seat, credits the house and re-runs the exposure
    // check — this function moves no money (solo double's contract).
    return { state: advance(next), wagerDelta: { seat, amount: hand.wager } };
  }

  return { state: advance(withHand(state, seat, { ...hand, phase: "stood" })) };
}

/** Solo `settle`'s payout table, per seat, against the one dealer hand. */
export function settleTable(state: BjTableState): { seat: number; payout: bigint }[] {
  const dealer = handValue(state.dealer);
  const dealerNatural = isNatural(state.dealer);
  return state.hands.map((hand) => {
    const value = handValue(hand.cards);
    let payout = 0n;
    if (value <= 21) {
      if (hand.phase === "natural" && !dealerNatural) payout = (hand.wager * 5n) / 2n;
      else if (dealer > 21 || value > dealer) payout = hand.wager * 2n;
      else if (value === dealer) payout = hand.wager;
    }
    return { seat: hand.seat, payout };
  });
}
```

- [ ] **Step 4: Export from `packages/plugins/blackjack/src/index.ts`:** add `export { dealTable, actSeat, settleTable, type BjTableState, type BjSeatHand, type SeatPhase } from "./multi.js";`

- [ ] **Step 5: Run to verify pass.** Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/blackjack/src/multi.ts packages/plugins/blackjack/src/index.ts apps/server/test/blackjack-table-rules.test.ts vitest.workspace.ts
git commit -m "feat(blackjack): multi-seat table rules"
```

---

### Task 5: Blackjack table view + manifest swap to `tableGames`

**Files:**
- Create: `packages/plugins/blackjack/src/table-view.ts`
- Modify: `packages/plugins/blackjack/src/index.ts` (add `BLACKJACK_TABLE`, drop the solo `BLACKJACK` from `casino.games`, subscribe `tableGames`)
- Delete content: solo `BLACKJACK` GameDef and `view.ts` become dead — remove `view.ts` and the solo def; keep `rules.ts` intact (multi.ts uses it).
- Test: `apps/server/test/blackjack-table-view.test.ts` (new; register in `@gl3/server:unit`)
- Remove from workspace + delete: `apps/server/test/blackjack-view.test.ts` (its assertions move here), and rewrite `apps/server/test/blackjack-rules.test.ts` to keep only the `handValue`/`shuffle` describe blocks (the game-behaviour blocks are superseded by `blackjack-table-rules.test.ts`).

**Interfaces:**
- Consumes: `BjTableState` etc. from `./multi.js`; `TableGameDef`, `tableGames` from `@gl3/plugin-casino`.
- Produces: `renderTable(state: BjTableState, viewer: number | null): ViewNode`; `export const BLACKJACK_TABLE: TableGameDef<BjTableState>` with `id: "blackjack"`, `maxPayoutMultiplier: 2.5`, `action: z.enum(["hit","stand","double"])`.

- [ ] **Step 1: Write the failing tests** — `apps/server/test/blackjack-table-view.test.ts`. Port `blackjack-view.test.ts`'s `cardsIn`/`rowsIn`/`valueOf` walkers verbatim, then:

```ts
import { BLACKJACK_TABLE, type BjTableState } from "@gl3/plugin-blackjack";
import { shuffle } from "@gl3/plugin-blackjack";

const W = 100_000n;

function liveTable(): BjTableState {
  return {
    shoe: shuffle("fixture"), cursor: 6,
    hands: [
      { seat: 0, cards: ["S9", "S8"], wager: W, phase: "playing" },
      { seat: 3, cards: ["C4", "C9"], wager: W, phase: "playing" },
    ],
    dealer: ["Hk", "Da"],   // up-card Hk, hole Da — 21 if seen
    turn: 0, done: false,
  };
}

describe("the dealer's hole card at a table", () => {
  it("is face-down for every viewer while any seat is still choosing", () => {
    for (const viewer of [0, 3, null]) {
      const cards = cardsIn(BLACKJACK_TABLE.view(liveTable(), viewer));
      expect(cards).toContain("Hk");
      expect(cards).not.toContain("Da");
      expect(cards.filter((c) => c === "B1" || c === "B2")).toHaveLength(1);
    }
  });

  it("does not leak through the dealer total", () => {
    const rows = rowsIn(BLACKJACK_TABLE.view(liveTable(), 0)).map((r) => r.value);
    expect(rows).not.toContain("21");
  });

  it("every seat's own cards are public to every viewer — blackjack hides only the hole card", () => {
    const cards = cardsIn(BLACKJACK_TABLE.view(liveTable(), 3));
    expect(cards).toEqual(expect.arrayContaining(["S9", "S8", "C4", "C9"]));
  });

  it("reveals dealer hand and true total once done", () => {
    const done: BjTableState = { ...liveTable(), done: true, turn: null };
    const view = BLACKJACK_TABLE.view(done, 0);
    expect(cardsIn(view)).toContain("Da");
    expect(cardsIn(view).filter((c) => c === "B1" || c === "B2")).toHaveLength(0);
    expect(valueOf(view, "Dealer total")).toBe("21");
  });

  it("marks the viewer's own seat and the seat whose turn it is", () => {
    const view = BLACKJACK_TABLE.view(liveTable(), 3);
    const titles = panelTitlesIn(view); // helper: collect panel titles recursively
    expect(titles.some((t) => t.includes("Seat 4") && t.includes("you"))).toBe(true);
    expect(titles.some((t) => t.includes("Seat 1") && t.includes("to act"))).toBe(true);
  });
});

describe("GameDef plumbing", () => {
  it("deal/act/autoAct/settle round-trip through the TableGameDef surface", () => {
    const step = BLACKJACK_TABLE.deal({ seats: [{ seat: 0, wager: W }], seed: "no-natural" });
    expect(step.done).toBe(false);
    expect(step.turn).toBe(0);
    const done = BLACKJACK_TABLE.autoAct(step.state, 0);   // stand
    expect(done.done).toBe(true);
    const payouts = BLACKJACK_TABLE.settle(done.state);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.seat).toBe(0);
  });

  it("rejects actions outside the schema", () => {
    expect(BLACKJACK_TABLE.action.safeParse("split").success).toBe(false);
    expect(BLACKJACK_TABLE.action.safeParse("hit").success).toBe(true);
  });
});
```

(Seat panels are 1-indexed for display — "Seat 1" is seat_no 0.)

- [ ] **Step 2: Register in workspace, remove `test/blackjack-view.test.ts` from the include list, run to verify failure.**

- [ ] **Step 3: Implement `table-view.ts`:**

```ts
import type { ViewNode } from "@gl3/plugin-sdk";
import { handValue } from "./rules.js";
import type { BjTableState } from "./multi.js";

const FACE_DOWN = "B1";

/**
 * Solo view.ts's concealment contract, per table: while ANY seat is still
 * choosing (`!state.done`), the dealer's second card renders as a back and
 * the total as the up-card's alone. All player cards are public — blackjack's
 * only secret is the hole card, but the `viewer` parameter is the contract
 * (a poker port needs it), and here it marks "you" and "to act".
 */
export function renderTable(state: BjTableState, viewer: number | null): ViewNode {
  const hidden = !state.done;
  const dealerCards = hidden ? [state.dealer[0] ?? FACE_DOWN, FACE_DOWN] : state.dealer;
  const dealerTotal = hidden
    ? `${String(handValue(state.dealer.slice(0, 1)))} + ?`
    : String(handValue(state.dealer));

  const seatPanels: ViewNode[] = state.hands.map((hand) => {
    const marks = [
      hand.seat === viewer ? "you" : null,
      hand.seat === state.turn ? "to act" : null,
    ].filter((m): m is string => m !== null);
    const title = `Seat ${hand.seat + 1}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`;
    return {
      kind: "panel",
      title,
      children: [
        { kind: "cards", cards: hand.cards },
        {
          kind: "keyValue",
          rows: [
            { label: "Total", value: String(handValue(hand.cards)) },
            { label: "Status", value: hand.phase },
          ],
        },
      ],
    };
  });

  return {
    kind: "panel",
    title: "Blackjack table",
    children: [
      { kind: "panel", title: "Dealer", children: [{ kind: "cards", cards: dealerCards }] },
      {
        kind: "keyValue",
        rows: [{ label: hidden ? "Dealer showing" : "Dealer total", value: dealerTotal }],
      },
      ...seatPanels,
    ],
  };
}
```

- [ ] **Step 4: Rewrite `packages/plugins/blackjack/src/index.ts`:**

```ts
import { z } from "zod";
import { definePlugin, on } from "@gl3/plugin-sdk";
import { tableGames, type TableGameDef, type TableStep } from "@gl3/plugin-casino";
import { actSeat, dealTable, settleTable, type BjTableState } from "./multi.js";
import { renderTable } from "./table-view.js";

export { handValue, isNatural, shuffle, type BlackjackState, type Card } from "./rules.js";
export { actSeat, dealTable, settleTable, type BjSeatHand, type BjTableState, type SeatPhase } from "./multi.js";
export { renderTable } from "./table-view.js";

const ActionSchema = z.enum(["hit", "stand", "double"]);

function toStep(result: { state: BjTableState; wagerDelta?: { seat: number; amount: bigint } }): TableStep<BjTableState> {
  return {
    state: result.state,
    done: result.state.done,
    turn: result.state.turn,
    ...(result.wagerDelta !== undefined ? { wagerDelta: result.wagerDelta } : {}),
  };
}

export const BLACKJACK_TABLE: TableGameDef<BjTableState> = {
  id: "blackjack",
  name: "Blackjack",
  maxPayoutMultiplier: 2.5,
  action: ActionSchema,
  deal: ({ seats, seed }) => toStep({ state: dealTable(seats, seed) }),
  act: (state, seat, action) => toStep(actSeat(state, seat, ActionSchema.parse(action))),
  autoAct: (state, seat) => toStep(actSeat(state, seat, "stand")),
  view: renderTable,
  settle: settleTable,
};

export default definePlugin({
  id: "blackjack",
  version: "1.0.0",
  basePaths: ["/api/blackjack"],
  providesAssets: [
    { slot: "table", label: "Blackjack table", singleton: true },
    { slot: "property", label: "Casino building", singleton: true },
  ],
  providesProperties: [{
    id: "blackjack",
    name: "Blackjack Table",
    price: 1_000_000n,
    leverLabel: "Maximum bet",
  }],
  filters: [on(tableGames, (_ctx, list) => [...list, BLACKJACK_TABLE as TableGameDef])],
});
```

Delete `packages/plugins/blackjack/src/view.ts`. Note `rules.ts` keeps `playDealer` exported only if something still imports it — if nothing does after this task, delete `playDealer` and `Phase`/`BlackjackState` too, and drop the `BlackjackState` re-export (check with `grep -rn "playDealer\|BlackjackState" apps packages | grep -v dist`). Trim `apps/server/test/blackjack-rules.test.ts` to the `hand value` and `shoe` describe blocks (delete `baseState` and the `blackjack game` block; keep the file and its workspace entry).

- [ ] **Step 5: Run the unit project and typecheck**

Run: `npx vitest run --project @gl3/server:unit && npm run typecheck`
Expected: table-view and table-rules PASS; typecheck clean. Solo casino tests in other projects are now broken — that is Tasks 6–8, do not run them here.

- [ ] **Step 6: Commit**

```bash
git add -A packages/plugins/blackjack apps/server/test/blackjack-table-view.test.ts apps/server/test/blackjack-rules.test.ts vitest.workspace.ts
git rm apps/server/test/blackjack-view.test.ts
git commit -m "feat(blackjack): table game via casino.tableGames; retire solo GameDef"
```

---

### Task 6: FARO synthetic solo game + convert casino-play and casino-lobby

**Files:**
- Create: `apps/server/test/helpers/faro.ts`
- Modify: `apps/server/test/casino-play.test.ts`, `apps/server/test/casino-lobby.test.ts`

The solo engine (sessions, play/act, lazy forfeit) stays and stays tested, but blackjack no longer lives there. FARO is a deterministic solo `GameDef` installed as its own plugin manifest through `bootTestServer({ plugins })`. Determinism also retires the "natural settles at deal" retry idioms — a FARO hand settles exactly when told to.

- [ ] **Step 1: Write `apps/server/test/helpers/faro.ts`:**

```ts
import { z } from "zod";
import { definePlugin, on, type PluginManifest } from "@gl3/plugin-sdk";
import { games, type GameDef, type GameStep } from "@gl3/plugin-casino";

/**
 * A deterministic solo game for the hub's own tests, now that blackjack is a
 * table game. The ACTION decides the outcome, so a test chooses its branch:
 *   win → settles at 2×, lose → 0, push → 1×, double → wagerDelta then 2×.
 * `start` never settles — the "natural at deal" nondeterminism the blackjack
 * fixtures had to net-from-the-body around does not exist here.
 */
export interface FaroState { wager: bigint; outcome: "open" | "win" | "lose" | "push" }

export const FARO: GameDef<FaroState> = {
  id: "faro",
  name: "Faro",
  maxPayoutMultiplier: 2.5,
  action: z.enum(["win", "lose", "push", "double"]),
  start: ({ wager }) => ({
    state: { wager, outcome: "open" },
    view: { kind: "text", value: "faro: place your call" },
    done: false,
  }),
  act: (state, action): GameStep<FaroState> => {
    if (action === "double") {
      const next: FaroState = { ...state, wager: state.wager * 2n, outcome: "win" };
      return {
        state: next, done: true, wagerDelta: state.wager,
        view: { kind: "text", value: "faro: doubled and won" },
      };
    }
    const outcome = action as "win" | "lose" | "push";
    return {
      state: { ...state, outcome }, done: true,
      view: { kind: "text", value: `faro: ${outcome}` },
    };
  },
  settle: (state, wager) => {
    if (state.outcome === "win") return wager * 2n;
    if (state.outcome === "push") return wager;
    return 0n;
  },
  view: (state) => ({ kind: "text", value: `faro: ${state.outcome}` }),
};

/** Installed alongside CORE_PLUGINS via bootTestServer({ plugins: [faroPlugin] }). */
export const faroPlugin: PluginManifest = definePlugin({
  id: "faro",
  version: "1.0.0",
  basePaths: ["/api/faro"],
  filters: [on(games, (_ctx, list) => [...list, FARO as GameDef])],
});
```

- [ ] **Step 2: Convert `casino-play.test.ts`.** Mechanical, whole-file:
  - `bootTestServer()` → `bootTestServer({ plugins: [faroPlugin] })`; import `{ faroPlugin }` from `./helpers/faro.js`.
  - Every `"blackjack"` game id → `"faro"` (the `play()` helper's calls and `seedHouse`'s `pluginId`).
  - The escrow test's net-from-the-body arithmetic simplifies: FARO's `start` never settles, so `net` is always `-wager` — assert `body.done` is `false` and drop the conditional.
  - Exposure figures: FARO's multiplier is 2.5, same as blackjack — the `house_cannot_cover` fixtures keep their numbers.

- [ ] **Step 3: Convert `casino-lobby.test.ts`** the same way: boot with `faroPlugin`, ids `"blackjack"` → `"faro"`, `seedHouse` `pluginId: "faro"`. The lazy-forfeit fixtures insert session rows directly with `gameId: "blackjack"` — change to `"faro"`; the play that triggers the forfeit is deterministic now (assert `done: false`, `net = -wager`, `open` has length 1). The resume-view test drives `FARO.view` (a `text` node) — assert on that shape. The viewless-resume test builds its own local GameDef via `callPluginRoute` and is unaffected. Any test asserting the lobby lists blackjack now asserts it lists Faro.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project @gl3/server apps/server/test/casino-play.test.ts apps/server/test/casino-lobby.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/helpers/faro.ts apps/server/test/casino-play.test.ts apps/server/test/casino-lobby.test.ts
git commit -m "test(casino): solo engine tests run against synthetic FARO game"
```

---

### Task 7: Convert casino-act

**Files:**
- Modify: `apps/server/test/casino-act.test.ts`

- [ ] **Step 1: Convert.** Boot with `faroPlugin`; ids → `"faro"`. The file's 17 tests fall in three groups:
  - **Hub-contract tests keep their logic with FARO actions**: net accounting (`act` with `"win"`/`"lose"`/`"push"`), double debit and doubled-payout (`"double"`), double-when-house-cannot-cover → 409 with the session unchanged (seed owner cash to cover the opening exposure but not the doubled one: with 2.5×, wager `100000` → exposure `250000`, doubled exposure `500000`, so owner cash `300000n` passes the first check and fails the second), `session_closed`, `session_expired` (backdate `createdAt` directly), unowned-town faucet, other player's session 404, frozen-house settle, bankruptcy takeover + its two exclusions, 400-not-500 on an action FARO's schema rejects (`"hit"` is now invalid — use it) and on a throwing game (that test builds its own manifest already).
  - **Blackjack-behaviour tests are superseded** by `blackjack-table-rules/-view` and the table tests: delete the hole-card-over-HTTP test and the natural-2.5× test from this file, noting in a comment where they went (`casino-tables.test.ts` re-proves concealment over HTTP at a table).
  - Push/2.5 arithmetic tests that survive translate to FARO's `push`/`win` figures.

- [ ] **Step 2: Run to verify pass**

Run: `npx vitest run --project @gl3/server apps/server/test/casino-act.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/casino-act.test.ts
git commit -m "test(casino): act suite converted to FARO"
```

---

### Task 8: Convert casino-lock-order

**Files:**
- Modify: `apps/server/test/casino-lock-order.test.ts`

- [ ] **Step 1: Convert.** Boot with `faroPlugin`; `play()` payload gameId `"faro"`; `seedHouse` pluginId `"faro"`. Behavioural deltas:
  - FARO never settles at `start`, so the same-player race's 15-attempt retry loop is no longer needed: the winner's hand always stays open, the loser always answers 409 `session_open`. Collapse the loop to a single attempt asserting exactly `[200, 409]` (order-independent), one open row, `session_open`. Keep the row-count assertions.
  - The seizure-window test's net-from-the-body conditional collapses to `net = -WAGER` (never done at start). Keep every conservation assertion.
  - Tests 1, 2 (ABBA) and 4 (deliberate inversion) are unchanged apart from ids.
- Do not touch `raceTwoPlays`, `waitForLockWaiters`, or the inversion choreography — they are the load-bearing machinery, and this file carries the known intermittent bare-500 flake; keep its shape recognizable against that record.

- [ ] **Step 2: Run to verify pass** (twice, to shake contention):

Run: `npx vitest run --project @gl3/server apps/server/test/casino-lock-order.test.ts`
Expected: PASS. A bare 500 on `lockPlayersForUpdate` here is the recorded pre-existing flake — re-run standalone before blaming the conversion, and say so in the report either way.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/casino-lock-order.test.ts
git commit -m "test(casino): lock-order suite converted to FARO"
```

---

### Task 9: Hub table routes — sit, leave, read

**Files:**
- Create: `packages/plugins/casino/src/table-engine.ts`
- Create: `packages/plugins/casino/src/table-routes.ts`
- Modify: `packages/plugins/casino/src/index.ts` (register routes)
- Test: `apps/server/test/casino-tables.test.ts` (new; register in the default `@gl3/server` project)

**Interfaces:**
- Consumes: `casinoTables`/`casinoSeats` (Task 2), `buildTableRegistry`/`tableGames` (Task 3), `frozenHouse`/`House` from `./engine.js`, settings readers (Task 1), `toStorableState`/`fromStorableState`.
- Produces (`table-engine.ts`):

```ts
export interface TableRow { /* row of casinoTables, drizzle-inferred */ }
export interface SeatRow { /* row of casinoSeats */ }
export interface LockedTable { table: TableRow; seats: SeatRow[]; house: House }
/** Caller must already hold tx.locks.location(table.location_id).
 *  Reads seats (stable under the location lock), resolves the frozen house,
 *  takes ONE sorted tx.locks.player over [seat players..., owner, ...extra],
 *  then the table row FOR UPDATE, then re-reads seats. Returns null if the
 *  table vanished. */
export async function lockTable(tx: PluginTx, ctx: PluginCtx, tableId: string, extraPlayerIds?: string[]): Promise<LockedTable | null>;
```

- Routes produced (all `auth` default player, `accessInJail: false`, `accessInHospital: true`):
  - `POST /api/casino/table/sit` body `{ gameId: z.string().min(1).max(80) }` → 200 `{ tableId, seat }`
  - `POST /api/casino/table/leave` (no body) → 200 `{ left: true, deferred: boolean }` (`deferred` true when in-hand and only marked leaving)
  - `GET /api/casino/table` → 200 `{ table: null }` or the table view payload (shape fixed in Task 12's DTO; build it here and keep it in sync):

```ts
{
  tableId, gameId, gameName,
  locationId, locationName,
  phase: "betting" | "acting",
  handNo: number,
  deadlineAt: string | null,
  turnSeat: number | null,
  mySeat: number | null,   // null when a re-read after an advance shows the caller kicked
  minBet: string, maxBet: string,
  seats: [{ seat: number, username: string, wager: string, leaving: boolean, idleHands: number }],
  view: ViewNode | null,
}
```

- [ ] **Step 1: Write the failing tests** — `apps/server/test/casino-tables.test.ts`, booted with a bare `bootTestServer()` (blackjack is a CORE plugin and now a table game). Reuse `casino-play.test.ts`'s `register`/`seedLocation`/`seedHouse` (pluginId `"blackjack"`)/`placePlayer` helpers verbatim, plus:

```ts
const sit = (token: string, gameId = "blackjack") => app.inject({
  method: "POST", url: "/api/casino/table/sit",
  headers: { authorization: `Bearer ${token}` }, payload: { gameId },
});
const leave = (token: string) => app.inject({
  method: "POST", url: "/api/casino/table/leave",
  headers: { authorization: `Bearer ${token}` }, payload: {},
});
const tableView = (token: string) => app.inject({
  method: "GET", url: "/api/casino/table",
  headers: { authorization: `Bearer ${token}` },
});
```

Cases:

```ts
describe("POST /api/casino/table/sit", () => {
  it("seats the caller at a fresh table in their town", async () => { /* 200; body.seat === 0; row in p_casino_tables with location, gameId, phase betting; seat row */ });
  it("fills seats in order and the sixth sitter opens a second table", async () => {
    // five players sit → same tableId, seats 0..4; a sixth sits → NEW tableId, seat 0
  });
  it("re-uses the lowest freed seat number", async () => { /* A,B sit; A leaves; C sits → seat 0 */ });
  it("refuses a second seat anywhere with 409 already_seated", async () => { /* sit twice; also sit, travel the player's location column elsewhere, sit again → still 409 */ });
  it("404s an unknown game and 409s a caller with no location", async () => {});
  it("stamps the frozen house at table creation", async () => { /* seedHouse first; sit; table row's propertyId === the property */ });
});

describe("POST /api/casino/table/leave", () => {
  it("frees a betting-phase seat immediately and deletes an emptied table", async () => { /* sit, leave → deferred false; seat row gone; table row gone */ });
  it("keeps the table when other seats remain", async () => {});
});

describe("GET /api/casino/table", () => {
  it("answers { table: null } for the unseated", async () => {});
  it("shows phase, seats with usernames, and no view between hands", async () => {
    /* two sitters; view null; phase betting; seats.length 2; usernames right; mySeat right */
  });
});
```

- [ ] **Step 2: Register the file in `vitest.workspace.ts` (default `@gl3/server` project), run to verify failure** (404s — routes missing).

- [ ] **Step 3: Implement.** `table-engine.ts`:

```ts
import { asc, eq } from "drizzle-orm";
import type { PluginCtx, PluginTx } from "@gl3/plugin-sdk";
import { frozenHouse, type House } from "./engine.js";
import { casinoSeats, casinoTables } from "./schema.js";
import { readMaxBet } from "./settings.js";

export type TableRow = typeof casinoTables.$inferSelect;
export type SeatRow = typeof casinoSeats.$inferSelect;

export interface LockedTable { table: TableRow; seats: SeatRow[]; house: House }

/**
 * RULE 6, the table edge. The caller holds tx.locks.location(the table's
 * town) BEFORE calling — that lock serializes every sit/leave/bet/act/advance
 * at the table, which is what makes the seat read below authoritative. Then:
 * ONE sorted tx.locks.player over every seated player, the frozen-house
 * owner, and any extra ids (sit's caller, who has no seat yet) — splitting
 * this call is the ABBA cycle casino-table-lock-order.test.ts pins — then
 * the table row FOR UPDATE.
 */
export async function lockTable(
  tx: PluginTx, ctx: PluginCtx, tableId: string, extraPlayerIds: string[] = [],
): Promise<LockedTable | null> {
  const seatRows = await tx.db.select().from(casinoSeats)
    .where(eq(casinoSeats.tableId, tableId)).orderBy(asc(casinoSeats.seatNo));
  const [pre] = await tx.db.select().from(casinoTables).where(eq(casinoTables.id, tableId));
  if (pre === undefined) return null;
  const house = await frozenHouse(tx, pre.propertyId, readMaxBet(ctx.settings));
  const ids = new Set<string>(extraPlayerIds);
  for (const seat of seatRows) ids.add(seat.playerId);
  if (house.ownerId !== null) ids.add(house.ownerId);
  await tx.locks.player([...ids]);
  const [table] = await tx.db.select().from(casinoTables)
    .where(eq(casinoTables.id, tableId)).for("update");
  if (table === undefined) return null;
  const seats = await tx.db.select().from(casinoSeats)
    .where(eq(casinoSeats.tableId, tableId)).orderBy(asc(casinoSeats.seatNo));
  return { table, seats, house };
}
```

`table-routes.ts` — sit/leave/read (deal/act/clock land in Tasks 10–11; structure the file so they slot in):

```ts
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { PluginError, route, type PluginCtx, type PluginTx } from "@gl3/plugin-sdk";
import { resolveHouse } from "./engine.js";
import { buildTableRegistry, type TableGameDef } from "./games.js";
import { casinoSeats, casinoTables, locations, players, playerStats } from "./schema.js";
import { fromStorableState } from "./state.js";
import { readMaxBet, readMinBet, readTableMaxSeats } from "./settings.js";
import { lockTable, type LockedTable } from "./table-engine.js";

/** The caller's current town, `play`'s idiom: 409 when nowhere. */
async function locationOf(tx: PluginTx, playerId: string): Promise<string> {
  const [stats] = await tx.db.select({ locationId: playerStats.locationId })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  const locationId = stats?.locationId;
  if (locationId === null || locationId === undefined) throw new PluginError("no_location", 409);
  return locationId;
}

/** The caller's seat + its table, unlocked pre-read. */
async function seatOf(tx: PluginTx, playerId: string): Promise<{ seatId: string; tableId: string; locationId: string } | null> {
  const [row] = await tx.db
    .select({ seatId: casinoSeats.id, tableId: casinoSeats.tableId, locationId: casinoTables.locationId })
    .from(casinoSeats)
    .innerJoin(casinoTables, eq(casinoTables.id, casinoSeats.tableId))
    .where(eq(casinoSeats.playerId, playerId));
  return row ?? null;
}

const sitRoute = route({
  method: "POST",
  path: "/api/casino/table/sit",
  accessInJail: false,
  accessInHospital: true,
  body: z.object({ gameId: z.string().min(1).max(80) }).strict(),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const registry = await buildTableRegistry(ctx, ctx.installedPluginIds);
    const game = registry.get(body.gameId);
    if (game === undefined) throw new PluginError("no_such_game", 404);
    const maxSeats = readTableMaxSeats(ctx.settings);

    return ctx.transaction(async (tx) => {
      // Unlocked pre-read for the clean refusal; the authoritative check is
      // the re-read below under the caller's own player lock (two sits by one
      // player serialize on that row — the solo one-open shape), and the
      // p_casino_seats_one_seat unique index is the backstop.
      if (await seatOf(tx, player.id) !== null) throw new PluginError("already_seated", 409);

      const locationId = await locationOf(tx, player.id);
      await tx.locks.location(locationId);

      // Candidate table BEFORE the player lock? No — lockTable needs the seat
      // set, which is stable only under the location lock we now hold, and the
      // player-lock step needs the owner. Find the table, then lock.
      const tables = await tx.db.select().from(casinoTables)
        .where(eq(casinoTables.locationId, locationId))
        .orderBy(asc(casinoTables.createdAt));
      let target: string | null = null;
      for (const t of tables) {
        if (t.gameId !== body.gameId) continue;
        const seats = await tx.db.select({ id: casinoSeats.id }).from(casinoSeats)
          .where(eq(casinoSeats.tableId, t.id));
        if (seats.length < maxSeats) { target = t.id; break; }
      }

      if (target === null) {
        // A fresh table. The house is frozen NOW (the play-time freeze's
        // sibling): resolveHouse reads unlocked, payOwner re-reads FOR UPDATE.
        const house = await resolveHouse(tx, body.gameId, locationId, readMaxBet(ctx.settings));
        await tx.locks.player(house.ownerId === null || house.ownerId === player.id
          ? [player.id] : [player.id, house.ownerId]);
        if (await seatOf(tx, player.id) !== null) throw new PluginError("already_seated", 409);
        const tableId = uuidv7();
        await tx.db.insert(casinoTables).values({
          id: tableId, gameId: body.gameId, locationId,
          propertyId: house.propertyId, seed: randomBytes(16).toString("hex"),
        });
        await tx.db.insert(casinoSeats).values({
          id: uuidv7(), tableId, playerId: player.id, seatNo: 0,
        });
        return { status: 200, body: { tableId, seat: 0 } };
      }

      const locked = await lockTable(tx, ctx, target, [player.id]);
      if (locked === null) throw new PluginError("no_such_table", 404);
      if (await seatOf(tx, player.id) !== null) throw new PluginError("already_seated", 409);
      if (locked.seats.length >= maxSeats) throw new PluginError("table_full", 409);
      const taken = new Set(locked.seats.map((s) => s.seatNo));
      let seatNo = 0;
      while (taken.has(seatNo)) seatNo += 1;
      await tx.db.insert(casinoSeats).values({
        id: uuidv7(), tableId: target, playerId: player.id, seatNo,
      });
      return { status: 200, body: { tableId: target, seat: seatNo } };
    });
  },
});

const leaveRoute = route({
  method: "POST",
  path: "/api/casino/table/leave",
  accessInJail: false,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    return ctx.transaction(async (tx) => {
      const seat = await seatOf(tx, player.id);
      if (seat === null) throw new PluginError("not_seated", 404);
      // The SEAT'S table's town, not the caller's — leave works from anywhere
      // (spec: travelling away is resolved by leaving, never by a
      // two-location transaction).
      await tx.locks.location(seat.locationId);
      const locked = await lockTable(tx, ctx, seat.tableId);
      if (locked === null) throw new PluginError("not_seated", 404);
      const mine = locked.seats.find((s) => s.playerId === player.id);
      if (mine === undefined) throw new PluginError("not_seated", 404);

      if (mine.wager > 0n) {
        // In hand — wager escrowed, whether the deal has fired (acting) or is
        // still pending (betting): the stake stays in play, spec §5's "no
        // money is ever dropped by leaving". Mark leaving; the deal includes
        // this seat, the turn clock auto-stands its turns, and Task 10's
        // settle pays it normally and frees the seat at hand end. The
        // wager-0 test is the spec's in-hand definition — NEVER phase.
        await tx.db.update(casinoSeats).set({ leaving: true }).where(eq(casinoSeats.id, mine.id));
        return { status: 200, body: { left: true, deferred: true } };
      }
      await tx.db.delete(casinoSeats).where(eq(casinoSeats.id, mine.id));
      if (locked.seats.length === 1) {
        await tx.db.delete(casinoTables).where(eq(casinoTables.id, locked.table.id));
      }
      return { status: 200, body: { left: true, deferred: false } };
    });
  },
});

/** The view payload GET, bet and act all answer with (Task 12's DTO). */
export async function renderTablePayload(
  tx: PluginTx, ctx: PluginCtx, locked: LockedTable, game: TableGameDef, viewerId: string,
): Promise<Record<string, unknown>> {
  const { table, seats, house } = locked;
  const [loc] = await tx.db.select({ name: locations.name })
    .from(locations).where(eq(locations.id, table.locationId));
  const ids = seats.map((s) => s.playerId);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const rows = await tx.db.select({ id: players.id, username: players.username })
      .from(players).where(inArray(players.id, ids));
    for (const row of rows) names.set(row.id, row.username);
  }
  const mine = seats.find((s) => s.playerId === viewerId);
  const viewerSeat = mine === undefined ? null : mine.seatNo;
  const inHand = mine !== undefined && mine.wager > 0n;
  return {
    tableId: table.id,
    gameId: table.gameId,
    gameName: game.name,
    locationId: table.locationId,
    locationName: loc?.name ?? "",
    phase: table.phase,
    handNo: table.handNo,
    deadlineAt: table.deadlineAt === null ? null : table.deadlineAt.toISOString(),
    turnSeat: table.turnSeat,
    mySeat: viewerSeat,
    minBet: readMinBet(ctx.settings).toString(),
    maxBet: house.maxBet.toString(),
    seats: seats.map((s) => ({
      seat: s.seatNo,
      username: names.get(s.playerId) ?? "",
      wager: s.wager.toString(),
      leaving: s.leaving,
      idleHands: s.idleHands,
    })),
    view: table.state === null
      ? null
      : guardGame(table.gameId, "view", () =>
          game.view(fromStorableState(table.state), inHand ? viewerSeat : null)),
  };
}

const readRoute = route({
  method: "GET",
  path: "/api/casino/table",
  accessInJail: false,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const registry = await buildTableRegistry(ctx, ctx.installedPluginIds);
    return ctx.transaction(async (tx) => {
      const seat = await seatOf(tx, player.id);
      if (seat === null) return { status: 200, body: { table: null } };
      // Fast path: no lapsed deadline → plain reads, zero locks. Task 11
      // replaces this comment with the advance-then-render slow path.
      await tx.locks.location(seat.locationId);
      const locked = await lockTable(tx, ctx, seat.tableId);
      if (locked === null) return { status: 200, body: { table: null } };
      const game = registry.get(locked.table.gameId);
      if (game === undefined) throw new PluginError("no_such_game", 404);
      return { status: 200, body: { table: await renderTablePayload(tx, ctx, locked, game, player.id) } };
    });
  },
});

export const tableRoutes = [sitRoute, leaveRoute, readRoute];
```

(Import `guardGame` from `./engine.js` and `inArray` from `drizzle-orm`. The GET's lock-taking read is temporary scaffolding replaced by Task 11's real fast/slow split — the comment marks it.)

In `index.ts`: `import { tableRoutes } from "./table-routes.js";` and spread into the manifest's `routes: [...existing, ...tableRoutes]`; also `export { lockTable } from "./table-engine.js";` for tests.

- [ ] **Step 4: Run to verify pass** — `npx vitest run --project @gl3/server apps/server/test/casino-tables.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/casino/src apps/server/test/casino-tables.test.ts vitest.workspace.ts
git commit -m "feat(casino): table sit/leave/read routes"
```

---

### Task 10: Bet, deal, act, settle — the money path

**Files:**
- Modify: `packages/plugins/casino/src/table-engine.ts` (add `totalExposure`, `resolveTablePayouts`, `settleHand`, `dealIfReady`, `applyStep`)
- Modify: `packages/plugins/casino/src/table-routes.ts` (add `bet` and `act` routes)
- Test: `apps/server/test/casino-table-money.test.ts` (new; default `@gl3/server` project)

**Interfaces:**
- Produces (`table-engine.ts` additions; `escrow`/`assertHouseCanCover`-family reused from `engine.js`):

```ts
/** Σ per-seat exposureOf over every in-hand wager, `extra` included. */
export function totalExposure(seats: readonly SeatRow[], multiplier: number, extra?: { seat: number; amount: bigint }): bigint;
/** Bounds a table game's settle figures: unknown/duplicate seat or negative
 *  payout → 500; each figure clamped to exposureOf(seatWager, multiplier);
 *  seats absent from the array pay 0. */
export function resolveTablePayouts(game: TableGameDef, state: unknown, seats: readonly SeatRow[]): Map<string, bigint>; // seatId → payout
/** Pays every in-hand seat, hands the table property to the first short-paid
 *  winner in seat order (takeOverFrom), notifies both sides, resets seats
 *  (wager 0, idleHands 0 for players who played), deletes leaving seats and
 *  an emptied table, resets the table row to betting/null-state/null-deadline. */
export async function settleHand(tx: PluginTx, ctx: PluginCtx, locked: LockedTable, game: TableGameDef): Promise<void>;
/** Persists a TableStep: state, turnSeat, deadline (turn_seconds when not
 *  done), handles wagerDelta escrow (cover re-check FIRST), settles when done. */
export async function applyStep(tx: PluginTx, ctx: PluginCtx, locked: LockedTable, game: TableGameDef, step: TableStep<unknown>, actingSeat: number | null): Promise<void>;
/** Betting phase: if every non-leaving seat has bet, or `force`, deal —
 *  seed rotation, hand_no + 1, idle_hands sweep + kick for non-bettors,
 *  phase acting, then applyStep on game.deal. No-op otherwise. */
export async function dealIfReady(tx: PluginTx, ctx: PluginCtx, locked: LockedTable, game: TableGameDef, force: boolean): Promise<void>;
```

- Routes: `POST /api/casino/table/bet` body `{ wager: NonNegativeIntegerString }` and `POST /api/casino/table/act` body `{ action: z.unknown() }` — both answer `{ table: <payload> }`, the exact envelope GET uses, so the client parses all three with one schema (Task 16 depends on this). The payload is rendered from a **post-settle re-read** (`lockTable` again after `applyStep`/`settleHand`), because settle can delete the caller's `leaving` seat or the whole table — a vanished table answers `{ table: null }` (the schema allows it), never a stale pre-settle snapshot. Both: pre-read seat, **409 `wrong_location` when the caller's current location ≠ the table's**, then location lock → `lockTable` → phase checks (`bet` in betting only → 409 `wrong_phase`; `act` in acting with `turnSeat === mySeat` → 409 `not_your_turn`), bet bounds (`wager_below_min`/`wager_above_max` against the frozen house lever), cover check over **total** exposure, escrow, and for `bet`: stamp `deadline_at = now + table_bet_seconds` when it was null, `dealIfReady` (not forced). `act`: `parseAction` with the game's schema → `guardGame` act → `applyStep`.

- [ ] **Step 1: Write the failing tests** — `casino-table-money.test.ts`. Same helpers as Task 9 plus `bet(token, wager)` / `tableAct(token, action)` injectors and the `cashOf`/`ledgerCashOf` idioms from `casino-lock-order.test.ts`. Blackjack is deterministic in the seed, and the seed is a table-row column — tests that need a known deal UPDATE `p_casino_tables.seed` to a probed value (the `no-natural` scanning idiom from Task 4) before the final bet lands, then read `state` back out of the row to compute expectations with `dealTable`. Cases:

```ts
describe("betting", () => {
  it("escrows each seat's wager to the frozen house, exactly, and deals when all have bet", async () => {
    // owner + 3 players; all bet; assert per-player cash deltas, owner delta
    // = sum of wagers, property profit = sum, phase now acting, handNo 1,
    // state non-null, turnSeat = lowest dealt seat, deadlineAt ~now+30s.
  });
  it("refuses a bet outside min/lever bounds and outside the betting phase", async () => {});
  it("refuses the bet that would push total exposure past the house's cash", async () => {
    // Owner cash 300_000n, wagers 100_000n at 2.5×: A's bet checks 250k ≤
    // 300k and passes (escrow then RAISES owner cash to 400k); B's bet checks
    // 250k + 250k = 500k > 400k → 409 house_cannot_cover, B's cash untouched,
    // hand not dealt. (The owner-cash read is live per bet, so A's escrowed
    // wager counts toward covering B — pick figures accordingly.)
  });
  it("answers 409 wrong_location for a seated player who travelled away", async () => {});
});

describe("acting and settling", () => {
  it("plays a full 2-seat hand to settlement with conserved money", async () => {
    // Probe a seed where both seats can immediately stand; both stand in
    // turn order (second act by the other player; out-of-turn first → 409
    // not_your_turn). After settle: per-seat payouts match settleTable() on
    // the final state read from... the row is reset — so compute from
    // dealTable(seed) + the acts applied via actSeat. Assert cash and
    // ledger deltas per player and owner; seats' wager back to 0; phase
    // betting; state null; hand survives for the next bet.
  });
  it("double escrows the delta, re-checks cover, and refuses when the house cannot cover the raise", async () => {
    // Owner cash covers 2.5×W but not 2.5×2W → double answers 409, seat
    // wager unchanged in DB, hand still acting. (casino-act's solo
    // double-cover case, at a table.)
  });
  it("hands the table to the first SHORT-PAID winner in seat order and still pays everyone in full", async () => {
    // Two winners; owner cash strictly between seat 0's payout and the sum —
    // the house pays seat 0 IN FULL and comes up short only at seat 1, so the
    // table goes to SEAT 1's player (an implementation seizing for the first
    // WINNER regardless of shortfall fails this). Assert both winners' cash
    // credited in full, owner_player_id = seat 1's player, notifications via
    // tx.notify (query the notifications table for both parties).
  });
  it("answers 409 wrong_location on act, and leave works from another town", async () => {
    // Seated in-hand player's location moved elsewhere: act → 409
    // wrong_location (cooldown-free refusal, hand untouched); leave from the
    // remote town → 200 deferred:true (leave locks the SEAT's town, never the
    // caller's).
  });
  it("never sends the dealer's hole card to a seat still choosing", async () => {
    // Over HTTP: after the deal, GET the table as each seated player; walk
    // body.table.view for card codes; exactly one B1/B2 back present and the
    // hole card's code absent. (The concealment contract casino-act used to
    // prove for solo play.)
  });
  it("keeps a betting-phase leaver's escrowed stake in play — no money is ever dropped by leaving", async () => {
    // Two seats. A bets (phase still betting — B hasn't); A leaves → 200
    // { deferred: true }, A's cash unchanged by the leave. B bets → the deal
    // fires WITH A's seat in it; A's turns auto-stand via the clock; settle
    // pays A per settleTable on the final state and DELETES A's seat.
    // Assert: A's cash and ledger deltas equal escrow-out + payout-in; A's
    // seat row gone after settle; B's remains.
  });
});
```

- [ ] **Step 2: Register in the workspace, run to verify failure.**

- [ ] **Step 3: Implement.** Key excerpts (write these for real, not as sketches):

```ts
export function totalExposure(
  seats: readonly SeatRow[], multiplier: number, extra?: { seat: number; amount: bigint },
): bigint {
  let sum = 0n;
  for (const seat of seats) {
    let wager = seat.wager;
    if (extra !== undefined && seat.seatNo === extra.seat) wager += extra.amount;
    if (wager > 0n) sum += exposureOf(wager, multiplier);
  }
  return sum;
}

export function resolveTablePayouts(
  game: TableGameDef, state: unknown, seats: readonly SeatRow[],
): Map<string, bigint> {
  const figures = guardGame(game.id, "settle", () => game.settle(state));
  const bySeat = new Map<number, SeatRow>();
  for (const s of seats) if (s.wager > 0n) bySeat.set(s.seatNo, s);
  const payouts = new Map<string, bigint>();
  const seen = new Set<number>();
  for (const figure of figures) {
    const seat = bySeat.get(figure.seat);
    if (seat === undefined || seen.has(figure.seat)) throw new PluginError("invalid_payout", 500);
    seen.add(figure.seat);
    if (figure.payout < 0n) throw new PluginError("invalid_payout", 500);
    const cap = exposureOf(seat.wager, game.maxPayoutMultiplier);
    payouts.set(seat.id, figure.payout > cap ? cap : figure.payout);
  }
  for (const seat of bySeat.values()) if (!payouts.has(seat.id)) payouts.set(seat.id, 0n);
  return payouts;
}
```

`settleHand`: iterate `locked.seats` ascending `seatNo`; for each in-hand seat with payout > 0n, `payOwner(tx, propertyId, -payout, "casino.<gameId>.payout")`, compute shortfall exactly as `settleSession` does, `takeOverFrom` **only for the first** short-paid winner (a `seized` boolean latch — later shortfalls still pay but the table has already changed hands; `notifyTakeover` with that winner), then `applyBalanceChange` the payout to the player. After the loop: `UPDATE casinoSeats SET wager = 0, idle_hands = 0 WHERE table_id = ... AND wager > 0`; `DELETE FROM casinoSeats WHERE table_id = ... AND leaving`; if no seats remain, delete the table row, else `UPDATE casinoTables SET phase='betting', state=NULL, turn_seat=NULL, deadline_at=NULL`.

`applyStep`: on `wagerDelta` — refuse `amount <= 0n` or `seat !== actingSeat` with `PluginError("invalid_wager_delta", 500)` (a `null` actingSeat — deal or autoAct — refuses every delta); re-check cover with `totalExposure(seats, multiplier, wagerDelta)` vs owner cash (read with `readOwnerCash`'s query — move that helper from `index.ts` into `engine.ts` and re-import; the check keeps the SOLO semantics: Σ exposure over all in-hand wagers including the raise must not exceed the owner's cash as currently read, no incoming-wager addend — `assertHouseCanCover`'s exact comparison, summed); `escrow(tx, house, seatPlayerId, amount, gameId)` (the SEAT'S player). **Turn guard**: when `step.done` is false, `step.turn` must be a non-null integer naming an in-hand seat — `seats.some(s => s.wager > 0n && s.seatNo === step.turn)` (post-delta wagers) — else `PluginError("invalid_turn", 500)`; when `step.done` is true ignore `step.turn` and persist NULL. This is the single choke point for deal, act and autoAct steps — Task 14's turn-not-in-hand case exercises it. Then persist seat wager and `UPDATE casinoTables SET state = toStorableState(step.state), turn_seat = step.done ? NULL : step.turn, deadline_at = step.done ? NULL : now + readTableTurnSeconds`; if `step.done`, call `settleHand` (which overwrites those resets — acceptable double-write, single tx).

`dealIfReady`: bettors = **ALL** seats with `wager > 0n`, leaving included — an escrowed stake is always dealt in and settles normally (spec §5: no money is ever dropped by leaving); `leaving` matters only to the readiness check and the idle sweep. If `!force` and any **non-leaving** seat has `wager === 0n`, return. If bettors empty, clear `deadline_at` and return. Sweep: for each non-leaving zero-wager seat `idle_hands + 1`; delete seats reaching `readTableIdleKickHands` (they hold no money). Deal with the row's **CURRENT** seed — `game.deal({ seats: bettors.map(s => ({ seat: s.seatNo, wager: s.wager })), seed: locked.table.seed })` under `guardGame(gameId, "start", ...)` — then rotate the row for the NEXT hand: `seed = randomBytes(16).toString("hex")`, `hand_no + 1`, phase `acting`, then `applyStep` with `actingSeat: null` (deal deltas refused like autoAct's). The creation-time seed (Task 9) feeds hand 1, and a test's pre-bet `UPDATE p_casino_tables SET seed = ...` deterministically controls the imminent deal — Step 1's probed-seed strategy depends on this order; spec §3's "rotated at every deal" still holds because every deal writes a fresh seed.

Both new routes mirror `sit`'s shape; `wrong_location` check happens on the unlocked pre-read (compare `locationOf(tx, player.id)` to `seat.locationId`) — deliberately before any lock, mirroring `play`'s pre-reads.

- [ ] **Step 4: Run to verify pass** — the new file plus `casino-tables.test.ts` (regression). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/casino/src apps/server/test/casino-table-money.test.ts vitest.workspace.ts
git commit -m "feat(casino): table bet/act with per-seat escrow, settle and takeover"
```

---

### Task 11: The lazy clock

**Files:**
- Modify: `packages/plugins/casino/src/table-engine.ts` (add `advanceTable`)
- Modify: `packages/plugins/casino/src/table-routes.ts` (call it from bet/act/GET; give GET its real fast path)
- Test: `apps/server/test/casino-table-clock.test.ts` (new; default project)

**Interfaces:**
- Produces: `export async function advanceTable(tx, ctx, locked: LockedTable, game: TableGameDef): Promise<LockedTable>` — while `deadline_at !== null && deadline_at <= now`: betting → `dealIfReady(force: true)`; acting → `applyStep` on `guardGame(gameId, "act", () => game.autoAct(state, turnSeat))`; re-read table+seats between iterations; returns the final locked view. Called at the TOP of bet's and act's locked section (deadline may have lapsed while the request was queued) and by GET's slow path.
- GET's real shape: unlocked pre-read of the table row; if `deadlineAt === null || deadlineAt > now` → render from plain reads, NO locks taken (build a `LockedTable`-shaped object from unlocked reads and reuse `renderTablePayload`); else location lock → `lockTable` → `advanceTable` → render.

- [ ] **Step 1: Write the failing tests** — `casino-table-clock.test.ts`. Deadlines are driven by backdating columns directly (`UPDATE p_casino_tables SET deadline_at = now() - interval '1 second'`), never by sleeping:

```ts
describe("the betting deadline", () => {
  it("deals to the bettors and skips the seat that never bet, bumping its idle count", async () => {
    // A bets, B doesn't; backdate deadline; GET as A → phase acting, hand
    // dealt to A alone; B's seat idleHands 1, still seated.
  });
  it("kicks a seat that idles through table_idle_kick_hands deals", async () => {
    // Loop three backdated deals (A bets each time, B never); after the
    // third, B's seat row is gone.
  });
});

describe("the turn deadline", () => {
  it("auto-stands the timed-out seat and moves on", async () => {
    // Two bettors; backdate the turn deadline; GET as the OTHER player →
    // turnSeat advanced past seat 0 (or hand settled), seat 0's hand stood.
  });
  it("plays a fully abandoned hand to settlement on one read", async () => {
    // Both seats' turns lapse: backdate, GET once → advanceTable loops both
    // auto-stands AND the settle; phase betting, wagers 0, money conserved
    // (ledger assertions).
  });
});

describe("the clock in sit and leave", () => {
  it("leave on a fully-lapsed acting table settles first and frees the seat now", async () => {
    // Both turns lapsed: backdate, then POST leave → advanceTable inside
    // leave plays the hand out and settles; response { left: true,
    // deferred: false }, seat row gone, money conserved.
  });
  it("sit fires a lapsed deal before seating the newcomer", async () => {
    // A bet, deadline backdated; C sits → the deal includes only A, C's
    // fresh seat has idle_hands 0 and is not in the hand.
  });
});

describe("the read fast path", () => {
  it("takes no row locks when no deadline has lapsed", async () => {
    // Hold the table row FOR UPDATE from a raw connection; GET (live
    // deadline in the future) must still answer 200 without blocking —
    // assert it resolves within the test timeout while the lock is held.
  });
});
```

- [ ] **Step 2: Register, run to verify failure.**

- [ ] **Step 3: Implement.** `advanceTable`:

```ts
export async function advanceTable(
  tx: PluginTx, ctx: PluginCtx, locked: LockedTable, game: TableGameDef,
): Promise<LockedTable | null> {
  let current = locked;
  // Bounded: every iteration either settles the hand (deadline → null),
  // deals (deadline → future), or stands one seat (deadline → future). The
  // guard is belt-and-braces against a rogue game's autoAct never
  // advancing `turn` — 3 × MAX_TABLE_SEATS covers a full hand of lapses.
  for (let i = 0; i < 15; i++) {
    const { table } = current;
    if (table.deadlineAt === null || table.deadlineAt > new Date()) return current;
    if (table.phase === "betting") {
      await dealIfReady(tx, ctx, current, game, true);
    } else if (table.turnSeat !== null && table.state !== null) {
      const state = fromStorableState(table.state);
      const step = guardGame(table.gameId, "act", () => game.autoAct(state, table.turnSeat!));
      await applyStep(tx, ctx, current, game, step, null);
    } else {
      throw new PluginError("invalid_turn", 500);
    }
    const reread = await lockTable(tx, ctx, table.id);
    // null, never the stale pre-settle snapshot: a settle that emptied the
    // table deleted it, and rendering the old LockedTable would show a table
    // that no longer exists. Callers answer { table: null } / not_seated.
    if (reread === null) return null;
    current = reread;
  }
  throw new PluginError("invalid_turn", 500);
}
```

Wire it: `bet`, `act` AND `leave` call `advanceTable` immediately after `lockTable` and re-derive `mine`/phase/seats from its return — a lapsed bet deadline may have dealt without the caller, a lapsed turn may have passed them, and a settle may already have freed a leaver's seat (leave then answers `{ left: true, deferred: false }`; a `null` return means the table is gone — `not_seated`/`{ table: null }` as fits the route; `leave` builds the table registry the way `bet` does and treats an uninstalled game as `no_such_game` 404). `sit`'s existing-table branch calls `advanceTable` after its `lockTable` and re-checks fullness/table-existence from the advanced state — a lapsed deal must fire BEFORE the newcomer's seat row exists, so the idle sweep never touches them. GET's slow/fast split per the interface block. `applyStep` with `actingSeat: null` refusing deltas (Task 10) is what makes autoAct-driven raises impossible.

- [ ] **Step 4: Run to verify pass** (clock + money + tables files). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/casino/src apps/server/test/casino-table-clock.test.ts vitest.workspace.ts
git commit -m "feat(casino): lazy table clock — bet/turn deadlines, auto-stand, idle kick"
```

---

### Task 12: Lobby extension — local tables and remote counts

**Files:**
- Modify: `packages/plugins/casino/src/index.ts` (lobby route)
- Test: extend `apps/server/test/casino-tables.test.ts`

**Interfaces:**
- Produces, added to `GET /api/casino`'s body: `tableGames: [{ gameId, name, ownerName, maxBet, tables: [{ tableId, seatsFilled, maxSeats, phase }] }]` for the caller's town (every registered table game listed, with-or-without live tables); `remote: [{ locationId, locationName, gameId, gameName, seated }]` — every OTHER location with ≥1 seated player at a table of an installed table game, counts only, **no usernames anywhere in the remote branch**.

- [ ] **Step 1: Write the failing tests** — extend `casino-tables.test.ts`:

```ts
describe("GET /api/casino table listings", () => {
  it("lists the town's tables with fill counts and the game's house", async () => {
    // seedHouse for blackjack in town A; two players sit there; caller (a
    // third player) stands in A. body.tableGames has a blackjack row with
    // ownerName = the owner's username, maxBet = lever-or-setting, and one
    // table { seatsFilled: 2, maxSeats: 5, phase: "betting" }. A registered
    // table game with NO live table still appears, tables: [].
  });
  it("lists a remote town's tables as counts only — no usernames", async () => {
    // Seat two players at town B; caller stands in town A. body.remote has
    // one row { locationId: B, gameId: "blackjack", seated: 2 }; assert
    // JSON.stringify(body.remote) contains NEITHER seated player's username.
  });
  it("omits empty remote towns", async () => {
    // A third town with a house but no seats appears nowhere in body.remote.
  });
});
```

- [ ] **Step 2: Run to verify failure.** — the lobby body lacks `tableGames`/`remote`.

- [ ] **Step 3: Implement** in the lobby handler, after the existing solo-games block, inside the same transaction: build the table registry too; for the caller's town, `resolveHouse` per table game (reusing the existing `houses`/`ownerNames` machinery — extend the owner-name batch to cover both registries); list local tables with a seats count (`select tableId, count(*)` grouped, drizzle `sql<number>` count over a join); for `remote`, one grouped query:

```ts
const remoteRows = await tx.db
  .select({
    locationId: casinoTables.locationId,
    locationName: locations.name,
    gameId: casinoTables.gameId,
    seated: sql<number>`count(*)::int`,
  })
  .from(casinoSeats)
  .innerJoin(casinoTables, eq(casinoTables.id, casinoSeats.tableId))
  .innerJoin(locations, eq(locations.id, casinoTables.locationId))
  .where(ne(casinoTables.locationId, locationId))
  .groupBy(casinoTables.locationId, locations.name, casinoTables.gameId);
```

filtered to registered game ids, `gameName` from the registry.

- [ ] **Step 4: Run to verify pass** (plus `casino-lobby.test.ts` for solo-lobby regression). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/casino/src/index.ts apps/server/test/casino-tables.test.ts
git commit -m "feat(casino): lobby lists local tables and remote seat counts"
```

---

### Task 13: Table lock-order regression test

**Files:**
- Test: `apps/server/test/casino-table-lock-order.test.ts` (new; default project; register it)

Model on `casino-lock-order.test.ts` — copy its `waitForLockWaiters`, barrier and inversion machinery wholesale; the file header documents what each case proves.

- [ ] **Step 1: Write the tests:**
  - **ABBA across two tables:** towns X and Y; player A owns the blackjack house in X, B owns it in Y; A sits (alone) at Y's table, B sits at X's. Barrier holds both `player_stats` rows sorted; both fire `bet` (the money-moving route). Under the ONE sorted `lockTable` call both queue on the same first row: expect `[200, 200]`, no 500. This must go red with a real `40P01` when `lockTable`'s single `tx.locks.player([...ids])` is split into caller-then-owner — **demonstrate red** by temporarily splitting the call locally (two sequential `tx.locks.player` calls, caller first), capture the 40P01/500 in the task report, revert.
  - **Deliberate inversion:** the `casino-lock-order` test-4 choreography verbatim against `POST /api/casino/table/bet` (a seated, unowned-town bettor): an actor taking `player_stats` before `locations` deadlocks and is the victim; the route answers 200.
  - **Two sitters race one seat:** two players, empty town; barrier both; both `sit`. Expect one `{seat: 0}` and one `{seat: 1}` at the same table OR clean statuses — never a 500 (the `p_casino_seats_table_seat` unique backstop must not surface as 23505).

- [ ] **Step 2: Run to verify pass; perform and record the red demonstration.**

Run: `npx vitest run --project @gl3/server apps/server/test/casino-table-lock-order.test.ts`

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/casino-table-lock-order.test.ts vitest.workspace.ts
git commit -m "test(casino): table lock-order regression (ABBA, inversion, seat race)"
```

---

### Task 14: Rogue table game

**Files:**
- Test: `apps/server/test/casino-rogue-table.test.ts` (new; default project — it uses `callPluginRoute` WITHOUT `bootTestServer`, so it runs `runPluginMigrations(db, [casinoPlugin, propertiesPlugin])` itself, the `casino-rogue-game.test.ts` shape — copy that file's scaffolding, `rogueGame` → `rogueTableGame` with id `"casino"` subscribed to `tableGames`).

- [ ] **Step 1: Write the tests** (each drives sit → bet → act via `callPluginRoute`):
  - settle returning 10× per seat → clamped to 2× (`maxPayoutMultiplier: 2`); over two seats, each clamped independently.
  - settle returning a negative figure, or naming a seat not in the hand, or the same seat twice → rejects `invalid_payout`, transaction rolled back (cash unchanged).
  - act returning `wagerDelta` with the WRONG seat, or a negative amount → `invalid_wager_delta`, seat wager unchanged.
  - `autoAct` returning a `wagerDelta` → `invalid_wager_delta` when the clock fires (backdate the deadline, then GET via `callPluginRoute`).
  - deal/act that throws → `game_error` (400-class `PluginError`), not a crash.
  - `turn` pointing at a seat not in the hand → `invalid_turn`.

- [ ] **Step 2–3: Run failing → implement nothing (the guards exist from Tasks 10–11; failures here are defects — fix in `table-engine.ts`) → run to pass → commit**

```bash
git add apps/server/test/casino-rogue-table.test.ts vitest.workspace.ts
git commit -m "test(casino): hostile TableGameDef is bounded by the hub"
```

---

### Task 15: Shared DTOs

**Files:**
- Modify: `packages/shared/src/dto/casino.ts`
- Modify: `packages/shared/package.json` (version bump)
- Test: `packages/shared/test/` — extend the existing dto test file for casino if one exists (check `ls packages/shared/test`); otherwise parse fixtures inline in a new `test/casino-tables.test.ts` there (that project's include is `test/**/*.test.ts` — no workspace edit needed).
- Modify: `apps/web/test/casino-page.test.ts` — its lobby fixtures (built without the new fields) stop parsing once `CasinoLobbyResponseSchema` gains required `tableGames`/`remote` arrays; add `tableGames: [], remote: []` to every fixture there (and to any other test parsing the lobby body with the shared schema — grep `CasinoLobbyResponseSchema` across apps).

**Interfaces:**
- Produces (all exported from `@gl3/shared`):

```ts
export const CasinoTableSeatSchema = z.object({
  seat: z.number().int().min(0).max(4),
  username: z.string(),
  wager: MoneySchema,
  leaving: z.boolean(),
  idleHands: z.number().int(),
});

export const CasinoTableViewSchema = z.object({
  tableId: IdSchema,
  gameId: z.string(),
  gameName: z.string(),
  locationId: IdSchema,
  locationName: z.string(),
  phase: z.enum(["betting", "acting"]),
  handNo: z.number().int(),
  deadlineAt: TimestampSchema.nullable(),
  turnSeat: z.number().int().nullable(),
  mySeat: z.number().int().nullable(),
  minBet: MoneySchema,
  maxBet: MoneySchema,
  seats: z.array(CasinoTableSeatSchema),
  view: BoundedViewNodeDtoSchema.nullable(),
});

export const CasinoTableResponseSchema = z.object({ table: CasinoTableViewSchema.nullable() });
export const CasinoSitResponseSchema = z.object({ tableId: IdSchema, seat: z.number().int() });
export const CasinoLeaveResponseSchema = z.object({ left: z.literal(true), deferred: z.boolean() });

export const CasinoTableSummarySchema = z.object({
  tableId: IdSchema, seatsFilled: z.number().int(), maxSeats: z.number().int(),
  phase: z.enum(["betting", "acting"]),
});
export const CasinoTableGameSchema = CasinoGameSchema.extend({
  tables: z.array(CasinoTableSummarySchema),
});
export const CasinoRemoteTablesSchema = z.object({
  locationId: IdSchema, locationName: z.string(), gameId: z.string(),
  gameName: z.string(), seated: z.number().int(),
});
// CasinoLobbyResponseSchema gains:
//   tableGames: z.array(CasinoTableGameSchema),
//   remote: z.array(CasinoRemoteTablesSchema),
```

plus the matching `export type` lines. `maxSeats` means the lobby payload carries it — add it to Task 12's lobby rows (`readTableMaxSeats`).

- [ ] **Step 1: Failing test** — parse a representative fixture of each new schema (valid passes; a `wager: 100` number fails; a 5th-seat `seat: 5` fails).
- [ ] **Step 2: Implement; bump `packages/shared/package.json` version by one patch from whatever it currently reads (do NOT publish — registry check + user approval happen outside this plan).**
- [ ] **Step 3: Reconcile the server**: `renderTablePayload` and the lobby must emit exactly these shapes — run `casino-tables.test.ts` and add one assertion there parsing a live GET body with `CasinoTableResponseSchema`.
- [ ] **Step 4: Run `@gl3/shared` project + the two server files → commit**

```bash
git add packages/shared apps/server/test/casino-tables.test.ts
git commit -m "feat(shared): casino table DTOs"
```

---

### Task 16: Web — table page

**Files:**
- Modify: `apps/web/src/api/keys.ts` (add `casinoTable: () => ["casino", "table"] as const`)
- Modify: `apps/web/src/api/queries.ts` (hooks)
- Modify: `apps/web/src/pages/Casino.tsx`
- Test: `apps/web/test/casino-table-helpers.test.ts` (new; `@gl3/web` include is `test/**/*.test.ts` — no workspace edit)

**Interfaces:**
- Hooks:

```ts
export function useCasinoTable(seated: boolean) {
  return useQuery<CasinoTableResponse>({
    queryKey: keys.casinoTable(),
    queryFn: async () => CasinoTableResponseSchema.parse(await api("/api/casino/table")),
    // The poll IS the realtime channel AND the lazy clock's heartbeat —
    // casino publishes no events (spec §8, amended). Only while seated.
    refetchInterval: seated ? 2500 : false,
  });
}
export function useSitCasino()   // POST /api/casino/table/sit   → CasinoSitResponseSchema; onSettled invalidate keys.casinoTable(), keys.casino()
export function useLeaveCasino() // POST /api/casino/table/leave → CasinoLeaveResponseSchema; same invalidations + keys.me()
export function useTableBet()    // POST /api/casino/table/bet   → CasinoTableResponseSchema-shaped body { table } — parse CasinoTableViewSchema on .table; invalidate keys.casinoTable(), keys.me()
export function useTableAct()    // POST /api/casino/table/act   → same; same invalidations
```

(Task 10's routes already answer `{ table: payload }` — all three read paths share `CasinoTableResponseSchema`.)

- Pure page helpers (exported for the test): `tableActions(view: CasinoTableView, myCash: string): { canBet: boolean; canAct: boolean; canDouble: boolean; reason: string | null }` — betting phase + `mySeat` + not yet wagered ⇒ `canBet` (via the existing `checkWager` against `minBet`/`maxBet`); acting + `turnSeat === mySeat` ⇒ `canAct`; `canDouble` when additionally my seat's rendered card count is unknowable client-side — the server refuses an illegal double with a clean 400, `handActions`'s precedent — so `canDouble = canAct`.

- [ ] **Step 1: Failing test** for `tableActions` (betting/acting/not-my-turn/no-seat cases).
- [ ] **Step 2: Implement hooks + helpers.**
- [ ] **Step 3: Rework `Casino.tsx`.** Structure:
  - Seated (`table !== null`): full-page table — location + hand number header, seat list (username, wager `<Money/>`, "leaving"/"idle" badges, turn highlight on `turnSeat`, "you" on `mySeat`), the `view` through `renderNode`/`PageRenderer` (the existing `cards` pipeline draws the hands), a countdown to `deadlineAt` (re-render on a 1s `setInterval`; when it crosses zero the 2.5s poll picks up the advance — no extra fetch call needed), then: betting phase → wager input + Bet button (reusing `checkWager`); acting + my turn → Hit/Stand/Double buttons via `useTableAct`; always → Leave button (two-step confirm when `phase === "acting"` and my wager > 0 — the property board's arm-then-fire idiom, never `window.confirm`).
  - Unseated: the existing solo lobby (kept — solo games may exist), plus a "Tables" section per `tableGames` row: game art (`SlotImage scope={gameId} slot="table"`), house line, each table's `seatsFilled/maxSeats · phase` with a Sit button (`useSitCasino`), or a bare Sit when no table exists yet; then the greyed `remote` list: `{locationName}: {seated} at the {gameName} tables` with a `Link to="/travel"` hint — rendered with reduced opacity and no buttons.
  - Keep `PropertyPanel` per table game (unchanged).
- [ ] **Step 4: Run `@gl3/web` project + `npm run typecheck` — the exhaustive-switch files (`eventCopy.ts`, `invalidation.ts`) must be untouched (no new event variants; TS2366 here means a stray edit).**
- [ ] **Step 5: Commit**

```bash
git add apps/web packages/shared
git commit -m "feat(web): multiplayer casino table page with polling"
```

---

### Task 17: Docs + merge gate

**Files:**
- Modify: `docs/STATUS.md` (cluster section: what shipped, the FARO conversion, the polling decision, the lock edge, the red-proof record from Task 13)
- Modify: `CLAUDE.md` (Current state: one paragraph — tables/seats migrations 0003–0006, `casino.tableGames`, lazy clock, no events, no new GameEvent variant, `casino-table-lock-order.test.ts` added to rule 6's list; update the rule-6 lock-order test enumeration)

- [ ] **Step 1: Write both docs.**
- [ ] **Step 2: Pre-gate checks** — no concurrent suites:

```bash
pgrep -fa vitest | grep -v pgrep
psql "$DATABASE_URL" -Atc "select datname from pg_database where datname like 'gl3_tmpl%'"
```

Both must come back empty (the template list may show only your own run's DB mid-run; before starting it must be empty). If not empty, WAIT — a concurrent session makes the run void, not failing.

- [ ] **Step 3: The gate** — bare, exit code from the process:

```bash
npm run verify > /tmp/claude-1000/-home-dlite-GL3/2c1130ac-fddb-4f9d-9c8e-0f30b75c3de9/scratchpad/verify.log 2>&1
echo $?
```

Run the two commands SEPARATELY (never `; echo "exit=$?"` on the same line as a pipe — the recorded trap). Non-zero exit = failure even if the summary reads all-passed; check the log tail for unhandled rejections. Known flake: `casino-lock-order`'s ABBA case bare-500 — if it fires, re-run that file standalone and report both results verbatim; it does not clear the gate by itself, the full suite must exit 0.

- [ ] **Step 4: Commit docs; report the gate's exit code and test counts verbatim in the task report.**

```bash
git add docs/STATUS.md CLAUDE.md
git commit -m "docs: blackjack tables cluster status"
```
