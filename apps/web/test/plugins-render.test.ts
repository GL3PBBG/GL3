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
    expect(out[0]).toEqual({ kind: "panelHeader", title: "P" });
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
      kind: "form", action: "POST /api/x", submitLabel: "Go",
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
      kind: "form", action: "POST /api/x", submitLabel: "Go",
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
      kind: "form", action: "POST /api/x", submitLabel: "Go",
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
      kind: "form", action: "POST /api/x", submitLabel: "Go",
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
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      fields: [{
        name: "thingId", label: "Thing (empty clears)", type: "select",
        optionsSource: "GET /api/x/things", valueKey: "id", labelKey: "name",
        allowEmpty: true,
      }],
    }]);
  });

  it("maps a table node to a table instruction", () => {
    const out = renderNode({
      kind: "table", source: "GET /api/admin/travel/locations",
      columns: [{ key: "id", label: "Id" }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "table", source: "GET /api/admin/travel/locations",
      columns: [{ key: "id", label: "Id" }],
    }]);
  });

  it("maps a cards node to a cards instruction, codes intact", () => {
    const out = renderNode({ kind: "cards", cards: ["Sa", "H10", "J1"] }, {});
    expect(out).toEqual<RenderInstruction[]>([
      { kind: "cards", cards: ["Sa", "H10", "J1"] },
    ]);
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
