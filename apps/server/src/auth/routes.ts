import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { ForgotRequestSchema, LoginRequestSchema, RegisterRequestSchema, ResetRequestSchema, VerifyRequestSchema } from "@gl3/shared";
import { settlePool, type PluginManifest } from "@gl3/plugin-sdk";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { MailDriver } from "../mail/driver.js";
import { players, playerStats, playerTimers, roleModuleAccess, roles, rounds } from "../db/schema/index.js";
import { touchPresence } from "../presence/touch.js";
import { hashPassword, verifyLegacyMccodesPassword, verifyLegacyPassword, verifyPassword } from "./password.js";
import { DEFAULT_RATE_LIMIT_PREFIX, tokenBucket, withinRateLimit } from "./rate-limit.js";
import { loadGrants } from "../plugins/routes.js";
import { collectAttributePools, memberRegenMultiplier } from "../plugins/attribute-pools.js";
import { createSession, destroyAllSessions, destroySession, readSession } from "./session.js";
import { clearBanned, isBanned, markBanned } from "./ban.js";
import { clearUnverified, consumeResetToken, consumeVerifyToken, isUnverified, issueResetToken, issueVerifyToken, markUnverified } from "./verify.js";

/**
 * Gated players may still verify, sign out, read their own profile, or open
 * the events socket. Query strings are stripped before the check.
 * `/api/ws/ticket` is exempt because presence already counts an unverified
 * player as online and the event stream carries nothing gated — without the
 * exemption, `useGameEvents` minting a ticket from the /verify page itself
 * would 403 and retrigger the client's own gate redirect to /verify, looping.
 */
const GATE_EXEMPT = ["/api/auth/verify", "/api/auth/logout", "/api/auth/me", "/api/ws/ticket"];

declare module "fastify" {
  interface FastifyRequest { playerId?: string }
  interface FastifyInstance { requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void> }
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

/**
 * PostgreSQL SQLSTATE 23505 = unique_violation. drizzle-orm wraps the raw
 * driver error in its own `DrizzleQueryError`, with the real `PostgresError`
 * attached as `.cause` — so the unique-violation check has to look one level
 * down the `Error.cause` chain, not just at the thrown error itself.
 */
function uniqueViolation(err: unknown): postgres.PostgresError | null {
  const candidate = err instanceof postgres.PostgresError ? err
    : err instanceof Error && err.cause instanceof postgres.PostgresError ? err.cause
    : null;
  return candidate?.code === "23505" ? candidate : null;
}

export function registerAuthRoutes(
  app: FastifyInstance, config: Config, db: Db, redis: Redis, mail: MailDriver,
  rateLimitPrefix = DEFAULT_RATE_LIMIT_PREFIX,
  // A THUNK, not the list itself: this function is called from app.ts before
  // the loader's `loaded` binding is assigned (buildApp assigns it further
  // down, then loads plugin routes). A closure captures the BINDING, not the
  // value at call time, so it observes the post-loadPlugins assignment when
  // /api/auth/me actually runs a request — long after buildApp has returned.
  // Defaults to an empty list so every other caller (most test files build
  // their own app via `buildApp`, which always supplies this) keeps working
  // with no attribute pools declared.
  manifests: () => readonly PluginManifest[] = () => [],
): void {
  const requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearer(request);
    const playerId = token ? await readSession(redis, token) : null;
    if (!playerId) { await reply.code(401).send({ error: "unauthorized" }); return; }
    // Before touchPresence, and with no GATE_EXEMPT carve-out: a banned player
    // must neither show as online nor reach even the verify/resend routes. The
    // ban itself destroys every session, so this only fires for a token the
    // reverse index missed — belt and braces, same 403 either way.
    if (await isBanned(redis, playerId)) {
      await reply.code(403).send({ error: "banned" }); return;
    }
    await touchPresence(redis, db, playerId);
    const url = request.url.split("?")[0] ?? request.url;
    if (!GATE_EXEMPT.some((p) => url === p || url.startsWith(`${p}/`))) {
      if (await isUnverified(redis, playerId)) {
        await reply.code(403).send({ error: "email_unverified" }); return;
      }
    }
    request.playerId = playerId;
  };
  app.decorate("requireAuth", requireAuth);

  app.post("/api/auth/register", {
    preHandler: tokenBucket(redis, { name: "register", limit: 5, windowSeconds: 3600 }, rateLimitPrefix),
  }, async (request, reply) => {
    const parsed = RegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });

    const existing = await db.select({ id: players.id }).from(players).where(eq(players.username, parsed.data.username));
    if (existing.length > 0) return reply.code(409).send({ error: "username_taken" });

    const playerId = uuidv7();
    const passwordHash = await hashPassword(parsed.data.password);

    // Declared pools start FULL (spec 2026-08-26 §7 item 7): MCCodes'
    // register.php hands a new player 12/12 energy, 5/5 brave, 100/100 will,
    // and a GL3 game running the pool family must match that feel — a fresh
    // player who cannot act until a regen cycle passes has a broken first
    // minute. Only DECLARED pools are seeded: an install with no attribute
    // plugin keeps writing the all-zero row, opt-in property intact. Stamps
    // stay NULL — the clock starts on first read and accrues nothing, which
    // settlePool's null-stamp branch already handles.
    const attributePools = collectAttributePools(manifests());
    const seededStats: Partial<typeof playerStats.$inferInsert> = {};
    for (const [pool, decl] of attributePools) {
      switch (pool) {
        case "energy":
          seededStats.energy = decl.defaultMax;
          seededStats.energyMax = decl.defaultMax;
          break;
        case "will":
          seededStats.will = decl.defaultMax;
          seededStats.willMax = decl.defaultMax;
          break;
        case "brave":
          seededStats.brave = decl.defaultMax;
          seededStats.braveMax = decl.defaultMax;
          break;
      }
    }

    try {
      await db.transaction(async (tx) => {
        await tx.insert(players).values({
          id: playerId,
          username: parsed.data.username,
          email: parsed.data.email,
          passwordHash,
        });
        await tx.insert(playerStats).values({ playerId, ...seededStats });

        // A player who registers halfway through a round competes on progress
        // from the moment they join, not from zero. There is no round id in
        // scope here — the register route knows nothing about rounds — so the
        // block starts with its own read, using the same active predicate
        // ensureCurrentRound's probe uses. Registration deliberately does NOT
        // call ensureCurrentRound: that opens a transaction (we are in one) and
        // takes a global advisory lock, and this is a hot path. A round that
        // has ended but not yet rolled over matches nothing here; the next
        // round's whole-population activation picks the player up.
        const [round] = await tx.select({ id: rounds.id }).from(rounds)
          .where(sql`${rounds.finalizedAt} is null
                     and ${rounds.startsAt} is not null and ${rounds.startsAt} <= now()
                     and (${rounds.endsAt} is null or ${rounds.endsAt} > now())`)
          .orderBy(asc(rounds.startsAt), asc(rounds.id))
          .limit(1);

        if (round) {
          // INSERT ... SELECT off player_stats rather than three literal zeroes:
          // hard-coded 0n would be correct today and would silently start lying
          // the day new players get a starting balance.
          await tx.execute(sql`
            insert into round_entries (round_id, player_id, joined_at, exp_at_start, cash_at_start, bank_at_start)
            select ${round.id}, ps.player_id, now(), ps.exp, ps.cash, ps.bank
            from player_stats ps where ps.player_id = ${playerId}
            on conflict (round_id, player_id) do nothing`);

          await tx.update(players).set({ roundId: round.id }).where(eq(players.id, playerId));
        }

        // First-player-ever becomes Administrator. The advisory lock is
        // load-bearing: under read committed, two concurrent first registrations
        // each see only their own insert — both would see no other player and both
        // would claim admin. The lock serializes probe-and-claim; it releases at
        // commit. The probe *before* the lock is what keeps it off the hot path:
        // every registration after the first finds another player and never takes
        // the lock at all. The recheck under the lock is the one that decides —
        // the unlocked probe can only be stale in the direction of "maybe empty".
        const others = await tx.select({ id: players.id }).from(players)
          .where(ne(players.id, playerId)).limit(1);
        if (others.length === 0) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(7461001)`);
          const recheck = await tx.select({ id: players.id }).from(players)
            .where(ne(players.id, playerId)).limit(1);
          if (recheck.length === 0) {
            const adminRoleId = uuidv7();
            await tx.insert(roles).values({ id: adminRoleId, name: "Administrator" });
            await tx.insert(roleModuleAccess).values({ roleId: adminRoleId, moduleKey: "*" });
            await tx.update(players).set({ roleId: adminRoleId }).where(eq(players.id, playerId));
          }
        }
      });
    } catch (err) {
      // Unique index is the real arbiter; the pre-check above only saves a hash round.
      // Only a genuine unique-constraint violation is a client error (409) — anything
      // else (connection loss, constraint we don't recognise, etc.) is a real failure
      // and must surface as one, not be misreported as "username taken".
      const violation = uniqueViolation(err);
      if (violation?.constraint_name === "players_username_unique") {
        return reply.code(409).send({ error: "username_taken" });
      }
      if (violation?.constraint_name === "players_email_unique") {
        return reply.code(409).send({ error: "email_taken" });
      }
      throw err;
    }

    // Post-commit, like events (rule 5): a mail failure must not unwind the row.
    await markUnverified(redis, playerId);
    const code = await issueVerifyToken(redis, playerId);
    await mail.send({
      to: parsed.data.email, subject: "Verify your GL3 account",
      text: `Your verification code is ${code}\n\nOr click: ${config.mail.appBaseUrl}/verify?code=${code}\n\nThe code expires in 24 hours.`,
    });

    const token = await createSession(redis, playerId, config.sessionTtlSeconds);
    return reply.code(201).send({ token, playerId, username: parsed.data.username });
  });

  app.post("/api/auth/login", {
    preHandler: tokenBucket(redis, { name: "login", limit: 10, windowSeconds: 900 }, rateLimitPrefix),
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
    } else if (player.legacyMccodesHash !== null) {
      // MCCodes formula (spec 2026-08-26 §7 item 10): md5(pass_salt . md5(pw)),
      // with an empty/NULL salt meaning the older unsalted md5(pw) form. Same
      // lazy-upgrade flow as the V2 branch above.
      authenticated = verifyLegacyMccodesPassword(
        player.legacyMccodesHash, player.legacyMccodesSalt ?? "", parsed.data.password,
      );
      if (authenticated) {
        const upgraded = await hashPassword(parsed.data.password);
        await db.update(players)
          .set({ passwordHash: upgraded, legacyMccodesHash: null, legacyMccodesSalt: null })
          .where(eq(players.id, player.id));
        request.log.info({ event: "auth.legacy_upgraded", playerId: player.id, legacy: "mccodes" });
      }
    }

    if (!authenticated) return reply.code(401).send({ error: "invalid_credentials" });

    // Same row-is-truth shape as the unverified gate below: a live ban
    // re-asserts its Redis flag (surviving a flush), an expired one clears its
    // own columns here — lazily, no cron — so the admin table never shows a
    // ban that is no longer in force.
    if (player.bannedAt !== null) {
      if (player.banExpiresAt !== null && player.banExpiresAt <= new Date()) {
        await db.update(players).set({ bannedAt: null, banReason: null, banExpiresAt: null })
          .where(eq(players.id, player.id));
        await clearBanned(redis, player.id);
      } else {
        await markBanned(redis, player.id, player.banExpiresAt);
        return reply.code(403).send({
          error: "banned",
          reason: player.banReason,
          expiresAt: player.banExpiresAt?.toISOString() ?? null,
        });
      }
    }

    // Redis is a cache of the gate, the row is the truth: a flushed flag
    // re-asserts here, and a verified player never re-acquires it.
    //
    // `player.email === null` deliberately falls into the else branch (never
    // gated) rather than being treated as unverified: a migrated V2 player
    // with `U_status=2` and no email on file could never satisfy the
    // verification flow (there's nowhere to send a code), and
    // `verify/resend` would 409 `no_email` on every attempt. Gating them
    // would be a dead end with no way out, so they're grandfathered in the
    // same spirit as `email_verified_at` being backfilled for every
    // pre-cluster row.
    if (player.emailVerifiedAt === null && player.email !== null) {
      await markUnverified(redis, player.id);
    } else {
      await clearUnverified(redis, player.id);
    }

    const token = await createSession(redis, player.id, config.sessionTtlSeconds);
    return reply.code(200).send({ token, playerId: player.id, username: player.username });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = bearer(request);
    if (token) await destroySession(redis, token);
    return reply.code(204).send();
  });

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

  app.post("/api/auth/forgot", {
    preHandler: tokenBucket(redis, { name: "forgot", limit: 5, windowSeconds: 3600 }, rateLimitPrefix),
  }, async (request, reply) => {
    const parsed = ForgotRequestSchema.safeParse(request.body);
    // Every path answers 200 with the same body: the response must not reveal
    // whether the email exists (account enumeration) or whether the email-key
    // limiter below tripped — a 429 here would itself be a signal.
    if (!parsed.success) return reply.code(200).send({});

    // The per-IP bucket above stops one IP from hammering /forgot, but not an
    // attacker spraying requests for one victim's address across many IPs —
    // that needs a second bucket keyed on the email itself. Applied
    // in-handler, after the body is parsed, since a preHandler runs before
    // Fastify has a body to key on.
    const emailKey = `${rateLimitPrefix}:forgotemail:${parsed.data.email.trim().toLowerCase()}`;
    const withinEmailLimit = await withinRateLimit(redis, emailKey, { limit: 3, windowSeconds: 3600 });

    if (withinEmailLimit) {
      const [row] = await db.select({ id: players.id, verifiedAt: players.emailVerifiedAt })
        .from(players).where(eq(players.email, parsed.data.email));
      if (row && row.verifiedAt !== null) {
        const token = await issueResetToken(redis, row.id);
        await mail.send({
          to: parsed.data.email, subject: "Reset your GL3 password",
          text: `Reset link: ${config.mail.appBaseUrl}/reset?token=${token}\n\nThe link expires in 1 hour. If you didn't ask for this, ignore it.`,
        });
      }
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
    await db.update(players)
      .set({ passwordHash, legacyPasswordSha256: null, legacyMccodesHash: null, legacyMccodesSalt: null })
      .where(eq(players.id, playerId));
    await destroyAllSessions(redis, playerId);
    return reply.code(200).send({});
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const [row] = await db.select({
      username: players.username,
      cash: playerStats.cash, bank: playerStats.bank,
      points: playerStats.points,
      bullets: playerStats.bullets, exp: playerStats.exp,
      energy: playerStats.energy, energyMax: playerStats.energyMax, energyRegenAt: playerStats.energyRegenAt,
      will: playerStats.will, willMax: playerStats.willMax, willRegenAt: playerStats.willRegenAt,
      brave: playerStats.brave, braveMax: playerStats.braveMax, braveRegenAt: playerStats.braveRegenAt,
      level: playerStats.level,
      strength: playerStats.strength, agility: playerStats.agility,
      guard: playerStats.guard, labour: playerStats.labour,
      iq: playerStats.iq,
    }).from(players)
      .innerJoin(playerStats, eq(playerStats.playerId, players.id))
      .where(eq(players.id, playerId));

    if (!row) return reply.code(404).send({ error: "player_not_found" });

    const grants = await loadGrants(db, playerId);

    // Display-only settle: pure, in memory, writes nothing. Core takes no
    // lock, opens no transaction and runs no clock — the authoritative write
    // happens on the next plugin action via tx.attributes. Absent entirely
    // when no pool is declared, which keeps a V2 install's payload
    // byte-identical to what it served before this feature existed.
    const pools = collectAttributePools(manifests());
    const attributes = pools.size === 0 ? undefined : await (async () => {
      const now = new Date();
      // The same memberMultiplier settleAll applies (ctx.ts, via the shared
      // memberRegenMultiplier decision): a member must not SEE less regen
      // than they get. Display-only — one extra timer read, no lock, no
      // write, same as the settles below.
      const anyMemberPriced = [...pools.values()].some((d) => d.memberMultiplier !== undefined);
      let memberLive = false;
      if (anyMemberPriced) {
        const [timer] = await db.select({ expiresAt: playerTimers.expiresAt })
          .from(playerTimers)
          .where(and(eq(playerTimers.playerId, playerId), eq(playerTimers.key, "membership")));
        memberLive = timer !== undefined && timer.expiresAt.getTime() > now.getTime();
      }
      const energyDecl = pools.get("energy") ?? null;
      const willDecl = pools.get("will") ?? null;
      const braveDecl = pools.get("brave") ?? null;
      const energy = settlePool(row.energy, row.energyMax, row.energyRegenAt, now, energyDecl, memberRegenMultiplier(energyDecl, memberLive));
      const will = settlePool(row.will, row.willMax, row.willRegenAt, now, willDecl, memberRegenMultiplier(willDecl, memberLive));
      const brave = settlePool(row.brave, row.braveMax, row.braveRegenAt, now, braveDecl, memberRegenMultiplier(braveDecl, memberLive));
      return {
        energy: energy.value, energyMax: energy.max,
        will: will.value, willMax: will.max,
        brave: brave.value, braveMax: brave.max,
        level: row.level,
        strength: row.strength.toString(), agility: row.agility.toString(),
        guard: row.guard.toString(), labour: row.labour.toString(),
        iq: row.iq.toString(),
        energyRegenAt: energy.stamp?.toISOString() ?? null,
        willRegenAt: will.stamp?.toISOString() ?? null,
        braveRegenAt: brave.stamp?.toISOString() ?? null,
      };
    })();

    return reply.send({
      playerId, username: row.username,
      cash: row.cash.toString(), bank: row.bank.toString(),
      points: row.points.toString(),
      bullets: row.bullets.toString(), exp: row.exp.toString(),
      grants,
      ...(attributes ? { attributes } : {}),
    });
  });
}
