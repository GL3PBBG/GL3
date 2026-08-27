#!/usr/bin/env node
/**
 * Playwright render smoke for the family frontend wave (FF Task 8).
 *
 * Boots the REAL server (core migrations + plugin migrations + the gl3
 * seed pack, all through apps/server/src/index.ts's actual boot path — the
 * same path that runs `seedFamilyContent`, which nothing else in the suite
 * exercises live) against a scratch Postgres database, boots the real web
 * dev server against it, registers and verifies a player through the API,
 * logs in through the real login form in a headless Chromium tab, and then
 * visits every family page plus the dashboard, asserting the Shell's pool
 * bars (`role="progressbar"`) and one piece of seed content per page.
 *
 * Self-contained: creates its own scratch database and drops it on exit,
 * kills both spawned servers on exit (success, failure, or signal). Never
 * touches Redis with FLUSHALL/FLUSHDB — it only reads/writes the exact keys
 * a real registration flow would.
 *
 * Usage: node scripts/family-render-smoke.mjs
 */
import { chromium } from "playwright";
import Redis from "ioredis";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRATCH_DIR = "/tmp/gl3-smoke";

const PG_ADMIN_URL = "postgres://gl3:gl3@localhost:5432/postgres";
const DB_NAME = `gl3_smoke_${randomBytes(4).toString("hex")}`;
const DB_URL = `postgres://gl3:gl3@localhost:5432/${DB_NAME}`;
const REDIS_URL = "redis://localhost:6379";
const SERVER_PORT = 3000; // apps/web/vite.config.ts's proxy target is hardcoded to this port.
const WEB_PORT = 5173;

const PAGES = [
  { url: `http://localhost:${WEB_PORT}/plugins/gym.index`, name: "gym", text: "Strength" },
  { url: `http://localhost:${WEB_PORT}/plugins/houses.index`, name: "houses", text: "Small Flat" },
  { url: `http://localhost:${WEB_PORT}/plugins/education.index`, name: "education", text: "Street Smarts" },
  { url: `http://localhost:${WEB_PORT}/plugins/jobs.index`, name: "jobs", text: "Warehouse Crew" },
  { url: `http://localhost:${WEB_PORT}/plugins/temple.index`, name: "temple", text: "Offered here" },
  { url: `http://localhost:${WEB_PORT}/`, name: "dashboard", text: null },
];

const children = [];
let browser = null;
let dbCreated = false;
const passed = [];
const failures = [];

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function fail(msg) {
  failures.push(msg);
  console.error(`[smoke] FAIL: ${msg}`);
}

/** Runs a one-off command to completion, streaming its output, rejecting on non-zero exit. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", ...opts });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
    child.on("error", reject);
  });
}

/**
 * Spawns a long-running server, capturing its output for post-mortem, tracked
 * for teardown. `detached: true` makes the child its own process-group
 * leader: `npx tsx <file>` is itself a wrapper that forks a grandchild node
 * process running the actual server, and a SIGTERM to just the immediate
 * child does not reliably reach that grandchild — observed live as an
 * orphaned server surviving teardown, squatting the port and answering the
 * NEXT run's requests against its own exhausted rate-limit bucket. Killing
 * the whole group (negative pid) reaches every descendant.
 */
function spawnServer(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: REPO_ROOT, detached: true, ...opts });
  const out = [];
  child.stdout?.on("data", (d) => { out.push(d.toString()); process.stdout.write(`[${name}] ${d}`); });
  child.stderr?.on("data", (d) => { out.push(d.toString()); process.stderr.write(`[${name}] ${d}`); });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[smoke] ${name} exited unexpectedly: code=${code} signal=${signal}`);
    }
  });
  children.push({ name, child });
  return { child, out };
}

/** Retries a 5xx/network failure a couple of times; a 2xx/4xx returns immediately. */
async function fetchWithRetry(url, init, attempts = 3) {
  let lastRes, lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res;
      lastRes = res;
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await sleep(750);
  }
  if (lastRes) return lastRes;
  throw lastErr;
}

/**
 * `getByText(...).first()` isn't safe here: gym's page puts a <select> full
 * of the same stat names ("Strength" etc.) BEFORE the visible keyValueSource
 * labels in DOM order (form, then stats list), and a closed <select>'s
 * <option> elements are never "visible" — `.first()` picks the hidden one
 * and the wait times out even though the real, visible text is right there.
 * Houses/education/jobs/temple happen to dodge this only because their
 * table content precedes their own form's <select> in DOM order. Polls every
 * match for the first one that is actually visible, rather than trusting
 * DOM order.
 */
async function waitForVisibleText(page, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const locator = page.getByText(text, { exact: false });
  while (Date.now() < deadline) {
    const count = await locator.count();
    for (let i = 0; i < count; i++) {
      if (await locator.nth(i).isVisible()) return true;
    }
    await sleep(200);
  }
  return false;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      // Any HTTP response (even 4xx/401) proves the server is accepting connections.
      if (res.status >= 200 && res.status < 600) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message ?? "no response"}`);
}

async function teardown() {
  log("tearing down");
  if (browser) {
    await browser.close().catch((e) => log(`browser close error (ignored): ${e.message}`));
  }
  for (const { name, child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
    log(`sent SIGTERM to ${name}'s process group`);
  }
  // Give them a moment to release their DB connections before DROP DATABASE.
  await sleep(1500);
  for (const { name, child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      log(`sent SIGKILL to ${name}'s process group (did not exit on SIGTERM)`);
    }
  }
  if (dbCreated && !process.env.SMOKE_KEEP_DB) {
    try {
      await run("psql", [PG_ADMIN_URL, "-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
      log(`dropped ${DB_NAME}`);
    } catch (err) {
      console.error(`[smoke] failed to drop ${DB_NAME}: ${err.message}`);
    }
  }
}

async function assertPortFree(port) {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) });
  } catch {
    return; // no response within 500ms (refused, reset, or timed out) — treat as free.
  }
  throw new Error(
    `port ${port} already has something answering — a previous run's server may not have been ` +
    `torn down. Check \`ss -ltnp | grep :${port}\` and kill it before retrying.`,
  );
}

async function main() {
  await mkdir(SCRATCH_DIR, { recursive: true });
  await assertPortFree(SERVER_PORT);
  await assertPortFree(WEB_PORT);

  log(`creating scratch database ${DB_NAME}`);
  await run("psql", [PG_ADMIN_URL, "-c", `CREATE DATABASE ${DB_NAME}`]);
  dbCreated = true;

  log("running core migrations against the scratch database");
  await run("npx", ["tsx", "apps/server/src/db/migrate.ts"], {
    env: { ...process.env, DATABASE_URL: DB_URL, REDIS_URL },
  });

  log(`booting the real server on :${SERVER_PORT} (GL3_PROFILE=gl3)`);
  spawnServer("server", "npx", ["tsx", "apps/server/src/index.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      REDIS_URL,
      GL3_PROFILE: "gl3",
      PORT: String(SERVER_PORT),
      NODE_ENV: "development",
      CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
    },
  });
  // /api/auth/me 401s on no Authorization header WITHOUT touching the DB
  // (requireAuth short-circuits first) — that only proves Fastify is
  // routing, not that the DB pool is ready. /api/theme is public and reads
  // the settings table on every call, so it's a real DB-readiness probe;
  // using the auth-only check here once produced a live 500 on the very
  // first /api/auth/register ("Failed query: select ... from players"),
  // reproducible standalone, that a DB-backed readiness probe closes.
  await waitForHttp(`http://localhost:${SERVER_PORT}/api/theme`, 60_000);
  log("server is up");

  log(`booting the web dev server on :${WEB_PORT}`);
  spawnServer("web", "npx", ["vite", "--port", String(WEB_PORT), "--strictPort"], {
    cwd: path.join(REPO_ROOT, "apps/web"),
  });
  await waitForHttp(`http://localhost:${WEB_PORT}/login`, 60_000);
  log("web dev server is up");

  // register's tokenBucket rate-limits at 5/hour keyed `ratelimit:register:<ip>`
  // in the shared Redis, and every fetch below comes from 127.0.0.1. Rerunning
  // this script a handful of times while iterating exhausts it, which then
  // reads as a false failure on a healthy server. Deleting only that one key
  // (never FLUSHALL/FLUSHDB, per house rule) resets just this script's own
  // register traffic and leaves every other bucket alone.
  const rlRedis = new Redis(REDIS_URL);
  await rlRedis.del("ratelimit:register:127.0.0.1");
  await rlRedis.quit();

  // --- Register + verify through the API, same as any real signup. ---
  const username = `smoke_${randomBytes(4).toString("hex")}`;
  const password = "smoke-test-password-1";
  const email = `${username}@example.test`;

  log(`registering ${username}`);
  const registerRes = await fetchWithRetry(`http://localhost:${SERVER_PORT}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  if (registerRes.status !== 201) {
    throw new Error(`register failed: ${registerRes.status} ${await registerRes.text()}`);
  }
  const { playerId } = await registerRes.json();
  passed.push("registered a player via POST /api/auth/register (201)");

  log("reading the verification code from Redis");
  const redis = new Redis(REDIS_URL);
  let code;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const keys = await redis.keys("emailverify:*");
      for (const key of keys) {
        if ((await redis.get(key)) === playerId) { code = key.slice("emailverify:".length); break; }
      }
      if (code) break;
      await sleep(200);
    }
  } finally {
    await redis.quit();
  }
  if (!code) throw new Error(`no emailverify:* code found for player ${playerId}`);
  passed.push("recovered the emailverify:* code from Redis");

  log("verifying via POST /api/auth/verify");
  const verifyRes = await fetchWithRetry(`http://localhost:${SERVER_PORT}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (verifyRes.status !== 200) {
    throw new Error(`verify failed: ${verifyRes.status} ${await verifyRes.text()}`);
  }
  passed.push("verified the player via POST /api/auth/verify (200)");

  // --- Browser: real login form, then each family page. ---
  log("launching chromium");
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => { consoleErrors.push(`pageerror: ${err.message}`); });

  await page.goto(`http://localhost:${WEB_PORT}/login`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  const [loginResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().endsWith("/api/auth/login") && res.request().method() === "POST"),
    page.getByRole("button", { name: "Log in" }).click(),
  ]);
  if (loginResponse.status() !== 200) {
    throw new Error(`login failed: ${loginResponse.status()} ${await loginResponse.text()}`);
  }
  // NOTE (pre-existing, not introduced by this wave): Login.tsx never calls
  // navigate() on success — it only stores the token and invalidates
  // queries. The Routes switch reactively once `useMe()` succeeds, but the
  // browser is still sitting at the URL "/login", which has no route in the
  // authenticated branch and falls through to the "*" -> NotFound route
  // inside Shell. A real user hitting this would see "Nothing here" for a
  // moment. Worked around here with an explicit navigation, the way a click
  // on a nav link would behave; not fixed, since Login.tsx is outside this
  // task's file list and this bug predates the family frontend wave.
  await page.goto(`http://localhost:${WEB_PORT}/`);
  passed.push("logged in through the real /login form");

  for (const target of PAGES) {
    consoleErrors.length = 0;
    await page.goto(target.url);
    try {
      await page.locator('[role="progressbar"]').first().waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      fail(`${target.name}: no role="progressbar" (Shell pool bars) visible`);
      await page.screenshot({ path: path.join(SCRATCH_DIR, `${target.name}-FAIL.png`), fullPage: true });
      continue;
    }
    const textOk = target.text === null || (await waitForVisibleText(page, target.text, 10_000));
    const screenshotPath = path.join(SCRATCH_DIR, `${target.name}${textOk ? "" : "-FAIL"}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    if (!textOk) {
      fail(`${target.name}: expected text "${target.text}" not found. Console errors: ${JSON.stringify(consoleErrors)}`);
      continue;
    }
    if (consoleErrors.length > 0) {
      fail(`${target.name}: browser console errors: ${JSON.stringify(consoleErrors)}`);
      continue;
    }
    passed.push(`${target.name}: role="progressbar" visible${target.text ? ` + "${target.text}" found` : ""}, no console errors, screenshot at ${screenshotPath}`);
    log(`${target.name}: OK (${screenshotPath})`);
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`[smoke] FATAL: ${err.stack ?? err.message}`);
  failures.push(`fatal: ${err.message}`);
} finally {
  await teardown();
}

console.log("\n=== family-render-smoke summary ===");
for (const p of passed) console.log(`  PASS: ${p}`);
for (const f of failures) console.log(`  FAIL: ${f}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s).`);
  exitCode = 1;
} else {
  console.log(`\nAll ${passed.length} assertions passed.`);
}
process.exit(exitCode);
