# Social Cluster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email verification via Resend (hard gate for new players) with password reset, a presence layer + online-users page, clickable player names everywhere, a forum plugin, and an M4 migrator for V2 forum content.

**Architecture:** Verify/reset/presence live in core (`config.ts` env, `auth/` routes, the `requireAuth` choke point every core and plugin route passes through). Forum is a new workspace plugin owning `p_forum_*` tables via plugin migrations. `apps/migrate` gains a forum migrator writing those tables through `id_map`.

**Tech Stack:** TypeScript strict ESM, Fastify, drizzle-orm/postgres, ioredis, zod, React + react-router, vitest. Resend via plain `fetch` — **no new npm dependency**.

**Spec:** `docs/superpowers/specs/2026-08-18-social-cluster-design.md` (this plan argues from it; read both).

## Global Constraints

- No `any` in `packages/*`; `apps/*` prefers `unknown` + zod parse.
- ESM; relative imports carry `.js`.
- Zod on every external boundary, route params included.
- Money never appears in this cluster; ids as uuid strings.
- Never check-then-act on Redis: `SET NX EX`, `GETDEL` only (rule 2).
- Publish/send side effects only after the transaction commits (rule 5).
- New `apps/server/test/*.test.ts` files MUST be added to `vitest.workspace.ts` in the right project's `include` — an unlisted file silently never runs (ninth registration site).
- A new workspace plugin has **eight** registration sites: `packages/plugins/forum/`, `apps/server/package.json` (+ `npm install`), `apps/server/tsconfig.json` references, root `tsconfig.json` references, `vitest.workspace.ts` `srcAliases`, `plugins/core-plugins.ts`, (no old app.ts registration exists for forum — skip), and **five COPY lines in `Dockerfile.server`** (`grep -c "packages/plugins/forum" Dockerfile.server` must print 5).
- `@gl3/shared` in-repo is `0.1.13` (unpublished, other clusters). This cluster's shared changes ship as ONE additive bump applied in Task 1 (to `0.1.14`); do not bump again in later tasks. Do NOT publish to `npm.gl3.dev` without the user's explicit approval.
- No new `GameEvent` variant anywhere. No new explicit lock; forum routes take no locks at all.
- While iterating use `npm run verify:related` / scoped vitest; the merge gate at the end is bare `npm run verify > /tmp/verify.log 2>&1` with the exit code read from the process (`echo "exit=$?"` as a SEPARATE command, never appended with `;`).
- Before ANY integration-suite run: `pgrep -fa vitest` must show nothing foreign and `psql -c "select datname from pg_database where datname like 'gl3_tmpl%'"` nothing unexpected — a concurrent session makes a run void, not failing.
- Commits: Conventional Commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Shared DTO surface (one bump for the whole cluster)

**Files:**
- Modify: `packages/shared/src/dto/auth.ts`
- Create: `packages/shared/src/dto/online.ts`
- Create: `packages/shared/src/dto/forum.ts`
- Modify: `packages/shared/src/dto/profile.ts` (add `lastSeenAt`)
- Modify: `packages/shared/src/dto/bounties.ts` (add player ids — find the exact file with `grep -rn "targetUsername" packages/shared/src/dto/`)
- Modify: `packages/shared/src/index.ts` (export new modules)
- Modify: `packages/shared/package.json` (`0.1.13` → `0.1.14`)
- Test: `packages/shared/test/dto-social.test.ts`

**Interfaces:**
- Produces: `RegisterRequestSchema` (email now **required**), `VerifyRequestSchema { code }`, `ForgotRequestSchema { email }`, `ResetRequestSchema { token, password }`, `OnlineListResponseSchema`, `OnlineEntrySchema`, `ForumListResponseSchema`, `ForumTopicListResponseSchema`, `ForumTopicViewResponseSchema`, `CreateTopicRequestSchema`, `CreatePostRequestSchema`, `ProfileDto.lastSeenAt?: string | null`, bounty rows gain `targetPlayerId`/`placerPlayerId` (IdSchema).

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/dto-social.test.ts
import { describe, expect, it } from "vitest";
import {
  RegisterRequestSchema, VerifyRequestSchema, ForgotRequestSchema,
  ResetRequestSchema, OnlineListResponseSchema, CreateTopicRequestSchema,
  CreatePostRequestSchema,
} from "../src/index.js";

describe("social cluster DTOs", () => {
  it("register requires email and rejects NUL bytes", () => {
    expect(RegisterRequestSchema.safeParse({ username: "abc", password: "12345678" }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ username: "abc", email: "a\u0000b@x.com", password: "12345678" }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ username: "abc", email: "a@x.com", password: "12345678" }).success).toBe(true);
  });
  it("verify code is bounded and NUL-guarded", () => {
    expect(VerifyRequestSchema.safeParse({ code: "ABCD2345EFGH" }).success).toBe(true);
    expect(VerifyRequestSchema.safeParse({ code: "" }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ code: "x".repeat(64) }).success).toBe(false);
  });
  it("forgot/reset shapes", () => {
    expect(ForgotRequestSchema.safeParse({ email: "a@x.com" }).success).toBe(true);
    expect(ResetRequestSchema.safeParse({ token: "t".repeat(12), password: "12345678" }).success).toBe(true);
    expect(ResetRequestSchema.safeParse({ token: "t".repeat(12), password: "short" }).success).toBe(false);
  });
  it("online list entries allow null location", () => {
    const ok = OnlineListResponseSchema.safeParse({
      onlineNow: [{ playerId: "0198c5b1-0000-7000-8000-000000000001", username: "a", locationName: null, lastActiveAt: new Date().toISOString() }],
      lastHour: [],
    });
    expect(ok.success).toBe(true);
  });
  it("forum bodies enforce V2 minimums", () => {
    expect(CreateTopicRequestSchema.safeParse({ subject: "hi", body: "too short? no — subject is" }).success).toBe(false);
    expect(CreateTopicRequestSchema.safeParse({ subject: "subject", body: "long enough body" }).success).toBe(true);
    expect(CreatePostRequestSchema.safeParse({ body: "short" }).success).toBe(false);
    expect(CreatePostRequestSchema.safeParse({ body: "long enough" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/dto-social.test.ts --project @gl3/shared` (from repo root; if "No test files found", check the `@gl3/shared` project's `include` in `vitest.workspace.ts` — shared's project globs `test/**/*.test.ts`, so it should be picked up automatically).
Expected: FAIL — new schemas not defined.

- [ ] **Step 3: Implement**

`packages/shared/src/dto/auth.ts` — change email line and add:

```ts
export const RegisterRequestSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only"),
  // Required since the social cluster: registration hard-gates on verifying
  // this address. noNulByte is explicit — .email()'s regex happens to reject
  // NUL today, but that is an implementation detail, not a guarantee.
  email: noNulByte(z.string().email().max(254)),
  password: z.string().min(8).max(200),
});

export const VerifyRequestSchema = z.object({
  code: noNulByte(z.string().min(1).max(32)),
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

export const ForgotRequestSchema = z.object({
  email: noNulByte(z.string().email().max(254)),
});
export type ForgotRequest = z.infer<typeof ForgotRequestSchema>;

export const ResetRequestSchema = z.object({
  token: noNulByte(z.string().min(1).max(64)),
  password: z.string().min(8).max(200),
});
export type ResetRequest = z.infer<typeof ResetRequestSchema>;
```

`packages/shared/src/dto/online.ts` (new):

```ts
import { z } from "zod";
import { IdSchema } from "../primitives.js";

export const OnlineEntrySchema = z.object({
  playerId: IdSchema,
  username: z.string(),
  /** null when the player stands in an underground town — name shown, town concealed. */
  locationName: z.string().nullable(),
  lastActiveAt: z.string(),
});
export type OnlineEntry = z.infer<typeof OnlineEntrySchema>;

export const OnlineListResponseSchema = z.object({
  onlineNow: z.array(OnlineEntrySchema),
  lastHour: z.array(OnlineEntrySchema),
});
export type OnlineListResponse = z.infer<typeof OnlineListResponseSchema>;
```

`packages/shared/src/dto/forum.ts` (new):

```ts
import { z } from "zod";
import { IdSchema, noNulByte } from "../primitives.js";

export const ForumSchema = z.object({
  id: IdSchema, name: z.string(), sort: z.number().int(),
  topicCount: z.number().int(),
});
export const ForumListResponseSchema = z.object({ forums: z.array(ForumSchema) });
export type ForumListResponse = z.infer<typeof ForumListResponseSchema>;

export const ForumTopicSchema = z.object({
  id: IdSchema,
  subject: z.string(),
  authorId: IdSchema.nullable(),
  authorName: z.string().nullable(),
  status: z.enum(["open", "locked"]),
  type: z.enum(["normal", "sticky"]),
  createdAt: z.string(),
  lastPostAt: z.string(),
  postCount: z.number().int(),
});
export const ForumTopicListResponseSchema = z.object({
  forumId: IdSchema, forumName: z.string(),
  topics: z.array(ForumTopicSchema),
  page: z.number().int(), pageCount: z.number().int(),
});
export type ForumTopicListResponse = z.infer<typeof ForumTopicListResponseSchema>;

export const ForumPostSchema = z.object({
  id: IdSchema,
  authorId: IdSchema.nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export const ForumTopicViewResponseSchema = z.object({
  topic: ForumTopicSchema,
  posts: z.array(ForumPostSchema),
  page: z.number().int(), pageCount: z.number().int(),
});
export type ForumTopicViewResponse = z.infer<typeof ForumTopicViewResponseSchema>;

/** V2 minimums: subject ≥ 6, bodies ≥ 6. */
export const CreateTopicRequestSchema = z.object({
  subject: noNulByte(z.string().min(6).max(120)),
  body: noNulByte(z.string().min(6).max(10_000)),
});
export type CreateTopicRequest = z.infer<typeof CreateTopicRequestSchema>;

export const CreatePostRequestSchema = z.object({
  body: noNulByte(z.string().min(6).max(10_000)),
});
export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;
```

`packages/shared/src/dto/profile.ts`: add to the profile response object schema: `lastSeenAt: z.string().nullable().optional(),` (match the file's existing style; it already exports `ProfileDtoSchema` — check with `grep -n "Schema" packages/shared/src/dto/profile.ts`).

Bounty DTO file (find via `grep -rn "placerUsername" packages/shared/src/`): add `targetPlayerId: IdSchema,` and `placerPlayerId: IdSchema,` alongside the usernames.

`packages/shared/src/index.ts`: add `export * from "./dto/online.js";` and `export * from "./dto/forum.js";` next to the existing dto exports.

`packages/shared/package.json`: `"version": "0.1.14"`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project @gl3/shared`
Expected: PASS, including the pre-existing shared tests (events census untouched — no new event).

- [ ] **Step 5: Typecheck — expect downstream breakage, fix ONLY compile errors**

Run: `npm run typecheck` (bare, then `echo "exit=$?"` separately). The required `email` breaks `apps/server/test/auth.test.ts` registrations and any web register form typing; the bounty id addition breaks the bounties plugin's list route (it must now select and return the ids — do that now: in `packages/plugins/bounties/src/index.ts` list handler, add `targetPlayerId: bounties.target` / `placerPlayerId: bounties.placedBy` to the selected columns and response mapping). Fix compile errors only; behavioural test updates land in their own tasks.

- [ ] **Step 6: Commit**

```bash
git add packages/shared packages/plugins/bounties apps/server apps/web
git commit -m "feat(shared): social cluster DTO surface (0.1.14)"
```

---

### Task 2: Mail driver + config env

**Files:**
- Create: `apps/server/src/mail/driver.ts`
- Modify: `apps/server/src/config.ts`
- Test: `apps/server/test/mail-driver.test.ts` (unit project — no DB/Redis)
- Modify: `vitest.workspace.ts` (`@gl3/server:unit` include + this file)
- Modify: `.env.example` (document the four new vars)

**Interfaces:**
- Produces: `interface MailMessage { to: string; subject: string; text: string }`, `interface MailDriver { send(msg: MailMessage): Promise<boolean> }` (false = send failed, callers treat as non-fatal), `createMailDriver(mail: MailConfig): MailDriver`, `Config.mail: MailConfig` where `interface MailConfig { driver: "log" | "resend"; apiKey: string | null; from: string; appBaseUrl: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/mail-driver.test.ts
import { describe, expect, it, vi } from "vitest";
import { createMailDriver } from "../src/mail/driver.js";
import { loadConfig } from "../src/config.js";

const BASE_ENV = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" };

describe("mail config", () => {
  it("defaults to the log driver with gl3.dev sender", () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.mail).toEqual({ driver: "log", apiKey: null, from: "noreply@gl3.dev", appBaseUrl: "http://localhost:5173" });
  });
  it("rejects resend without an API key at boot", () => {
    expect(() => loadConfig({ ...BASE_ENV, EMAIL_DRIVER: "resend" })).toThrow(/RESEND_API_KEY/);
  });
});

describe("log driver", () => {
  it("resolves true and never throws", async () => {
    const driver = createMailDriver({ driver: "log", apiKey: null, from: "noreply@gl3.dev", appBaseUrl: "http://localhost:5173" });
    await expect(driver.send({ to: "a@x.com", subject: "s", text: "t" })).resolves.toBe(true);
  });
});

describe("resend driver", () => {
  it("POSTs to the Resend API and reports non-2xx as false without throwing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("nope", { status: 422 }));
    const driver = createMailDriver({ driver: "resend", apiKey: "re_123", from: "noreply@gl3.dev", appBaseUrl: "http://localhost:5173" });
    await expect(driver.send({ to: "a@x.com", subject: "s", text: "t" })).resolves.toBe(true);
    await expect(driver.send({ to: "a@x.com", subject: "s", text: "t" })).resolves.toBe(false);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer re_123");
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/mail-driver.test.ts --project @gl3/server:unit`
If "No test files found": add `"test/mail-driver.test.ts"` to the `@gl3/server:unit` include list in `vitest.workspace.ts` FIRST — that error is the ninth-registration-site trap.
Expected: FAIL — module not found / `config.mail` undefined.

- [ ] **Step 3: Implement**

`apps/server/src/config.ts` — add to `EnvSchema`:

```ts
  /** Outbound mail. `log` prints to stdout (dev/test); `resend` POSTs to api.resend.com. */
  EMAIL_DRIVER: z.enum(["log", "resend"]).default("log"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().default("noreply@gl3.dev"),
  /** Web origin used to build links in outbound mail (verify, reset). */
  APP_BASE_URL: z.string().url().default("http://localhost:5173"),
```

Extend the existing `superRefine` (same body, after the asset block):

```ts
  if (env.EMAIL_DRIVER === "resend" && !env.RESEND_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["RESEND_API_KEY"],
      message: "RESEND_API_KEY is required when EMAIL_DRIVER=resend" });
  }
```

Add to `Config`: `mail: MailConfig;` with

```ts
export interface MailConfig {
  driver: "log" | "resend";
  apiKey: string | null;
  from: string;
  appBaseUrl: string;
}
```

and in `loadConfig`'s return:

```ts
    mail: {
      driver: parsed.EMAIL_DRIVER,
      apiKey: parsed.RESEND_API_KEY ?? null,
      from: parsed.EMAIL_FROM,
      appBaseUrl: parsed.APP_BASE_URL.replace(/\/+$/, ""),
    },
```

`apps/server/src/mail/driver.ts` (new):

```ts
import type { MailConfig } from "../config.js";

export interface MailMessage { to: string; subject: string; text: string }

/**
 * `send` resolves `false` on failure rather than throwing: registration and
 * forgot-password must succeed even when the mail provider is down — the
 * player lands on the verify screen with a resend button either way.
 */
export interface MailDriver { send(msg: MailMessage): Promise<boolean> }

export function createMailDriver(mail: MailConfig): MailDriver {
  if (mail.driver === "log") {
    return {
      async send(msg) {
        console.log(`[mail:log] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.text}`);
        return true;
      },
    };
  }
  return {
    async send(msg) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${mail.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from: mail.from, to: [msg.to], subject: msg.subject, text: msg.text }),
        });
        if (!response.ok) {
          console.error(`[mail:resend] ${response.status} ${await response.text().catch(() => "")}`);
          return false;
        }
        return true;
      } catch (err) {
        console.error("[mail:resend] request failed", err);
        return false;
      }
    },
  };
}
```

`.env.example`: append the four vars with one-line comments.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project @gl3/server:unit`
Expected: PASS including `test/config.test.ts` (its existing cases must not break — the new envs all default).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mail apps/server/src/config.ts apps/server/test/mail-driver.test.ts vitest.workspace.ts .env.example
git commit -m "feat(mail): MailDriver with log and resend backends, env config"
```

---

### Task 3: Core migration — `email_verified_at`

**Files:**
- Create: `apps/server/drizzle/0014_email_verified.sql`
- Modify: `apps/server/drizzle/meta/_journal.json`
- Modify: `apps/server/src/db/schema/identity.ts`

**Interfaces:**
- Produces: `players.emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true })` (nullable, no default). Existing rows backfilled non-null.

- [ ] **Step 1: Write the migration**

`apps/server/drizzle/0014_email_verified.sql`:

```sql
ALTER TABLE players ADD COLUMN email_verified_at timestamptz;
--> statement-breakpoint
-- Grandfathering is explicit and total: nobody playing before this migration
-- is ever gated. New registrations insert NULL and verify to clear it.
UPDATE players SET email_verified_at = now();
```

`_journal.json`: append (mirror the `0013` entry's shape, bump `idx` to 14, `tag` `0014_email_verified`, any `when` > the previous entry's).

`identity.ts` (players table): add `emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),` — nullable, matching the file's existing timestamp style.

- [ ] **Step 2: Verify against schema drift guard**

Run: `npx vitest run apps/server/test/schema.test.ts --project @gl3/server:db-only`
Expected: PASS **unchanged** — the column adds no FK and no index, so the counts (FK-by-rule map; 30 non-PK indexes) must not move. If this fails, something else is wrong; do not touch the counts.

- [ ] **Step 3: Sanity-run migrations against a scratch DB**

```bash
psql "$DATABASE_URL" -c "select 1" >/dev/null  # connectivity
npx vitest run apps/server/test/plugin-migrate.test.ts --project @gl3/server:db-only
```
Expected: PASS (template rebuild includes 0014 without error).

- [ ] **Step 4: Commit**

```bash
git add apps/server/drizzle apps/server/src/db/schema/identity.ts
git commit -m "feat(db): players.email_verified_at, backfilled for existing players"
```

---

### Task 4: Verify tokens, unverified flag, session index

**Files:**
- Create: `apps/server/src/auth/verify.ts`
- Modify: `apps/server/src/auth/session.ts`
- Test: `apps/server/test/auth-verify-tokens.test.ts` (redis-only project)
- Modify: `vitest.workspace.ts` (`@gl3/server:redis-only` include)

**Interfaces:**
- Produces (verify.ts): `issueVerifyToken(redis: Redis, playerId: string): Promise<string>` (12-char uppercase Crockford base32, key `emailverify:<token>`, EX 86400), `consumeVerifyToken(redis: Redis, code: string): Promise<string | null>` (uppercases input, GETDEL), `markUnverified(redis: Redis, playerId: string): Promise<void>` (`SET unverified:<id> 1`, no TTL), `clearUnverified(redis, playerId)`, `isUnverified(redis, playerId): Promise<boolean>`, `issueResetToken(redis, playerId): Promise<string>` (`pwreset:<token>`, EX 3600, 32-byte base64url), `consumeResetToken(redis, token): Promise<string | null>`.
- Produces (session.ts): `createSession` additionally `SADD playersessions:<playerId> <token>`; `destroySession(redis, token)` becomes GETDEL + SREM; new `destroyAllSessions(redis: Redis, playerId: string): Promise<void>` (SMEMBERS → DEL each `session:<t>` → DEL the set).

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/auth-verify-tokens.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import {
  issueVerifyToken, consumeVerifyToken, markUnverified, clearUnverified,
  isUnverified, issueResetToken, consumeResetToken,
} from "../src/auth/verify.js";
import { createSession, destroyAllSessions, readSession } from "../src/auth/session.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
afterAll(async () => { await redis.quit(); });

describe("verify tokens", () => {
  it("issues a typeable code and consumes it exactly once, case-insensitively", async () => {
    const playerId = crypto.randomUUID();
    const code = await issueVerifyToken(redis, playerId);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/); // Crockford: no I L O U
    expect(await consumeVerifyToken(redis, code.toLowerCase())).toBe(playerId);
    expect(await consumeVerifyToken(redis, code)).toBeNull(); // single-use
  });
  it("wrong code burns nothing", async () => {
    const playerId = crypto.randomUUID();
    const code = await issueVerifyToken(redis, playerId);
    expect(await consumeVerifyToken(redis, "WRONGWRONG22")).toBeNull();
    expect(await consumeVerifyToken(redis, code)).toBe(playerId);
  });
});

describe("unverified flag", () => {
  it("marks, reads and clears", async () => {
    const playerId = crypto.randomUUID();
    expect(await isUnverified(redis, playerId)).toBe(false);
    await markUnverified(redis, playerId);
    expect(await isUnverified(redis, playerId)).toBe(true);
    await clearUnverified(redis, playerId);
    expect(await isUnverified(redis, playerId)).toBe(false);
  });
});

describe("reset tokens and session teardown", () => {
  it("reset token is single-use", async () => {
    const playerId = crypto.randomUUID();
    const token = await issueResetToken(redis, playerId);
    expect(await consumeResetToken(redis, token)).toBe(playerId);
    expect(await consumeResetToken(redis, token)).toBeNull();
  });
  it("destroyAllSessions kills every session of the player", async () => {
    const playerId = crypto.randomUUID();
    const t1 = await createSession(redis, playerId, 60);
    const t2 = await createSession(redis, playerId, 60);
    await destroyAllSessions(redis, playerId);
    expect(await readSession(redis, t1)).toBeNull();
    expect(await readSession(redis, t2)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Add `"test/auth-verify-tokens.test.ts"` to `@gl3/server:redis-only`'s include in `vitest.workspace.ts`, then:
Run: `npx vitest run apps/server/test/auth-verify-tokens.test.ts --project @gl3/server:redis-only`
Expected: FAIL — `../src/auth/verify.js` not found.

- [ ] **Step 3: Implement**

`apps/server/src/auth/verify.ts` (new):

```ts
import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

/** Crockford base32 — unambiguous when read from an email and typed back. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i]! % 32];
  return code;
}

const verifyKey = (code: string): string => `emailverify:${code}`;
const VERIFY_TTL_SECONDS = 86_400;

export async function issueVerifyToken(redis: Redis, playerId: string): Promise<string> {
  const code = generateCode();
  await redis.set(verifyKey(code), playerId, "EX", VERIFY_TTL_SECONDS);
  return code;
}

/**
 * GETDEL, not GET+compare (rule 2): the token IS the lookup key, so a wrong
 * code deletes nothing and a right one can only ever be redeemed once.
 */
export async function consumeVerifyToken(redis: Redis, code: string): Promise<string | null> {
  const normalized = code.trim().toUpperCase();
  if (!/^[0-9A-Z]{1,32}$/.test(normalized)) return null;
  return redis.getdel(verifyKey(normalized));
}

/**
 * Present exactly while a player may not play. No TTL: verification is the
 * only exit. Login re-asserts it from the DB row, so a Redis flush heals on
 * the next login instead of silently unlocking unverified accounts forever.
 */
const unverifiedKey = (playerId: string): string => `unverified:${playerId}`;

export async function markUnverified(redis: Redis, playerId: string): Promise<void> {
  await redis.set(unverifiedKey(playerId), "1");
}
export async function clearUnverified(redis: Redis, playerId: string): Promise<void> {
  await redis.del(unverifiedKey(playerId));
}
export async function isUnverified(redis: Redis, playerId: string): Promise<boolean> {
  return (await redis.exists(unverifiedKey(playerId))) === 1;
}

const resetKey = (token: string): string => `pwreset:${token}`;
const RESET_TTL_SECONDS = 3_600;

export async function issueResetToken(redis: Redis, playerId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await redis.set(resetKey(token), playerId, "EX", RESET_TTL_SECONDS);
  return token;
}
export async function consumeResetToken(redis: Redis, token: string): Promise<string | null> {
  if (token.length === 0 || token.length > 64) return null;
  return redis.getdel(resetKey(token));
}
```

`apps/server/src/auth/session.ts` — change to:

```ts
const sessionsOf = (playerId: string): string => `playersessions:${playerId}`;

export async function createSession(redis: Redis, playerId: string, ttlSeconds: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await redis.set(key(token), playerId, "EX", ttlSeconds);
  // Reverse index for destroyAllSessions. Members may outlive their session
  // key (TTL passes, logout of a different device) — consumers tolerate that.
  await redis.sadd(sessionsOf(playerId), token);
  return token;
}

export async function destroySession(redis: Redis, token: string): Promise<void> {
  const playerId = await redis.getdel(key(token));
  if (playerId) await redis.srem(sessionsOf(playerId), token);
}

/** Password reset: every device logs out, not just the one that reset. */
export async function destroyAllSessions(redis: Redis, playerId: string): Promise<void> {
  const tokens = await redis.smembers(sessionsOf(playerId));
  if (tokens.length > 0) await redis.del(...tokens.map((t) => key(t)));
  await redis.del(sessionsOf(playerId));
}
```

(`readSession`, ticket helpers unchanged.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project @gl3/server:redis-only`
Expected: PASS (including the pre-existing cooldown/rate-limit files).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth vitest.workspace.ts apps/server/test/auth-verify-tokens.test.ts
git commit -m "feat(auth): verify/reset tokens, unverified flag, session reverse index"
```

---

### Task 5: Registration + gate + verify routes

**Files:**
- Modify: `apps/server/src/auth/routes.ts`
- Modify: `apps/server/src/app.ts` (pass the mail driver in; check `buildApp`'s deps type — add `mail?: MailDriver`, defaulting to `createMailDriver(config.mail)`)
- Test: `apps/server/test/auth-verify.test.ts` (default `@gl3/server` project)
- Modify: `vitest.workspace.ts` (default project include)
- Modify: `apps/server/test/auth.test.ts` (registrations now need `email`; existing players in fixtures are pre-backfill-style — create via SQL where needed)

**Interfaces:**
- Consumes: Task 2 `MailDriver`, Task 4 helpers.
- Produces: `POST /api/auth/verify { code }` → `200 {}` / `400 invalid_code`; `POST /api/auth/verify/resend` (auth) → `200 {}` / already-verified `409 already_verified`; 403 `email_unverified` from `requireAuth` for gated players outside the exempt set; `registerAuthRoutes` signature gains a `mail: MailDriver` parameter.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/auth-verify.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestServer, type TestServer } from "./helpers/boot.js"; // match the helper name used by test/auth.test.ts — read that file first and copy its boot pattern exactly
import { sql } from "drizzle-orm";

let server: TestServer;
beforeAll(async () => { server = await bootTestServer(); });
afterAll(async () => { await server.close(); });

/** The log mail driver prints codes; tests read the token straight from Redis instead. */
async function verifyCodeFor(playerId: string): Promise<string> {
  // scan for emailverify:* pointing at playerId — the code IS the key suffix
  const keys = await server.redis.keys("emailverify:*");
  for (const k of keys) {
    if ((await server.redis.get(k)) === playerId) return k.slice("emailverify:".length);
  }
  throw new Error("no verify token found");
}

describe("email verification hard gate", () => {
  it("registers with email, is gated, verifies, plays", async () => {
    const register = await server.inject({ method: "POST", url: "/api/auth/register",
      payload: { username: `v_${Date.now()}`, email: `v${Date.now()}@x.com`, password: "password123" } });
    expect(register.statusCode).toBe(201);
    const { token, playerId } = register.json();

    // gated: a game route 403s with the specific code
    const gated = await server.inject({ method: "GET", url: "/api/notifications", headers: { authorization: `Bearer ${token}` } });
    expect(gated.statusCode).toBe(403);
    expect(gated.json().error).toBe("email_unverified");

    // exempt: me still answers
    const me = await server.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);

    const code = await verifyCodeFor(playerId);
    const verify = await server.inject({ method: "POST", url: "/api/auth/verify", payload: { code } });
    expect(verify.statusCode).toBe(200);

    const after = await server.inject({ method: "GET", url: "/api/notifications", headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(200);
  });

  it("verify code is single-use", async () => { /* register, verify once 200, verify again 400 invalid_code */ });

  it("registration without email is a 400", async () => {
    const r = await server.inject({ method: "POST", url: "/api/auth/register",
      payload: { username: `x_${Date.now()}`, password: "password123" } });
    expect(r.statusCode).toBe(400);
  });

  it("grandfathered player (email_verified_at set) is never gated", async () => {
    // register+verify a player, then null the flag paths: simulate legacy by
    // updating email_verified_at directly and re-logging-in
  });

  it("login re-asserts the unverified flag after a Redis flush of the key", async () => {
    // register (unverified), DEL unverified:<id> manually, login again,
    // expect game route 403 again — the DB row is the source of truth
  });
});
```

Fill the sketched bodies with real code following the first case's pattern; read `apps/server/test/auth.test.ts` first and reuse its boot helper and any fixture util verbatim.

- [ ] **Step 2: Register the file and watch it fail**

Add `"test/auth-verify.test.ts"` to the default `@gl3/server` project include. Run it; expect FAIL (no verify route, no gate, register 400s on the now-required email in existing fixtures).

- [ ] **Step 3: Implement**

In `auth/routes.ts`:

1. Signature: `registerAuthRoutes(app, config, db, redis, mail: MailDriver, rateLimitPrefix = ...)` — update the caller in `app.ts` (`registerAuthRoutes(app, deps.config, deps.db, deps.redis, deps.mail ?? createMailDriver(deps.config.mail))`; add `mail?: MailDriver` to `buildApp`'s deps interface).
2. `requireAuth` becomes:

```ts
const GATE_EXEMPT = ["/api/auth/verify", "/api/auth/logout", "/api/auth/me"];

const requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const token = bearer(request);
  const playerId = token ? await readSession(redis, token) : null;
  if (!playerId) { await reply.code(401).send({ error: "unauthorized" }); return; }
  const url = request.url.split("?")[0] ?? request.url;
  if (!GATE_EXEMPT.some((p) => url === p || url.startsWith(`${p}/`))) {
    if (await isUnverified(redis, playerId)) {
      await reply.code(403).send({ error: "email_unverified" }); return;
    }
  }
  request.playerId = playerId;
};
```

3. Register route: `email: parsed.data.email` (no longer `?? null`); after the transaction commits and before replying:

```ts
    // Post-commit, like events (rule 5): a mail failure must not unwind the row.
    await markUnverified(redis, playerId);
    const code = await issueVerifyToken(redis, playerId);
    await mail.send({
      to: parsed.data.email, subject: "Verify your GL3 account",
      text: `Your verification code is ${code}\n\nOr click: ${config.mail.appBaseUrl}/verify?code=${code}\n\nThe code expires in 24 hours.`,
    });
```

4. Login route, after `authenticated` and before `createSession`:

```ts
    // Redis is a cache of the gate, the row is the truth: a flushed flag
    // re-asserts here, and a verified player never re-acquires it.
    if (player.emailVerifiedAt === null && player.email !== null) {
      await markUnverified(redis, player.id);
    } else {
      await clearUnverified(redis, player.id);
    }
```

Note: `player.email === null` (pre-cluster account that never set one) counts as grandfathered → `clearUnverified`. The backfill made those verified anyway; this is belt-and-braces.

5. New routes:

```ts
  app.post("/api/auth/verify", {
    preHandler: tokenBucket(redis, { name: "verify", limit: 10, windowSeconds: 900 }, rateLimitPrefix),
  }, async (request, reply) => {
    const parsed = VerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const playerId = await consumeVerifyToken(redis, parsed.data.code);
    if (!playerId) return reply.code(400).send({ error: "invalid_code" });
    await db.update(players).set({ emailVerifiedAt: sql`now()` }).where(eq(players.id, playerId));
    await clearUnverified(redis, playerId);
    return reply.code(200).send({});
  });

  app.post("/api/auth/verify/resend", {
    preHandler: [tokenBucket(redis, { name: "verifyresend", limit: 3, windowSeconds: 3600 }, rateLimitPrefix), requireAuth],
  }, async (request, reply) => {
    const playerId = request.playerId!;
    const [row] = await db.select({ email: players.email, verifiedAt: players.emailVerifiedAt })
      .from(players).where(eq(players.id, playerId));
    if (!row?.email) return reply.code(409).send({ error: "no_email" });
    if (row.verifiedAt !== null) return reply.code(409).send({ error: "already_verified" });
    const code = await issueVerifyToken(redis, playerId);
    await mail.send({ to: row.email, subject: "Verify your GL3 account",
      text: `Your verification code is ${code}\n\nOr click: ${config.mail.appBaseUrl}/verify?code=${code}` });
    return reply.code(200).send({});
  });
```

6. Update `apps/server/test/auth.test.ts`: every register payload gains an email; where a test logs in and exercises game routes, verify first via the Redis-token trick (extract `verifyCodeFor` into `test/helpers/verify.ts` and share it), or create players through existing SQL fixtures that set `email_verified_at = now()`. Other test files that register via HTTP have the same need — sweep with `grep -rln "api/auth/register" apps/server/test/` and fix each (most use SQL fixtures and are unaffected).

- [ ] **Step 4: Run the auth tests**

Run: `npx vitest run apps/server/test/auth.test.ts apps/server/test/auth-verify.test.ts --project @gl3/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server vitest.workspace.ts
git commit -m "feat(auth): email verification hard gate for new players"
```

---

### Task 6: Password reset routes

**Files:**
- Modify: `apps/server/src/auth/routes.ts`
- Test: `apps/server/test/auth-reset.test.ts` (default project; register in workspace include)

**Interfaces:**
- Consumes: Task 4 `issueResetToken`/`consumeResetToken`/`destroyAllSessions`, Task 2 `MailDriver`.
- Produces: `POST /api/auth/forgot { email }` → always `200 {}`; `POST /api/auth/reset { token, password }` → `200 {}` / `400 invalid_token`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/auth-reset.test.ts — same boot pattern as auth-verify.test.ts
describe("password reset", () => {
  it("forgot returns 200 for unknown and known emails alike", async () => { /* both inject calls expect 200 */ });
  it("verified player can reset; old password dies, sessions die", async () => {
    // register+verify, login twice (two tokens), forgot, read pwreset:* token
    // from Redis (same trick as verifyCodeFor), reset with new password,
    // expect: old tokens 401 on /api/auth/me, old password 401 on login,
    // new password 200 on login
  });
  it("unverified email receives no reset token", async () => {
    // register (do NOT verify), forgot with that email,
    // expect no pwreset:* key pointing at the playerId
  });
  it("reset token is single-use", async () => { /* second reset with same token → 400 */ });
});
```

Write each body out fully — the comments above name every step and expected status.

- [ ] **Step 2: Register + run, expect FAIL** (routes don't exist).

- [ ] **Step 3: Implement** — in `auth/routes.ts`:

```ts
  app.post("/api/auth/forgot", {
    preHandler: tokenBucket(redis, { name: "forgot", limit: 5, windowSeconds: 3600 }, rateLimitPrefix),
  }, async (request, reply) => {
    const parsed = ForgotRequestSchema.safeParse(request.body);
    // Every path answers 200 with the same body: the response must not reveal
    // whether the email exists (account enumeration).
    if (!parsed.success) return reply.code(200).send({});
    const [row] = await db.select({ id: players.id, verifiedAt: players.emailVerifiedAt })
      .from(players).where(eq(players.email, parsed.data.email));
    if (row && row.verifiedAt !== null) {
      const token = await issueResetToken(redis, row.id);
      await mail.send({ to: parsed.data.email, subject: "Reset your GL3 password",
        text: `Reset link: ${config.mail.appBaseUrl}/reset?token=${token}\n\nThe link expires in 1 hour. If you didn't ask for this, ignore it.` });
    }
    return reply.code(200).send({});
  });

  app.post("/api/auth/reset", {
    preHandler: tokenBucket(redis, { name: "reset", limit: 10, windowSeconds: 900 }, rateLimitPrefix),
  }, async (request, reply) => {
    const parsed = ResetRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const playerId = await consumeResetToken(redis, parsed.data.token);
    if (!playerId) return reply.code(400).send({ error: "invalid_token" });
    const passwordHash = await hashPassword(parsed.data.password);
    await db.update(players).set({ passwordHash, legacyPasswordSha256: null }).where(eq(players.id, playerId));
    await destroyAllSessions(redis, playerId);
    return reply.code(200).send({});
  });
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run apps/server/test/auth-reset.test.ts --project @gl3/server
git add apps/server vitest.workspace.ts
git commit -m "feat(auth): password reset via emailed single-use token"
```

---

### Task 7: Presence write path

**Files:**
- Create: `apps/server/src/presence/touch.ts`
- Modify: `apps/server/src/auth/routes.ts` (call from `requireAuth`)
- Test: `apps/server/test/presence.test.ts` (default project — needs DB + Redis)

**Interfaces:**
- Produces: `touchPresence(redis: Redis, db: Db, playerId: string, now?: Date): Promise<void>`; Redis ZSET `presence` (score = epoch ms); guard key `lastseenmark:<playerId>` EX 60; DB write to `players.last_seen_at` at most once per guard window. Constant `PRESENCE_KEY = "presence"` exported for the read side.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/presence.test.ts
import { touchPresence, PRESENCE_KEY } from "../src/presence/touch.js";
describe("touchPresence", () => {
  it("ZADDs the player and stamps last_seen_at once per window", async () => {
    // create player via SQL fixture; call touchPresence twice;
    // expect ZSCORE presence <id> ≈ now, and exactly ONE last_seen_at value
    // (capture after first call, assert unchanged after second)
  });
  it("authenticated request touches presence", async () => {
    // boot server, register+verify+login, GET /api/auth/me,
    // expect ZSCORE presence <playerId> non-null
  });
});
```

Write both bodies fully (fixture pattern from any db test file, e.g. `test/money-ranks.test.ts`).

- [ ] **Step 2: Register + run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// apps/server/src/presence/touch.ts
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { players } from "../db/schema/index.js";

export const PRESENCE_KEY = "presence";

/**
 * Called on every authenticated request. The ZADD is unconditional and cheap;
 * the DB stamp is throttled by SET NX EX — the NX *outcome* is the decision
 * (rule 2), so concurrent requests agree without a read.
 */
export async function touchPresence(redis: Redis, db: Db, playerId: string, now = new Date()): Promise<void> {
  await redis.zadd(PRESENCE_KEY, now.getTime(), playerId);
  const marked = await redis.set(`lastseenmark:${playerId}`, "1", "EX", 60, "NX");
  if (marked === "OK") {
    await db.update(players).set({ lastSeenAt: now }).where(eq(players.id, playerId));
  }
}
```

Check `players.lastSeenAt` exists in `identity.ts` (survey says line 48) — if the drizzle property is named differently, match it.

In `requireAuth` (auth/routes.ts), immediately after the session resolves to a `playerId` and BEFORE the unverified-gate check — presence means "authenticated activity", and a player sitting on the verify screen is online:

```ts
  await touchPresence(redis, db, playerId);
```

`registerAuthRoutes` already receives `db`.

- [ ] **Step 4: Run + commit**

```bash
npx vitest run apps/server/test/presence.test.ts --project @gl3/server
git add apps/server vitest.workspace.ts
git commit -m "feat(presence): heartbeat ZSET + throttled last_seen_at in requireAuth"
```

---

### Task 8: `GET /api/online` + underground hiding + profile lastSeenAt

**Files:**
- Create: `apps/server/src/presence/routes.ts`
- Modify: `apps/server/src/app.ts` (register)
- Modify: `apps/server/src/game/profile/routes.ts` (add `lastSeenAt` to the response; add tokenBucket rate limit to the public route — closes the watch item)
- Test: `apps/server/test/online.test.ts`

**Interfaces:**
- Consumes: `PRESENCE_KEY` (Task 7), `OnlineListResponse` shape (Task 1).
- Produces: `registerPresenceRoutes(app: FastifyInstance, db: Db, redis: Redis, requireAuth): void` → `GET /api/online`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/online.test.ts
describe("GET /api/online", () => {
  it("splits 5-minute and 1-hour windows and trims older entries", async () => {
    // Seed ZADD presence directly: playerA now, playerB now-10min, playerC now-2h
    // (players created via SQL fixture with usernames + locations).
    // Expect: A in onlineNow, B in lastHour, C absent; ZCARD shows C trimmed.
  });
  it("conceals the town of a player standing in an underground location", async () => {
    // UPDATE locations SET combat_mode='underground' WHERE id=<B's town>;
    // expect B.locationName === null while A.locationName is the town name.
  });
  it("profile exposes lastSeenAt and the public route is rate-limited", async () => {
    // GET /api/players/:id/profile returns lastSeenAt;
    // hammer the route past the bucket limit, expect a 429.
  });
});
```

- [ ] **Step 2: Register + run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// apps/server/src/presence/routes.ts
import { inArray, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { locations, players } from "../db/schema/index.js";
import { PRESENCE_KEY } from "./touch.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export function registerPresenceRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/online", { preHandler: requireAuth }, async (_request, reply) => {
    const now = Date.now();
    // Lazy trim — no cron, mirrors ensureCurrentRound's settle-at-read shape.
    await redis.zremrangebyscore(PRESENCE_KEY, "-inf", now - ONE_HOUR_MS);
    const flat = await redis.zrangebyscore(PRESENCE_KEY, now - ONE_HOUR_MS, "+inf", "WITHSCORES");

    const scores = new Map<string, number>();
    for (let i = 0; i < flat.length; i += 2) scores.set(flat[i]!, Number(flat[i + 1]));
    const ids = [...scores.keys()];
    if (ids.length === 0) return reply.send({ onlineNow: [], lastHour: [] });

    const rows = await db.select({
      id: players.id, username: players.username,
      locationName: locations.name, combatMode: locations.combatMode,
    }).from(players)
      .leftJoin(locations, eq(players.locationId, locations.id))
      .where(inArray(players.id, ids));
    // NOTE: check the actual location column name on players (grep identity.ts
    // for locationId; combat/travel read it) and adjust the join if it differs.

    const entries = rows.map((row) => ({
      playerId: row.id, username: row.username,
      // Underground towns conceal residents (combat-modes spec); name and
      // recency still list — the town is what disappears.
      locationName: row.combatMode === "underground" ? null : row.locationName,
      lastActiveAt: new Date(scores.get(row.id)!).toISOString(),
    })).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

    return reply.send({
      onlineNow: entries.filter((e) => scores.get(e.playerId)! >= now - FIVE_MINUTES_MS),
      lastHour: entries.filter((e) => scores.get(e.playerId)! < now - FIVE_MINUTES_MS),
    });
  });
}
```

`app.ts`: `registerPresenceRoutes(app, deps.db, deps.redis, requireAuth);` next to the other core route registrations.

`game/profile/routes.ts`: add `lastSeenAt: players.lastSeenAt` to the select and `lastSeenAt: row.lastSeenAt?.toISOString() ?? null` to the response; wrap the GET route with `preHandler: tokenBucket(redis, { name: "profile", limit: 60, windowSeconds: 60 }, rateLimitPrefix)` — this route currently takes no `redis` param, so extend `registerProfileRoutes(app, db, requireAuth)` to accept `redis` and update the `app.ts` call.

- [ ] **Step 4: Run + commit**

```bash
npx vitest run apps/server/test/online.test.ts --project @gl3/server
git add apps/server vitest.workspace.ts
git commit -m "feat(presence): online list with underground concealment; profile lastSeenAt + rate limit"
```

---

### Task 9: M4 — `email_verified_at` for migrated players

**Files:**
- Modify: `apps/migrate/src/migrators/players.ts`
- Test: extend the existing players migrator test (find with `ls apps/migrate/test/ | grep -i player`)

**Interfaces:**
- Consumes: V2 `U_status` (1 = active, 2 = awaiting validation).
- Produces: migrated players get `email_verified_at = now()` when `U_status = 1` (or any non-2 status), `NULL` when `U_status = 2`.

- [ ] **Step 1: Failing test** — in the players migrator test, add a fixture row with `U_status = 2` and one with `U_status = 1`; assert the Postgres rows land with `email_verified_at` NULL / non-NULL respectively.
- [ ] **Step 2: Run** (`cd apps/migrate` context; needs `MYSQL_ADMIN_URL` + `DATABASE_URL` + `REDIS_URL` exported — without `MYSQL_ADMIN_URL` the whole project fails on a missing env var, which is not a real failure). Expect FAIL.
- [ ] **Step 3: Implement** — in `players.ts`, add to the inserted values: `emailVerifiedAt: row.U_status === 2 ? null : new Date()`. The drizzle handle for `players` comes from `apps/server` schema (already imported there) — it gained the column in Task 3.
- [ ] **Step 4: Run the migrate test file + commit** `feat(migrate): map V2 U_status to email_verified_at`.

---

### Task 10: Web — verify, forgot, reset pages + 403 handling

**Files:**
- Create: `apps/web/src/pages/Verify.tsx`, `apps/web/src/pages/Forgot.tsx`, `apps/web/src/pages/Reset.tsx`
- Modify: `apps/web/src/App.tsx` (routes — check whether an auth-screen route group exists outside `<Shell>`; login/register live somewhere, put these siblings to them)
- Modify: `apps/web/src/api/client.ts` (403 `email_unverified` → redirect to `/verify`, mirroring however 401 is handled today — read the file's consumers first: `grep -rn "ApiError" apps/web/src | grep 401`)
- Modify: `apps/web/src/lib/errors.ts` (copy for `email_unverified`, `invalid_code`, `already_verified`, `invalid_token`, `no_email`)
- Modify: register/login page — registration form gains a required email field; login page links "Forgot password?"

**Interfaces:**
- Consumes: `POST /api/auth/verify|verify/resend|forgot|reset` (Tasks 5–6).

- [ ] **Step 1: Read the existing auth pages** (`grep -rln "api/auth/register" apps/web/src/pages`) and copy their form/mutation idiom exactly.
- [ ] **Step 2: Implement pages.** `Verify.tsx`: reads `?code=` (`useSearchParams`), auto-submits when present, paste field + "Resend email" button + logout link; success → navigate to `/`. `Forgot.tsx`: one email field, always shows "If that address is registered, a reset link is on its way." `Reset.tsx`: reads `?token=`, two password fields (match + min 8), success → navigate to login with a "password changed, log in" note.
- [ ] **Step 3: Wire 403 handling** — in the api client, `throw`-site or a caller-level handler (follow the existing 401 pattern): `if (error.status === 403 && error.code === "email_unverified") window.location.assign("/verify")`.
- [ ] **Step 4: Manual check via dev server if practical; then typecheck**: `npm run typecheck` bare. `@gl3/web` vitest project must stay green: `npx vitest run --project @gl3/web`.
- [ ] **Step 5: Commit** `feat(web): verify, forgot and reset pages; email required at registration`.

---

### Task 11: Web — PlayerLink + Online page + nav

**Files:**
- Create: `apps/web/src/components/PlayerLink.tsx`
- Create: `apps/web/src/pages/Online.tsx`
- Modify: `apps/web/src/App.tsx` (`<Route path="online" element={<Online />} />`), `apps/web/src/components/Shell.tsx` (`LINKS` gains `["/online", "Online"]` — read how LINKS is declared and match)
- Modify: `apps/web/src/pages/Combat.tsx` (:122 area), `Bounties.tsx` (:67,70), `News.tsx` (:26), `Gang.tsx` (:317 — replace inline Link), plus hospital/jail roster renderings if they show usernames (`grep -rn "username" apps/web/src/pages/Hospital.tsx apps/web/src/pages/Jail.tsx`)
- Modify: `apps/web/src/api/queries.ts` (add `useOnline` query, 30s refetch)

**Interfaces:**
- Produces: `PlayerLink({ playerId, username }: { playerId: string; username: string })`.

- [ ] **Step 1: Implement PlayerLink**

```tsx
import { Link } from "react-router-dom";

/** Every player name in the app routes to the profile — V2's profile links, GL3-wide. */
export function PlayerLink({ playerId, username }: { playerId: string; username: string }): JSX.Element {
  return <Link to={`/players/${playerId}`}>{username}</Link>;
}
```

- [ ] **Step 2: Online page** — two sections ("Online now", "Active in the last hour"), each a list of `PlayerLink` + location (render "—" for null locationName; do NOT label it "hidden" — concealment shouldn't advertise itself) + relative time. Follow News.tsx's fetch/render idiom.
- [ ] **Step 3: Apply PlayerLink at every listed site.** Bounties now has ids (Task 1). News: `authorId` nullable — plain text fallback when null.
- [ ] **Step 4: Typecheck + web tests + commit** `feat(web): online page and clickable player names everywhere`.

---

### Task 12: Forum plugin — package, migrations, read routes

**Files:**
- Create: `packages/plugins/forum/package.json`, `tsconfig.json`, `src/index.ts`, `src/migrations.ts`, `src/schema.ts`
- Modify (registration sites): `apps/server/package.json` (+`npm install`), `apps/server/tsconfig.json`, root `tsconfig.json`, `vitest.workspace.ts` `srcAliases`, `apps/server/src/plugins/core-plugins.ts`, `Dockerfile.server` (five COPY lines — grep for `packages/plugins/theft` and mirror each of its five occurrences)
- Test: `apps/server/test/forum.test.ts`

**Interfaces:**
- Produces: plugin id `forum`, `basePaths: ["/api/forum", "/api/admin/forum"]`; tables `p_forum_forums`, `p_forum_topics`, `p_forum_posts`; routes `GET /api/forum`, `GET /api/forum/:forumId/topics?page=`, `GET /api/forum/topics/:topicId?page=`. `FORUM_MIGRATIONS` exported from `src/migrations.ts`. Page size constant `PAGE_SIZE = 20`.

- [ ] **Step 1: Scaffold package** — copy `packages/plugins/bounties/package.json` and `tsconfig.json`, rename to `@gl3/plugin-forum`, prune deps to `@gl3/plugin-sdk`, `drizzle-orm`, `uuidv7`, `zod`. Complete ALL registration sites now; verify with `npx tsc --build --force apps/server/tsconfig.json` and `grep -c "packages/plugins/forum" Dockerfile.server` (expect 5).

- [ ] **Step 2: Migrations**

```ts
// packages/plugins/forum/src/migrations.ts
// One statement per migration — runPluginMigrations issues exactly one
// tx.execute per entry (the constraint bounties' migrations.ts documents).
export const FORUM_MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_forums",
    sql: `CREATE TABLE p_forum_forums (
      id   uuid PRIMARY KEY,
      name text NOT NULL,
      sort integer NOT NULL DEFAULT 0
    )`,
  },
  {
    name: "0002_topics",
    sql: `CREATE TABLE p_forum_topics (
      id           uuid PRIMARY KEY,
      forum_id     uuid NOT NULL REFERENCES p_forum_forums(id) ON DELETE CASCADE,
      author_id    uuid REFERENCES players(id) ON DELETE SET NULL,
      subject      text NOT NULL,
      status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked')),
      type         text NOT NULL DEFAULT 'normal' CHECK (type IN ('normal', 'sticky')),
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_post_at timestamptz NOT NULL DEFAULT now(),
      post_count   integer NOT NULL DEFAULT 0
    )`,
  },
  {
    name: "0003_topics_listing_idx",
    sql: `CREATE INDEX p_forum_topics_listing_idx ON p_forum_topics (forum_id, type, last_post_at DESC)`,
  },
  {
    name: "0004_posts",
    sql: `CREATE TABLE p_forum_posts (
      id         uuid PRIMARY KEY,
      topic_id   uuid NOT NULL REFERENCES p_forum_topics(id) ON DELETE CASCADE,
      author_id  uuid REFERENCES players(id) ON DELETE SET NULL,
      body       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: "0005_posts_topic_idx",
    sql: `CREATE INDEX p_forum_posts_topic_idx ON p_forum_posts (topic_id, created_at)`,
  },
];
```

Rule-6 note for the code comment: author/parent FKs take FOR KEY SHARE on insert; no forum route takes an explicit lock, so there is no ordering to invert and deliberately no lock-order test.

- [ ] **Step 3: Schema mirror** (`src/schema.ts`) — drizzle handles for the three tables plus mirrored `players` (id, username) — copy the mirror pattern and its comment from `packages/plugins/bounties/src/schema.ts`.

- [ ] **Step 4: Failing test**

```ts
// apps/server/test/forum.test.ts — boot via bootTestServer (plugin migrations run through the loader)
describe("forum reads", () => {
  it("lists forums with topic counts", async () => { /* seed a forum + 2 topics via SQL, GET /api/forum, expect topicCount 2 */ });
  it("paginates topics sticky-first", async () => {
    /* seed 25 normal topics + 1 sticky with oldest last_post_at;
       page=1 → 20 rows, sticky FIRST despite age; page=2 → 6 remaining meta check via pageCount */
  });
  it("paginates posts ascending", async () => { /* 25 posts; page=1 → posts[0] is the OLDEST; page=2 → 5 */ });
  it("404s an unknown forum id and 400s a malformed one", async () => { /* zod param guard */ });
});
```

- [ ] **Step 5: Implement routes** in `src/index.ts` with `definePlugin` + `route(...)` (copy bounties' idiom; params via zod `z.object({ forumId: z.string().uuid() })`, query `z.object({ page: z.coerce.number().int().min(1).default(1) })`). Topic listing:

```ts
const PAGE_SIZE = 20;
// sticky first, then recency — one indexed ORDER BY, no N+1
.orderBy(sql`case when ${topics.type} = 'sticky' then 0 else 1 end`, desc(topics.lastPostAt))
.limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE)
```

with a parallel `count(*)` for `pageCount` (`Math.max(1, Math.ceil(total / PAGE_SIZE))`). Author names hydrate via one `inArray` on the mirrored players table (news' pattern). Manifest: `migrations: FORUM_MIGRATIONS`, `basePaths: ["/api/forum", "/api/admin/forum"]`.

- [ ] **Step 6: Run + commit**

```bash
npx vitest run apps/server/test/forum.test.ts --project @gl3/server
git add packages/plugins/forum apps/server vitest.workspace.ts tsconfig.json Dockerfile.server
git commit -m "feat(forum): plugin scaffold, p_forum_* tables, paginated reads"
```

---

### Task 13: Forum writes — topics, posts, cooldowns, notify

**Files:**
- Modify: `packages/plugins/forum/src/index.ts`
- Test: `apps/server/test/forum-write.test.ts`

**Interfaces:**
- Consumes: `CreateTopicRequestSchema`/`CreatePostRequestSchema` shapes (restated in-plugin — plugins may NOT import `@gl3/shared`; restate the zod objects with the same bounds and a comment naming the shared schema they mirror, the `MoneySchema`-regex precedent bounties documents).
- Produces: `POST /api/forum/:forumId/topics` → `201 { topicId }`; `POST /api/forum/topics/:topicId/posts` → `201 { postId }`; errors `409 topic_locked`, `429 on_cooldown` (with `retryAfter`), `404 *_not_found`.

- [ ] **Step 1: Failing test**

```ts
describe("forum writes", () => {
  it("creates a topic with its opening post atomically", async () => { /* POST topic; expect topic row + 1 post row + post_count 1 */ });
  it("reply bumps last_post_at and post_count, notifies the author once", async () => {
    /* topic by A; reply by B → notification row for A; reply by A (self) → no new notification */
  });
  it("topic cooldown 60s, post cooldown 15s", async () => {
    /* second POST topic within window → 429 with retryAfter; same for posts;
       use distinct players so the two cooldowns don't mask each other */
  });
  it("locked topic refuses replies with 409", async () => { /* set status='locked' via SQL */ });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Cooldowns before the transaction, keyed per player (rule 2 — the SET NX EX outcome is the decision; on refusal read TTL for `retryAfter`):

```ts
const claimed = await ctx.redis.set(`forumtopic:${player.id}`, "1", "EX", 60, "NX");
if (claimed !== "OK") {
  const ttl = await ctx.redis.ttl(`forumtopic:${player.id}`);
  throw new PluginError("on_cooldown", 429, { retryAfter: Math.max(ttl, 1) });
}
```

(Check `ctx.redis` exists on PluginCtx — `grep -n "redis" packages/plugin-sdk/src/ctx.ts`; if plugins get cooldowns via a dedicated `ctx.cooldowns` helper instead, use that — `grep -rn "cooldown" packages/plugin-sdk/src/ctx.ts` and copy whatever combat's shot cooldown uses.) Topic create inserts topic + opening post in ONE `ctx.transaction`; reply updates `last_post_at`/`post_count` with plain `UPDATE ... SET post_count = post_count + 1` (no explicit lock; the row UPDATE self-serializes). Notify AFTER commit is not required for `tx.notify` (it writes a notification row in-transaction, which is its established semantics — follow existing users: `grep -rn "tx.notify" packages/plugins/*/src/index.ts` and match). Self-reply skips notify.

- [ ] **Step 4: Run + commit** `feat(forum): topics and posts with V2 cooldowns and reply notification`.

---

### Task 14: Forum moderation + admin pages

**Files:**
- Modify: `packages/plugins/forum/src/index.ts`
- Test: `apps/server/test/forum-mod.test.ts`; extend `apps/server/test/admin-ids-hidden.test.ts` (it enumerates adminPages tables — read its pattern first)

**Interfaces:**
- Produces: `POST /api/forum/topics/:topicId/lock` (body `{ locked: boolean }`), `POST /api/forum/topics/:topicId/type` (body `{ type: "normal" | "sticky" }`), `DELETE /api/forum/posts/:postId`, `DELETE /api/forum/topics/:topicId` — all requiring `hasPermission("forum")`; admin CRUD `POST /api/admin/forum/forums` (create, body `{ name, sort }`), `POST /api/admin/forum/forums/:forumId` (rename/sort), `GET /api/admin/forum/forums` (table feed); `adminPages` manifest entry (panel + create form + table, copy news' declarative shape at `packages/plugins/news/src/index.ts:39-55`; the table's `select` uses the forum id as `valueKey` but never displays it — that's what admin-ids-hidden enforces).

- [ ] **Step 1: Failing test** — moderation as a plain player → 403; grant `forum` to a role via SQL insert into `role_module_access` + assign role → lock/unlock/sticky/delete succeed; deleting a topic cascades its posts (assert count 0). Check how existing tests exercise `hasPermission` (`grep -rln "role_module_access" apps/server/test | head -3`) and copy the fixture idiom.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Moderation routes call `ctx.hasPermission("forum")` (check the exact SDK name: `grep -n "hasPermission" packages/plugin-sdk/src/ctx.ts`) and throw `PluginError("forbidden", 403)` when absent. Admin routes declare `auth: "admin"` (loader-enforced for `/api/admin/` paths).
- [ ] **Step 4: Run + commit** `feat(forum): moderation via ABAC forum grant; admin forum CRUD`.

---

### Task 15: Web — forum pages

**Files:**
- Create: `apps/web/src/pages/Forum.tsx`, `apps/web/src/pages/ForumTopic.tsx`
- Modify: `apps/web/src/App.tsx` (`forum`, `forum/:forumId`, `forum/topics/:topicId` — Forum.tsx renders both forum list and, with `:forumId`, its topics), `Shell.tsx` LINKS, `api/queries.ts`, `lib/errors.ts` (copy for `topic_locked`, `on_cooldown` reuse)

**Interfaces:**
- Consumes: forum routes (Tasks 12–14), `PlayerLink` (Task 11).

- [ ] **Step 1: Implement Forum.tsx** — forum list (name, topic count) → topic list (subject as Link, `PlayerLink` author, post count, last-post relative time, sticky badge, locked marker, page controls, "New topic" form with subject+body). Mirror Mail.tsx's structure.
- [ ] **Step 2: Implement ForumTopic.tsx** — posts ascending with author `PlayerLink` + timestamp, page controls, reply box (disabled with countdown while `retryAfter` runs — reuse the countdown idiom from Combat/Bullets), "Quote" button prefills the reply textarea with `> author wrote:\n> first 200 chars…`. Moderator controls (lock/sticky/delete) render only when `me.grants` includes `forum` or `*` (grants already come from `/api/auth/me`).
- [ ] **Step 3: Typecheck + `npx vitest run --project @gl3/web` + commit** `feat(web): forum pages`.

---

### Task 16: M4 forum migrator

**Files:**
- Create: `apps/migrate/src/migrators/forum.ts`
- Modify: `apps/migrate/src/pg/plugin-tables.ts` (mirror the three tables), `apps/migrate/src/orchestrator.ts` (call after the social phase), idempotency test (find: `grep -rln "idempot" apps/migrate/test/`)
- Test: `apps/migrate/test/forum.test.ts` (copy a migrator test's fixture pattern — `bounties-detectives` is closest)

**Interfaces:**
- Consumes: `getOrCreateV3Id(exec, "forums" | "topics" | "posts", v2Id)`, `lookupV3Id(exec, "users", U_id)`, `Executor`, `MigrationReport`.
- Produces: `migrateForum(pool: mysql.Pool, exec: Executor, report: MigrationReport): Promise<void>`.

- [ ] **Step 1: Failing test** — MySQL fixture: 2 forums (one with `F_id < 0` — gang forum), 1 topic (sticky+locked: `T_type` sticky maps, `T_status` locked maps), 2 posts one of which has an unknown `P_user`. Assert: positive forum + topic + posts land; negative forum AND its topics/posts skipped with report entries; unknown author lands `author_id NULL` + report entry; `post_count`/`last_post_at` recomputed from the migrated posts (not read from V2). Then extend the idempotency census with the three `p_forum_*` tables (26 → 29) and confirm the three-run test stays green.
- [ ] **Step 2: Run** (needs `MYSQL_ADMIN_URL`). Expect FAIL.
- [ ] **Step 3: Implement** — select `WHERE F_id > 0` (report skipped count via one `SELECT count(*) WHERE F_id < 0`); topics `WHERE T_forum IN (positive ids)`; posts by migrated topics. Map: `T_type` V2 sticky/important both → `sticky` (GL3 has one priority tier; report the collapse), `T_status` → `locked`/`open`. Recompute after inserting posts:

```ts
await exec.execute(sql`
  UPDATE p_forum_topics t SET
    post_count   = coalesce(p.n, 0),
    last_post_at = coalesce(p.latest, t.created_at)
  FROM (SELECT topic_id, count(*)::int AS n, max(created_at) AS latest
        FROM p_forum_posts GROUP BY topic_id) p
  WHERE p.topic_id = t.id`);
```

Upserts follow cars.ts (`onConflictDoUpdate` keyed on id) so re-runs are idempotent.
- [ ] **Step 4: Run + commit** `feat(migrate): V2 forum content into p_forum_* (gang forums reported-skipped)`.

---

### Task 17: Docs, gate, finish

**Files:**
- Modify: `CLAUDE.md` (current-state paragraph: social cluster; plugin-migration count "nine of nineteen"; shared `0.1.14` unpublished), `docs/STATUS.md` (cluster section following the established shape)

- [ ] **Step 1: Write the STATUS.md section + CLAUDE.md paragraph** — cover: hard gate + grandfathering, the requireAuth choke point (gate + presence in one place, plugin routes included), GETDEL tokens, `playersessions` reverse index, underground concealment on `/api/online`, forum's no-locks stance, the migrator's gang-forum skip, shared `0.1.14` **not yet published**.
- [ ] **Step 2: Concurrency check** — `pgrep -fa vitest` (nothing foreign) and `psql "$DATABASE_URL" -c "select datname from pg_database where datname like 'gl3_tmpl%'"` (only own templates). If anything foreign: STOP and wait; a shared run is void.
- [ ] **Step 3: Merge gate** — bare run, exit code from the process:

```bash
npm run verify > /tmp/claude-1000/-home-dlite-GL3/d06b9b6e-eb7d-467f-bcc2-0b5ae8f37796/scratchpad/verify.log 2>&1
echo "exit=$?"   # separate command — never joined with ';' to the run
```

Non-zero exit = failure even if every test printed green (unhandled-rejection precedent). Also confirm zero `(0 test)` files in the log (cross-talk signature). Expect the known `casino-lock-order` ABBA flake possibly firing — it is a pre-existing open issue; if it fires, rerun the FILE standalone and the full suite once, and report it explicitly either way. Do not chase it inside this cluster.
- [ ] **Step 4: Commit docs** `docs: social cluster status`, then use superpowers:finishing-a-development-branch (do NOT publish `@gl3/shared@0.1.14` without asking the user).
