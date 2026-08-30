import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import crimesPlugin, {
  evaluateSuccessFormula,
  FormulaEvalError,
  FormulaParseError,
  formulaUsesToken,
  parseSuccessFormula,
} from "@gl3/plugin-crimes";
import { loadConfig } from "../src/config.js";
import { crimeLog, crimes, playerCrimeSkill, playerStats, players } from "../src/db/schema/index.js";
import { runPluginJob } from "../src/plugins/jobs.js";
import { uuidv7 } from "uuidv7";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * B0 Task 2 (spec 2026-08-26-mccodes-migrator-design §2.2): the sandboxed
 * success-formula dialect — audit §7 item 5's runtime half. Unit corpus pins
 * the parser/evaluator math; job tests pin the two mutually exclusive chance
 * models. Determinism trick: rng.int is exclusive of its upper bound, so the
 * commit roll spans [0,9999] against a 0–10000 threshold — a formula that
 * clamps to 100 succeeds on every roll and "0" fails on every roll, no seed
 * knowledge needed.
 */
const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const jobDeps = () => ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix: "crimes-formula-test" });

afterAll(async () => { await conn.end(); redis.disconnect(); });

const CTX = { LEVEL: 5, CRIMEXP: 8500, EXP: 1200, WILL: 90, IQ: 42 };

function evalText(text: string, ctx = CTX): number {
  return evaluateSuccessFormula(parseSuccessFormula(text), ctx);
}

describe("success formula parser/evaluator (pure)", () => {
  it("substitutes the five tokens and evaluates arithmetic", () => {
    expect(evalText("min(95, 10 + CRIMEXP / 100)")).toBe(95); // 10+85 → capped
    expect(evalText("10 + CRIMEXP / 100")).toBe(95);
    expect(evalText("1 + 2 * 3")).toBe(7); // precedence
    expect(evalText("(1 + 2) * 3")).toBe(9); // parentheses
    expect(evalText("-LEVEL + 10")).toBe(5); // unary minus
    expect(evalText("1.5 * 2")).toBe(3); // decimal literals
    expect(evalText("(WILL + IQ) / 2")).toBe(66); // 132/2 — under the clamp
  });

  it("runs the whitelisted functions, case-insensitively (PHP call semantics)", () => {
    expect(evalText("MAX(3, LEVEL)")).toBe(5);
    expect(evalText("min(1, 2, 3)")).toBe(1); // 2+ args
    expect(evalText("floor(1.9)")).toBe(1);
    expect(evalText("ceil(1.2)")).toBe(2);
    expect(evalText("round(1.5)")).toBe(2);
    expect(evalText("abs(0 - 10)")).toBe(10);
    expect(evalText("  LEVEL  *  2  ")).toBe(10); // whitespace-tolerant
  });

  it("clamps the result to 0-100 (normalization, not divergence)", () => {
    expect(evalText("LEVEL * 1000")).toBe(100);
    expect(evalText("0 - LEVEL")).toBe(0);
  });

  it("gives % PHP's integer-cast semantics", () => {
    expect(evalText("10.5 % 3")).toBe(1); // (int)10 % 3, not JS 1.5
  });

  it("rejects everything outside the dialect", () => {
    // rand() is MCCodes' outcome roll, not a chance input — the seeded RNG
    // owns outcomes, so a formula that would draw its own randomness does
    // not fit and imports as NULL (B spec §5).
    for (const bad of [
      "rand(1,100)", "sqrt(9)", "LEVEL & 2", "$x", "LEVEL;",
      "level", // lowercase token: str_replace was case-sensitive in MCCodes
      "", "   ", "LEVEL +", "min(LEVEL)", "min()", "1 2", "(LEVEL",
    ]) {
      expect(() => parseSuccessFormula(bad), JSON.stringify(bad)).toThrow(FormulaParseError);
    }
  });

  it("throws FormulaEvalError on division by zero against live stats", () => {
    // Parses fine — the fault only appears against a player whose WILL hits
    // the zeroing subtrahend.
    const ast = parseSuccessFormula("100 / (WILL - 90)");
    expect(() => evaluateSuccessFormula(ast, CTX)).toThrow(FormulaEvalError); // WILL=90
    expect(evaluateSuccessFormula(ast, { ...CTX, WILL: 110 })).toBe(5); // 100/20
  });
});

describe("crimes.commit — formula crimes (success_formula set)", () => {
  let app: FastifyInstance;
  let closeServer: () => Promise<void>;
  let playerId: string;
  let alwaysCrimeId: string;
  let neverCrimeId: string;
  let faultCrimeId: string;

  beforeEach(async () => {
    await resetDb(db);
    if (!app) ({ app, close: closeServer } = await bootTestServer());
    ({ playerId } = await registerVerifiedPlayer({ app, redis }));

    alwaysCrimeId = crypto.randomUUID();
    neverCrimeId = crypto.randomUUID();
    faultCrimeId = crypto.randomUUID();
    await db.insert(crimes).values([
      {
        id: alwaysCrimeId, name: "Sure Thing", cooldownSeconds: 60,
        minPayout: 50n, maxPayout: 50n, crimeExpReward: 7n,
        successFormula: "min(100, LEVEL)", // level >= 1 ⇒ clamps to 100
      },
      {
        id: neverCrimeId, name: "Impossible", cooldownSeconds: 60,
        minPayout: 50n, maxPayout: 50n, crimeExpReward: 7n,
        successFormula: "0",
      },
      {
        id: faultCrimeId, name: "DivZero", cooldownSeconds: 60,
        minPayout: 50n, maxPayout: 50n, crimeExpReward: 7n,
        // Valid syntax; WILL is 0 at registration ⇒ 100/0 at eval time.
        successFormula: "100 / WILL",
      },
    ]);
    await db.update(playerStats).set({ crimeExp: 100n, level: 5 })
      .where(eq(playerStats.playerId, playerId));
  });
  afterAll(async () => { await closeServer(); });

  it("resolves by the formula: a 100% crime succeeds, pays out, and grants crime_exp_reward", async () => {
    await runPluginJob(jobDeps(), crimesPlugin, "commit", {
      id: "formula-always", data: { playerId, crimeId: alwaysCrimeId, seed: "s1", costs: {} },
    });

    const [log] = await db.select().from(crimeLog).where(eq(crimeLog.jobId, "formula-always"));
    expect(log?.success).toBe(true);
    expect(log?.payout).toBe(50n);

    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.cash).toBe(50n);
    // Imported crime_exp 100 + reward 7 — the counter's main producer.
    expect(stats?.crimeExp).toBe(107n);
  });

  it("resolves by the formula: a 0% crime fails and grants nothing", async () => {
    await runPluginJob(jobDeps(), crimesPlugin, "commit", {
      id: "formula-never", data: { playerId, crimeId: neverCrimeId, seed: "s2", costs: {} },
    });

    const [log] = await db.select().from(crimeLog).where(eq(crimeLog.jobId, "formula-never"));
    expect(log?.success).toBe(false);
    expect(log?.payout).toBe(0n);
    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.crimeExp).toBe(100n);
    expect(stats?.cash).toBe(0n);
  });

  it("resolves an eval-time fault as a failed attempt, never a crashed job", async () => {
    await runPluginJob(jobDeps(), crimesPlugin, "commit", {
      id: "formula-fault", data: { playerId, crimeId: faultCrimeId, seed: "s3", costs: {} },
    });

    const [log] = await db.select().from(crimeLog).where(eq(crimeLog.jobId, "formula-fault"));
    expect(log?.success).toBe(false);
    const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.crimeExp).toBe(100n);
  });

  it("never reads or writes player_crime_skill for a formula crime", async () => {
    await runPluginJob(jobDeps(), crimesPlugin, "commit", {
      id: "formula-skill", data: { playerId, crimeId: alwaysCrimeId, seed: "s4", costs: {} },
    });
    const skills = await db.select().from(playerCrimeSkill)
      .where(eq(playerCrimeSkill.playerId, playerId));
    expect(skills).toHaveLength(0);
  });

  it("lists a formula crime's chance evaluated against the caller's own stats", async () => {
    const skillCrimeId = crypto.randomUUID();
    await db.insert(crimes).values({
      id: skillCrimeId, name: "Skill Crime", cooldownSeconds: 60,
      minPayout: 10n, maxPayout: 20n,
    });
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await app.inject({
      method: "GET", url: "/api/crimes", headers: { authorization: `Bearer ${token}` },
    });
    const listed = res.json().crimes as Array<{ id: string; chance: string | null }>;
    // A fresh player is level 1: min(100, LEVEL) previews as 1.00, the same
    // figure the commit job would roll against right now. Unlocked preview —
    // the job re-evaluates in-transaction, the detectives-list precedent.
    expect(listed.find((c) => c.id === alwaysCrimeId)?.chance).toBe("1.00");
    expect(listed.find((c) => c.id === neverCrimeId)?.chance).toBe("0.00");
    // 100/WILL is NOT a fault for a real registered player: the gl3-profile
    // registration flow seeds the will pool to its declared 100, so this
    // previews honestly as 1.00 (the job-side "eval fault" test relies on a
    // raw-inserted player whose will stays at the column default 0).
    expect(listed.find((c) => c.id === faultCrimeId)?.chance).toBe("1.00");
    expect(listed.find((c) => c.id === skillCrimeId)?.chance).toBe("35.00");
  });

  it("previews null for a formula that faults at eval time, never a 500", async () => {
    const divZeroId = crypto.randomUUID();
    await db.insert(crimes).values({
      id: divZeroId, name: "DivZero Always", cooldownSeconds: 60,
      minPayout: 10n, maxPayout: 20n,
      // Deterministic division by zero for EVERY player — parse-valid, so
      // only the evaluator can refuse it. The web renders "chance by stats"
      // for null, so a broken formula degrades instead of 500ing the list.
      successFormula: "100 / (LEVEL - LEVEL)",
    });
    const { token } = await registerVerifiedPlayer({ app, redis });
    const res = await app.inject({
      method: "GET", url: "/api/crimes", headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const listed = res.json().crimes as Array<{ id: string; chance: string | null }>;
    expect(listed.find((c) => c.id === divZeroId)?.chance).toBeNull();
  });
});

describe("an unparseable stored formula", () => {
  it("resolves as a 0% failure instead of killing the job (the growth gate must not re-parse unguarded)", async () => {
    const brokenId = crypto.randomUUID();
    await db.insert(crimes).values({
      id: brokenId, name: "Broken Formula", cooldownSeconds: 60,
      minPayout: 10n, maxPayout: 20n,
      // Reaches the DB only behind the migrator/admin validators' backs (a
      // stale import, a hand-edited row) — but when it does, the job's
      // documented behavior is a warned 0% resolution, never a dead job.
      // The growth gate's original second, unguarded parse turned exactly
      // this into: accepted commit, burned cooldown, BullMQ retries, silence.
      successFormula: "LEVEL +",
    });
    const playerId = uuidv7();
    await db.insert(players).values({ id: playerId, username: `bf-${playerId.slice(-8)}` });
    await db.insert(playerStats).values({ playerId });

    await runPluginJob(jobDeps(), crimesPlugin, "commit", {
      id: `broken-formula-${brokenId}`, data: { playerId, crimeId: brokenId, seed: "fixed-seed" },
    });

    const [log] = await db.select().from(crimeLog).where(eq(crimeLog.playerId, playerId));
    expect(log).toBeDefined();
    expect(log?.success).toBe(false);
    expect(log?.payout).toBe(0n);
  });
});

describe("SKILL — the GL3-native hybrid token", () => {
  it("parses and evaluates SKILL, and formulaUsesToken walks the whole tree", () => {
    const ast = parseSuccessFormula("min(95, SKILL + LEVEL / 2)");
    expect(formulaUsesToken(ast, "SKILL")).toBe(true);
    // Not just the root: the token sits inside a call, inside a binary.
    expect(formulaUsesToken(parseSuccessFormula("LEVEL * 2 + WILL / 20"), "SKILL")).toBe(false);
    expect(evaluateSuccessFormula(ast, {
      LEVEL: 10, CRIMEXP: 0, EXP: 0, WILL: 0, IQ: 0, SKILL: 50,
    })).toBe(55);
  });

  it("keeps the token case-sensitive like every stat token", () => {
    expect(() => parseSuccessFormula("skill")).toThrow(FormulaParseError);
  });
});
