---
title: Build a world client
---

# Build a world client

GL3 can render the town a player is standing in as a scene: one street, a
building or NPC per plugin that declares one, the jail and hospital, and the
other players present as avatars. This guide is for whoever writes such a
client — the reference Godot client, a web embed, anything that speaks the
`/ws` protocol. The exact frame and descriptor shapes are generated from the
schemas at [WebSocket frames](/reference/ws) and the `presence` DTO; this page
is the contract around them.

## The one rule

**Positions are cosmetic.** A player's `x`, `y` and `facing` are broadcast to
the room and nothing else — no route, job or filter on the server reads them.
A spoofed position makes an avatar look wrong and cannot do anything else. The
consequences for a client author:

- Which room a player is in is decided by the server from
  `player_stats.location_id`. There is no frame that names a location; you
  change town with `POST /api/travel/:locationId` and the server moves the
  avatar for you.
- Standing next to someone means nothing to combat. Attacking is still
  `POST /api/combat/attack/:id`, checked by the server exactly as it is for the
  text client (same town, underground rules, protection, cooldown). Use scene
  proximity as a UI affordance if you like, but never assume the server
  enforces it — a player drawn across the street is just as attackable.
- Move validation is anti-griefing, not anti-cheat: a token bucket per socket
  (10 tokens, refilling 10 per second, shared by `presence.move` and
  `presence.emote`; the 200th dropped frame in a minute closes the socket with
  `rate_limited`), a monotonic `seq`, and clamps to the room bounds and to a
  6 m/s displacement with a 50 ms floor. Frames are clamped, never rejected —
  a rejected frame under lag is a stuck avatar; a clamped one is a rubber band.
  One exception: `facing` outside `[-π, π]` is an `invalid_frame`, so wrap your
  yaw before sending.

## Lifecycle

```
POST /api/auth/login              → { token }
POST /api/ws/ticket   (Bearer)    → 201 { ticket }        single-use, ~30 s
GET  /ws?ticket=…                 → { kind: "ready", playerId }
                                    the server now auto-joins you as a STATIC member
presence.join { client }          → { kind: "presence.snapshot", room, you, players, concealed }
                                    you now DRIVE the avatar
presence.move { seq, x, y, facing }  ≤ 10 Hz, only when moved > 0.05 m or turned > 0.05 rad
                                  ← { kind: "presence.tick", … } every 200 ms while anything changed
presence.enter { hookId }         → a fresh presence.snapshot for the interior, if the door has one
presence.exit                     → a fresh presence.snapshot back on the street
presence.join { client, interior } reconnect straight inside: the street snapshot, then the interior one
POST /api/travel/:id              ← a fresh presence.snapshot for the new town
socket close / presence.leave     the room is told left
```

Reconnect by minting a new ticket and sending `presence.join` again; a join is
idempotent and there is no session to resume. Godot's native `WebSocketPeer`
sends no `Origin` header, which the gateway allows on purpose; a web export
sends the page's origin, which must be in `CORS_ORIGINS`.

## Who is in the room

Every authenticated socket is put into its player's town the moment it
connects — a web tab, the Android app, anything — as a **static** member
(`PresenceState.static: true`): it stands still on the pavement at a
deterministic spot and its client receives no presence frames, because it
never asked for any. So a 3D client sees every player in the town, not just
the ones running a 3D client. A `presence.join` on any socket of that player
takes the avatar over (`static` flips to `false`, re-announced through
`tick.joined`); when the driving socket closes and another remains, the member
falls back to static at its last position.

One avatar per player: the most recent `presence.join` drives; the socket it
displaced gets `presence.error superseded` and keeps receiving ticks, so a web
tab can render a minimap while the Godot window drives.

`PresenceState.sentence` is `"jail"`, `"hospital"` or `null`, so you can draw a
sentenced player in the facility's yard even if their own client is old or
offline. It is refreshed from the jail/hospital events and re-announced via
`tick.joined`. One gap: hospital self check-in publishes no event, so it
reaches other clients only at that player's next join, travel or discharge.

## Concealed towns

A town whose `combat_mode` is `underground` conceals its residents everywhere
in GL3 — `/api/online`, search, casino — and presence is no exception. The
snapshot arrives with `concealed: true` and `players: []`, and the room
broadcasts nothing about anyone, including you. Draw the scene, say "nobody
shows their face here", and take combat targets from `GET /api/combat/targets`,
which in an underground town lists only the players the caller holds a live
detective report on.

## The scene

`presence.snapshot.room` — also served as `GET /api/world/scene` (the caller's
town) and `GET /api/world/scene/:locationId` (any town, for preloading a
destination while a travel request is in flight) — is the room descriptor:

- `sceneKey` — which scene asset to load (`"default"` unless an admin set one).
- `bounds` (`minX/minY/maxX/maxY`, default ±40 × ±20) and `spawn`
  (`x/y/facing`, default `(0, −15, 0)`). `x` is east, `y` north, metres, origin
  at the scene centre; Godot maps `y → −z`. `facing` is a yaw in radians, `0`
  facing north, positive counter-clockwise from above. On a `default` (non-
  template) town, the served `bounds.minX`/`maxX` are widened, never
  shrunk, to contain every placed building and core yard with a 4 m margin
  to spare — a town with enough buildings to run past the ±40 default gets
  a wider street rather than an invisible wall short of its last building.
  `minY`/`maxY` are never widened. A client must treat the served `bounds`
  as authoritative for clamping and never assume the ±40 default. The served
  bounds are authoritative for GEOMETRY SIZING too, not just clamping: on a
  gl3 default town the served street can run to about `x = 86`, well past
  the `default` scene asset's own ±40 build, and a client that sizes its
  ground plane from the asset's defaults instead of the served `bounds`
  leaves roughly 46 m of walkable void past the visible ground.
- `hooks[]` — every building and NPC, placed by the server so all clients
  agree. Layout is deterministic: one street along `x` at `y = 0`, road
  `|y| ≤ 7.5`, pavement to `|y| = 10.5`, buildings beyond it alternating north
  and south from the row's `minX + 4` with a 4 m gap (positions are served
  explicitly; do not re-derive them from the served `minX`), NPCs on the
  pavement in front of
  the building placed before them; the spawn lot `[spawn.x − 8, spawn.x + 10]`
  on the spawn's side is kept clear. A building north of the street faces it
  with `facing = π`, south with `0`.

Each `PlacedHook` carries `id` (`"<pluginId>.<hookId>"`), `kind`
(`building` | `npc`), `label` (≤ 24 chars, for the sign), `model` (an asset-kit
key — `garage`, `bank`, `station`, `newsstand`, `npc-suit`, `npc-coat`, … —
unknown keys fall back by `kind`), `footprint {w, d}` (buildings are 3 m-grid,
12×9 or 6×6), `position` (footprint centre), `facing`, `href`
(`/plugins/<pageId>`) and `signageUrl` (an image bound by an admin, or `null`).
The bundled plugins declare five doors on the default street — `travel.station`,
`crimes.corner` (an npc), `bank.bank`, `casino.casino` and `inventory.shop` (6×6) —
and a template town may add more. The last two hooks are always core's `core.jail` and `core.hospital`, pinned
at the east end of the street with an extra `yard {x, y}` — the confinement
spot for a sentenced player.

### Scene templates

A town may run on an authored template instead of the auto-laid starter street. Its
`sceneKey` names one; fetch the geometry with `GET /api/world/template/:sceneKey` (404
`unknown_template`): `bounds`, `spawn`, `roads[]` (`from`, `to`, `halfWidth`, `pavement`),
`slots[]` (`id`, `accepts` building | npc | prop, `zone`, `position`, `facing`, `max {w, d}`)
and `facilities.jail` / `.hospital` (building slots with an explicit `yard`). The engine
assigns hooks to slots — zone-first, any zone for buildings and npcs, parking bays only for
props — and the room's `hooks[]` carries the result exactly as on the default street, so a
client renders the same `PlacedHook` shape; only the road scene changes. A `prop` hook is an
interactive object (a parked car: `model` is a vehicle key, no sign), never sent for a
`default` town. Build the road scene from the template endpoint, not from a local copy.

Interacting with a hook means opening `href`. Nothing is sent to the server:
a hook is declarative, and the page already knows what to do. The reference
client opens the app in a browser; a web embed routes inside the shell. A hook
opens a plugin page, and every core plugin's pages render from the view-node
vocabulary (see [Create a plugin](/guides/create-a-plugin)), so a client that
renders those nodes needs no per-plugin code.

## Interiors

A door can be ENTERED. A `PlacedHook` that carries `interior: { sceneKey }` is such a
door; `href` still opens its page, so an older client keeps working. Inside, the
player is in a second **space** of the same town — combat, travel and every route
still see the same `location_id` — with its own room, bounds, spawn and interaction
`points[]`. The server owns every transition:

```
presence.enter { hookId: "casino.casino" }   → presence.snapshot (room.space.kind = "interior", room.points)
                                               the street is told left, the interior joined
presence.exit                                 → presence.snapshot (street; you stand at room.space.exit)
presence.join { client, interior: "casino.casino" }   reconnect straight inside (street snapshot, then interior)
GET /api/world/interior/:hookId               the descriptor, for preloading (404 no_location | unknown_hook | no_interior)
```

Refusals arrive as `presence.error`: `wrong_space` (exit on the street, enter while
inside another building), `unknown_hook`, `no_interior`, `sentenced` (jail or
hospital — a sentence acquired inside walks you out automatically), `superseded`
(only the driving socket may transition), `not_joined`. A `presence.enter` for the
door you are already inside is a silent no-op — no snapshot, no error — so never
block waiting on an answer to one. `presence.tick` carries
`space` so you can drop a tick for a room you have left. An underground town
conceals its interiors exactly as its street. Travel always lands on the destination
street.

### The casino floor (`casino-floor-v2`)

Bounds `{ minX: -12, minY: -9, maxX: 12, maxY: 9 }`, entrance spawn `(0, −7.5, facing 0)`,
exit 3 m in front of the door on the street. One `table` point per real-money table
game plus eight `machine` points for slots:

- **Blackjack**, model `blackjack-table`, centre `(−6, 1)`, dealer facing π (south),
  bound to `{ gameId: "blackjack", station: 0 }`.
- **Texas Hold'em**, model `holdem-table`, centre `(6, 1)`, dealer facing π (south),
  bound to `{ gameId: "holdem", station: 0 }`.

Both tables carry the same five `seats` on the south arc (offsets `(−1.8, −0.9)`,
`(−1.0, −1.7)`, `(0, −2)`, `(1, −1.7)`, `(1.8, −0.9)` from their own centre, each
facing it). Seat index = seat number at the table.

- **Slots**, eight `machine` points along the north wall, model `slot-machine`,
  `y = 7.5`, `x = −10.5 … 10.5` in 3 m steps, facing π (south), bound to
  `{ gameId: "slots", station: 0..7 }`. Each has exactly one `seats` entry — the
  stand spot 1.5 m south of the machine, `(x, 6)`, facing north — because a slots
  session is per player: a machine never fills, and the count is only how many
  the scene draws.

Both `holdem` and `slots` are `@gl3-plugins/*` packages not installed in this repo,
so their floor rows carry `available: false` until an operator installs them; the
geometry and stations are real either way.

Playing is the existing casino contract, unchanged:

| Need | Route |
|---|---|
| Who is at which table right now | `GET /api/casino/floor` → one row per declared station, in DECLARATION order (blackjack, then hold'em, then slots 0..7 — never re-sorted by station number, since each game starts its own stations at 0): `gameId`, `station`, `available`, `tableId`, `phase`, `seatsFilled`, `seats[{ seat, playerId, username }]` (names only in open towns; `available` is false when the game's plugin is not installed, and its row's table fields are null/zero/empty). Poll on entry and every 15 s. |
| Sit at the table you walked up to | `POST /api/casino/table/sit { gameId, station }` → `{ tableId, seat, station }`; 400 `unknown_station`, 409 `table_full` / `already_seated` |
| Your hand, turn, legal moves | `GET /api/casino/table` → `{ table: { station, mySeat, phase, turnSeat, deadlineAt, view, moves, seats } }`; `view` is scoped to the viewer (the dealer's hole card is hidden while any seat acts) |
| Bet / act | `POST /api/casino/table/bet { wager }`, `POST /api/casino/table/act { action: "hit" \| "stand" \| "double" }` |
| Resume after a reconnect | `GET /api/casino/table` — the hand never depended on your socket |
| Stand up | `POST /api/casino/table/leave` → `{ left, deferred }`; call it BEFORE `presence.exit` and honour `deferred` (a stake in hand plays out, auto-standing on your turns) |

Walking out, disconnecting, travelling or being sentenced never touches your seat: the
table's own rules (turn clock, idle kick, `leaving`) apply. Positions stay cosmetic —
move your avatar to the seat spot after `sit` succeeds; the server never checks it.
Hand information is never in a presence frame; the `table` silent event still tells a
seated client the table moved. Combat is unchanged: eligibility is by town, so a player
inside the casino is attackable from the street and vice versa.

## Declaring a hook (plugin authors)

A plugin puts itself in the world with one manifest field:

```ts
worldHooks: [{
  id: "station",            // kebab-case, unique within the plugin
  kind: "building",         // or "npc"
  label: "Station",         // 1–24 chars, author-written
  page: "travel.index",     // one of THIS plugin's player pages
  model: "station",
  footprint: { w: 12, d: 9 },
  order: 10,                // layout order along the street
  signageSlot: "sign",      // optional: one of this plugin's singleton providesAssets
  interior: { sceneKey, bounds, spawn, points },  // optional: makes the door enterable — see Interiors
}]
```

Boot validation refuses a duplicate id, a page that is not the plugin's own
player page (never another plugin's, never an admin section), and a signage
slot that is not one of its own singleton slots. Hooks appear in every town;
per-town hooks, admin placement and a player-chosen avatar are not built yet.
