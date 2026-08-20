# Multiplayer Blackjack Tables — Design

Date: 2026-08-20. Branch: `feat/blackjack-tables`. Status: approved design, pre-plan.

## 1. Goal

Turn blackjack from a solo hand-vs-house game into shared tables: up to **5
seats**, one shared dealer, turn-based play, seats persisting across hands.
The table machinery lives in the **casino hub** (`@gl3/plugin-casino`) as a
generic multi-seat layer so future games (poker, etc.) inherit it;
`@gl3/plugin-blackjack` stays pure rules — no tables, no routes, no I/O.

Non-goals:

- Hiding the dealer hole card — **already done** (`blackjack/src/view.ts:26-53`,
  pinned by `blackjack-view.test.ts` and `casino-act.test.ts`). Confirmed
  working by the user; do not touch.
- Split / insurance / surrender. Same rule set as today.
- Remote play. Tables are location-gated (see §5).
- A background scheduler. The plugin job loader exposes no delay/cron
  (`apps/server/src/plugins/jobs.ts`, `ctx.ts:312-321`); every timer here is
  lazy-at-read, the `ensureCurrentRound` shape.
- Removing the solo engine. `casino.games`, `p_casino_sessions` and the
  `play`/`act` routes stay for future single-player games (slots, roulette);
  blackjack simply moves out of them.

## 2. Decisions already made (user-approved)

1. Shared dealer, **turn-based** in seat order; turn timer with auto-stand.
2. Seats **persist across hands**; betting phase between hands; idle seats
   eventually kicked.
3. Hub owns tables; blackjack implements a new `TableGameDef` contract.
4. **Location-gated** (option A): you sit only at tables in the town you stand
   in. Travel cost is the table-access fee; no new fee, no auto-travel, no
   casino→travel dependency.
5. Lobby lists **remote** casinos greyed out with seated-player **counts**
   (never names — underground towns conceal residents' locations elsewhere;
   a count leaks no identity).
6. Solo path retired *for blackjack* only; a 1-player table is solo play.

## 3. Data model — casino plugin migration `0003_tables`

No core migration; `apps/server/test/schema.test.ts` (core `public` counts,
built from core migrations only) is untouched. Casino already declares
migrations, so the migrations-declaring plugin census (10 of 20) is unchanged.

`p_casino_tables`:

| column | type | notes |
|---|---|---|
| `id` | uuid PK | uuidv7 |
| `game_id` | text NOT NULL | `TableGameDef.id` = declaring plugin id |
| `location_id` | uuid NOT NULL, FK → `locations(id)` ON DELETE CASCADE | |
| `property_id` | uuid NULL, **no FK** | house frozen at table creation; pins the row, not the person — transfer/`takeOverFrom` hands the position over, same semantics as today's per-hand freeze |
| `phase` | text NOT NULL | `'betting'` \| `'acting'` |
| `deadline_at` | timestamptz NULL | lazy clock; NULL = no pending deadline (betting phase with no bets yet) |
| `hand_no` | int NOT NULL DEFAULT 0 | increments at each deal |
| `state` | jsonb NULL | opaque game state via the hub's bigint-tagging codec (`state.ts`); NULL between hands |
| `seed` | text NOT NULL | 16 random bytes hex, **rotated at every deal** |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

`p_casino_seats`:

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `table_id` | uuid NOT NULL, FK → `p_casino_tables(id)` ON DELETE CASCADE | |
| `player_id` | uuid NOT NULL, FK → `players(id)` ON DELETE CASCADE | |
| `seat_no` | smallint NOT NULL | 0–4; CHECK `seat_no BETWEEN 0 AND 4` |
| `wager` | bigint NOT NULL DEFAULT 0 | escrowed bet for the **current** hand; `> 0` = in hand |
| `leaving` | boolean NOT NULL DEFAULT false | seat frees at hand end (or immediately if not in hand) |
| `idle_hands` | int NOT NULL DEFAULT 0 | betting deadlines sat out without betting; reset on bet |
| `joined_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: UNIQUE `(table_id, seat_no)`; UNIQUE `(player_id)` — one seat per
player game-wide. The existing `p_casino_sessions_one_open` partial index is
independent and untouched: a player may hold a solo session in some future
solo game and a table seat simultaneously.

Rule-6 note: a seat INSERT takes `FOR KEY SHARE` on its `players` row and its
`p_casino_tables` row. Both are already held `FOR UPDATE` by the inserting
transaction under the lock order in §7, so no new invisible edge exists.
Drizzle handles in `schema.ts` are kept in step **by hand**, as the existing
comment there demands.

Table lifecycle: `sit` joins the first table of (game, caller's location) with
a free seat, else inserts a new table (house = `ownerAt` property row id at
that moment, or NULL for an unowned town — the existing sink semantics).
A `leave`/kick that empties a table DELETEs the table row (seats cascade).

## 4. `TableGameDef` — in casino's `games.ts`, NOT the SDK

New filter point alongside the existing one:

```ts
export const tableGames = filterPoint<TableGameDef[]>("casino.tableGames");

export interface TableSeatInput { seat: number; wager: bigint }

export interface TableStep<S> {
  state: S;
  done: boolean;
  turn: number | null;                       // seat whose turn it is; null when done
  wagerDelta?: { seat: number; amount: bigint };  // e.g. double; positive only
}

export interface TableGameDef<S = unknown> {
  id: string;                    // must equal declaring plugin id (registry check, request-time)
  name: string;
  maxPayoutMultiplier: number;   // per-seat exposure clamp, same as solo
  action: z.ZodType<unknown>;
  deal(input: { seats: TableSeatInput[]; seed: string }): TableStep<S>;
  act(state: S, seat: number, action: unknown): TableStep<S>;
  autoAct(state: S, seat: number): TableStep<S>;   // timeout policy is the game's (blackjack: stand)
  view(state: S, viewer: number | null): ViewNode; // per-seat redaction; null = spectating seat not in hand
  settle(state: S): { seat: number; payout: bigint }[];  // TOTAL returned per seat; 0=loss, wager=push
}
```

All handlers **pure** (no ctx/db/clock/randomness/io), wrapped by the existing
`guardGame` (a game throw → 400 `game_error`, never 500). Registry built per
request by a `buildTableRegistry` sibling with the same id-must-be-installed
and duplicate checks. The hub enforces every rogue-game bound per seat:
`settle` figures clamped to `exposureOf(seatWager, maxPayoutMultiplier)`,
negative payout refused (500), negative/zero `wagerDelta.amount` refused,
`wagerDelta.seat` must be the acting seat, non-finite multiplier refused.
`turn` out of range or pointing at a seat not in the hand → 500
`invalid_turn` (hub defect guard, same class as `invalid_wager_delta`).

**No `@gl3/plugin-sdk` change**: `GameDef` never lived in the SDK, and
blackjack already depends on `@gl3/plugin-casino` (existing plugin→plugin
edge). No new dependency edges anywhere in this cluster.

## 5. Routes and lifecycle (hub)

All under `/api/casino/table`, auth `"player"`, `accessInJail: false`,
`accessInHospital: true` (matching existing casino routes). Every route
validates body/params with zod via `route()`.

- `POST /sit` `{ gameId }` — location-gated: caller's current location. 409
  `no_location`, 404 unknown/uninstalled table game, 409 `already_seated`
  (the UNIQUE(player_id) is the authoritative backstop). An unowned town
  still plays (existing sink rule) — there is no `casino_closed` error.
  Returns `{ tableId, seat }`.
- `POST /leave` — not in hand (wager 0): seat deleted now. In hand: `leaving`
  set true; the hand plays out (their turns auto-stand via the lazy clock or
  immediately if it is currently their turn), settle pays them normally, seat
  freed at hand end. No money is ever dropped by leaving.
- `POST /bet` `{ wager: /^\d+$/ }` — betting phase only, min/max bet per the
  existing settings + house lever, escrow per §6. First bet at a table stamps
  `deadline_at = now + bet_seconds`. When every non-`leaving` seat has bet,
  deal immediately; otherwise the deal fires when the deadline lapses (lazy),
  with bettors only. Non-bettors get `idle_hands + 1`; at
  `idle_kick_hands` the seat is freed. A lone bettor plays solo — same table
  machinery, no special case.
- `POST /act` `{ action }` — acting phase, caller's seat must equal the
  current `turn`, else 409 `not_your_turn`. Applies `game.act`, handles
  `wagerDelta` escrow (house-cover recheck first), stamps
  `deadline_at = now + turn_seconds`, settles when `done`.
- `GET /` — the caller's table view: seats (usernames, seat_no, wager,
  leaving flag), phase, `deadlineAt`, `handNo`, whose turn, and
  `game.view(state, callerSeat)` rendered ViewNode (or null between hands).
  **Location mismatch** (caller travelled away while seated) → same treatment
  on every table route: seat marked `leaving` under the §7 locks, then the
  route answers as if they had left (GET returns `{ table: null }`).
- Lobby `GET /api/casino` extended: per game, the local tables
  `{ tableId, seatsFilled, phase }`, plus `remote:
  [{ locationId, locationName, gameId, seated }]` for every other location
  with ≥ 1 seated player at a table of an installed game — counts only,
  never names, greyed out client-side.

**Lazy clock** — the single `advanceTable(tx, table)` helper, called first
inside every mutating table route and by GET's slow path: while
`deadline_at` is in the past — betting: deal to bettors (or, with zero
bettors, `idle_hands++` sweep/kicks and clear `deadline_at`); acting:
`game.autoAct(state, turn)` for the timed-out seat, repeat until the clock is
in the future or the hand settles. GET takes a **fast path**: a plain
lock-free SELECT when `deadline_at` is NULL or in the future; only a lapsed
deadline opens the locking transaction. Precedent: `GET /api/bullets/shop`
restocks on read; `ensureCurrentRound` settles on read.

## 6. Money

Identical primitives to solo, per seat; every movement through
`applyBalanceChange` (ledger invariant untouched).

- **Bet / double**: `assertHouseCanCover` first — house cash + the incoming
  wager must cover the **sum over all in-hand seats** of
  `exposureOf(seatWager, maxPayoutMultiplier)` (including the bet being
  placed). Then debit the player, `payOwner(house, wager,
  "casino.<gameId>.wager")` with the return discarded (unowned town = sink,
  the seizeOnKill race degrades exactly as today).
- **Settle**: for each seat figure (clamped per §4), `payOwner(-payout)`;
  if the house comes up short, `takeOverFrom(tx, propertyId, ownerId,
  winnerId)` hands the table property to the **first short-paid winner in
  seat order**; every winner is still credited in full from the sink. Both
  sides notified via `tx.notify` (existing `notifyTakeover` shape). Seats'
  `wager` reset to 0, `state` set NULL, `phase` back to `'betting'`,
  `deadline_at` NULL, `leaving` seats deleted, empty table deleted.

## 7. Locks (rule 6)

Every mutating table route and `advanceTable`:

```
tx.locks.location(table.location_id)
  → ONE sorted tx.locks.player([...all seated player ids, ownerId])
  → table row FOR UPDATE
```

(For `sit`, the table row may not exist yet: location lock → player lock on
self+owner → SELECT ... FOR UPDATE on candidate table / INSERT. The insert's
FKs land on rows already held.) Seat rows are never locked separately — the
table row is the serialization point for seat membership.

Splitting the player-lock call is the ABBA cycle; a new
`casino-table-lock-order.test.ts` proves it: two tables, overlapping
players racing (A seated with B racing B seated with A across tables), a
deliberate split-call inversion **demonstrated red** (real 40P01), and the
green sorted-call case. Test waits on `pg_stat_activity`, never sleeps
(existing casino-lock-order idiom).

## 8. Realtime + web

- After commit, the hub publishes one **plugin event** per seated player
  (audience `{kind: "player"}`, ≤ 5 sends) on every table transition
  (sit/leave/bet/deal/act/auto-act/settle/kick), declared with
  `invalidates: ["casino"]` so seated clients refetch. No global audience, no
  new audience kind, no per-hand core event (feed-flood rule stands).
- `apps/web` `Casino.tsx` reworked (stays hand-written): lobby with local
  table cards + greyed remote list; table screen with seat arc, per-seat
  cards from the existing `cards` ViewNode leaf, turn highlight, countdown
  to `deadlineAt` (client re-fetches when the countdown lapses — that read
  is what fires the lazy clock if no one acted), bet box, hit/stand/double,
  leave. `keys.casino()` invalidation arrives via the plugin-event
  invalidation path (`pluginInvalidationKeys`) that already exists.
- `@gl3/shared`: new `dto/casino` table schemas (`CasinoTableViewSchema`,
  lobby extensions). Additive **patch bump**; exact number chosen at publish
  time after a registry check (`0.1.14` collision trap is on record), publish
  only with the user's approval. `@gl3/plugin-sdk` untouched.

## 9. Blackjack (`@gl3/plugin-blackjack`)

- Moves its registration from `casino.games` to `casino.tableGames`;
  implements `TableGameDef`. `providesProperties` (the house) and the two
  singleton asset slots are unchanged.
- State: `{ shoe, cursor, hands: { seat, cards, phase }[], dealer, turn }`.
  Same six-deck seed-keyed Fisher-Yates shoe, shuffled once at deal.
- Deal order: seat 0..n first card, dealer upcard, seat 0..n second card,
  dealer hole card. Naturals auto-stand (resolved at settle, 2.5×). If every
  seat naturals, the hand settles at the deal, as solo does today.
- `act`: `z.enum(["hit","stand","double"])`; double only on first two cards,
  emits `wagerDelta { seat, amount: seatWager }`, one card, auto-stand.
  `autoAct` = stand. Turn passes in seat order among in-hand seats; after the
  last, dealer plays — **stands on all 17** — and `done: true`.
- `view(state, viewer)`: all player cards public; dealer hole card rendered
  face-down (`"B1"`) and total as `"n + ?"` until the dealer plays — the
  existing concealment contract, now per-table. `viewer` marks "your hand";
  blackjack has no viewer-secret info beyond the hole card, but the argument
  is the contract future games (poker) need.
- `settle`: per seat, today's figures verbatim — bust 0, natural (wager·5)/2,
  beat dealer or dealer bust 2×, push 1×, else 0.

## 10. Retirement + tests

- Solo engine stays; blackjack leaves it, so the solo registry ships empty.
  Existing solo tests (`casino-play`, `casino-act`, `casino-lobby`,
  `casino-lock-order`, `casino-rogue-game`) switch their game fixture from
  blackjack to a **synthetic test `GameDef`** where they used the real one;
  their behaviour contracts are unchanged. `blackjack-view.test.ts` and
  `blackjack-rules.test.ts` are rewritten against the `TableGameDef` shape
  (same rule/concealment assertions, now per-seat).
- New: table rules unit tests; per-seat view redaction; bet/turn deadlines,
  auto-stand, idle kick; leave mid-hand; travel-away = leave; 5-seat
  house-cover sum + short-house takeover (first winner in seat order); the
  6th sitter opens a second table; UNIQUE(player_id) refusal; lobby remote
  counts (and that no names leak); boot/migration test for both tables;
  `casino-table-lock-order.test.ts` (§7); economy conservation across a full
  multi-seat hand. Every new `apps/server/test/*.test.ts` file is enumerated
  in `vitest.workspace.ts` (ninth registration site — unlisted files silently
  never run).
- Any test driving casino/blackjack without `bootTestServer()` runs
  `runPluginMigrations(db, [casinoPlugin, propertiesPlugin])` itself
  (rogue-game precedent; properties needed because `ownerAt` reads its table).
- Gate: bare `npm run verify` (exit code from the process, no pipes, no
  `; echo`), with the concurrent-session checks (`pgrep -fa vitest`,
  `gl3_tmpl_*` scan) before the run. Known pre-existing flake on record:
  `casino-lock-order` ABBA bare-500 — a recurrence there is investigated
  against that record, not assumed caused by this branch.

## 11. Settings (casino namespace, admin-visible read-only like today)

- `table_bet_seconds` (default 20), `table_turn_seconds` (default 30),
  `table_idle_kick_hands` (default 3), `table_max_seats` (default 5, hard
  ceiling 5 — the seat CHECK constraint is the backstop).
- Existing `min_bet` / house `max_bet` lever semantics reused per seat.
