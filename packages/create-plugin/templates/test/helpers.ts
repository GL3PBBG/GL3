import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { InsufficientFundsError, type PluginCtx } from "@gl3/plugin-sdk";
import { MIGRATIONS } from "../src/migrations.js";

export type TestDb = ReturnType<typeof drizzle>;

/**
 * The slice of core the plugin reads. Add a `CREATE TABLE IF NOT EXISTS` per
 * core table you mirror in src/schema.ts, with only the columns you use.
 */
const CORE_SUBSET = [
  `CREATE TABLE IF NOT EXISTS players (
     id uuid PRIMARY KEY, username text NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS settings (
     key text PRIMARY KEY, value text NOT NULL)`,
];
const CORE_TABLES = ["players", "settings"];

let client: postgres.Sql | null = null;

export function connectTestDb(): TestDb {
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) throw new Error("TEST_DATABASE_URL is required (a throwaway db on the NATIVE postgres, e.g. gl3___ID___test)");
  // onnotice: CREATE TABLE IF NOT EXISTS emits a 42P07 notice per table per
  // reset; without this a real failure is buried under forty lines of them.
  client ??= postgres(url, { max: 5, types: { bigint: postgres.BigInt }, onnotice: () => {} });
  return drizzle(client);
}

/** Drops every `p___ID___*` table, recreates the core subset, replays MIGRATIONS. */
export async function resetDb(db: TestDb): Promise<void> {
  const owned = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' and tablename like ${"p___ID___%"}`,
  );
  for (const row of owned) await db.execute(sql.raw(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`));
  for (const stmt of CORE_SUBSET) await db.execute(sql.raw(stmt));
  await db.execute(sql.raw(`TRUNCATE ${CORE_TABLES.join(", ")} CASCADE`));
  for (const m of MIGRATIONS) await db.execute(sql.raw(m.sql));
}

export async function closeTestDb(): Promise<void> {
  await client?.end();
  client = null;
}

export interface TestPlayer {
  id: string;
  username: string;
}

export interface LockCall {
  kind: "player" | "location" | "locations" | "gangAndPlayer";
  ids: readonly (string | null)[];
}

export interface HarnessCalls {
  balance: { playerId: string; amount: bigint; kind: string; reason: string; refId?: string | undefined }[];
  locks: LockCall[];
  events: Record<string, unknown>[];
  enqueued: { name: string; data: Record<string, unknown> }[];
  notifications: { playerId: string; body: string }[];
}

export interface HarnessOptions {
  settings?: Map<string, string>;
  /**
   * Fires inside the route's own transaction on every lock call, BEFORE the
   * route continues. Use it to assert ordering ("the lock preceded the
   * write") by inspecting `calls` or querying `tx.db` from the hook.
   */
  onLock?: (call: LockCall, calls: HarnessCalls) => void | Promise<void>;
}

/**
 * A fake `PluginCtx` over a REAL drizzle transaction: `tx.db` is the genuine
 * transaction handle, so your own tables are exercised for real, while every
 * other SDK side-effect (balance changes, locks, events, notifications) is
 * recorded into `calls` instead of touching core tables this plugin does not
 * own. Events buffer per transaction and flush into `calls.events` only on
 * commit — dropped on throw — the contract the real loader gives a plugin.
 *
 * Locks are recorded, not taken: this harness cannot prove the absence of a
 * deadlock against the engine. It CAN prove your route asked for the right
 * locks in the right order before it wrote anything — assert on `calls.locks`
 * and use `onLock` for the "before" half.
 */
export function makeHarness(db: TestDb, options: HarnessOptions = {}) {
  const settingsMap = options.settings ?? new Map<string, string>();
  const balances = new Map<string, bigint>();
  const calls: HarnessCalls = { balance: [], locks: [], events: [], enqueued: [], notifications: [] };

  const addPlayer = async (username: string, cash: bigint): Promise<TestPlayer> => {
    const id = crypto.randomUUID();
    await db.execute(sql`insert into players (id, username) values (${id}, ${username})`);
    balances.set(id, cash);
    return { id, username };
  };

  const recordLock = async (call: LockCall): Promise<void> => {
    calls.locks.push(call);
    await options.onLock?.(call, calls);
  };

  const buildCtx = (player: TestPlayer | null): PluginCtx => {
    const ctx = {
      pluginId: "__ID__",
      player: player === null ? null : {
        id: player.id, username: player.username,
        cash: balances.get(player.id) ?? 0n, bank: 0n, level: 1, jailed: false, gangId: null,
      },
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        const pending: Record<string, unknown>[] = [];
        const result = await db.transaction(async (dtx) => {
          const tx = {
            db: dtx,
            economy: {
              applyBalanceChange: async (c: HarnessCalls["balance"][number]) => {
                const cur = balances.get(c.playerId) ?? 0n;
                const next = cur + c.amount;
                if (c.kind === "cash" && next < 0n) throw new InsufficientFundsError(c.playerId, "cash");
                balances.set(c.playerId, next);
                calls.balance.push(c);
                return next;
              },
            },
            locks: {
              player: (ids: string[]) => recordLock({ kind: "player", ids: [...ids].sort() }),
              location: (id: string) => recordLock({ kind: "location", ids: [id] }),
              locations: (ids: readonly (string | null)[]) => recordLock({ kind: "locations", ids }),
              gangAndPlayer: (gangId: string, playerId: string) =>
                recordLock({ kind: "gangAndPlayer", ids: [gangId, playerId] }),
            },
            events: {
              publish: async (e: Record<string, unknown>) => { pending.push(e); },
              publishCore: async (e: Record<string, unknown>) => { pending.push(e); },
            },
            notify: async (playerId: string, body: string) => { calls.notifications.push({ playerId, body }); },
            timers: { get: async () => null, set: async () => {}, clear: async () => false },
          };
          return fn(tx);
        });
        calls.events.push(...pending); // flush after commit only
        return result;
      },
      cooldown: { acquire: async () => true, peek: async () => 0, release: async () => {} },
      jobs: { enqueue: async (name: string, data: Record<string, unknown>) => { calls.enqueued.push({ name, data }); return "job-1"; } },
      job: null,
      filters: { apply: async <T,>(_p: unknown, v: T) => v },
      settings: { get: (key: string) => settingsMap.get(key) ?? null },
      propertyTypes: { get: () => null, list: () => [] },
      installedPluginIds: new Set(["__ID__"]),
      assetSlots: { get: () => null, list: () => [] },
      assets: { resolve: async () => new Map(), mine: async () => new Map(), singleton: async () => null },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    return ctx as unknown as PluginCtx; // test-only cast; src/ stays cast-free
  };

  return {
    calls, balances, addPlayer,
    ctx: (player: TestPlayer | null) => buildCtx(player),
  };
}
