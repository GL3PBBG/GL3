# Money ranks, backfire, and weapon condition — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give behaviour to three migrated-but-unread pieces of schema — `money_ranks`, `player_stats.backfire`, and a new weapon-condition system that makes backfire vary between players.

**Architecture:** `money_ranks` stays core-owned; core's public profile route resolves the bracket, the `ranks` plugin edits the table. Weapon condition is a new combat-owned table with no foreign keys, decaying lazily on read (no background job). Backfire is a fourth roll in the already-pure `resolveShot`, evaluated before the hit roll.

**Tech Stack:** TypeScript strict (ESM, `.js` import extensions), Fastify, Drizzle + Postgres 16, Redis, zod, vitest against real Postgres/Redis, React + TanStack Query on the web side.

**Spec:** `docs/superpowers/specs/2026-08-15-money-ranks-backfire-weapon-condition-design.md`

**Branch:** `feat/money-ranks-backfire` (already created; the spec commit `88dfd98` is its first commit).

## Global Constraints

These apply to every task. They are the repo's standing rules (`CLAUDE.md`), restated with the exact values this work must honour.

- **No `any` in `packages/*`** — none, not even a cast. In `apps/*` prefer `unknown` plus a zod parse.
- **ESM only**; every relative import carries a `.js` extension despite `.ts` sources.
- **Zod-validates every external boundary** — HTTP bodies, route params, WS frames, bus messages, and `items.effects` jsonb.
- **Money is `bigint`** in Postgres and TypeScript and crosses the wire as a **decimal string** (`MoneySchema`). Never a JSON number.
- **Bigint column defaults are written `` .default(sql`0`) ``**, never `.default(0n)` — drizzle-kit's serialiser crashes on `BigInt`.
- **Every balance movement goes through `tx.economy.applyBalanceChange`** — one transaction, one ledger row. `sum(ledger) == balance` is enforced by `apps/server/test/economy-invariant.test.ts`.
- **Never check-then-act on Redis.** No task here adds a Redis key; if you find yourself wanting one, stop and re-read the spec §7.
- **Publish events only after the transaction commits.** `tx.events.publishCore` inside `ctx.transaction` is correct — the loader buffers and publishes post-commit.
- **A foreign key is a lock.** `p_combat_weapon_condition` declares **no** foreign keys, deliberately. Do not add one.
- **Tests asserting on `game:events` must filter by their own `actorId`** using `awaitOwnEvent()` from `apps/server/test/helpers/events.ts`.
- **A test that drives a plugin without `bootTestServer()` must run that plugin's migrations itself** via `runPluginMigrations(db, [plugin])`, or every test in the file dies on 42P01.
- **Conventional Commits.**
- **Combat settings keys are bare** in `readCombatSettings` — `condition.wear_per_shot`, not `combat.condition.wear_per_shot`. The SDK prefixes `combat.` on lookup. A pre-prefixed key resolves `combat.combat.…`, never exists, and silently falls back to the default with no error.
- **`effects.ts` is duplicated verbatim** between `packages/plugins/combat/src/effects.ts` and `packages/plugins/inventory/src/effects.ts`. Any change goes into **both**.
- **Verification runs bare:** `npm run verify` with no pipe through `grep`/`tail`, with `DATABASE_URL` and `REDIS_URL` exported. A non-zero exit is a failure even when every test is reported passing.

**New settings and their defaults** (bare keys, `combat` namespace):

| Key | Default | Clamp |
|---|---|---|
| `condition.wear_per_shot` | 1 | `>= 0` |
| `condition.decay_period_seconds` | 86400 | `>= 1` |
| `condition.decay_per_period` | 1 | `>= 0` |
| `backfire.base_chance` | 2 | `0..100` |
| `backfire.wear_factor` | 3 | `>= 0` |
| `repair.cost_per_point` | `1000n` | `>= 0` |

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/plugins/combat/src/condition.ts` | Pure condition math: lazy time decay, backfire chance. No I/O, no DB. |
| `apps/server/test/combat-condition.test.ts` | Unit tests for the above (no-DB project). |
| `apps/server/test/combat-backfire.test.ts` | Integration tests for backfire in the attack route. |
| `apps/server/test/combat-repair.test.ts` | Integration tests for the gunsmith route. |
| `apps/server/test/money-ranks.test.ts` | Integration tests for bracket resolution and the profile payload. |
| `apps/server/test/effects-parity.test.ts` | Asserts combat's and inventory's `effects.ts` copies agree. |

**Modified:**

| File | Change |
|---|---|
| `packages/shared/src/events.ts` | `player.backfired` variant |
| `packages/shared/src/dto/combat.ts` | `AttackResponseSchema` grows 3 fields; new weapon/repair DTOs |
| `packages/shared/src/dto/profile.ts` | `ProfileDtoSchema` grows `moneyRankLabel`, `backfire` |
| `packages/shared/src/dto/rank.ts` | `MoneyRankDtoSchema`; `RankListResponseSchema` grows `moneyRanks` |
| `packages/shared/package.json` | `0.1.1` → `0.1.2` |
| `packages/plugins/combat/src/settings.ts` | Three new settings groups |
| `packages/plugins/combat/src/resolve.ts` | Backfire roll and branch |
| `packages/plugins/combat/src/effects.ts` | `backfireChance` field |
| `packages/plugins/inventory/src/effects.ts` | Same field (hand-kept copy) |
| `packages/plugins/combat/src/migrations.ts` | Migration `0004_weapon_condition` |
| `packages/plugins/combat/src/schema.ts` | `weaponCondition` table; `playerItems` mirror; `playerStats.backfire`; `items.name` |
| `packages/plugins/combat/src/index.ts` | Condition load/wear, backfire effects, repair route, weapon route |
| `packages/plugins/ranks/src/schema.ts` | `moneyRanks` mirror; `playerStats.cash`/`bank` |
| `packages/plugins/ranks/src/index.ts` | Ladder field + money-rank admin CRUD + admin page section |
| `apps/server/src/game/profile/routes.ts` | Bracket resolution; two new payload fields |
| `apps/server/test/helpers/plugin-tables.ts` | `weaponCondition` test mirror |
| `apps/web/src/api/queries.ts` | Hooks for weapon condition and repair |
| `apps/web/src/lib/eventCopy.ts` | `player.backfired` copy |
| `apps/web/src/pages/Combat.tsx` | Condition + repair UI |
| `apps/web/src/pages/Profile.tsx`, `PlayerProfile.tsx` | Money-rank label, backfire count |
| `apps/web/src/pages/Ranks.tsx` | Money ladder |
| `docs/STATUS.md`, `CLAUDE.md` | Record what shipped |

---

## Task 1: `@gl3/shared` — DTOs, the `player.backfired` event, and the version bump

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/dto/combat.ts:30-39`
- Modify: `packages/shared/src/dto/profile.ts:72-82`
- Modify: `packages/shared/src/dto/rank.ts`
- Modify: `packages/shared/package.json:3`
- Test: `packages/shared/test/events.test.ts` (existing file; add cases)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `player.backfired` event variant: `{ ...base, type: "player.backfired", selfDamage: number, hospitalised: boolean }`
  - `AttackResponseSchema` gains `backfire: boolean`, `selfDamage: number`, `attackerHealth: number`
  - `WeaponConditionDtoSchema` → `{ itemId: string | null, name: string | null, condition: number, backfireChance: number, repairCost: MoneySchema }`
  - `RepairResponseSchema` → `{ condition: number, cost: MoneySchema }`
  - `ProfileDtoSchema` gains `moneyRankLabel: string | null`, `backfire: number`
  - `MoneyRankDtoSchema` → `{ id, label, threshold: MoneySchema }`; `RankListResponseSchema` gains `moneyRanks: MoneyRankDto[]`

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/events.test.ts`:

```ts
import { GameEventSchema } from "../src/events.js";
import { AttackResponseSchema, WeaponConditionDtoSchema } from "../src/dto/combat.js";
import { ProfileDtoSchema } from "../src/dto/profile.js";
import { RankListResponseSchema } from "../src/dto/rank.js";

describe("backfire and condition contracts", () => {
  it("parses a player.backfired event", () => {
    const parsed = GameEventSchema.parse({
      id: "018f0000-0000-7000-8000-000000000001",
      at: new Date().toISOString(),
      actorId: "018f0000-0000-7000-8000-000000000002",
      actorName: "shooter",
      audience: { kind: "player", playerId: "018f0000-0000-7000-8000-000000000002" },
      type: "player.backfired",
      selfDamage: 7,
      hospitalised: false,
    });
    expect(parsed.type).toBe("player.backfired");
  });

  it("rejects a negative selfDamage", () => {
    expect(() => GameEventSchema.parse({
      id: "018f0000-0000-7000-8000-000000000001",
      at: new Date().toISOString(),
      actorId: "018f0000-0000-7000-8000-000000000002",
      actorName: "shooter",
      audience: { kind: "player", playerId: "018f0000-0000-7000-8000-000000000002" },
      type: "player.backfired",
      selfDamage: -1,
      hospitalised: false,
    })).toThrow();
  });

  it("requires the three new attack response fields", () => {
    expect(() => AttackResponseSchema.parse({
      hit: false, crit: false, damage: 0, armorAbsorbed: 0,
      targetHealth: 100, targetKilled: false, payout: "0", bulletsSpent: 1,
    })).toThrow();
  });

  it("parses a weapon condition dto with no weapon equipped", () => {
    const dto = WeaponConditionDtoSchema.parse({
      itemId: null, name: null, condition: 100, backfireChance: 0, repairCost: "0",
    });
    expect(dto.itemId).toBeNull();
  });

  it("carries a nullable money rank label on a profile", () => {
    const dto = ProfileDtoSchema.parse({
      playerId: "018f0000-0000-7000-8000-000000000002",
      username: "someone", bio: null, avatarUrl: null,
      gangId: null, gangName: null, exp: "0", rankName: null,
      moneyRankLabel: null, backfire: 0,
      createdAt: new Date().toISOString(),
    });
    expect(dto.moneyRankLabel).toBeNull();
  });

  it("carries a money rank ladder on the rank list", () => {
    const res = RankListResponseSchema.parse({
      ranks: [],
      moneyRanks: [{ id: "018f0000-0000-7000-8000-000000000003", label: "Broke", threshold: "0" }],
    });
    expect(res.moneyRanks[0]?.label).toBe("Broke");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run --project @gl3/shared packages/shared/test/events.test.ts`
Expected: FAIL — `player.backfired` is not a member of the discriminated union; `WeaponConditionDtoSchema` is not exported.

- [ ] **Step 3: Add the event variant**

In `packages/shared/src/events.ts`, immediately after the `player.killed` variant:

```ts
  /**
   * Published to the ATTACKER only. The target has no way of knowing your gun
   * jammed, and telling them is information the attacker did not choose to
   * give. `hospitalised` is true when the self-damage put the attacker at 0.
   */
  z.object({
    ...base,
    type: z.literal("player.backfired"),
    selfDamage: z.number().int().nonnegative(),
    hospitalised: z.boolean(),
  }),
```

- [ ] **Step 4: Extend the combat DTOs**

In `packages/shared/src/dto/combat.ts`, replace `AttackResponseSchema` with:

```ts
export const AttackResponseSchema = z.object({
  hit: z.boolean(),
  crit: z.boolean(),
  damage: z.number().int(),
  armorAbsorbed: z.number().int(),
  targetHealth: z.number().int(),
  targetKilled: z.boolean(),
  payout: MoneySchema,
  bulletsSpent: z.number().int(),
  /** True when the weapon went off in the attacker's hand: no miss, no hit. */
  backfire: z.boolean(),
  /** Damage the attacker took from their own weapon. 0 unless `backfire`. */
  selfDamage: z.number().int().nonnegative(),
  /** The attacker's health after the shot, so the client need not refetch. */
  attackerHealth: z.number().int().nonnegative(),
});
```

Append to the same file:

```ts
/**
 * The equipped weapon's wear, for the combat page. Every field is nullable or
 * zero when nothing is equipped: fists have no condition and never backfire.
 */
export const WeaponConditionDtoSchema = z.object({
  itemId: z.string().uuid().nullable(),
  name: z.string().nullable(),
  condition: z.number().int().min(0).max(100),
  backfireChance: z.number().int().min(0).max(100),
  repairCost: MoneySchema,
});
export type WeaponConditionDto = z.infer<typeof WeaponConditionDtoSchema>;

export const RepairResponseSchema = z.object({
  condition: z.number().int().min(0).max(100),
  cost: MoneySchema,
});
export type RepairResponse = z.infer<typeof RepairResponseSchema>;
```

- [ ] **Step 5: Extend the profile and rank DTOs**

In `packages/shared/src/dto/profile.ts`, add two fields to `ProfileDtoSchema`, after `rankName`:

```ts
  /**
   * The wealth BRACKET, never the figure. `cash`/`bank` are read to compute
   * it and are never returned. Null when the player is below the lowest
   * threshold, or when `money_ranks` is empty.
   */
  moneyRankLabel: z.string().nullable(),
  /** Lifetime count of the player's own weapon backfiring. */
  backfire: z.number().int().nonnegative(),
```

In `packages/shared/src/dto/rank.ts`, append and amend:

```ts
export const MoneyRankDtoSchema = z.object({
  id: IdSchema,
  label: z.string(),
  threshold: MoneySchema,
});
export type MoneyRankDto = z.infer<typeof MoneyRankDtoSchema>;

export const RankListResponseSchema = z.object({
  ranks: z.array(RankDtoSchema),
  moneyRanks: z.array(MoneyRankDtoSchema),
});
export type RankListResponse = z.infer<typeof RankListResponseSchema>;
```

Delete the old single-field `RankListResponseSchema` declaration — do not leave two.

- [ ] **Step 6: Bump the package version**

In `packages/shared/package.json`, `"version": "0.1.1"` → `"version": "0.1.2"`.

This is additive, so `^0.1.0` consumers resolve it and `@gl3/plugin-sdk` needs no bump of its own — the same shape the `player.discharged`/`0.1.1` change took. Publishing happens in Task 9, not here.

- [ ] **Step 7: Run the tests and verify they pass**

Run: `npx vitest run --project @gl3/shared`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: FAILS, in `apps/web` and the profile/ranks routes, because `ProfileDtoSchema` and `RankListResponseSchema` now require fields nothing supplies yet. This is expected and is fixed by Tasks 7 and 8. Record the failing files in the commit body; do not "fix" them by making the new fields optional.

- [ ] **Step 9: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add player.backfired, weapon condition and money rank DTOs

Bumps @gl3/shared to 0.1.2. Additive, so ^0.1.0 ranges resolve it and
@gl3/plugin-sdk needs no bump. Typecheck fails until the profile route
and web client supply the new required fields (Tasks 7 and 8)."
```

---

## Task 2: Pure condition math and the new combat settings

**Files:**
- Create: `packages/plugins/combat/src/condition.ts`
- Modify: `packages/plugins/combat/src/settings.ts`
- Modify: `packages/plugins/combat/src/index.ts` (re-exports only)
- Test: `apps/server/test/combat-condition.test.ts`
- Test: `apps/server/test/combat-settings.test.ts` (existing; add cases)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `PRISTINE: 100`
  - `effectiveCondition(stored: number, updatedAt: Date, now: Date, decayPeriodSeconds: number, decayPerPeriod: number): number`
  - `backfireChanceFor(base: number, condition: number, wearFactor: number): number`
  - `CombatSettings` gains `condition: { wearPerShot, decayPeriodSeconds, decayPerPeriod }`, `backfire: { baseChance, wearFactor }`, `repair: { costPerPoint: bigint }`

This test file runs in the no-DB `@gl3/server:unit` project, like `combat-resolve.test.ts` — it touches neither Postgres nor Redis.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/combat-condition.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { backfireChanceFor, effectiveCondition, PRISTINE } from "@gl3/plugin-combat";

const DAY = 86_400;
const at = (iso: string): Date => new Date(iso);

describe("effectiveCondition", () => {
  it("returns the stored value when no time has passed", () => {
    const t = at("2026-08-15T00:00:00Z");
    expect(effectiveCondition(80, t, t, DAY, 1)).toBe(80);
  });

  it("does not decay before a full period elapses", () => {
    expect(effectiveCondition(
      80, at("2026-08-15T00:00:00Z"), at("2026-08-15T23:59:59Z"), DAY, 1,
    )).toBe(80);
  });

  it("decays exactly one step at the period boundary", () => {
    expect(effectiveCondition(
      80, at("2026-08-15T00:00:00Z"), at("2026-08-16T00:00:00Z"), DAY, 1,
    )).toBe(79);
  });

  it("floors partial periods rather than rounding", () => {
    expect(effectiveCondition(
      80, at("2026-08-15T00:00:00Z"), at("2026-08-17T12:00:00Z"), DAY, 1,
    )).toBe(78);
  });

  it("clamps at zero rather than going negative", () => {
    expect(effectiveCondition(
      5, at("2026-01-01T00:00:00Z"), at("2026-08-15T00:00:00Z"), DAY, 1,
    )).toBe(0);
  });

  it("clamps at 100 for a stored value above it", () => {
    const t = at("2026-08-15T00:00:00Z");
    expect(effectiveCondition(140, t, t, DAY, 1)).toBe(100);
  });

  it("treats a future updatedAt as zero elapsed, never restoring condition", () => {
    expect(effectiveCondition(
      50, at("2026-08-20T00:00:00Z"), at("2026-08-15T00:00:00Z"), DAY, 1,
    )).toBe(50);
  });

  it("never decays when the rate is zero", () => {
    expect(effectiveCondition(
      50, at("2020-01-01T00:00:00Z"), at("2026-08-15T00:00:00Z"), DAY, 0,
    )).toBe(50);
  });

  it("PRISTINE is the value a missing row stands for", () => {
    expect(PRISTINE).toBe(100);
  });
});

describe("backfireChanceFor", () => {
  it("is the base chance on a pristine weapon", () => {
    expect(backfireChanceFor(2, 100, 3)).toBe(2);
  });

  it("is base times (1 + factor) on a ruined weapon", () => {
    expect(backfireChanceFor(2, 0, 3)).toBe(8);
  });

  it("interpolates at half condition", () => {
    expect(backfireChanceFor(2, 50, 3)).toBe(5);
  });

  it("stays zero for a weapon that declares zero, at any condition", () => {
    expect(backfireChanceFor(0, 0, 3)).toBe(0);
  });

  it("clamps at 100", () => {
    expect(backfireChanceFor(90, 0, 3)).toBe(100);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run --project @gl3/server:unit apps/server/test/combat-condition.test.ts`
Expected: FAIL — `effectiveCondition` is not exported from `@gl3/plugin-combat`.

- [ ] **Step 3: Write the implementation**

Create `packages/plugins/combat/src/condition.ts`:

```ts
/**
 * Weapon wear, as two pure functions. No I/O, no DB, no clock read — `now` is
 * a parameter — which is what lets the boundaries be tested exhaustively, the
 * same shape `resolve.ts` uses for the shot arithmetic.
 *
 * Decay is computed lazily from `updated_at` on every read rather than by a
 * sweeper job. That is not an optimisation: a BullMQ worker mutating condition
 * would need an idempotency key tied to `job.id` (CLAUDE.md rule 1), and there
 * is nothing here worth that risk.
 */

/** What a missing `p_combat_weapon_condition` row stands for. */
export const PRISTINE = 100;

function clamp(n: number): number {
  return Math.min(PRISTINE, Math.max(0, n));
}

/**
 * `stored` is the value written at `updatedAt`; this ages it forward to `now`.
 *
 * A future `updatedAt` — clock skew, or a row written by a machine running
 * ahead — clamps elapsed to 0 rather than RESTORING condition, which an
 * unguarded subtraction would do.
 *
 * `decayPeriodSeconds` is floored at 1 by `readCombatSettings`, so the
 * division here can never be by zero.
 */
export function effectiveCondition(
  stored: number,
  updatedAt: Date,
  now: Date,
  decayPeriodSeconds: number,
  decayPerPeriod: number,
): number {
  const elapsedSeconds = Math.max(0, (now.getTime() - updatedAt.getTime()) / 1000);
  const periods = Math.floor(elapsedSeconds / decayPeriodSeconds);
  return clamp(stored - periods * decayPerPeriod);
}

/**
 * Condition scales the weapon's own backfire chance as a MULTIPLIER, never as
 * an addend: a weapon declaring `backfireChance: 0` must stay at zero however
 * ruined it is, the same "an explicit zero survives the round trip" property
 * `accuracy: 0` already has in `WeaponEffectsSchema`.
 *
 * With the defaults (base 2, factor 3): pristine 2%, ruined 8%.
 */
export function backfireChanceFor(
  base: number,
  condition: number,
  wearFactor: number,
): number {
  const multiplier = 1 + ((PRISTINE - condition) / PRISTINE) * wearFactor;
  return Math.min(100, Math.round(base * multiplier));
}
```

- [ ] **Step 4: Re-export from the manifest module**

In `packages/plugins/combat/src/index.ts`, beside the existing `resolve.js` re-exports:

```ts
export { backfireChanceFor, effectiveCondition, PRISTINE } from "./condition.js";
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run --project @gl3/server:unit apps/server/test/combat-condition.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Write the failing settings test**

Append to `apps/server/test/combat-settings.test.ts`:

```ts
describe("condition, backfire and repair settings", () => {
  const from = (map: Record<string, string>) =>
    readCombatSettings((key) => map[key] ?? null);

  it("defaults every new key", () => {
    const s = from({});
    expect(s.condition.wearPerShot).toBe(1);
    expect(s.condition.decayPeriodSeconds).toBe(86_400);
    expect(s.condition.decayPerPeriod).toBe(1);
    expect(s.backfire.baseChance).toBe(2);
    expect(s.backfire.wearFactor).toBe(3);
    expect(s.repair.costPerPoint).toBe(1000n);
  });

  it("reads bare keys, not combat-prefixed ones", () => {
    expect(from({ "backfire.base_chance": "40" }).backfire.baseChance).toBe(40);
    expect(from({ "combat.backfire.base_chance": "40" }).backfire.baseChance).toBe(2);
  });

  it("falls back rather than reading a blank value as zero", () => {
    const s = from({ "backfire.base_chance": "  ", "repair.cost_per_point": "" });
    expect(s.backfire.baseChance).toBe(2);
    expect(s.repair.costPerPoint).toBe(1000n);
  });

  it("floors the decay period at 1 so the division can never be by zero", () => {
    expect(from({ "condition.decay_period_seconds": "0" }).condition.decayPeriodSeconds).toBe(1);
  });

  it("caps the base chance at 100", () => {
    expect(from({ "backfire.base_chance": "500" }).backfire.baseChance).toBe(100);
  });
});
```

- [ ] **Step 7: Run it and verify it fails**

Run: `npx vitest run --project @gl3/server:unit apps/server/test/combat-settings.test.ts`
Expected: FAIL — `s.condition` is undefined.

- [ ] **Step 8: Extend the settings reader**

In `packages/plugins/combat/src/settings.ts`, add to the `CombatSettings` interface:

```ts
  condition: {
    wearPerShot: number;
    decayPeriodSeconds: number;
    decayPerPeriod: number;
  };
  backfire: {
    baseChance: number;
    wearFactor: number;
  };
  repair: {
    costPerPoint: bigint;
  };
```

And to the object `readCombatSettings` returns, after `unarmed`:

```ts
    condition: {
      wearPerShot: num(get, "condition.wear_per_shot", 1),
      // Floored at 1: `effectiveCondition` divides by this, and a zero would
      // make every read Infinity periods of decay.
      decayPeriodSeconds: Math.max(1, num(get, "condition.decay_period_seconds", 86_400)),
      decayPerPeriod: num(get, "condition.decay_per_period", 1),
    },
    backfire: {
      baseChance: Math.min(100, num(get, "backfire.base_chance", 2)),
      wearFactor: num(get, "backfire.wear_factor", 3),
    },
    repair: {
      costPerPoint: big(get, "repair.cost_per_point", 1000n),
    },
```

- [ ] **Step 9: Run both unit files and verify they pass**

Run: `npx vitest run --project @gl3/server:unit apps/server/test/combat-condition.test.ts apps/server/test/combat-settings.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/plugins/combat/src/condition.ts packages/plugins/combat/src/settings.ts \
        packages/plugins/combat/src/index.ts \
        apps/server/test/combat-condition.test.ts apps/server/test/combat-settings.test.ts
git commit -m "feat(combat): add pure weapon-condition math and its settings

Decay is lazy on read from updated_at, so nothing here enqueues BullMQ
work and rule 1's at-least-once hazard never applies."
```

---

## Task 3: Backfire in `resolveShot`, and the `backfireChance` weapon effect

**Files:**
- Modify: `packages/plugins/combat/src/resolve.ts`
- Modify: `packages/plugins/combat/src/effects.ts`
- Modify: `packages/plugins/inventory/src/effects.ts`
- Test: `apps/server/test/combat-resolve.test.ts` (existing; add cases)
- Test: `apps/server/test/effects-parity.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `WeaponProfile` gains `backfireChance: number`
  - `Rolls` gains `backfireRoll: number`
  - `ShotOutcome` gains `backfire: boolean`, `selfDamage: number`
  - `WeaponEffectsSchema` gains `backfireChance?: number` (0–100)

- [ ] **Step 1: Write the failing resolve tests**

Append to `apps/server/test/combat-resolve.test.ts`. Use whatever weapon-profile factory that file already defines; if it builds profiles inline, build one the same way and add `backfireChance`.

```ts
describe("backfire", () => {
  const weapon: WeaponProfile = {
    accuracy: 100,
    damageMin: 10,
    damageMax: 10,
    bulletsPerShot: 2,
    critChance: 100,
    critMultiplier: 2,
    armorPierce: 0,
    minRankExp: 0,
    backfireChance: 50,
  };

  it("beats a hit roll that would otherwise connect", () => {
    const out = resolveShot(weapon, 5, { hitRoll: 0, damageRoll: 10, critRoll: 0, backfireRoll: 0 });
    expect(out.backfire).toBe(true);
    expect(out.hit).toBe(false);
    expect(out.crit).toBe(false);
    expect(out.damage).toBe(0);
    expect(out.armorAbsorbed).toBe(0);
  });

  it("deals the raw damage roll to the attacker, unreduced by the target's armor", () => {
    const out = resolveShot(weapon, 99, { hitRoll: 0, damageRoll: 10, critRoll: 0, backfireRoll: 0 });
    expect(out.selfDamage).toBe(10);
  });

  it("spends bullets anyway", () => {
    const out = resolveShot(weapon, 0, { hitRoll: 0, damageRoll: 10, critRoll: 0, backfireRoll: 0 });
    expect(out.bulletsSpent).toBe(2);
  });

  it("does not fire when the roll is at or above the chance", () => {
    const out = resolveShot(weapon, 0, { hitRoll: 0, damageRoll: 10, critRoll: 0, backfireRoll: 50 });
    expect(out.backfire).toBe(false);
    expect(out.hit).toBe(true);
  });

  it("is unreachable for a weapon declaring zero, even on roll 0", () => {
    const out = resolveShot({ ...weapon, backfireChance: 0 }, 0,
      { hitRoll: 0, damageRoll: 10, critRoll: 0, backfireRoll: 0 });
    expect(out.backfire).toBe(false);
  });

  it("reports selfDamage 0 on every non-backfire outcome", () => {
    const hit = resolveShot({ ...weapon, backfireChance: 0 }, 0,
      { hitRoll: 0, damageRoll: 10, critRoll: 99, backfireRoll: 0 });
    const miss = resolveShot({ ...weapon, accuracy: 0, backfireChance: 0 }, 0,
      { hitRoll: 50, damageRoll: 10, critRoll: 99, backfireRoll: 0 });
    expect(hit.selfDamage).toBe(0);
    expect(miss.selfDamage).toBe(0);
  });
});

describe("rollFor", () => {
  it("draws a backfire roll in [0, 100)", () => {
    for (let i = 0; i < 200; i += 1) {
      const rolls = rollFor({
        accuracy: 50, damageMin: 1, damageMax: 5, bulletsPerShot: 1,
        critChance: 0, critMultiplier: 1, armorPierce: 0, minRankExp: 0,
        backfireChance: 5,
      });
      expect(rolls.backfireRoll).toBeGreaterThanOrEqual(0);
      expect(rolls.backfireRoll).toBeLessThan(100);
    }
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run --project @gl3/server:unit apps/server/test/combat-resolve.test.ts`
Expected: FAIL — `backfireChance` is not a property of `WeaponProfile`; `out.backfire` is undefined.

- [ ] **Step 3: Extend `resolve.ts`**

Add to `WeaponProfile`:

```ts
  /**
   * Already scaled by condition — `backfireChanceFor` is applied by the
   * caller, so this stays pure and knows nothing about wear.
   */
  backfireChance: number;
```

Add to `Rolls`:

```ts
  backfireRoll: number;
```

Add to `ShotOutcome`:

```ts
  /** The weapon went off in the attacker's hand. Not a miss. */
  backfire: boolean;
  /** Damage dealt to the ATTACKER. 0 on every non-backfire outcome. */
  selfDamage: number;
```

In `rollFor`, add to the returned object:

```ts
    backfireRoll: randomInt(0, 100),
```

In `resolveShot`, insert this as the **first** branch, before the hit check, and add `backfire: false, selfDamage: 0` to both existing returns:

```ts
  // BEFORE the hit roll, deliberately. A backfire is not a miss — the gun
  // went off in your hand, and the hit roll never happens. Ordering it after
  // would make a backfire impossible on any shot that connects, which is
  // exactly backwards.
  //
  // Self-damage is the raw damage roll reduced by NO armor: not the target's
  // (irrelevant — nothing reached them) and not the attacker's (armor does
  // not protect you from your own weapon).
  if (rolls.backfireRoll < weapon.backfireChance) {
    return {
      backfire: true,
      hit: false,
      crit: false,
      damage: 0,
      armorAbsorbed: 0,
      selfDamage: rolls.damageRoll,
      bulletsSpent,
    };
  }
```

- [ ] **Step 4: Add the `backfireChance` effect to BOTH copies**

In `packages/plugins/combat/src/effects.ts` **and** `packages/plugins/inventory/src/effects.ts`, add to `WeaponEffectsSchema` before the `.refine(...)`:

```ts
  /**
   * Optional for the same reason `accuracy` is: a migrated V2 item has no
   * such column and must still parse. Combat fills an absent value from
   * `combat.backfire.base_chance`. An explicit 0 means "never backfires" and
   * must survive the round trip — do not collapse it to the default.
   */
  backfireChance: z.number().int().min(0).max(100).optional(),
```

- [ ] **Step 5: Write the parity test**

Create `apps/server/test/effects-parity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WeaponEffectsSchema as CombatWeapon } from "@gl3/plugin-combat/effects";
import { WeaponEffectsSchema as InventoryWeapon } from "@gl3/plugin-inventory/effects";

/**
 * `effects.ts` is a VERBATIM COPY between the two plugins — a plugin may not
 * import another plugin, and both must read the same `items.effects` blob.
 * The copies are kept in step BY HAND and nothing else enforces it, so a
 * field added to one and not the other shows up as combat silently ignoring
 * a stat the player can see in their inventory. This test is that
 * enforcement.
 */
describe("weapon effects schema parity", () => {
  const fixture = {
    accuracy: 70,
    damageMin: 5,
    damageMax: 12,
    bulletsPerShot: 2,
    critChance: 10,
    critMultiplier: 1.5,
    armorPierce: 3,
    minRankExp: 400,
    backfireChance: 4,
  };

  it("parses one fixture identically through both copies", () => {
    expect(CombatWeapon.parse(fixture)).toEqual(InventoryWeapon.parse(fixture));
  });

  it("applies the same defaults to a minimal item", () => {
    const minimal = { damageMin: 1, damageMax: 2 };
    expect(CombatWeapon.parse(minimal)).toEqual(InventoryWeapon.parse(minimal));
  });

  it("rejects the same invalid input in both", () => {
    const bad = { damageMin: 9, damageMax: 2 };
    expect(CombatWeapon.safeParse(bad).success).toBe(false);
    expect(InventoryWeapon.safeParse(bad).success).toBe(false);
  });
});
```

If `@gl3/plugin-combat/effects` and `@gl3/plugin-inventory/effects` are not resolvable subpaths, import by relative path instead — `../../../packages/plugins/combat/src/effects.js` and the inventory equivalent — and say so in a comment. Do **not** add `exports` subpaths to either plugin manifest just for a test.

- [ ] **Step 6: Run both test files and verify they pass**

Run: `npx vitest run --project @gl3/server:unit apps/server/test/combat-resolve.test.ts apps/server/test/effects-parity.test.ts`
Expected: PASS. Every pre-existing `resolveShot` test still passes — a profile with `backfireChance: 0` makes the new branch unreachable.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/combat/src/resolve.ts packages/plugins/combat/src/effects.ts \
        packages/plugins/inventory/src/effects.ts \
        apps/server/test/combat-resolve.test.ts apps/server/test/effects-parity.test.ts
git commit -m "feat(combat): resolve backfire before the hit roll

Adds backfireChance to both hand-kept copies of effects.ts and a parity
test so the next drift fails a test instead of surfacing as combat
ignoring a stat inventory displays."
```

---

## Task 4: The condition table, its migration, and the schema mirrors

**Files:**
- Modify: `packages/plugins/combat/src/migrations.ts`
- Modify: `packages/plugins/combat/src/schema.ts`
- Modify: `apps/server/test/helpers/plugin-tables.ts`
- Test: `apps/server/test/combat-log-schema.test.ts` (existing; add cases)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `p_combat_weapon_condition(player_id uuid, item_id uuid, condition integer, updated_at timestamptz)`, PK `(player_id, item_id)`, **no foreign keys**
  - `weaponCondition` drizzle table exported from `packages/plugins/combat/src/schema.ts` and from `apps/server/test/helpers/plugin-tables.ts`
  - `playerStats` mirror gains `backfire`; `items` mirror gains `name`; new `playerItems` mirror

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/combat-log-schema.test.ts`. That file already asserts what `p_combat_log` must and must not have; this extends the same discipline to the new table. Follow the existing file's helper for reading `information_schema` rather than inventing a new one.

```ts
describe("p_combat_weapon_condition", () => {
  it("has the expected columns", async () => {
    const cols = await columnsOf("p_combat_weapon_condition");
    expect(cols).toEqual(
      expect.arrayContaining(["player_id", "item_id", "condition", "updated_at"]),
    );
  });

  it("is keyed on (player_id, item_id)", async () => {
    const pk = await primaryKeyOf("p_combat_weapon_condition");
    expect(pk).toEqual(["player_id", "item_id"]);
  });

  /**
   * The point of the table's design. Rows here are written while the
   * transaction holds two `player_stats` rows FOR UPDATE, so ANY foreign key
   * would take FOR KEY SHARE on its referent at that moment. An `items` FK
   * in particular would open a player-then-item lock edge that exists
   * nowhere else in the graph (CLAUDE.md rule 6). Declaring none keeps the
   * graph at exactly gang<->player, location<->player, player<->player and
   * organized crime's heist-first order.
   */
  it("declares no foreign keys, deliberately", async () => {
    const fks = await foreignKeysOf("p_combat_weapon_condition");
    expect(fks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run apps/server/test/combat-log-schema.test.ts`
Expected: FAIL — relation `p_combat_weapon_condition` does not exist.

- [ ] **Step 3: Add the migration**

Append to `COMBAT_MIGRATIONS` in `packages/plugins/combat/src/migrations.ts`, one statement as the file's convention requires:

```ts
  {
    /**
     * No foreign keys, and that is the design. See the file header on
     * `p_combat_log`: these rows are written while two `player_stats` rows
     * are held FOR UPDATE, so an FK would take FOR KEY SHARE on its referent
     * right there. A `players` FK would be player-then-player, which
     * `tx.locks.player` already orders safely, but an `items` FK would open
     * a player-then-item edge that exists nowhere else. Declaring neither
     * leaves CLAUDE.md rule 6's lock graph exactly as it was — the same
     * choice `p_inventory_shop_stock` made.
     *
     * A row whose player or item has since been deleted is harmless: it is
     * only ever read by full primary key, from a path that has already
     * loaded both, and is never joined back.
     *
     * No index beyond the primary key: every read is by full key.
     */
    name: "0004_weapon_condition",
    sql: `CREATE TABLE p_combat_weapon_condition (
      player_id  uuid        NOT NULL,
      item_id    uuid        NOT NULL,
      condition  integer     NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (player_id, item_id)
    )`,
  },
```

- [ ] **Step 4: Add the drizzle table and extend the mirrors**

In `packages/plugins/combat/src/schema.ts`:

```ts
/**
 * Owned and migrated by this plugin (`migrations.ts` `0004`), not a mirror.
 * Grain is `(player, item)`, matching core `player_items` — which is qty-
 * stacked with no per-instance identity, so a player owning two of the same
 * pistol has ONE shared condition. Buying another copy does not improve it;
 * you cannot dilute wear.
 */
export const weaponCondition = pgTable("p_combat_weapon_condition", {
  playerId: uuid("player_id").notNull(),
  itemId: uuid("item_id").notNull(),
  condition: integer("condition").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.playerId, t.itemId] }) }));

/**
 * Core-owned mirror. Read-only here, and only to answer "does the caller own
 * this weapon" for the repair route — a weapon need not be equipped to be
 * repaired.
 */
export const playerItems = pgTable("player_items", {
  playerId: uuid("player_id").notNull(),
  itemId: uuid("item_id").notNull(),
  qty: integer("qty").notNull(),
});
```

Add `primaryKey` to the `drizzle-orm/pg-core` import. Add to the existing `playerStats` mirror:

```ts
  backfire: integer("backfire").notNull(),
```

Add to the existing `items` mirror:

```ts
  name: text("name").notNull(),
```

- [ ] **Step 5: Add the test mirror**

In `apps/server/test/helpers/plugin-tables.ts`, beside `combatLog`:

```ts
/** Mirrors `packages/plugins/combat/src/migrations.ts` `0004_weapon_condition`. */
export const weaponCondition = pgTable("p_combat_weapon_condition", {
  playerId: uuid("player_id").notNull(),
  itemId: uuid("item_id").notNull(),
  condition: integer("condition").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 6: Run and verify it passes**

Run: `npx vitest run apps/server/test/combat-log-schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/combat/src/migrations.ts packages/plugins/combat/src/schema.ts \
        apps/server/test/helpers/plugin-tables.ts apps/server/test/combat-log-schema.test.ts
git commit -m "feat(combat): add p_combat_weapon_condition with no foreign keys

Pinned by a test: an FK here would be taken while two player_stats rows
are held FOR UPDATE, opening a player->item lock edge that exists
nowhere else in the graph."
```

---

## Task 5: Wire condition and backfire into the attack route

**Files:**
- Modify: `packages/plugins/combat/src/index.ts` (`loadWeapon`, `attackRoute`)
- Test: `apps/server/test/combat-backfire.test.ts` (new)

**Interfaces:**
- Consumes: `effectiveCondition`, `backfireChanceFor`, `PRISTINE` (Task 2); `ShotOutcome.backfire`/`.selfDamage` (Task 3); `weaponCondition` (Task 4); `AttackResponseSchema`'s three new fields (Task 1).
- Produces: `POST /api/combat/attack/:targetId` returns `backfire`, `selfDamage`, `attackerHealth`; publishes `player.backfired`.

`loadWeapon` gains a fifth parameter: `loadWeapon(tx, weaponItemId, config, condition: number)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/combat-backfire.test.ts`. Copy the fixture scaffolding from `apps/server/test/combat.test.ts` — `bootTestServer`, two registered players placed in the same location, both above `combat.newbie_exp_threshold`, and a seeded weapon item. Force the outcome by setting `combat.backfire.base_chance` to `100` in `settings` before the shot, which makes the branch deterministic without injecting an RNG into shipped code.

```ts
it("increments the lifetime counter, damages the attacker, and leaves the target alone", async () => {
  await setSetting("combat.backfire.base_chance", "100");
  const before = await statsOf(attacker);

  const res = await attack(token, target);

  expect(res.statusCode).toBe(200);
  const body = AttackResponseSchema.parse(res.json());
  expect(body.backfire).toBe(true);
  expect(body.hit).toBe(false);
  expect(body.damage).toBe(0);
  expect(body.selfDamage).toBeGreaterThan(0);
  expect(body.targetKilled).toBe(false);

  const after = await statsOf(attacker);
  expect(after.backfire).toBe(before.backfire + 1);
  expect(after.health).toBe(Math.max(0, before.health - body.selfDamage));
  expect(after.bullets).toBeLessThan(before.bullets);

  const targetAfter = await statsOf(target);
  expect(targetAfter.health).toBe(100);
  expect(targetAfter.cash).toBe(TARGET_START_CASH);
});

it("writes a miss-shaped combat log row", async () => {
  await setSetting("combat.backfire.base_chance", "100");
  await attack(token, target);

  const [logRow] = await db.select().from(combatLog)
    .where(eq(combatLog.attackerId, attacker))
    .orderBy(desc(combatLog.createdAt)).limit(1);
  expect(logRow?.hit).toBe(false);
  expect(logRow?.damage).toBe(0);
  expect(logRow?.fatal).toBe(false);
  expect(logRow?.payout).toBe(0n);
});

it("hospitalises the ATTACKER when the self-damage reaches zero health", async () => {
  await setSetting("combat.backfire.base_chance", "100");
  await db.update(playerStats).set({ health: 1 }).where(eq(playerStats.playerId, attacker));

  const body = AttackResponseSchema.parse((await attack(token, target)).json());
  expect(body.attackerHealth).toBe(0);

  const after = await statsOf(attacker);
  expect(after.hospitalUntil).not.toBeNull();
});

it("publishes player.backfired to the attacker only", async () => {
  await setSetting("combat.backfire.base_chance", "100");
  const seen = awaitOwnEvent(redis, attacker, (e) => e.type === "player.backfired");
  await attack(token, target);
  const event = await seen;
  expect(event.type).toBe("player.backfired");
  expect(event.audience).toEqual({ kind: "player", playerId: attacker });
});

it("wears the weapon on a normal shot and creates the row on the first one", async () => {
  await setSetting("combat.backfire.base_chance", "0");
  await setSetting("combat.condition.wear_per_shot", "5");

  await attack(token, target);
  const [row] = await db.select().from(weaponCondition)
    .where(and(eq(weaponCondition.playerId, attacker), eq(weaponCondition.itemId, weaponId)));
  expect(row?.condition).toBe(95);
});

it("ages a planted row forward before wearing it", async () => {
  await setSetting("combat.backfire.base_chance", "0");
  await setSetting("combat.condition.wear_per_shot", "1");
  await setSetting("combat.condition.decay_period_seconds", "86400");
  await setSetting("combat.condition.decay_per_period", "10");
  await db.insert(weaponCondition).values({
    playerId: attacker, itemId: weaponId, condition: 100,
    updatedAt: new Date(Date.now() - 3 * 86_400_000),
  });

  await attack(token, target);
  const [row] = await db.select().from(weaponCondition)
    .where(and(eq(weaponCondition.playerId, attacker), eq(weaponCondition.itemId, weaponId)));
  // 100 - (3 periods x 10) = 70, then - 1 wear = 69.
  expect(row?.condition).toBe(69);
});

it("does not wear or backfire on an unarmed attack", async () => {
  await setSetting("combat.backfire.base_chance", "100");
  await db.update(playerStats).set({ weaponItemId: null }).where(eq(playerStats.playerId, attacker));

  const body = AttackResponseSchema.parse((await attack(token, target)).json());
  expect(body.backfire).toBe(false);

  const rows = await db.select().from(weaponCondition).where(eq(weaponCondition.playerId, attacker));
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run apps/server/test/combat-backfire.test.ts`
Expected: FAIL — `AttackResponseSchema` rejects the body (no `backfire` field in the response yet).

- [ ] **Step 3: Give `loadWeapon` the condition**

Change the signature and the two profiles it can return:

```ts
async function loadWeapon(
  tx: PluginTx,
  weaponItemId: string | null,
  config: CombatSettings,
  condition: number,
): Promise<WeaponProfile> {
```

The unarmed profile gets `backfireChance: 0` — fists have no condition row and never backfire. The equipped profile gets:

```ts
    backfireChance: backfireChanceFor(
      parsed.data.backfireChance ?? config.backfire.baseChance,
      condition,
      config.backfire.wearFactor,
    ),
```

Import `backfireChanceFor`, `effectiveCondition` and `PRISTINE` from `./condition.js`, and `weaponCondition` from `./schema.js`.

- [ ] **Step 4: Load the condition in the attack handler**

Immediately before the existing `loadWeapon` call:

```ts
      // Read once, used three times: to scale backfire chance, to compute the
      // value written back after the shot, and to answer the response. `now`
      // is captured once so the decay a shot observes and the decay it writes
      // cannot straddle a period boundary.
      const shotAt = new Date();
      const [conditionRow] = attacker.weaponItemId === null ? [] : await tx.db
        .select()
        .from(weaponCondition)
        .where(and(
          eq(weaponCondition.playerId, player.id),
          eq(weaponCondition.itemId, attacker.weaponItemId),
        ));
      const currentCondition = conditionRow === undefined
        ? PRISTINE
        : effectiveCondition(
            conditionRow.condition, conditionRow.updatedAt, shotAt,
            config.condition.decayPeriodSeconds, config.condition.decayPerPeriod,
          );

      const weapon = await loadWeapon(tx, attacker.weaponItemId, config, currentCondition);
```

(Replace the existing `const weapon = await loadWeapon(tx, attacker.weaponItemId, config);` line.)

- [ ] **Step 5: Write the wear back after the shot resolves**

Directly after `const outcome = resolveShot(...)`:

```ts
      // Every shot wears the weapon, hit or miss or backfire: as with bullets,
      // the cost is firing, not connecting.
      //
      // `updated_at = shotAt` resets the time-decay clock, deliberately. Time
      // decay models rust from disuse and use decay models firing; a player
      // who shoots constantly accrues only the latter, one who never shoots
      // only the former. Both reach zero and neither double-counts.
      if (attacker.weaponItemId !== null) {
        const nextCondition = Math.max(0, currentCondition - config.condition.wearPerShot);
        await tx.db
          .insert(weaponCondition)
          .values({
            playerId: player.id,
            itemId: attacker.weaponItemId,
            condition: nextCondition,
            updatedAt: shotAt,
          })
          .onConflictDoUpdate({
            target: [weaponCondition.playerId, weaponCondition.itemId],
            set: { condition: nextCondition, updatedAt: shotAt },
          });
      }
```

- [ ] **Step 6: Add the backfire branch**

Directly after the wear write, before `const targetHealth = ...`:

```ts
      if (outcome.backfire) {
        const attackerHealth = Math.max(0, attacker.health - outcome.selfDamage);
        await tx.db
          .update(playerStats)
          .set({
            health: attackerHealth,
            backfire: sql`${playerStats.backfire} + 1`,
          })
          .where(eq(playerStats.playerId, player.id));

        const hospitalised = attackerHealth === 0;
        // No existing path hospitalises the ATTACKER — every other call sends
        // the victim. Sets health = 0 alongside the deadline, so the UPDATE
        // above is redundant on this path; left alone, as the kill path does.
        if (hospitalised) {
          await tx.hospital.sendToHospital(player.id, config.hospitalSeconds);
        }

        // The log answers "who shot at me", and someone did.
        await tx.db.insert(combatLog).values({
          id: uuidv7(),
          attackerId: player.id,
          targetId: params.targetId,
          hit: false,
          damage: 0,
          fatal: false,
          weaponItemId: attacker.weaponItemId,
          payout: 0n,
        });

        // Attacker only. The target has no way of knowing your gun jammed,
        // and telling them is information the attacker did not choose to give.
        await tx.events.publishCore({
          type: "player.backfired",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "player", playerId: player.id },
          selfDamage: outcome.selfDamage,
          hospitalised,
        });

        // Returns early, so the target's health is never written, no kill is
        // evaluated, no payout moves, and `killResolved` never runs —
        // a backfire cannot claim a bounty.
        return {
          status: 200,
          body: {
            hit: false, crit: false, damage: 0, armorAbsorbed: 0,
            targetHealth: target.health, targetKilled: false,
            payout: "0", bulletsSpent: outcome.bulletsSpent,
            backfire: true, selfDamage: outcome.selfDamage, attackerHealth,
          },
        };
      }
```

- [ ] **Step 7: Extend the normal response**

Add to the existing success body, after `bulletsSpent`:

```ts
          backfire: false,
          selfDamage: 0,
          attackerHealth: attacker.health,
```

- [ ] **Step 8: Run and verify they pass**

Run: `npx vitest run apps/server/test/combat-backfire.test.ts apps/server/test/combat.test.ts apps/server/test/combat-kill.test.ts apps/server/test/combat-kill-filter.test.ts`
Expected: PASS. The three pre-existing combat files must stay green — with `backfire.base_chance` at its default of 2 they are effectively unaffected, but any that assert on the exact response body shape need the three new fields added to their expectations.

- [ ] **Step 9: Commit**

```bash
git add packages/plugins/combat/src/index.ts apps/server/test/combat-backfire.test.ts
git commit -m "feat(combat): wear weapons on every shot and resolve backfires

A backfire returns early: the target is never touched, no kill is
evaluated, and killResolved never runs, so a backfire cannot claim a
bounty. First path in the codebase to hospitalise the attacker."
```

---

## Task 6: The gunsmith — repair and the weapon-condition read

**Files:**
- Modify: `packages/plugins/combat/src/index.ts`
- Test: `apps/server/test/combat-repair.test.ts` (new)

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces:
  - `GET /api/combat/weapon` → `WeaponConditionDto`
  - `POST /api/combat/repair` body `{ itemId: uuid }` → 200 `{ condition, cost }` | 204 | 404 `weapon_not_found` | 409 `insufficient_funds`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/combat-repair.test.ts`, using the same `bootTestServer` scaffolding as Task 5.

```ts
it("reports the equipped weapon's condition and its repair cost", async () => {
  await setSetting("combat.repair.cost_per_point", "10");
  await db.insert(weaponCondition).values({
    playerId: player, itemId: weaponId, condition: 60, updatedAt: new Date(),
  });

  const dto = WeaponConditionDtoSchema.parse((await get(token, "/api/combat/weapon")).json());
  expect(dto.itemId).toBe(weaponId);
  expect(dto.condition).toBe(60);
  expect(dto.repairCost).toBe("400");
});

it("reports fists as pristine, zero-chance and free", async () => {
  await db.update(playerStats).set({ weaponItemId: null }).where(eq(playerStats.playerId, player));
  const dto = WeaponConditionDtoSchema.parse((await get(token, "/api/combat/weapon")).json());
  expect(dto).toEqual({
    itemId: null, name: null, condition: 100, backfireChance: 0, repairCost: "0",
  });
});

it("charges cost_per_point per point restored and sets condition to 100", async () => {
  await setSetting("combat.repair.cost_per_point", "10");
  await db.insert(weaponCondition).values({
    playerId: player, itemId: weaponId, condition: 60, updatedAt: new Date(),
  });
  const before = (await statsOf(player)).cash;

  const res = await post(token, "/api/combat/repair", { itemId: weaponId });
  expect(res.statusCode).toBe(200);
  expect(RepairResponseSchema.parse(res.json())).toEqual({ condition: 100, cost: "400" });

  expect((await statsOf(player)).cash).toBe(before - 400n);
  const [row] = await db.select().from(weaponCondition)
    .where(and(eq(weaponCondition.playerId, player), eq(weaponCondition.itemId, weaponId)));
  expect(row?.condition).toBe(100);
});

it("writes exactly one ledger row for the repair", async () => {
  await setSetting("combat.repair.cost_per_point", "10");
  await db.insert(weaponCondition).values({
    playerId: player, itemId: weaponId, condition: 60, updatedAt: new Date(),
  });
  await post(token, "/api/combat/repair", { itemId: weaponId });

  const rows = await db.select().from(transactions)
    .where(and(eq(transactions.playerId, player), eq(transactions.reason, "combat.repair")));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.amount).toBe(-400n);
});

it("is a no-op on a pristine weapon, with no charge and no ledger row", async () => {
  const before = (await statsOf(player)).cash;
  const res = await post(token, "/api/combat/repair", { itemId: weaponId });
  expect(res.statusCode).toBe(204);
  expect((await statsOf(player)).cash).toBe(before);
});

it("refuses when the player cannot afford it, moving no money", async () => {
  await setSetting("combat.repair.cost_per_point", "1000000");
  await db.insert(weaponCondition).values({
    playerId: player, itemId: weaponId, condition: 10, updatedAt: new Date(),
  });
  const before = (await statsOf(player)).cash;

  const res = await post(token, "/api/combat/repair", { itemId: weaponId });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toMatchObject({ error: "insufficient_funds" });
  expect((await statsOf(player)).cash).toBe(before);
});

it("refuses an item the player does not own", async () => {
  const res = await post(token, "/api/combat/repair", { itemId: unownedWeaponId });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ error: "weapon_not_found" });
});

it("refuses a non-weapon the player does own", async () => {
  const res = await post(token, "/api/combat/repair", { itemId: ownedArmorId });
  expect(res.statusCode).toBe(404);
});

it("repairs an owned weapon that is not equipped", async () => {
  await db.update(playerStats).set({ weaponItemId: null }).where(eq(playerStats.playerId, player));
  await db.insert(weaponCondition).values({
    playerId: player, itemId: weaponId, condition: 50, updatedAt: new Date(),
  });
  const res = await post(token, "/api/combat/repair", { itemId: weaponId });
  expect(res.statusCode).toBe(200);
});

it("rejects a non-uuid itemId at the boundary", async () => {
  const res = await post(token, "/api/combat/repair", { itemId: "not-a-uuid" });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run apps/server/test/combat-repair.test.ts`
Expected: FAIL — 404 from the router; neither route exists.

- [ ] **Step 3: Write a shared condition reader**

Add near `loadWeapon` in `packages/plugins/combat/src/index.ts`:

```ts
/**
 * The current, time-aged condition of one weapon, and the row it came from.
 * A missing row is PRISTINE — every migrated player's weapons start there and
 * no backfill migration is needed.
 */
async function readCondition(
  tx: PluginTx,
  playerId: string,
  itemId: string,
  config: CombatSettings,
  now: Date,
): Promise<number> {
  const [row] = await tx.db
    .select()
    .from(weaponCondition)
    .where(and(eq(weaponCondition.playerId, playerId), eq(weaponCondition.itemId, itemId)));
  if (row === undefined) return PRISTINE;
  return effectiveCondition(
    row.condition, row.updatedAt, now,
    config.condition.decayPeriodSeconds, config.condition.decayPerPeriod,
  );
}
```

Refactor Task 5's inline load in `attackRoute` to call it, keeping the single `shotAt` capture.

- [ ] **Step 4: Add the weapon read route**

```ts
/**
 * What the combat page shows above the target list. Read-only, so it takes no
 * lock and opens no write. Fists report pristine, zero chance and zero cost:
 * there is nothing to wear and nothing to repair.
 */
const weaponRoute = route({
  method: "GET",
  path: "/api/combat/weapon",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readCombatSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      const [stats] = await tx.db
        .select({ weaponItemId: playerStats.weaponItemId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const itemId = stats?.weaponItemId ?? null;
      if (itemId === null) {
        return {
          status: 200,
          body: {
            itemId: null, name: null, condition: PRISTINE,
            backfireChance: 0, repairCost: "0",
          },
        };
      }

      const [item] = await tx.db
        .select({ name: items.name, itemType: items.itemType, effects: items.effects })
        .from(items)
        .where(eq(items.id, itemId));
      const condition = await readCondition(tx, player.id, itemId, config, new Date());
      const parsed = item === undefined || item.itemType !== ITEM_TYPE_WEAPON
        ? undefined
        : WeaponEffectsSchema.safeParse(item.effects);
      const base = parsed?.success === true
        ? parsed.data.backfireChance ?? config.backfire.baseChance
        : 0;

      return {
        status: 200,
        body: {
          itemId,
          name: item?.name ?? null,
          condition,
          backfireChance: backfireChanceFor(base, condition, config.backfire.wearFactor),
          repairCost: (config.repair.costPerPoint * BigInt(PRISTINE - condition)).toString(),
        },
      };
    });
  },
});
```

- [ ] **Step 5: Add the repair route**

```ts
/**
 * The gunsmith. Cost is `repair.cost_per_point` x points restored — a flat
 * rate rather than a fraction of item value, because `items` HAS no value
 * column: price lives in `p_inventory_shop_stock`, and reading it here would
 * be the first cross-plugin table read in the repo.
 *
 * No cooldown: cost is the limiter, and a cooldown would mean a Redis key,
 * which would mean rule 2's SET NX EX discipline for no gameplay gain.
 *
 * Reachable in hospital. You are not shooting anyone; you are fixing a gun.
 */
const repairRoute = route({
  method: "POST",
  path: "/api/combat/repair",
  accessInJail: false,
  accessInHospital: true,
  body: z.object({ itemId: z.string().uuid() }),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readCombatSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      // Player-only lock. Nothing here touches a gang, a location or a second
      // player, so this adds no edge to rule 6's graph.
      await tx.locks.player([player.id]);

      // Ownership, not equipment: a weapon in the bag can be repaired.
      const [owned] = await tx.db
        .select({ qty: playerItems.qty, itemType: items.itemType })
        .from(playerItems)
        .innerJoin(items, eq(items.id, playerItems.itemId))
        .where(and(eq(playerItems.playerId, player.id), eq(playerItems.itemId, body.itemId)));
      if (owned === undefined || owned.qty <= 0 || owned.itemType !== ITEM_TYPE_WEAPON) {
        throw new PluginError("weapon_not_found", 404);
      }

      const now = new Date();
      const current = await readCondition(tx, player.id, body.itemId, config, now);
      const restored = PRISTINE - current;
      // Not an error: repairing a pristine weapon is a no-op, and charging
      // zero would still write a ledger row.
      if (restored === 0) return { status: 204 };

      const cost = config.repair.costPerPoint * BigInt(restored);
      const [stats] = await tx.db
        .select({ cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      // Checked under the lock taken as this transaction's first statement,
      // so the balance cannot move between the check and the debit.
      if (stats === undefined || stats.cash < cost) {
        throw new PluginError("insufficient_funds", 409);
      }

      await tx.economy.applyBalanceChange({
        playerId: player.id,
        amount: -cost,
        kind: "cash",
        reason: "combat.repair",
      });

      await tx.db
        .insert(weaponCondition)
        .values({ playerId: player.id, itemId: body.itemId, condition: PRISTINE, updatedAt: now })
        .onConflictDoUpdate({
          target: [weaponCondition.playerId, weaponCondition.itemId],
          set: { condition: PRISTINE, updatedAt: now },
        });

      return { status: 200, body: { condition: PRISTINE, cost: cost.toString() } };
    });
  },
});
```

- [ ] **Step 6: Register both routes**

In the manifest, extend `basePaths` is **not** needed — `/api/combat` already covers both. Add to `routes`:

```ts
  routes: [attackRoute, logRoute, targetsRoute, weaponRoute, repairRoute],
```

Add `playerItems` to the `./schema.js` import.

- [ ] **Step 7: Run and verify they pass**

Run: `npx vitest run apps/server/test/combat-repair.test.ts apps/server/test/economy-invariant.test.ts`
Expected: PASS, including the ledger invariant.

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/combat/src/index.ts apps/server/test/combat-repair.test.ts
git commit -m "feat(combat): add the gunsmith repair and weapon-condition routes

Cost is a flat per-point setting rather than a fraction of item value:
items has no value column, and reading inventory's shop table would be
the first cross-plugin table read in the repo."
```

---

## Task 7: Money ranks — the public bracket and the admin ladder

**Files:**
- Modify: `apps/server/src/game/profile/routes.ts`
- Modify: `packages/plugins/ranks/src/schema.ts`
- Modify: `packages/plugins/ranks/src/index.ts`
- Test: `apps/server/test/money-ranks.test.ts` (new)
- Test: `apps/server/test/profile.test.ts` (existing; extend expectations)
- Test: `apps/server/test/admin-ranks.test.ts` (existing; add money-rank cases)

**Interfaces:**
- Consumes: `ProfileDtoSchema`, `MoneyRankDtoSchema`, `RankListResponseSchema` (Task 1).
- Produces:
  - `GET /api/players/:playerId/profile` returns `moneyRankLabel`, `backfire`
  - `GET /api/ranks` returns `moneyRanks[]`
  - `GET /api/admin/ranks/money/list`, `POST /api/admin/ranks/money`, `POST /api/admin/ranks/money/update`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/money-ranks.test.ts` using `bootTestServer`.

```ts
const seed = async (rows: { label: string; threshold: bigint }[]) => {
  await db.delete(moneyRanks);
  await db.insert(moneyRanks).values(rows.map((r) => ({ id: uuidv7(), ...r })));
};

it("picks the highest bracket at or below cash+bank", async () => {
  await seed([
    { label: "Broke", threshold: 0n },
    { label: "Comfortable", threshold: 10_000n },
    { label: "Rich", threshold: 1_000_000n },
  ]);
  await db.update(playerStats).set({ cash: 9_000n, bank: 2_000n })
    .where(eq(playerStats.playerId, player));

  const dto = ProfileDtoSchema.parse((await get(`/api/players/${player}/profile`)).json());
  expect(dto.moneyRankLabel).toBe("Comfortable");
});

it("includes a player sitting exactly on the threshold", async () => {
  await seed([{ label: "Broke", threshold: 0n }, { label: "Rich", threshold: 1_000n }]);
  await db.update(playerStats).set({ cash: 1_000n, bank: 0n })
    .where(eq(playerStats.playerId, player));

  const dto = ProfileDtoSchema.parse((await get(`/api/players/${player}/profile`)).json());
  expect(dto.moneyRankLabel).toBe("Rich");
});

it("returns null below the lowest threshold", async () => {
  await seed([{ label: "Rich", threshold: 1_000n }]);
  await db.update(playerStats).set({ cash: 10n, bank: 0n })
    .where(eq(playerStats.playerId, player));

  const dto = ProfileDtoSchema.parse((await get(`/api/players/${player}/profile`)).json());
  expect(dto.moneyRankLabel).toBeNull();
});

it("returns null when the table is empty rather than erroring", async () => {
  await db.delete(moneyRanks);
  const res = await get(`/api/players/${player}/profile`);
  expect(res.statusCode).toBe(200);
  expect(ProfileDtoSchema.parse(res.json()).moneyRankLabel).toBeNull();
});

it("sums cash and bank, not either alone", async () => {
  await seed([{ label: "Rich", threshold: 1_000n }]);
  await db.update(playerStats).set({ cash: 600n, bank: 600n })
    .where(eq(playerStats.playerId, player));
  const dto = ProfileDtoSchema.parse((await get(`/api/players/${player}/profile`)).json());
  expect(dto.moneyRankLabel).toBe("Rich");
});

/**
 * The bracket is public; the figure is not. This is the guard on the payload
 * widening — cash and bank are SELECTed to compute the label and must never
 * appear in the response.
 */
it("never returns a cash or bank figure", async () => {
  await seed([{ label: "Rich", threshold: 0n }]);
  const body = (await get(`/api/players/${player}/profile`)).json();
  expect(body).not.toHaveProperty("cash");
  expect(body).not.toHaveProperty("bank");
  expect(JSON.stringify(body)).not.toContain("1234567");
});

it("returns the lifetime backfire count", async () => {
  await db.update(playerStats).set({ backfire: 4 }).where(eq(playerStats.playerId, player));
  const dto = ProfileDtoSchema.parse((await get(`/api/players/${player}/profile`)).json());
  expect(dto.backfire).toBe(4);
});

it("serves the ladder on GET /api/ranks, ascending by threshold", async () => {
  await seed([
    { label: "Rich", threshold: 1_000n },
    { label: "Broke", threshold: 0n },
  ]);
  const res = RankListResponseSchema.parse((await get("/api/ranks", token)).json());
  expect(res.moneyRanks.map((m) => m.label)).toEqual(["Broke", "Rich"]);
  expect(res.moneyRanks[0]?.threshold).toBe("0");
});
```

Set the player's cash to `1234567n` in the "never returns a figure" test's setup so the string assertion is meaningful.

Add to `apps/server/test/admin-ranks.test.ts`:

```ts
it("creates, lists and updates a money rank", async () => {
  const created = await post(adminToken, "/api/admin/ranks/money",
    { label: "Loaded", threshold: "5000" });
  expect(created.statusCode).toBe(201);
  const { id } = created.json() as { id: string };

  const list = (await get(adminToken, "/api/admin/ranks/money/list")).json() as
    { rows: { id: string; label: string; threshold: string }[] };
  expect(list.rows.find((r) => r.id === id)?.threshold).toBe("5000");

  const updated = await post(adminToken, "/api/admin/ranks/money/update",
    { id, label: "Very loaded", threshold: "6000" });
  expect(updated.statusCode).toBe(204);
});

it("404s on updating a money rank that does not exist", async () => {
  const res = await post(adminToken, "/api/admin/ranks/money/update",
    { id: uuidv7(), label: "Ghost", threshold: "1" });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ error: "money_rank_not_found" });
});

it("refuses a non-admin", async () => {
  const res = await post(playerToken, "/api/admin/ranks/money", { label: "X", threshold: "1" });
  expect(res.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run apps/server/test/money-ranks.test.ts apps/server/test/admin-ranks.test.ts`
Expected: FAIL — `ProfileDtoSchema` rejects the payload (no `moneyRankLabel`); the admin routes 404.

- [ ] **Step 3: Resolve the bracket in the core profile route**

In `apps/server/src/game/profile/routes.ts`, add `desc`, `lte` to the `drizzle-orm` import and `moneyRanks` to the schema import. Replace the handler's comment and query:

```ts
  // Public — no requireAuth. The response is a public surface: only the
  // explicit columns selected below ever leave this handler. `players`
  // carries passwordHash/legacy password columns, and `player_stats` carries
  // cash/bank/points. The rule is that a wealth BRACKET is public and a
  // wealth FIGURE is not: `cash` and `bank` are selected here solely to
  // resolve the `money_ranks` label, and neither is ever returned. This
  // never selects a whole row and spreads it into the response.
  app.get("/api/players/:playerId/profile", async (request, reply) => {
    const params = ProfileParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const [row] = await db.select({
      playerId: players.id, username: players.username, createdAt: players.createdAt,
      bio: playerStats.bio, avatarUrl: playerStats.avatarUrl, exp: playerStats.exp,
      gangId: playerStats.gangId, gangName: gangs.name, rankName: ranks.name,
      cash: playerStats.cash, bank: playerStats.bank, backfire: playerStats.backfire,
    })
      .from(players)
      .innerJoin(playerStats, eq(playerStats.playerId, players.id))
      .leftJoin(gangs, eq(gangs.id, playerStats.gangId))
      .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
      .where(eq(players.id, params.data.playerId));

    if (!row) return reply.code(404).send({ error: "player_not_found" });

    // Highest bracket at or below the player's wealth; inclusive at the
    // threshold. A separate query rather than a join: a correlated
    // "greatest row below" join is harder to read than two statements, and
    // this route is not hot.
    const [bracket] = await db.select({ label: moneyRanks.label })
      .from(moneyRanks)
      .where(lte(moneyRanks.threshold, row.cash + row.bank))
      .orderBy(desc(moneyRanks.threshold))
      .limit(1);

    return reply.send({
      playerId: row.playerId, username: row.username, bio: row.bio, avatarUrl: row.avatarUrl,
      gangId: row.gangId, gangName: row.gangName, exp: row.exp.toString(), rankName: row.rankName,
      moneyRankLabel: bracket?.label ?? null,
      backfire: row.backfire,
      createdAt: row.createdAt.toISOString(),
    });
  });
```

- [ ] **Step 4: Extend the ranks plugin mirrors**

In `packages/plugins/ranks/src/schema.ts`:

```ts
export const moneyRanks = pgTable("money_ranks", {
  id: uuid("id").primaryKey(),
  label: text("label").notNull(),
  threshold: bigint("threshold", { mode: "bigint" }).notNull(),
});
```

- [ ] **Step 5: Serve the ladder**

In `packages/plugins/ranks/src/index.ts`, inside the `GET /api/ranks` transaction, add:

```ts
          const money = await tx.db.select().from(moneyRanks).orderBy(asc(moneyRanks.threshold));
```

and add to the response body:

```ts
              moneyRanks: money.map((m) => ({
                id: m.id, label: m.label, threshold: m.threshold.toString(),
              })),
```

- [ ] **Step 6: Add the money-rank admin routes**

```ts
const MoneyRankFieldsSchema = z.object({
  label: z.string().min(1).max(80),
  threshold: AdminMoney,
});
const MoneyRankCreateSchema = MoneyRankFieldsSchema.strict();
const MoneyRankUpdateSchema = MoneyRankFieldsSchema.extend({ id: z.string().uuid() }).strict();

const adminMoneyRanksListRoute = route({
  method: "GET", path: "/api/admin/ranks/money/list", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select().from(moneyRanks).orderBy(asc(moneyRanks.threshold)),
    );
    return {
      status: 200,
      body: {
        rows: rows.map((r) => ({
          id: r.id, label: r.label, threshold: r.threshold.toString(),
        })),
      },
    };
  },
});

const adminMoneyRanksCreateRoute = route({
  method: "POST", path: "/api/admin/ranks/money", auth: "admin",
  body: MoneyRankCreateSchema,
  handler: async (ctx, { body }) => {
    const id = newId();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(moneyRanks).values({
        id, label: body.label, threshold: BigInt(body.threshold),
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminMoneyRanksUpdateRoute = route({
  method: "POST", path: "/api/admin/ranks/money/update", auth: "admin",
  body: MoneyRankUpdateSchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db.update(moneyRanks)
        .set({ label: body.label, threshold: BigInt(body.threshold) })
        .where(eq(moneyRanks.id, body.id))
        .returning({ id: moneyRanks.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("money_rank_not_found", 404);
    return { status: 204 };
  },
});
```

Register all three in `routes`. Import `moneyRanks` from `./schema.js`.

- [ ] **Step 7: Add the admin page section**

Append to `adminRanksPage.view.children`:

```ts
      { kind: "table", source: "GET /api/admin/ranks/money/list", columns: [
        { key: "label", label: "Money rank" },
        { key: "threshold", label: "Threshold" },
      ] },
      { kind: "form", action: "POST /api/admin/ranks/money", submitLabel: "Add money rank", fields: [
        { name: "label", label: "Label", type: "text" },
        { name: "threshold", label: "Threshold", type: "money" },
      ] },
      { kind: "form", action: "POST /api/admin/ranks/money/update", submitLabel: "Update money rank", fields: [
        // `id` travels as the select's valueKey and is never a table column:
        // no admin table shows a UUID (`test/admin-ids-hidden.test.ts`).
        { name: "id", label: "Money rank", type: "select",
          optionsSource: "GET /api/admin/ranks/money/list", valueKey: "id", labelKey: "label" },
        { name: "label", label: "Label", type: "text" },
        { name: "threshold", label: "Threshold", type: "money" },
      ] },
```

- [ ] **Step 8: Update the existing profile test's expectations**

`apps/server/test/profile.test.ts` asserts the profile body. Add `moneyRankLabel: null` and `backfire: 0` to whatever exact-shape assertion it makes; if it uses `toMatchObject`, no change is needed but add one positive assertion that both keys are present.

- [ ] **Step 9: Run and verify they pass**

Run: `npx vitest run apps/server/test/money-ranks.test.ts apps/server/test/profile.test.ts apps/server/test/admin-ranks.test.ts apps/server/test/ranks.test.ts apps/server/test/admin-ids-hidden.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/game/profile/routes.ts packages/plugins/ranks/src \
        apps/server/test/money-ranks.test.ts apps/server/test/profile.test.ts \
        apps/server/test/admin-ranks.test.ts
git commit -m "feat: render money ranks on the public profile and admin them in ranks

The bracket is public, the figure is not: cash and bank are selected to
resolve the label and are never returned. Pinned by a test."
```

---

## Task 8: Web client

**Files:**
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/lib/eventCopy.ts`
- Modify: `apps/web/src/pages/Combat.tsx`
- Modify: `apps/web/src/pages/Profile.tsx`, `apps/web/src/pages/PlayerProfile.tsx`
- Modify: `apps/web/src/pages/Ranks.tsx`

**Interfaces:**
- Consumes: `WeaponConditionDtoSchema`, `RepairResponseSchema`, `AttackResponseSchema`, `ProfileDtoSchema`, `RankListResponseSchema` (Task 1); the routes from Tasks 6 and 7.
- Produces: nothing other tasks depend on.

There are **no web tests**, by design — the item-economy spec §7.3 records why. Verification here is `npm run typecheck` plus reading the rendered page. Do not add a web test framework as part of this task.

- [ ] **Step 1: Add the query hooks**

In `apps/web/src/api/queries.ts`, beside the existing combat hooks:

```ts
export function useWeaponCondition() {
  return useQuery({
    queryKey: keys.weaponCondition(),
    queryFn: async () =>
      WeaponConditionDtoSchema.parse(await api("/api/combat/weapon")),
  });
}

export function useRepairWeapon() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (itemId: string) =>
      RepairResponseSchema.parse(
        await api("/api/combat/repair", { method: "POST", body: { itemId } }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.weaponCondition() });
      void queryClient.invalidateQueries({ queryKey: keys.me() });
    },
  });
}
```

Add `weaponCondition: () => ["combat", "weapon"] as const` to the `keys` object. Match the exact `api()` call shape the neighbouring hooks use — if they pass `JSON.stringify` bodies rather than objects, do the same.

Extend `useAttack`'s `onSuccess` to also invalidate `keys.weaponCondition()`, since every shot wears the weapon.

- [ ] **Step 2: Add the event copy**

In `apps/web/src/lib/eventCopy.ts`, after the `player.killed` case:

```ts
    case "player.backfired":
      return event.hospitalised
        ? `Your weapon backfired for ${event.selfDamage} — you're in hospital`
        : `Your weapon backfired for ${event.selfDamage}`;
```

- [ ] **Step 3: Show condition and repair on the combat page**

In `apps/web/src/pages/Combat.tsx`, above the target list, render a panel from `useWeaponCondition()`:

- weapon name, or "Unarmed" when `itemId` is null
- a condition bar: `condition`% width, following whatever bar or meter markup `Hospital.tsx` already uses for health rather than inventing one
- `backfireChance`% as "Backfire chance"
- a "Repair" button, shown only when `itemId !== null && condition < 100`, labelled with the formatted `repairCost`, calling `useRepairWeapon().mutate(itemId)` and disabled while pending

When an attack response has `backfire: true`, show the self-damage in the result area instead of the hit/miss line.

- [ ] **Step 4: Show the money-rank label and backfire count on the profiles**

In both `Profile.tsx` and `PlayerProfile.tsx`, render `moneyRankLabel` beside `rankName` (omit the element entirely when null — do not render "null" or an empty chip), and `backfire` as a stat row labelled "Backfires".

- [ ] **Step 5: Show the money ladder on the ranks page**

In `Ranks.tsx`, render `moneyRanks` as a second table below the exp ladder: label and formatted threshold, using the same `formatMoney` helper the page already imports.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS — this is the step where Task 1's deliberate typecheck failure finally clears.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): show weapon condition, repair, money ranks and backfires"
```

---

## Task 9: Publish `@gl3/shared`, update the docs, and verify the whole suite

**Files:**
- Modify: `docs/STATUS.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Run the full suite, bare**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
npm run verify
```

Expected: exit 0. Read the **exit code**, not the summary — an unhandled rejection makes vitest exit non-zero while still printing every test as passed. Do not pipe this through `grep` or `tail`; that discards npm's exit status. Do not start this while any other test suite is running, including an agent's.

- [ ] **Step 2: Run the exact typecheck CI runs**

```bash
npx tsc --build --force apps/server/tsconfig.json
```

Expected: exit 0. This catches the class of failure the root tsconfig hides from `npm run typecheck`.

- [ ] **Step 3: Publish `@gl3/shared@0.1.2`**

**STOP and get explicit confirmation from the human before running this.** Publishing is outward-facing and not reversible — `npm unpublish` on a public registry is time-limited and messy, and `npm.gl3.dev` has already lost its storage once.

```bash
npm run build --workspace @gl3/shared
npm publish --workspace @gl3/shared
```

`files` in the manifest is load-bearing: `dist/` is gitignored, and without it npm publishes a package with no build output. Verify the tarball contents with `npm pack --dry-run --workspace @gl3/shared` **before** publishing and confirm `dist/` is present.

`@gl3/plugin-sdk` needs no bump: this change is additive and `^0.1.0` resolves `0.1.2`.

- [ ] **Step 4: Update `docs/STATUS.md`**

Replace the "**`player_stats.backfire` is still unused.**" bullet with a description of what shipped. Add entries recording:

- the new `p_combat_weapon_condition` table, that combat now has four migrations, and that the table carries no FKs on purpose
- that `effects.ts` drift is now caught by `effects-parity.test.ts`, which downgrades the standing duplication hazard from "nothing enforces it" to "a test enforces the schema surface"
- that the public profile payload now carries a wealth bracket, and the rule that a bracket is public and a figure is not
- that `@gl3/shared` is at `0.1.2` on `npm.gl3.dev`
- the new suite totals from Step 1's output

- [ ] **Step 5: Update `CLAUDE.md`**

- In "Current state", note that the money-ranks/backfire/weapon-condition work shipped and that three of the five dead-table clusters remain (cars, properties, rounds).
- In the `@gl3/shared` bullet, change the registry line to say it serves `@gl3/shared@0.1.2` and `@gl3/plugin-sdk@0.1.0`.
- Update the suite count.

- [ ] **Step 6: Commit**

```bash
git add docs/STATUS.md CLAUDE.md packages/shared/package.json
git commit -m "docs: record money ranks, backfire and weapon condition

@gl3/shared published at 0.1.2. Three dead-table clusters remain: cars,
properties, rounds."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4.1 bracket resolution, inclusive boundary, empty table | 7 |
| §4.2 public profile payload widening | 1, 7 |
| §4.3 ranks plugin ladder + admin CRUD + no UUID column | 1, 7 |
| §5.1 table, grain, stacking consequence, no extra index | 4 |
| §5.2 lazy decay, PRISTINE default, clock skew | 2 |
| §5.3 wear on use, clock reset rationale, unarmed | 5 |
| §5.4 six settings with clamps and blank-fallback | 2 |
| §6.1 chance formula | 2 |
| §6.2 `backfireChance` in both `effects.ts` copies + parity test | 3 |
| §6.3 `resolveShot` roll ordering, purity, no-armor self-damage | 3 |
| §6.4 counter, health, attacker hospitalisation, log row, target untouched, no bounty | 5 |
| §6.5 `player.backfired`, attacker-only audience, 0.1.2 bump | 1, 9 |
| §7 gunsmith: cost model, 204 no-op, 409, 404, ownership-not-equipment, ledger | 6 |
| §8 four web pages + event copy | 8 |
| §9 every listed test | 2–7 |
| §9 verification discipline | 9 |

No spec requirement is unassigned.

**Type consistency:** `effectiveCondition`, `backfireChanceFor`, `PRISTINE`, `readCondition`, `weaponCondition`, `playerItems`, `WeaponConditionDtoSchema`, `RepairResponseSchema`, `MoneyRankDtoSchema` are each defined once and referenced under the same name everywhere after. `loadWeapon`'s new fourth parameter (`condition`) is introduced in Task 5 and consumed only there.

**Placeholder scan:** clean. No TBD, no "handle edge cases", no "similar to Task N", no test described without its code. Every route, function and migration appears as real source.

**Ordering:** Task 1's typecheck failure is deliberate and stated, and clears in Task 8. No other task leaves the tree broken. Tasks 2–4 are mutually independent and could run in parallel; 5 needs 2, 3 and 4; 6 needs 5; 7 needs 1; 8 needs 1, 6 and 7; 9 needs everything.
