import { coreHud, definePlugin, on } from "@gl3/plugin-sdk";
import type { PlayerSnapshot } from "@gl3/plugin-sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let closeServer: () => Promise<void>;
let plugins: Awaited<ReturnType<typeof bootTestServer>>["plugins"];

const contributorPlugin = definePlugin({
  id: "hud-contributor",
  version: "1.0.0",
  basePaths: ["/api/hud-contributor"],
  filters: [
    on(coreHud, async (ctx, value) => [
      ...value,
      { pluginId: ctx.pluginId, label: "T", value: "1" },
    ]),
  ],
});

const throwingPlugin = definePlugin({
  id: "hud-thrower",
  version: "1.0.0",
  basePaths: ["/api/hud-thrower"],
  filters: [
    on(coreHud, async () => {
      throw new Error("boom");
    }),
  ],
});

const playerSnapshot: PlayerSnapshot = {
  id: "00000000-0000-0000-0000-000000000001",
  username: "Nazorine",
  cash: 0n,
  bank: 0n,
  level: 0,
  jailed: false,
  gangId: null,
};

beforeEach(async () => {
  await resetDb(db);
  ({ plugins, close: closeServer } = await bootTestServer({
    plugins: [contributorPlugin, throwingPlugin],
  }));
});

afterAll(async () => {
  await conn.end();
});

describe("core filter points and the server-side applier", () => {
  it("collects a subscriber's contribution attributed to its own plugin id", async () => {
    const result = await plugins.coreFilters.apply(coreHud, null, []);
    expect(result).toEqual([
      { pluginId: "hud-contributor", label: "T", value: "1" },
    ]);
    await closeServer();
  });

  it("drops a throwing subscriber under collect policy, keeping the others", async () => {
    const result = await plugins.coreFilters.apply(coreHud, null, []);
    // Both subscribers ran; only the non-throwing one contributed.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pluginId: "hud-contributor" });
    await closeServer();
  });

  it("threads the player snapshot into the subscriber's ctx", async () => {
    let seenPlayerId: string | undefined;
    const playerCheckPlugin = definePlugin({
      id: "hud-player-check",
      version: "1.0.0",
      basePaths: ["/api/hud-player-check"],
      filters: [
        on(coreHud, async (ctx, value) => {
          seenPlayerId = ctx.player?.id;
          return value;
        }),
      ],
    });
    await closeServer();
    await resetDb(db);
    ({ plugins, close: closeServer } = await bootTestServer({ plugins: [playerCheckPlugin] }));

    await plugins.coreFilters.apply(coreHud, playerSnapshot, []);
    expect(seenPlayerId).toBe(playerSnapshot.id);
    await closeServer();
  });
});
