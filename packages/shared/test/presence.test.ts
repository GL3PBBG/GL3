import { describe, expect, it } from "vitest";
import {
  ClientFrameSchema, ServerFrameSchema, PresenceStateSchema, RoomDescriptorSchema, PlacedHookSchema,
  DEFAULT_SCENE_BOUNDS, DEFAULT_SCENE_SPAWN, HookKindSchema, SceneTemplateSchema,
  SpaceRefSchema, InteriorDeclSchema,
} from "../src/index.js";

const id = "0192a1b2-0000-7000-8000-000000000001";
const state = {
  playerId: id, username: "Vito", gangId: null, x: 1, y: -2, facing: 0.5,
  avatar: { body: "coat" }, since: 1_700_000_000_000,
};
const room = {
  locationId: id, locationName: "Chicago", combatMode: "open", sceneKey: "default",
  bounds: DEFAULT_SCENE_BOUNDS, spawn: DEFAULT_SCENE_SPAWN,
  hooks: [{
    id: "travel.station", pluginId: "travel", hookId: "station", kind: "building", label: "Station",
    model: "station", footprint: { w: 12, d: 9 }, position: { x: -30, y: 15 }, facing: Math.PI,
    href: "/plugins/travel.index", signageUrl: null,
  }],
};

describe("presence client frames", () => {
  it("accepts the four presence frames", () => {
    expect(ClientFrameSchema.parse({ kind: "presence.join", client: "godot-desktop" }).kind).toBe("presence.join");
    for (const client of ["godot-web", "web", "android", "ios"]) {
      expect(ClientFrameSchema.parse({ kind: "presence.join", client }).kind).toBe("presence.join");
    }
    expect(ClientFrameSchema.parse({ kind: "presence.move", seq: 0, x: 1, y: 2, facing: -3 }).kind).toBe("presence.move");
    expect(ClientFrameSchema.parse({ kind: "presence.emote", emote: "wave" }).kind).toBe("presence.emote");
    expect(ClientFrameSchema.parse({ kind: "presence.leave" }).kind).toBe("presence.leave");
  });
  it("rejects a string coordinate, a non-finite coordinate, a negative seq and a free-text emote", () => {
    expect(ClientFrameSchema.safeParse({ kind: "presence.move", seq: 0, x: "1", y: 2, facing: 0 }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ kind: "presence.move", seq: 0, x: Infinity, y: 2, facing: 0 }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ kind: "presence.move", seq: 0, x: 1, y: NaN, facing: 0 }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ kind: "presence.move", seq: -1, x: 1, y: 2, facing: 0 }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ kind: "presence.move", seq: 1.5, x: 1, y: 2, facing: 0 }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ kind: "presence.move", seq: 0, x: 1, y: 2, facing: 4 }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ kind: "presence.emote", emote: "hello there" }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ kind: "presence.join", client: "curl" }).success).toBe(false);
  });
});

describe("presence server frames", () => {
  it("accepts snapshot, tick and error", () => {
    expect(ServerFrameSchema.parse({ kind: "presence.snapshot", room, you: state, players: [], concealed: true }).kind).toBe("presence.snapshot");
    expect(ServerFrameSchema.parse({
      kind: "presence.tick", locationId: id, joined: [state],
      moved: [{ playerId: id, x: 0, y: 0, facing: 0, at: 1 }], emoted: [{ playerId: id, emote: "smoke" }], left: [id],
    }).kind).toBe("presence.tick");
    for (const code of ["not_joined", "no_location", "rate_limited", "superseded"]) {
      expect(ServerFrameSchema.parse({ kind: "presence.error", code }).kind).toBe("presence.error");
    }
  });
  it("still accepts the four pre-existing frames", () => {
    expect(ServerFrameSchema.parse({ kind: "ready", playerId: id }).kind).toBe("ready");
    expect(ServerFrameSchema.parse({ kind: "pong" }).kind).toBe("pong");
    expect(ClientFrameSchema.parse({ kind: "ping" }).kind).toBe("ping");
  });
  it("rejects a room whose bounds are inverted and a state with an unknown avatar", () => {
    expect(RoomDescriptorSchema.safeParse({ ...room, bounds: { minX: 10, minY: 0, maxX: -10, maxY: 1 } }).success).toBe(false);
    expect(PresenceStateSchema.safeParse({ ...state, avatar: { body: "tuxedo" } }).success).toBe(false);
  });
});

describe("core-hook yard and presence sentence", () => {
  it("accepts an optional yard on a placed hook, and still parses with it absent", () => {
    const hookWithYard = { ...room.hooks[0], yard: { x: 1, y: 2 } };
    expect(PlacedHookSchema.parse(hookWithYard).yard).toEqual({ x: 1, y: 2 });
    expect(PlacedHookSchema.parse(room.hooks[0]).yard).toBeUndefined();
  });
  it("accepts an optional static flag on presence state, and still parses with it absent", () => {
    expect(PresenceStateSchema.parse({ ...state, static: true }).static).toBe(true);
    expect(PresenceStateSchema.parse({ ...state, static: false }).static).toBe(false);
    expect(PresenceStateSchema.parse(state).static).toBeUndefined();
    expect(PresenceStateSchema.safeParse({ ...state, static: "yes" }).success).toBe(false);
    // It rides every frame that carries a PresenceState, not just the snapshot.
    const frame = ServerFrameSchema.parse({
      kind: "presence.tick", locationId: id, joined: [{ ...state, static: true }],
      moved: [], emoted: [], left: [],
    });
    expect(frame.kind === "presence.tick" && frame.joined[0]!.static).toBe(true);
  });

  it("accepts an optional sentence on presence state — jail, hospital, null or absent — and rejects an unknown value", () => {
    expect(PresenceStateSchema.parse({ ...state, sentence: "jail" }).sentence).toBe("jail");
    expect(PresenceStateSchema.parse({ ...state, sentence: "hospital" }).sentence).toBe("hospital");
    expect(PresenceStateSchema.parse({ ...state, sentence: null }).sentence).toBeNull();
    expect(PresenceStateSchema.parse(state).sentence).toBeUndefined();
    expect(PresenceStateSchema.safeParse({ ...state, sentence: "prison" }).success).toBe(false);
  });
});

describe("hook kinds and scene templates", () => {
  it("accepts prop as a hook kind", () => {
    expect(HookKindSchema.parse("prop")).toBe("prop");
  });
  it("parses a minimal template and rejects a bad zone", () => {
    const t = {
      key: "t", bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 }, spawn: { x: 0, y: 0, facing: 0 },
      roads: [{ from: { x: -10, y: 0 }, to: { x: 10, y: 0 }, halfWidth: 3, pavement: 1 }],
      slots: [{ id: "a", accepts: "building", zone: "main", position: { x: 0, y: 6 }, facing: Math.PI, max: { w: 4, d: 3 } }],
      facilities: {
        jail: { id: "jail", accepts: "building", zone: "core", position: { x: -6, y: 6 }, facing: Math.PI, max: { w: 4, d: 3 }, yard: { x: -9, y: 6 } },
        hospital: { id: "hospital", accepts: "building", zone: "core", position: { x: -6, y: -6 }, facing: 0, max: { w: 4, d: 3 }, yard: { x: -9, y: -6 } },
      },
    };
    expect(SceneTemplateSchema.parse(t).slots[0]!.zone).toBe("main");
    expect(SceneTemplateSchema.safeParse({ ...t, slots: [{ ...t.slots[0], zone: "Main Street" }] }).success).toBe(false);
  });
});

describe("interior spaces (spec 2026-09-20 casino-interior §2)", () => {
  const exit = { x: -30, y: 7.5, facing: Math.PI };
  it("accepts enter, exit and a join with an interior hint", () => {
    expect(ClientFrameSchema.parse({ kind: "presence.enter", hookId: "casino.casino" }).kind).toBe("presence.enter");
    expect(ClientFrameSchema.parse({ kind: "presence.exit" }).kind).toBe("presence.exit");
    expect(ClientFrameSchema.parse({ kind: "presence.join", client: "godot-desktop", interior: "casino.casino" }).kind).toBe("presence.join");
    expect(ClientFrameSchema.safeParse({ kind: "presence.enter", hookId: "casino" }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ kind: "presence.enter", hookId: "Casino.Floor" }).success).toBe(false);
  });
  it("accepts a street and an interior space ref, and a tick carrying one", () => {
    expect(SpaceRefSchema.parse({ kind: "street", locationId: id }).kind).toBe("street");
    expect(SpaceRefSchema.parse({ kind: "interior", locationId: id, hookId: "casino.casino", exit }).kind).toBe("interior");
    expect(ServerFrameSchema.parse({
      kind: "presence.tick", locationId: id, space: { kind: "interior", locationId: id, hookId: "casino.casino", exit },
      joined: [], moved: [], emoted: [], left: [],
    }).kind).toBe("presence.tick");
  });
  it("accepts an interior room descriptor with points, and a door with interior on the street", () => {
    const point = {
      id: "blackjack-1", kind: "table", label: "Blackjack 1", model: "blackjack-table",
      position: { x: -6, y: 3 }, facing: Math.PI,
      seats: [{ x: -6, y: 1, facing: 0 }], binding: { gameId: "blackjack", station: 0 },
    };
    const interior = RoomDescriptorSchema.parse({
      ...room, sceneKey: "casino-floor-v1", bounds: { minX: -12, minY: -9, maxX: 12, maxY: 9 },
      spawn: { x: 0, y: -7.5, facing: 0 }, hooks: [],
      space: { kind: "interior", locationId: id, hookId: "casino.casino", exit }, points: [point],
    });
    expect(interior.points?.[0]?.binding?.station).toBe(0);
    expect(RoomDescriptorSchema.parse(room).space).toBeUndefined();
    expect(PlacedHookSchema.parse({ ...room.hooks[0], interior: { sceneKey: "casino-floor-v1" } }).interior?.sceneKey).toBe("casino-floor-v1");
    expect(PlacedHookSchema.parse(room.hooks[0]).interior).toBeUndefined();
  });
  it("validates an interior declaration", () => {
    const decl = { sceneKey: "casino-floor-v1", bounds: { minX: -12, minY: -9, maxX: 12, maxY: 9 }, spawn: { x: 0, y: -7.5, facing: 0 }, points: [] };
    expect(InteriorDeclSchema.parse(decl).sceneKey).toBe("casino-floor-v1");
    expect(InteriorDeclSchema.safeParse({ ...decl, sceneKey: "Casino Floor" }).success).toBe(false);
    expect(InteriorDeclSchema.safeParse({ ...decl, points: [{ id: "t", kind: "table", label: "T", model: "m", position: { x: 0, y: 0 }, facing: 0, seats: new Array(6).fill({ x: 0, y: 0, facing: 0 }) }] }).success).toBe(false);
  });
  it("accepts the four new presence error codes", () => {
    for (const code of ["unknown_hook", "no_interior", "wrong_space", "sentenced"]) {
      expect(ServerFrameSchema.parse({ kind: "presence.error", code }).kind).toBe("presence.error");
    }
  });
});
