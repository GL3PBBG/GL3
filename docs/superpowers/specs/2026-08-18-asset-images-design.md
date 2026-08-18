# Asset images — design

**Date:** 2026-08-18
**Status:** approved (design), implementation on `feat/asset-images`

## Why

GL3 has no image infrastructure. One column exists — `player_stats.avatar_url`,
a text field the M4 migrator fills from V2's `US_pic`. Nothing else in the game
carries art: not items, not cars, not crimes, not locations, not ranks.

V2 has no image infrastructure either. `install/schema.sql` declares no image
column on `cars`, `items`, `crimes`, `locations`, `weapons`, `ranks` or
`properties`. `US_pic` defaults to `themes/default/images/default-profile-picture.png`
— a path into the theme directory, not an upload. Game art in V2 lived in
`themes/`, hardcoded per skin and not addressable per row.

So this is not a port. There is no V2 behaviour to match and no migrator work:
we define the mechanic. That is also why it is worth building — it is engine
capability the original never had, and it is what makes a marketplace plugin
look like a finished product rather than a table of text.

## Scope decisions

Four decisions taken during brainstorming, recorded here because each one cuts
a large amount of work:

1. **Admin/creator art only.** No player-uploaded content. This removes
   moderation, reporting, takedown, per-player quotas and the entire abuse
   surface. Avatars and gang logos are explicitly out.
2. **Per-install art, plugin-declarable.** Each running game uploads its own
   art. Plugins declare image slots in their manifest, so adopting images is an
   engine-level capability rather than a per-plugin reinvention. No asset packs,
   no theme layer, no plugin-bundled binaries.
3. **Filesystem driver for dev/test, S3 driver for production.** Two real
   implementations behind one interface. The accepted cost is that the suite
   never exercises the S3 path; the mitigation is a driver contract suite
   (below) that runs against a real endpoint on demand.
4. **Slot registry, not per-entity columns.** See "Data model".

## Data model

Core migration `0012_assets` adds two tables.

```
assets           id uuid pk
                 sha256 text not null unique
                 mime text not null
                 bytes integer not null
                 width integer not null
                 height integer not null
                 uploaded_by uuid null
                 created_at timestamptz not null default now()

entity_assets    scope text not null
                 entity_id uuid not null
                 slot text not null
                 asset_id uuid not null
                 bound_at timestamptz not null default now()
                 primary key (scope, entity_id, slot)
                 asset_id -> assets(id) on delete cascade
```

`scope` is the declaring plugin's id, or the literal `"core"` for core-owned
tables (`items`, `locations`, `ranks`).

**There is deliberately no foreign key on `entity_id`.** That is the whole
reason this shape was chosen over an `asset_id` column on each entity table.
A per-entity column would mean:

- a migration for every plugin that ever wants an image, forever; and
- a new foreign key from each plugin table into a core table.

A foreign key is a lock (CLAUDE.md rule 6). Two deadlocks have already shipped
in this repo from implicit `FOR KEY SHARE` taken by an FK nobody read. This
design adds **zero** edges into any plugin table. The single new FK is
`entity_assets.asset_id -> assets(id)`, core to core, on a table no gameplay
path locks.

The cost is no referential integrity on `entity_id`: deleting an entity leaves
an orphan mapping row. That is handled by the sweep (below), not by the
database.

### Drift guard

`apps/server/test/schema.test.ts` counts foreign keys by `ON DELETE` rule and
non-primary-key indexes. This migration moves:

- foreign keys **36 -> 37**, cascade **23 -> 24** (`entity_assets.asset_id`)
- non-PK indexes **29 -> 30** (`assets.sha256` unique)

`entity_assets`' composite primary key is not counted. The test is a drift
guard: restate the numbers and extend the comment block. Never loosen it.

Note that `schema.test.ts` imports nothing from the migration, so no scoped
test run selects it. The last run before merge is the bare `npm run verify`.

## Storage

Keys are **content-addressed**: the sha256 of the bytes *is* the storage key.

- Dedup is free — the same art bound to two entities is one stored object.
- Cache-busting is free — different bytes are a different key, so
  `Cache-Control: immutable` is always correct and never stale.
- There is no rename or overwrite problem, because a key's content cannot
  change.

```ts
interface StorageDriver {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  urlFor(key: string): string;
}
```

`urlFor` is the only place the two drivers visibly diverge: the filesystem
driver returns `/assets/<sha256>` (served by a core route), the S3 driver
returns `<ASSET_CDN_BASE>/<sha256>`. Nothing above the driver knows which is
in use.

### Filesystem driver

Root is `ASSET_FS_ROOT`, default `var/assets`, gitignored. Files are written
under a two-character shard prefix (`ab/abcdef...`) so a large install does not
put a hundred thousand entries in one directory.

Tests get a per-file temporary root, so no two test files share storage state.

### S3 driver

Selected by `ASSET_DRIVER=s3`. Configuration:

| Env | Meaning |
| --- | --- |
| `ASSET_DRIVER` | `fs` (default) or `s3` |
| `ASSET_FS_ROOT` | filesystem root, `fs` only |
| `S3_ENDPOINT` | S3-compatible endpoint (R2 account endpoint) |
| `S3_BUCKET` | bucket name |
| `S3_ACCESS_KEY_ID` | credential |
| `S3_SECRET_ACCESS_KEY` | credential |
| `S3_REGION` | `auto` for R2 |
| `ASSET_CDN_BASE` | public base URL images are served from |

All of these are parsed in `config.ts` and validated together: selecting `s3`
with any field missing **fails at boot**, not at the first upload.

Reads are unsigned public-bucket/CDN URLs. Uploads are server-side with the
server holding the credentials, so there are no presigned PUTs and **no bucket
CORS configuration at all** — the browser only ever issues a `GET` for an
image.

Dependency: `@aws-sdk/client-s3`.

## Upload

Uploads are a **core** route, not a plugin route. Plugin routes take a
Zod-parsed JSON body (`body: z.ZodTypeAny`); pushing binary through that
contract would drag multipart handling into the SDK for every plugin.

`POST /api/admin/assets`, `auth: admin`. The raw body arrives as a Buffer via
`addContentTypeParser` for `image/png`, `image/jpeg` and `image/webp`. No
`@fastify/multipart` dependency and no `sharp` dependency.

Validation, in order:

1. **Size cap** — a setting, `assets.max_bytes`, default 524288 (512 KB),
   admin-editable through the same machinery as bullets' `max_buy`.
2. **Magic bytes** must agree with the declared `Content-Type`. A `.php`
   renamed `.png` dies here.
3. **Intrinsic dimensions** parsed from the file header (PNG `IHDR`, JPEG
   `SOF0`-`SOF15`, WebP `VP8`/`VP8L`/`VP8X`) — a pure-TypeScript reader, no
   native dependency. Over `assets.max_dimension` (default 2048) is rejected.
4. **sha256**; on conflict the existing row is returned. Uploading the same
   bytes twice is idempotent and costs no storage.

**Write order is driver-then-database**: hash, `driver.put`, then insert. A
crash between the two orphans an object in the bucket, which the sweep
collects. Database-first would leave a row pointing at an object that does not
exist — a broken image with no way to detect it.

### Not done

Stated explicitly so the gaps are on record rather than assumed:

- No re-encode and no thumbnails. The fixed-size render is CSS's job.
- No EXIF stripping. Irrelevant for trusted admin art; a blocker the day UGC
  is considered.
- No server-side resize, so a 512 KB image is 512 KB on every list that shows
  it.

## Binding

`PUT /api/admin/assets/bind`, JSON body `{ scope, entityId, slot, assetId }`
where a null `assetId` unbinds.

- `scope` + `slot` are validated against the loader's registry. An undeclared
  slot is a 400, not a silently orphaned row.
- The permission is `hasPermission(scope)`, **not** blanket admin. Whoever
  holds the `travel` grant can set town art and cannot set item art. This falls
  out of the existing ABAC with no new concept.

## SDK surface

### Manifest

```ts
providesAssets?: AssetSlotDecl[]   // { slot: string; label: string }
```

`scope` is not a field — the loader derives it from the declaring plugin's id.
`PropertyTypeDecl` enforces the same rule by hand (`id` must equal the plugin's
own id); here it cannot be got wrong. Two plugins therefore cannot collide on a
slot, so the loader needs no collision pass for this field.

It is pure data, so it is validated by Zod at `definePlugin` time — the
`pages`/`events` tier, not the `routes`/`jobs` `z.unknown()` tier.

Core declares its own slots under scope `"core"` for `items`, `locations` and
`ranks`: the tables plugins read but do not own.

### Ctx

```ts
readonly assetSlots: {
  list(): readonly AssetSlot[];
  get(scope: string, slot: string): AssetSlot | null;
};
readonly assets: {
  resolve(scope: string, entityIds: string[], slot: string): Promise<Map<string, string>>;
  mine(entityIds: string[], slot: string): Promise<Map<string, string>>;
};
```

Same shape as `propertyTypes` and `installedPluginIds`: cross-plugin,
loader-assembled data a route handler cannot otherwise see.

`resolve` is **batched by construction**. It takes an array and returns a Map,
and there is deliberately no single-id accessor: a list page is the common
case, and a `urlFor(oneId)` inside a `.map()` is an N+1 waiting to happen. A
missing binding is absent from the Map and the renderer falls back to a
placeholder.

Cross-scope reads are allowed — combat renders a weapon image whose `items`
rows are core-scope. Reads only; writes go through the bind route and its
`hasPermission(scope)` check.

## Rendering

Three additive schema changes, each of which must land in **both**
`packages/plugin-sdk/src/pages.ts` (`ViewNodeSchema`) and `packages/shared`
(`ViewNodeDtoSchema`). `packages/plugin-sdk/test/view-node-parity.test.ts`
enforces the pair. The `cards` leaf is the recorded incident where it did not:
`PluginsPayloadSchema.parse` is all-or-nothing, so one unmirrored leaf takes
down the entire plugin payload in the browser.

1. **Leaf `image`** — `{ kind: "image", url, alt, size?: "sm" | "md" | "lg" }`.
   Display only. `alt` is required rather than optional: it is the one
   accessibility decision that is free at authoring time and impossible to
   retrofit across every plugin later.
2. **`table.columns[].render?: "image"`** — the cell value is a URL and renders
   as an `<img>`. Additive and safe under `.strict()`; existing columns are
   unaffected.
3. **Leaf `assetBinder`** — the admin upload widget:
   `{ kind: "assetBinder", slot, entitySource: "GET /...", entityLabelKey }`.

On (3): the obvious design is a `form` with a file field, but a form's `action`
must live under the plugin's `basePaths` (the loader's containment pass) and
binding is a core route. Rather than punch a containment exception for one
path, `assetBinder` is its own node whose target the renderer knows. It picks
an entity from `entitySource` (whose `valueKey` is the id, per the existing
admin-ids-hidden rule), takes a file, `POST`s the bytes to
`/api/admin/assets`, then `PUT`s the returned `assetId` to
`/api/admin/assets/bind` with `scope` filled in **by the loader** from the
declaring plugin. `scope` is never author-supplied, so a plugin cannot declare
a widget that binds another plugin's art. Valid in `adminPages` only, enforced
at boot.

### Web

Manifest-declared pages get `image` nodes and image table columns. The
hand-written pages read URLs the existing DTOs now carry, populated via
`ctx.assets.resolve`. One shared `<GameImage>` component in `apps/web` owns the
placeholder-on-404 and a fixed aspect box, so a missing binding never reflows a
list.

`apps/web/serve.mjs` sets no CSP, so `ASSET_CDN_BASE` needs no `img-src` entry.
If a CSP is ever added, it does.

## Serving (filesystem driver)

`GET /assets/:key`, public. Art is not secret, and requiring auth would defeat
browser caching.

`key` is validated as `/^[0-9a-f]{64}$/`, which makes path traversal
structurally impossible rather than sanitised away. Headers:
`Cache-Control: public, max-age=31536000, immutable`, correct by construction
because the key is the content hash. A miss is a plain 404 and the client falls
back to its placeholder; the server does not substitute one.

## Sweep

The existing core sweeper gains a pass that deletes:

- `entity_assets` rows whose entity no longer exists, and
- `assets` rows with no remaining `entity_assets` reference, together with
  their stored object.

It reuses the sweeper's established shape — an unlocked candidate SELECT with
the claim in the mutating statement — and is bounded by the same batch limit.

## Testing

The load-bearing test is a **driver contract suite**: one set of cases run
against the filesystem driver always, and against a real endpoint when
`S3_TEST_ENDPOINT` is set, skipped otherwise. Cases: `put`/`get` roundtrip,
`delete`, missing key returns null, same-key overwrite is idempotent, `urlFor`
shape. This is the honest mitigation for decision 3 — `npm run verify` stays
offline and green, and the S3 driver has a green path it can be made to prove
before a deploy.

Beyond that:

- magic-byte mismatch rejected; oversize rejected
- dimension parsing per format against committed fixtures
- duplicate upload returns the same asset id
- `GET /assets/../../etc/passwd` fails in the Zod param as a 400, proving
  traversal is structurally impossible rather than scrubbed
- unknown slot rejected at bind; wrong-scope bind rejected by `hasPermission`
- `resolve` correct over N ids, including ids with no binding
- sweep collects an unreferenced asset
- `schema.test.ts` restated to 37 foreign keys / 30 indexes

Two process traps this cluster walks into:

1. Every new test file must be added to `vitest.workspace.ts`'s `include`.
   A file that is not listed is invisible to every run, and `npm run verify`
   stays green without it.
2. `schema.test.ts` is unreachable from any scoped run. The last run before
   merge is the bare `npm run verify`, with the exit code read from the
   process rather than from a summary or a wrapper.

## Versioning

Both published packages change their public surface, and the workspace hides
staleness (every in-repo consumer resolves `*`), so both need a bump and a
republish:

- `@gl3/shared` **0.1.8 -> 0.1.9** — the DTO side of the three view-node
  changes.
- `@gl3/plugin-sdk` **0.1.3 -> 0.1.4** — `providesAssets`, `ctx.assetSlots`,
  `ctx.assets`, and the same view-node changes.

Shared republishes first: `pages.ts` imports values from it, not only types.
Both are additive under `0.x`, so both ship as patches and existing
`^0.1.0` ranges keep resolving.

## Out of scope

Recorded so these are decisions rather than omissions:

- player avatars and all user-generated content
- gang logos
- moderation, reporting, takedown
- thumbnails, resizing, re-encoding
- EXIF stripping
- asset packs and themes
- plugin-bundled default art
- `player_stats.avatar_url` and the M4 migrator, which stay untouched: V2
  stores theme-relative paths to files this project does not have

## Phasing

1. core migration `0012_assets` + `schema.test.ts` restate
2. `StorageDriver` interface + filesystem driver + contract suite
3. upload route + serve route
4. bind route + loader registry
5. SDK manifest field, ctx surface, version bumps
6. view nodes in both packages
7. web renderer: `GameImage`, `image` leaf, image table column, `assetBinder`
8. adopt in exactly two places as proof: `theft` cars and core `items`
9. S3 driver + config + `.env.example`
10. sweep pass
