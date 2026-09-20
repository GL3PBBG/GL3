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
  facing north, positive counter-clockwise from above.
- `hooks[]` — every building and NPC, placed by the server so all clients
  agree. Layout is deterministic: one street along `x` at `y = 0`, road
  `|y| ≤ 7.5`, pavement to `|y| = 10.5`, buildings beyond it alternating north
  and south from `minX + 4` with a 4 m gap, NPCs on the pavement in front of
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

Interacting with a hook means opening `href`. Nothing is sent to the server:
a hook is declarative, and the page already knows what to do. The reference
client opens the app in a browser; a web embed routes inside the shell. A hook
opens a plugin page, and every core plugin's pages render from the view-node
vocabulary (see [Create a plugin](/guides/create-a-plugin)), so a client that
renders those nodes needs no per-plugin code.

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
}]
```

Boot validation refuses a duplicate id, a page that is not the plugin's own
player page (never another plugin's, never an admin section), and a signage
slot that is not one of its own singleton slots. Hooks appear in every town;
per-town hooks, admin placement and a player-chosen avatar are not built yet.
