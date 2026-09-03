import { describe, expect, it } from "vitest";
import { pluginInvalidationKeys } from "../src/plugins/invalidation.js";
import type { EventMeta } from "@gl3/shared";

const metas: EventMeta[] = [{
  pluginId: "hello", name: "greeted",
  describe: "{actorName} said hello", invalidates: ["hello"],
}];

describe("pluginInvalidationKeys", () => {
  it("returns the declared prefixes for a matching plugin event", () => {
    const event = {
      type: "plugin.event" as const, id: "e1", at: "2026-01-01T00:00:00Z",
      actorId: "p1", actorName: "Ron", audience: { kind: "global" as const },
      pluginId: "hello", name: "greeted", payload: { count: "3" },
    };
    expect(pluginInvalidationKeys(event, metas)).toEqual([["plugins"], ["hello"]]);
  });

  it("returns only plugins() when the event has no matching metadata", () => {
    const event = {
      type: "plugin.event" as const, id: "e1", at: "2026-01-01T00:00:00Z",
      actorId: "p1", actorName: "Ron", audience: { kind: "global" as const },
      pluginId: "unknown", name: "x", payload: {},
    };
    expect(pluginInvalidationKeys(event, metas)).toEqual([["plugins"]]);
  });

  it("returns only plugins() when the metadata declares no invalidations", () => {
    const metasNone: EventMeta[] = [{ ...metas[0], invalidates: [] }];
    const event = {
      type: "plugin.event" as const, id: "e1", at: "2026-01-01T00:00:00Z",
      actorId: "p1", actorName: "Ron", audience: { kind: "global" as const },
      pluginId: "hello", name: "greeted", payload: {},
    };
    expect(pluginInvalidationKeys(event, metasNone)).toEqual([["plugins"]]);
  });
});
