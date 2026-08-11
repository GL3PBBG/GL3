# Mail Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/server/src/game/mail/routes.ts` into `packages/plugins/mail/` (`@gl3/plugin-mail`) so the four mail routes answer from a plugin, with every status code, error string, response body and the `mail.received` event unchanged.

**Architecture:** Four routes, all served through `ctx.transaction`. One writes (`POST /api/mail`) and publishes `mail.received` via `tx.events.publishCore`; three are read-mostly. The plugin mirrors two core-owned tables (`mail_messages`, `players`) in its own `schema.ts`. No money, no job, no jail gate, no lock ordering — the plainest port since `news`. Mail has no extracted `service.ts` and its tests are entirely `app.inject`, so the cutover is a single commit, not the bullets/bank/crimes prove-then-cutover shape.

**Tech Stack:** TypeScript strict ESM, Fastify, Drizzle ORM, Postgres, Redis, zod, vitest.

**Design:** `docs/superpowers/specs/2026-08-11-plugin-mail-port-design.md`. Read it before Task 1.

## Global Constraints

- **No `any` in `packages/*`** — none, not even a cast. Type guards over casts.
- **ESM only.** Every relative import carries a `.js` extension despite `.ts` sources.
- **A plugin package may import only `@gl3/plugin-sdk`, `zod` and `drizzle-orm`.** Never `@gl3/shared`, never anything under `apps/server`. This is the dependency direction M5 exists to enforce.
- **Publish events only after the transaction commits.** `tx.events.publishCore` buffers; the loader flushes post-commit and discards on rollback. Never publish by hand inside `ctx.transaction(...)`.
- **Tests asserting on `game:events` (or WS frames) must filter by their own actor/recipient.** The channel is global across test files. The mail test already does this via `isMailFor(recipientId)` — keep it.
- **Never run `FLUSHALL` / `FLUSHDB`.** Redis is shared across every test file and every concurrent agent.
- **Run the full suite with `npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"` and treat any non-zero exit as failure even when every test passed.** Piping through `grep`/`tail` discards npm's exit status, and an unhandled rejection makes vitest exit non-zero while still printing a green summary.
- **Never run two full test suites at once.**
- Conventional Commits.

**Environment for every test command:**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
```

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `packages/plugins/mail/package.json` | Package manifest — `@gl3/plugin-mail`, deps `@gl3/plugin-sdk`, `zod`, `drizzle-orm` |
| `packages/plugins/mail/tsconfig.json` | Project reference to `plugin-sdk` |
| `packages/plugins/mail/src/schema.ts` | Drizzle mirrors of the two core-owned tables (`mail_messages`, `players`). No migration, no manifest `tables` entry |
| `packages/plugins/mail/src/index.ts` | The manifest and the four route handlers |

**Modified:**

| Path | Change | Task |
|---|---|---|
| `apps/server/package.json` | `"@gl3/plugin-mail": "*"` | 1 |
| `apps/server/tsconfig.json` | `references` entry. **Fails only in CI** | 1 |
| `tsconfig.json` | `references` entry | 1 |
| `vitest.workspace.ts` | `srcAliases` entry. **Fails nothing** — silently grades src edits against stale `dist/` | 1 |
| `apps/server/src/plugins/core-plugins.ts` | Import + `CORE_PLUGINS` entry | 2 |
| `apps/server/src/app.ts:11,62` | Delete `registerMailRoutes` | 2 |
| `Dockerfile.server` | Five COPY sites + comment lines. **Fails only in CI** | 2 |
| `docs/STATUS.md`, `CLAUDE.md` | Record the port | 2 |

**Deleted (Task 2):** `apps/server/src/game/mail/routes.ts` and the directory.

**Not modified (important — mail's test is unchanged):** `apps/server/test/mail.test.ts`. It is entirely `app.inject`, written against core, and is the proof that the plugin is byte-identical. No `economy-invariant.test.ts` edit either — mail moves no money.

---

### Task 1: The plugin package, registered in the build sites

Creates `@gl3/plugin-mail` and wires it into the four build/test sites and the manifest endpoint. Core still serves the HTTP routes at the end of this task — the plugin is built and typechecked but not yet registered in `CORE_PLUGINS`, so nothing serves its routes. Task 2 is the cutover.

**Read first:** `docs/superpowers/specs/2026-08-11-plugin-mail-port-design.md` §2 (package shape), §3 (the four handlers step by step), §5 (the one wire-shape difference: the 400 carries no `issues` array).

**Files:**
- Create: `packages/plugins/mail/package.json`, `packages/plugins/mail/tsconfig.json`, `packages/plugins/mail/src/schema.ts`, `packages/plugins/mail/src/index.ts`
- Modify: `apps/server/package.json`, `apps/server/tsconfig.json`, `tsconfig.json`, `vitest.workspace.ts`

**Interfaces:**
- Consumes: `definePlugin`, `route`, `PluginError`, `newId` from `@gl3/plugin-sdk`; `ctx.transaction<T>(fn)`, `ctx.player: PlayerSnapshot | null` (with `.id`, `.username`), `tx.events.publishCore(event)`, `tx.db` (the `PluginDbTx` — `select`/`insert`/`update` survive, `.query` does not).
- Produces: default export `mailPlugin: PluginManifest` from `@gl3/plugin-mail`, id `"mail"`, with four routes (`POST /api/mail`, `GET /api/mail`, `GET /api/mail/thread/:threadId`, `POST /api/mail/:mailId/read`). Task 2 imports it in `core-plugins.ts`.

- [ ] **Step 1: Create the package manifest**

`packages/plugins/mail/package.json` — `drizzle-orm` is a dependency here (this plugin has a `schema.ts`), matching `news`/`bullets`/`crimes`. Copy the `drizzle-orm` version from `packages/plugins/news/package.json` exactly (at time of writing `^0.45.2`; confirm before writing).

```json
{
  "name": "@gl3/plugin-mail",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc --build" },
  "dependencies": { "@gl3/plugin-sdk": "*", "drizzle-orm": "^0.45.2", "zod": "^3.23.8" }
}
```

- [ ] **Step 2: Create the tsconfig**

`packages/plugins/mail/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../plugin-sdk" }]
}
```

- [ ] **Step 3: Write the schema mirrors**

`packages/plugins/mail/src/schema.ts`. Types must match `apps/server/src/db/schema/social.ts:74` (`mail_messages`) exactly: `sender_id` is nullable, `recipient_id` is notNull, `read_at` is nullable, `created_at` is notNull with a default. A wrong nullability here is a serialisation/runtime bug, not always a compile error.

```ts
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Mirrors of core-owned tables — this plugin reads/writes `mail_messages` and
 * reads `players` (recipient lookup by username), but owns neither schema.
 * Column names and types match `apps/server/src/db/schema/social.ts` and
 * `identity.ts` exactly, which is what lets `tx.db.select` / `.insert` /
 * `.update` type and serialise correctly. Neither is listed in this plugin's
 * manifest `tables` map and neither gets a migration here: core already owns
 * and migrates both (the pattern `packages/plugins/news/src/schema.ts`
 * established — the loader enforces naming and prefix rules only on tables a
 * manifest *declares*).
 *
 * Only the columns this plugin touches are listed. `mail_messages` has two
 * indexes (`mail_recipient_idx`, `mail_thread_idx`); they affect performance,
 * not correctness or types, and stay core-owned.
 */
export const mailMessages = pgTable("mail_messages", {
  id: uuid("id").primaryKey(),
  threadId: uuid("thread_id").notNull(),
  senderId: uuid("sender_id"),
  recipientId: uuid("recipient_id").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
});
```

- [ ] **Step 4: Write the plugin**

`packages/plugins/mail/src/index.ts`. The step numbers in the POST handler's comments map to design §3.1's table. **Read `apps/server/src/game/mail/routes.ts` first** — this is a line-for-line port, and the two thread-participant checks (including the recipient-side check at `:50-51`) must be preserved verbatim; dropping either fails two tests.

```ts
import { definePlugin, newId, PluginError, route } from "@gl3/plugin-sdk";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { mailMessages, players } from "./schema.js";

/**
 * Ported verbatim from `apps/server/src/game/mail/routes.ts`: paths, status
 * codes, error strings, response bodies and the `mail.received` event are
 * byte-identical. `apps/server/test/mail.test.ts` is unchanged and is the
 * proof (all `app.inject`, written against core).
 *
 * Two deliberate differences (design §3.5, §5):
 *  - `POST`'s re-`select` after insert becomes `.insert(...).returning()` —
 *    same row, one fewer round trip.
 *  - A 400 from a bad body carries `{ error: "invalid_request" }` with no
 *    `issues` array, because the plugin route layer owns body validation
 *    (`apps/server/src/plugins/routes.ts`). Nothing in `@gl3/web` reads
 *    `issues`. Identical to what `news` documented.
 *  - `actorName` comes from `ctx.player.username` — no `players` read for the
 *    sender (core did one at routes.ts:62).
 *
 * `@gl3/shared` is off-limits to a plugin package, so `IdSchema` and
 * `noNulByte` are restated below. The NUL guard is load-bearing: Postgres
 * `text` rejects an embedded NUL outright (SQLSTATE 22021), and
 * `recipientUsername` reaches Postgres as an `eq(players.username, ...)`
 * lookup parameter — so without it, three of mail.test.ts's cases 500 instead
 * of 400.
 */
// Copy `noNulByte` VERBATIM from packages/plugins/news/src/index.ts:31-32
// (the whole two-line declaration, exactly as it appears there). Do NOT
// retype the escape sequence by hand: it must be the six-character literal
// backslash-u-0-0-0-0, never the single NUL character it denotes. A raw NUL
// is invisible, makes the file binary to grep, and will not survive
// copy/paste — the refinement would then accept everything it exists to
// reject. This plan file caught exactly that during its own review. Copy the
// two lines from news/src/index.ts and paste them here, replacing this
// comment block.

const IdSchema = z.string().uuid();

const SendMailBodySchema = z.object({
  recipientUsername: noNulByte(z.string().min(3).max(30)),
  subject: noNulByte(z.string().min(1).max(200)),
  body: noNulByte(z.string().min(1).max(5000)),
  /** Reply within an existing thread; omit to start a new one. */
  threadId: IdSchema.optional(),
});

const MailParamsSchema = z.object({ mailId: IdSchema });
const ThreadParamsSchema = z.object({ threadId: IdSchema });

function toDto(
  row: typeof mailMessages.$inferSelect,
  senderName: string | null,
): Record<string, unknown> {
  return {
    id: row.id, threadId: row.threadId, senderId: row.senderId, senderName,
    recipientId: row.recipientId, subject: row.subject, body: row.body,
    readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  };
}

const sendRoute = route({
  method: "POST",
  path: "/api/mail",
  body: SendMailBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // (2) Resolve the recipient by username. Unlocked read — no row to lock.
      const [recipient] = await tx.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.username, body.recipientUsername));
      if (!recipient) throw new PluginError("recipient_not_found", 404);

      // (3) Thread participation gate. If a threadId is supplied, the sender
      // must already be a participant AND the resolved recipient must be too.
      // The recipient-side check (routes.ts:50-51) closed a real splice defect
      // — its test ("403s replying in a real thread to a recipient who isn't
      // part of it") must keep passing.
      let threadId = body.threadId;
      if (threadId) {
        const [existing] = await tx.db
          .select({ senderId: mailMessages.senderId, recipientId: mailMessages.recipientId })
          .from(mailMessages)
          .where(and(
            eq(mailMessages.threadId, threadId),
            or(eq(mailMessages.senderId, player.id), eq(mailMessages.recipientId, player.id)),
          ));
        if (!existing) throw new PluginError("forbidden", 403);
        const isRecipientParticipant =
          existing.senderId === recipient.id || existing.recipientId === recipient.id;
        if (!isRecipientParticipant) throw new PluginError("forbidden", 403);
      } else {
        // (4) Fresh thread for a new conversation.
        threadId = newId();
      }

      // (5) Insert the message.
      const id = newId();
      const [inserted] = await tx.db
        .insert(mailMessages)
        .values({
          id, threadId, senderId: player.id, recipientId: recipient.id,
          subject: body.subject, body: body.body,
        })
        .returning();

      // (6) Buffered here, published after commit — events are facts, not
      // commands (CLAUDE.md rule 5). `mail.received`'s actor is the sender
      // (packages/shared/src/events.ts:48); audience is the recipient.
      await tx.events.publishCore({
        type: "mail.received",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: recipient.id },
        mailId: id,
        recipientId: recipient.id,
        subject: body.subject,
      });

      // (7) `.returning()` replaces core's post-insert re-select (routes.ts:70).
      return { status: 201, body: toDto(inserted!, player.username) };
    });
  },
});

const inboxRoute = route({
  method: "GET",
  path: "/api/mail",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      const rows = await tx.db
        .select()
        .from(mailMessages)
        .where(eq(mailMessages.recipientId, player.id))
        .orderBy(desc(mailMessages.createdAt));
      const senderIds = [...new Set(rows.map((r) => r.senderId).filter((id): id is string => id !== null))];
      const senders = senderIds.length > 0
        ? await tx.db
            .select({ id: players.id, username: players.username })
            .from(players)
            .where(inArray(players.id, senderIds))
        : [];
      const nameById = new Map(senders.map((s) => [s.id, s.username]));
      return {
        status: 200,
        body: { mail: rows.map((r) => toDto(r, r.senderId ? nameById.get(r.senderId) ?? null : null)) },
      };
    });
  },
});

const threadRoute = route({
  method: "GET",
  path: "/api/mail/thread/:threadId",
  params: ThreadParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { threadId } = params;

    return ctx.transaction(async (tx) => {
      const rows = await tx.db
        .select()
        .from(mailMessages)
        .where(and(
          eq(mailMessages.threadId, threadId),
          or(eq(mailMessages.senderId, player.id), eq(mailMessages.recipientId, player.id)),
        ))
        .orderBy(mailMessages.createdAt);
      // Sender-name resolution is not optional: the thread view's
      // senderName==="Vito" assertion (mail.test.ts:247) was the defect the
      // brief's sample introduced by hardcoding null. Resolve it the same way
      // the inbox does.
      const senderIds = [...new Set(rows.map((r) => r.senderId).filter((id): id is string => id !== null))];
      const senders = senderIds.length > 0
        ? await tx.db
            .select({ id: players.id, username: players.username })
            .from(players)
            .where(inArray(players.id, senderIds))
        : [];
      const nameById = new Map(senders.map((s) => [s.id, s.username]));
      return {
        status: 200,
        body: { mail: rows.map((r) => toDto(r, r.senderId ? nameById.get(r.senderId) ?? null : null)) },
      };
    });
  },
});

const markReadRoute = route({
  method: "POST",
  path: "/api/mail/:mailId/read",
  params: MailParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const { mailId } = params;

    return ctx.transaction(async (tx) => {
      // recipientId = player is the access control: marking someone else's
      // mail read affects zero rows and returns 404, not 200.
      const [updated] = await tx.db
        .update(mailMessages)
        .set({ readAt: new Date() })
        .where(and(eq(mailMessages.id, mailId), eq(mailMessages.recipientId, player.id)))
        .returning({ id: mailMessages.id });
      if (!updated) throw new PluginError("mail_not_found", 404);
      return { status: 204, body: null };
  });
  },
});

export default definePlugin({
  id: "mail",
  version: "1.0.0",
  basePaths: ["/api/mail"],
  routes: [sendRoute, inboxRoute, threadRoute, markReadRoute],
  // No `menu`, `pages` or `events`: plugin-manifest-endpoint.test.ts:87
  // asserts a no-arg boot answers GET /api/plugins with exactly
  // { menu: [], pages: [], events: [] }. No `jobs`: buildApp throws at boot
  // if a core plugin declares any.
});
```

- [ ] **Step 5: Confirm the param-access shape against `crimes`**

The `threadRoute` and `markReadRoute` handlers above destructure params as `(ctx, { params }) => { ... }`, matching the pattern `packages/plugins/crimes/src/index.ts:73-76` uses on its `:crimeId/commit` route (`handler: async (ctx, { params }) => { ...; const { crimeId } = params; }`). Open that file and confirm it still matches before trusting this — the SDK's `route()` signature is the authority, not this plan. If crimes has changed to read params another way, conform the two mail param-handlers to crimes exactly. Do not guess; read the real code.

- [ ] **Step 6: Register the package in the four build/test sites**

All four, in one pass. Two of them fail in ways you will not see locally.

1. `apps/server/package.json` — add to `dependencies`, keeping alphabetical order beside the other `@gl3/plugin-*` entries:

```json
    "@gl3/plugin-mail": "*",
```

2. `apps/server/tsconfig.json` — append to `references` (**this one fails only in CI**), after the crimes/travel entry:

```json
{ "path": "../../packages/plugins/mail" }
```

3. root `tsconfig.json` — append after the `travel` entry at line 12:

```json
    { "path": "./packages/plugins/mail" },
```

4. `vitest.workspace.ts` — append to `srcAliases` after the `@gl3/plugin-travel` entry at line 45 (**this one fails nothing**; without it, the specifier resolves to the gitignored `dist/` and a src-only edit is graded against a stale `tsc --build`):

```ts
      "@gl3/plugin-mail": fileURLToPath(
        new URL("./packages/plugins/mail/src/index.ts", import.meta.url),
      ),
```

Then install:

```bash
npm install
```

- [ ] **Step 7: Verify both silent failure modes are actually closed**

```bash
npx tsc --build --force apps/server/tsconfig.json
```

Expected: exits 0. This is the exact command the image build runs and the only local way to catch a missing `apps/server/tsconfig.json` reference. The plugin is not yet registered in `CORE_PLUGINS`, so nothing serves its routes yet — that is intentional; Task 2 is the cutover.

- [ ] **Step 8: Confirm the manifest-endpoint test still sees an empty core payload**

The plugin is built and installed but not yet in `CORE_PLUGINS`, so `GET /api/plugins` from a no-arg boot must still answer `{ menu: [], pages: [], events: [] }`:

```bash
npx vitest run apps/server/test/plugin-manifest-endpoint.test.ts
```

Expected: PASS. (If it fails, the plugin leaked into `CORE_PLUGINS` somehow — it should not be there yet.)

- [ ] **Step 9: Commit**

```bash
git add packages/plugins/mail apps/server/package.json apps/server/tsconfig.json \
  tsconfig.json vitest.workspace.ts package-lock.json
git commit -m "feat(plugins): add @gl3/plugin-mail

Ports game/mail's four routes to the SDK: mail_messages + players mirrors,
mail.received through publishCore, the two-check thread-participant gate
preserved verbatim (including the recipient-side splice guard), and
senderName from ctx.player.username. No money, no job, no jail gate, no
locks — the plainest port since news.

Built and wired into the four registration sites; not yet registered in
CORE_PLUGINS. Core still serves the four /api/mail routes; the cutover is
the next commit."
```

---

### Task 2: Cut over — the plugin serves the routes, core's module is deleted

**Files:**
- Modify: `apps/server/src/plugins/core-plugins.ts`, `apps/server/src/app.ts:11,62`, `Dockerfile.server`, `docs/STATUS.md`, `CLAUDE.md`
- Delete: `apps/server/src/game/mail/routes.ts` (and the now-empty `game/mail/` directory)

**Interfaces:**
- Consumes: `mailPlugin` (default export of `@gl3/plugin-mail`) from Task 1.
- Produces: the four `/api/mail` routes served by the plugin. `apps/server/src/game/mail/` no longer exists.

- [ ] **Step 1: Register the plugin as a core plugin**

`apps/server/src/plugins/core-plugins.ts` — add the import beside the others (alphabetical, after `crimesPlugin` at line 8):

```ts
import mailPlugin from "@gl3/plugin-mail";
```

and extend the array at line 25:

```ts
export const CORE_PLUGINS: readonly PluginManifest[] = [
  rankPlugin, notificationsPlugin, newsPlugin, bankPlugin, bulletsPlugin, travelPlugin, crimesPlugin,
  mailPlugin,
];
```

- [ ] **Step 2: Prove the cutover would collide — the duplicate-route error on a half-cutover**

Right now (after Step 1) the plugin is registered in `CORE_PLUGINS` but core's `registerMailRoutes` call is **still in `app.ts:62`** and core's `game/mail/routes.ts` still exists. Both register `/api/mail`. Boot the test and watch it fail:

```bash
npx vitest run apps/server/test/mail.test.ts
```

Expected: the suite **fails at boot** with a Fastify duplicate-route error on `/api/mail` (`Method 'POST' already declared for url '/api/mail'` or equivalent). This is the proof the plugin is actually live: if the plugin were inert, core would still serve and the test would pass as it did before Step 1. A green run here means the plugin never registered — stop and find out why before proceeding. **This is the "demand proof a test can fail" step for a cutover** — the failure mode it guards against is a silent no-op where core keeps answering and the plugin is dead code.

- [ ] **Step 3: Unregister core's routes**

`apps/server/src/app.ts` — delete line 11 (`import { registerMailRoutes } from "./game/mail/routes.js";`) and line 62 (`registerMailRoutes(app, deps.db, deps.redis, requireAuth);`). Leaving either in place reproduces the Step 2 failure, so this is not optional. Confirm no other reference to `registerMailRoutes` or `game/mail` remains:

```bash
grep -rn "game/mail\|registerMailRoutes" apps/server/src
```

Expected: no output.

- [ ] **Step 4: Delete core's module**

```bash
git rm apps/server/src/game/mail/routes.ts
rmdir apps/server/src/game/mail 2>/dev/null || true
```

The directory should be empty after removing `routes.ts`; `rmdir` removes it if so. If it is not empty, stop and check what else is there before deleting.

- [ ] **Step 5: Run the unchanged mail test against the plugin-served routes**

```bash
npx vitest run apps/server/test/mail.test.ts
```

Expected: PASS, all ten tests. **This is the moment the port is proven:** the `app.inject` block was written against core and now passes against the plugin with zero edits to the test file. If any test fails, the plugin deviates from core — find the row of design §4 it broke and fix the plugin, not the test. Combined with Step 2's red boot, red→green is the evidence the cutover is real.

- [ ] **Step 6: Update `Dockerfile.server` — five COPY sites and the comment lines**

**This fails only in CI**, and each Dockerfile change costs a full CI round trip. Get all five in one pass, each immediately after its `crimes` neighbour (crimes is the most-recently-added port and the template):

```dockerfile
# after the crimes line at :56
COPY packages/plugins/mail/package.json packages/plugins/mail/
```
```dockerfile
# after the crimes tsconfig/src lines at :80-81
COPY packages/plugins/mail/tsconfig.json packages/plugins/mail/tsconfig.json
COPY packages/plugins/mail/src packages/plugins/mail/src
```
```dockerfile
# after the crimes line at :124
COPY packages/plugins/mail/package.json packages/plugins/mail/
```
```dockerfile
# after the crimes line at :141
COPY --from=builder /app/packages/plugins/mail/dist packages/plugins/mail/dist
```

Then add `@gl3/plugin-mail` to any comment blocks in the Dockerfile that enumerate the plugin packages (search for the existing `@gl3/plugin-crimes` references in comments).

Verify the count before committing — five lines mentioning `packages/plugins/mail` must exist:

```bash
grep -c "packages/plugins/mail" Dockerfile.server
```

Expected: `5` (matching `grep -c "packages/plugins/crimes" Dockerfile.server`, which is `5`).

- [ ] **Step 7: Full verification**

```bash
npx tsc --build --force apps/server/tsconfig.json
npm run verify > /tmp/verify.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. **Read the exit code, not the summary** — an unhandled rejection makes vitest exit non-zero while still printing a green test count. If non-zero, treat it as failure even if every test passed, and find the rejection in `/tmp/verify.log`.

Note the test count for Step 8 (the record step). It should be 587 (mail adds no new test file — its tests already existed) but record the actual figure.

- [ ] **Step 8: Record what shipped**

**`docs/STATUS.md`:**

1. Line 3 — update the date and stage to `2026-08-11, M5 stage 9 (mail port)`.
2. Line 4 — the branch line currently says `feat/plugin-crimes-port`; update to this port's branch.
3. Milestone table row for M5 — change "seven of twelve module ports shipped" to **eight**, and list the four remaining as just `gangs` (one port remains: `gangs`). Actually: after mail, **one** port remains (`gangs`).
4. The suite count line (line 19) — update to the verified figure from Step 7.
5. Add a "The `mail` port (Plan 9)" section after the crimes section, mirroring crimes' shape. Cover:
   - `mail` ported to `packages/plugins/mail`; `apps/server/src/game/mail/` no longer exists; `mail.test.ts`'s `app.inject` block is **unchanged** and is the proof (all-HTTP, no service block, single-commit cutover).
   - Closest analog to `news`: event-driven write, no economy, no job, no jail gate, no locks. No loader change — the first port since `ranks`/`notifications`/`news` to add none.
   - `mail_messages` + `players` mirrors; `senderName` from `ctx.player.username` (no `players` read for the sender); `recipientUsername` lookup via the `players` mirror.
   - The two-check thread-participant gate preserved verbatim, including the recipient-side splice guard (`routes.ts:50-51`) — the regression this route's tests guard.
   - `.returning()` replaces core's post-insert re-select; the 400 carries no `issues` array (plugin route layer property, same as `news`).
   - No lock-order test, deliberately — mail takes no `FOR UPDATE`, only implicit `FOR KEY SHARE` on `players.id` via the FKs. No ABBA surface.
   - No `economy-invariant.test.ts` edit — mail moves no money.
   - One port remains: `gangs`.
6. Update the "Two module ports remain" line at the end of the crimes section (`:507`) — it becomes **one**: `gangs`.

**`CLAUDE.md` "Current state":** change "seven of the twelve `game/*` module ports have shipped (`ranks`, `notifications`, `news`, `bank`, `bullets`, `travel`, `crimes`)" to eight including `mail`, and change "the three remaining ports (`crimes`, `mail`, `gangs`)" to "the one remaining port (`gangs`)". Update the suite count to the verified figure.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(mail): cutover — serve mail from the plugin, delete core path

Registers @gl3/plugin-mail in CORE_PLUGINS, unregisters core's route and
deletes apps/server/src/game/mail/. mail.test.ts is unchanged and passes
against the plugin — the proof the four routes, error strings, response
bodies and the mail.received event are byte-identical. The cutover was
shown failing first (Fastify duplicate-route at boot with both core and
plugin registering /api/mail) before core's route was removed — the proof
the plugin is the one actually serving."
```

---

## Notes for the reviewer

Three things worth checking that a passing suite does not prove:

1. **`ctx.params` access matches the SDK's real shape.** Task 1 Step 5 asks the implementer to confirm against `crimes`. If params are destructured from the handler's second argument (`(ctx, { params })`) rather than read from `ctx.params`, the `threadRoute` and `markReadRoute` handlers need that fix. A passing mail test only proves the handler ran — it does not prove the param access is idiomatic. Confirm it matches crimes.
2. **The two thread-participant checks are both present.** Read the POST handler top to bottom and confirm both the sender-side (`if (!existing) throw forbidden`) and the recipient-side (`if (!isRecipientParticipant) throw forbidden`) checks survive. The recipient-side check is a regression guard for a real splice defect; dropping it fails one test but is the kind of thing a "simplification" could remove.
3. **`grep -c "packages/plugins/mail" Dockerfile.server` is `5`.** A missing COPY fails only in CI, one round trip per attempt. Matching crimes' count is the only local check.
4. **The cutover was shown failing.** Task 2 Step 2 requires it (the duplicate-route boot error with both core and plugin registering `/api/mail`). A green cutover commit that was never shown red does not prove the plugin is the one serving — core could still be answering.
