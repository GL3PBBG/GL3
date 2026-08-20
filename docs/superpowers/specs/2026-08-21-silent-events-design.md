# Silent events — realtime for casino tables

Date: 2026-08-21. Branch: `feat/silent-events`. Status: approved design (user
queued this cluster after the blackjack-tables merge; scope agreed in chat).

## 1. Goal

Give the multiplayer casino table WS-driven freshness without flooding the
game feed. Today the table polls at 2.5s because every plugin event renders a
feed line through its `describe` template — a blackjack hand is ~10
transitions × 5 seats, so per-hand events were ruled out and polling chosen
(blackjack-tables spec §8). This cluster adds the missing primitive: a
**feed-suppressed ("silent") plugin event** — the feed skips it, client cache
invalidation still honors it.

Non-goals: no new audience kind, no gateway changes, no core `GameEvent`
variant, no scheduler. The poll DOES NOT disappear — it relaxes to a slow
fallback, because a table read is what drives the lazy clock
(`advanceTable`); with no readers there is no clock.

## 2. The flag, end to end

1. **SDK** (`packages/plugin-sdk/src/events.ts`): `PluginEventDecl` gains
   `silent?: boolean` (absent = false). `PluginEventDeclSchema` gains
   `silent: z.boolean().optional()` — the schema stays `.strict()`.
   `describe` REMAINS required: an old client that predates the flag renders
   the describe text, which is the graceful degradation (noise, not breakage).
2. **Loader** (`apps/server/src/plugins/manifest-endpoint.ts`): the
   `EventMeta[]` built for `GET /api/plugins` carries `silent` through
   (omit-when-false or always-present — match `EventMetaSchema`'s shape,
   which uses `.optional()`, so omit when absent).
3. **Shared** (`packages/shared/src/dto/plugins.ts`): `EventMetaSchema` gains
   `silent: z.boolean().optional()`; still `.strict()`.
4. **Web feed** (`apps/web/src`): a new pure helper
   `isSilentEvent(event: GameEvent, eventMetas: readonly EventMeta[]): boolean`
   (in `lib/eventCopy.ts` or a sibling — true iff `event.type ===
   "plugin.event"` and its matching meta has `silent === true`; unknown meta
   = not silent). `EventFeed.tsx` filters silent events out before rendering.
   `pluginInvalidationKeys` / `ws/invalidation.ts` are UNTOUCHED — silent
   events still invalidate exactly what they declare.
5. **Casino hub** (`packages/plugins/casino`): declares its first event —
   `{ name: "table", payload: z.object({ tableId: z.string() }), describe:
   "{actorName} is at the tables", invalidates: ["casino"], silent: true }` —
   and publishes it once per SEATED player (audience `{kind: "player"}`,
   ≤5 sends) at the end of every mutating table transaction: sit, leave, bet,
   act, and GET's slow path (a lapsed-clock advance is a mutation other
   seats must learn about). Publishing from a GET is unusual but correct
   here: the loader flushes events only after the transaction commits, and
   the slow path only runs when it genuinely advanced the table. The actor
   is the caller; recipients are the seats at that table (including the
   caller — one uniform loop, the client dedupes by cache semantics anyway).
   `invalidates: ["casino"]` prefixes both `["casino"]` (lobby) and
   `["casino","table"]` (table view) query keys.
6. **Web poll** (`apps/web/src/api/queries.ts`): `useCasinoTable`'s
   `refetchInterval` while seated relaxes 2500 → **15000** (the clock's
   backstop for a table nobody acts on); WS invalidation is now the fast
   path. Unseated stays `false`.

## 3. Trust and compatibility

`silent` is per-declaration, boot-validated like every other decl field. A
plugin abusing it can suppress its own feed lines — the same trust class as
`publishCore` (install-time trust, no runtime guard). Old registry consumers
(`^0.1.x`) ignore the extra optional field. Versions: `@gl3/plugin-sdk`
0.1.11 → 0.1.12, `@gl3/shared` 0.1.19 → 0.1.20, both additive patches,
published only with the user's approval after a registry check.

## 4. Tests

- SDK unit: `PluginEventDeclSchema` accepts `silent: true`/absent, rejects
  non-boolean; parity of shape with `EventMetaSchema` where applicable.
- Shared unit: `EventMetaSchema` round-trips `silent`; `PluginsPayloadSchema`
  with a silent event parses.
- Web unit: `isSilentEvent` truth table (silent meta / non-silent / missing
  meta / core event); invalidation snapshot untouched (existing
  `invalidation.test.ts` untouched proves the path).
- Integration (`apps/server/test/casino-table-events.test.ts`, DB-backed):
  each seated player receives the `plugin.event` named `table` on a bet
  (via `awaitOwnEvent` filtered by actor — note rule 4: filter by own
  actorId), with `silent: true` visible in `GET /api/plugins`' event metas;
  a non-seated player at another table receives nothing. **This file may be
  written and registered but not executed while the no-Postgres constraint
  stands** — recorded, not hidden.

## 5. Feed-history note

Silent events still travel the bus and reach clients; they are skipped at
RENDER time only. If an event-history table ever lands, silence should be
re-evaluated there.
