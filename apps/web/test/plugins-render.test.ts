import { describe, expect, it } from "vitest";
import { renderNode, type RenderInstruction } from "../src/plugins/render.js";

describe("renderNode", () => {
  it("renders a leaf text node", () => {
    expect(renderNode({ kind: "text", value: "Hi" }, {})).toEqual<RenderInstruction[]>([
      { kind: "text", value: "Hi" },
    ]);
  });

  it("renders a button as a button instruction carrying its action", () => {
    expect(renderNode({ kind: "button", label: "Greet", action: "POST /api/hello/greet" }, {}))
      .toEqual<RenderInstruction[]>([{ kind: "button", label: "Greet", action: "POST /api/hello/greet" }]);
  });

  it("renders a panel by flattening its children in order", () => {
    const node = {
      kind: "panel" as const, title: "P",
      children: [{ kind: "text" as const, value: "a" }, { kind: "text" as const, value: "b" }],
    };
    const out = renderNode(node, {});
    expect(out).toHaveLength(3); // header + 2 children
    // `layout` is normalised to a required value, like every other optional
    // field this transform sees; null is the stacked default.
    expect(out[0]).toEqual({ kind: "panelHeader", title: "P", layout: null });
    expect(out[1]).toEqual({ kind: "text", value: "a" });
    expect(out[2]).toEqual({ kind: "text", value: "b" });
  });

  it("renders a list by flattening its items in order with no separator", () => {
    const node = {
      kind: "list" as const,
      items: [{ kind: "money" as const, value: "100" }, { kind: "text" as const, value: "x" }],
    };
    expect(renderNode(node, {})).toEqual<RenderInstruction[]>([
      { kind: "money", value: "100" },
      { kind: "text", value: "x" },
    ]);
  });

  it("renders a money value as a money instruction, value untouched (decimal string)", () => {
    expect(renderNode({ kind: "money", value: "1000000000000" }, {}))
      .toEqual<RenderInstruction[]>([{ kind: "money", value: "1000000000000" }]);
  });

  it("renders a keyValue as a single instruction carrying its rows", () => {
    const out = renderNode({ kind: "keyValue", rows: [{ label: "A", value: "1" }] }, {});
    expect(out).toEqual<RenderInstruction[]>([
      { kind: "keyValue", rows: [{ label: "A", value: "1" }] },
    ]);
  });

  it("renders a form with its fields and submit action", () => {
    const out = renderNode({
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      fields: [{ name: "amount", label: "Amount", type: "money" as const }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "form", action: "POST /api/x", submitLabel: "Go", valuesSource: null,
      fields: [{ name: "amount", label: "Amount", type: "money" }],
    }]);
  });

  // `decimal` exists because `number` is rendered as `<input type="number">`,
  // whose default `step` of 1 makes the browser reject a fractional value
  // before it is ever submitted. A weapon's `critMultiplier` is the live case.
  it("renders a decimal field", () => {
    const out = renderNode({
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      fields: [{ name: "critMultiplier", label: "Crit multiplier", type: "decimal" as const }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "form", action: "POST /api/x", submitLabel: "Go", valuesSource: null,
      fields: [{ name: "critMultiplier", label: "Crit multiplier", type: "decimal" }],
    }]);
  });

  // A hidden field submits a constant the route requires and draws nothing —
  // the inventory admin's `itemType` discriminator is the live case. The
  // constant has to survive the transform: it is the whole field.
  it("renders a hidden field carrying its constant", () => {
    const out = renderNode({
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      fields: [{ name: "itemType", type: "hidden" as const, value: "weapon" }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "form", action: "POST /api/x", submitLabel: "Go", valuesSource: null,
      fields: [{ name: "itemType", type: "hidden", value: "weapon" }],
    }]);
  });

  it("renders a select field carrying its options wiring", () => {
    const out = renderNode({
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      fields: [{
        name: "thingId", label: "Thing", type: "select" as const,
        optionsSource: "GET /api/x/things", valueKey: "id", labelKey: "name",
      }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "form", action: "POST /api/x", submitLabel: "Go", valuesSource: null,
      fields: [{
        name: "thingId", label: "Thing", type: "select",
        optionsSource: "GET /api/x/things", valueKey: "id", labelKey: "name",
        allowEmpty: false,
      }],
    }]);
  });

  it("renders a select field's allowEmpty flag", () => {
    const out = renderNode({
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      fields: [{
        name: "thingId", label: "Thing (empty clears)", type: "select" as const,
        optionsSource: "GET /api/x/things", valueKey: "id", labelKey: "name",
        allowEmpty: true,
      }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "form", action: "POST /api/x", submitLabel: "Go", valuesSource: null,
      fields: [{
        name: "thingId", label: "Thing (empty clears)", type: "select",
        optionsSource: "GET /api/x/things", valueKey: "id", labelKey: "name",
        allowEmpty: true,
      }],
    }]);
  });

  it("carries a form's valuesSource through, normalised to null when absent", () => {
    const out = renderNode({
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      valuesSource: "GET /api/x/values",
      fields: [{ name: "amount", label: "Amount", type: "money" as const }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      valuesSource: "GET /api/x/values",
      fields: [{ name: "amount", label: "Amount", type: "money" }],
    }]);
  });

  it("maps a table node to a table instruction", () => {
    const out = renderNode({
      kind: "table", source: "GET /api/admin/travel/locations",
      columns: [{ key: "id", label: "Id" }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "table", source: "GET /api/admin/travel/locations",
      // `render` is normalised to a required value here, the same way
      // `allowEmpty` is on a select field, so the renderer never has to
      // re-derive the DTO's optionality at the point of drawing a cell.
      columns: [{ key: "id", label: "Id", render: null, imageSize: "sm" }],
      rowActions: [],
    }]);
  });

  it("carries rowActions through, normalising an absent confirm to null", () => {
    const out = renderNode({
      kind: "table", source: "GET /api/admin/travel/locations",
      columns: [{ key: "name", label: "Name" }],
      rowActions: [
        { label: "Delete", action: "DELETE /api/admin/travel/locations/:id", confirm: "Delete this town?" },
        { label: "Poke", action: "POST /api/admin/travel/locations/:id/poke" },
      ],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "table", source: "GET /api/admin/travel/locations",
      columns: [{ key: "name", label: "Name", render: null, imageSize: "sm" }],
      rowActions: [
        { label: "Delete", action: "DELETE /api/admin/travel/locations/:id", confirm: "Delete this town?" },
        { label: "Poke", action: "POST /api/admin/travel/locations/:id/poke", confirm: null },
      ],
    }]);
  });

  it("carries a column's image render mode through", () => {
    const out = renderNode({
      kind: "table", source: "GET /api/garage",
      columns: [
        { key: "image", label: "", render: "image", imageSize: "md" },
        { key: "carName", label: "Car" },
      ],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "table", source: "GET /api/garage",
      columns: [
        { key: "image", label: "", render: "image", imageSize: "md" },
        { key: "carName", label: "Car", render: null, imageSize: "sm" },
      ],
      rowActions: [],
    }]);
  });

  it("maps an image node, defaulting an absent size rather than dropping it", () => {
    expect(renderNode({ kind: "image", url: "/assets/abc", alt: "A car" }, {}))
      .toEqual<RenderInstruction[]>([{ kind: "image", url: "/assets/abc", alt: "A car", size: "md" }]);
    expect(renderNode({ kind: "image", url: "/assets/abc", alt: "A car", size: "lg" }, {}))
      .toEqual<RenderInstruction[]>([{ kind: "image", url: "/assets/abc", alt: "A car", size: "lg" }]);
  });

  it("maps a slotImage node, defaulting its size to lg", () => {
    // A page banner is the whole point of this node, so the default is the big
    // one — unlike a table cell, which defaults to a thumbnail.
    expect(renderNode({ kind: "slotImage", slot: "page-jail", scope: "core", alt: "Jail" }, {}))
      .toEqual<RenderInstruction[]>([
        { kind: "slotImage", slot: "page-jail", scope: "core", alt: "Jail", size: "lg" },
      ]);
  });

  it("maps a singleton assetBinder, whose entity fields are absent", () => {
    const out = renderNode({ kind: "assetBinder", slot: "banner", scope: "casino" }, {});
    // Null, not "": the renderer branches on it to decide whether to draw an
    // entity picker at all.
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "assetBinder", slot: "banner", scope: "casino",
      entitySource: null, entityLabelKey: null,
    }]);
  });

  it("maps an assetBinder node, keeping the server-stamped scope", () => {
    const out = renderNode({
      kind: "assetBinder", slot: "car", scope: "theft",
      entitySource: "GET /api/admin/theft/cars", entityLabelKey: "name",
    }, {});
    // `scope` is filled in by the loader from the declaring plugin's id — the
    // client never chooses it, which is what stops a page binding another
    // plugin's art.
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "assetBinder", slot: "car", scope: "theft",
      entitySource: "GET /api/admin/theft/cars", entityLabelKey: "name",
    }]);
  });

  it("maps a cards node to a cards instruction, codes intact", () => {
    const out = renderNode({ kind: "cards", cards: ["Sa", "H10", "J1"] }, {});
    expect(out).toEqual<RenderInstruction[]>([
      { kind: "cards", cards: ["Sa", "H10", "J1"], size: "md", caption: null },
    ]);
  });

  // The casino table's row of opponents: each hand carries how big to draw it
  // and whose it is, because a row has no panel titles to say either.
  it("carries a cards node's size and caption through", () => {
    const out = renderNode(
      { kind: "cards", cards: ["Sa", "B1"], size: "sm", caption: "Seat 2 — 17, playing" }, {},
    );
    expect(out).toEqual<RenderInstruction[]>([
      { kind: "cards", cards: ["Sa", "B1"], size: "sm", caption: "Seat 2 — 17, playing" },
    ]);
  });

  it("carries a panel's row layout through on its header", () => {
    const out = renderNode({
      kind: "panel", title: "The other seats", layout: "row",
      children: [{ kind: "cards", cards: ["Sa"], size: "sm", caption: "Seat 1" }],
    }, {});
    expect(out[0]).toEqual({ kind: "panelHeader", title: "The other seats", layout: "row" });
  });

  it("renders a meter node with label, value and max", () => {
    expect(renderNode({ kind: "meter", label: "Energy", value: 6, max: 12 }, {}))
      .toEqual<RenderInstruction[]>([{ kind: "meter", label: "Energy", value: 6, max: 12 }]);
  });

  it("renders a meterSource node carrying its keys", () => {
    expect(renderNode({
      kind: "meterSource", label: "Energy", source: "GET /api/gym/pools",
      valueKey: "energy", maxKey: "energyMax",
    }, {})).toEqual<RenderInstruction[]>([{
      kind: "meterSource", label: "Energy", source: "GET /api/gym/pools",
      valueKey: "energy", maxKey: "energyMax",
    }]);
  });

  it("renders a keyValueSource node, defaulting an absent emptyText to null", () => {
    const out = renderNode({
      kind: "keyValueSource", source: "GET /api/jobs/board",
      entries: [{ label: "Rank", key: "rankName" }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "keyValueSource", source: "GET /api/jobs/board",
      entries: [{ label: "Rank", key: "rankName" }], emptyText: null,
    }]);
  });

  it("carries a keyValueSource node's emptyText through", () => {
    const out = renderNode({
      kind: "keyValueSource", source: "GET /api/jobs/board",
      entries: [{ label: "Rank", key: "rankName" }], emptyText: "Unemployed",
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "keyValueSource", source: "GET /api/jobs/board",
      entries: [{ label: "Rank", key: "rankName" }], emptyText: "Unemployed",
    }]);
  });

  it("nests arbitrarily deep panels", () => {
    const node = {
      kind: "panel" as const, title: "outer",
      children: [{ kind: "panel" as const, title: "inner",
        children: [{ kind: "text" as const, value: "deep" }] }],
    };
    const out = renderNode(node, {});
    expect(out.some((i) => "value" in i && i.value === "deep")).toBe(true);
  });
});
