import { describe, expect, it } from "vitest";
import { z } from "zod";
import { definePlugin, PluginEventDeclSchema, renderDescribe } from "../src/index.js";

const valid = { id: "bounties", version: "1.0.0", basePaths: ["/api/bounties"] };

const goodDecl = {
  name: "placed",
  payload: z.object({ target: z.string(), amount: z.string() }),
  describe: "{actorName} placed a bounty on {target} for {amount}",
  invalidates: ["bounties"],
};

describe("renderDescribe", () => {
  it("substitutes payload values into the template", () => {
    const out = renderDescribe("{actorName} placed a bounty on {target} for {amount}", {
      actorName: "Ron", target: "Vic", amount: "50000",
    });
    expect(out).toBe("Ron placed a bounty on Vic for 50000");
  });

  it("leaves an unknown placeholder visible rather than printing undefined", () => {
    expect(renderDescribe("{actorName} did {what}", { actorName: "Ron" })).toBe("Ron did {what}");
  });

  it("does not recurse into substituted values", () => {
    expect(renderDescribe("{a}", { a: "{a}" })).toBe("{a}");
  });

  it("renders a template with no placeholders unchanged", () => {
    expect(renderDescribe("something happened", {})).toBe("something happened");
  });

  // The case above cannot tell a single pass from a fixed-point loop — both
  // land on "{a}". This one can: a second pass would expand the "{b}" that the
  // first pass wrote, turning a player-supplied string into a placeholder that
  // reads another payload field. Single pass leaves it literal.
  it("does not expand a placeholder that a substituted value introduced", () => {
    expect(renderDescribe("{a} {b}", { a: "{b}", b: "secret" })).toBe("{b} secret");
  });
});

describe("PluginEventDecl validation", () => {
  it("accepts a well-formed declaration and carries the payload schema through", () => {
    const built = definePlugin({ ...valid, events: [goodDecl] });
    expect(built.events).toHaveLength(1);
    // Identity, not shape: the manifest must hand the loader the very schema the
    // author declared, since that is what will parse published payloads.
    expect(built.events[0]?.payload).toBe(goodDecl.payload);
    expect(built.events[0]?.invalidates).toEqual(["bounties"]);
  });

  // Asserted on `issues`, not on the thrown message: a zod error's `message` is
  // a serialised dump of the whole issue tree, so a regex over it can match text
  // from a branch that was never selected.
  it("rejects a payload that is not a zod schema at all", () => {
    const result = PluginEventDeclSchema.safeParse({ ...goodDecl, payload: { target: "string" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["payload", "custom"],
    ]);
  });

  // The spec requires a bad manifest to be a hard boot failure naming the
  // plugin, so the rejection has to survive the trip through definePlugin.
  it("fails definePlugin, naming the plugin, when an event payload is not a schema", () => {
    expect(() => definePlugin({ ...valid, events: [{ ...goodDecl, payload: "string" }] }))
      .toThrow(/invalid plugin manifest for "bounties"/);
  });

  it("rejects the shapes that would otherwise crash much later", () => {
    for (const bad of [{}, "nonsense", { ...goodDecl, name: "" }, { ...goodDecl, describe: "" }]) {
      expect(() => definePlugin({ ...valid, events: [bad] }), `accepted ${JSON.stringify(bad)}`)
        .toThrow(/invalid plugin manifest/);
    }
  });

  it("rejects an unknown field on a declaration", () => {
    expect(() => definePlugin({ ...valid, events: [{ ...goodDecl, invalidate: ["typo"] }] }))
      .toThrow(/invalid plugin manifest/);
  });
});

/**
 * `silent` suppresses the FEED LINE and nothing else: the event still travels
 * the bus and still invalidates everything `invalidates` names, so a plugin
 * whose events are state signals rather than news (casino's table tick, ~10
 * transitions a hand × 5 seats) can drive the client without flooding it.
 *
 * `describe` stays required alongside it. A client that predates the flag
 * renders the template it already knows how to render — noise, which is what
 * the feed did before this cluster, rather than a missing field it would have
 * to cope with.
 */
describe("PluginEventDecl silent", () => {
  it("carries a declared silent flag through definePlugin", () => {
    const built = definePlugin({ ...valid, events: [{ ...goodDecl, silent: true }] });
    expect(built.events[0]?.silent).toBe(true);
  });

  it("leaves silent absent when it is not declared", () => {
    expect(definePlugin({ ...valid, events: [goodDecl] }).events[0]?.silent).toBeUndefined();
  });

  it("still requires describe on a silent declaration", () => {
    const { describe: _dropped, ...noDescribe } = goodDecl;
    expect(() => definePlugin({ ...valid, events: [{ ...noDescribe, silent: true }] }))
      .toThrow(/invalid plugin manifest/);
  });

  it("rejects a non-boolean silent", () => {
    const result = PluginEventDeclSchema.safeParse({ ...goodDecl, silent: "yes" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["silent", "invalid_type"],
    ]);
  });
});
