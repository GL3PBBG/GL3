import type { ViewNode } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import { pruneViewForProgression } from "../src/plugins/progression-view.js";

/**
 * A page is static manifest data built at boot, but which progression model a
 * boot runs (exp thresholds, or a level ladder via an `applyExp` claimant) is
 * boot-static too — so a column or field can say which model it belongs to and
 * the server drops the others before the view reaches the wire. The `when`
 * key itself never reaches the client: the wire schema is `.strict()` and
 * parsed all-or-nothing, so a leaked key would blank the whole payload.
 */
const table: ViewNode = {
  kind: "table", source: "GET /api/admin/x/list",
  columns: [
    { key: "name", label: "Name" },
    { key: "expRequired", label: "Exp required", when: { progression: "exp" } },
    { key: "levelRequired", label: "Level", when: { progression: "level" } },
  ],
};
const form: ViewNode = {
  kind: "form", action: "POST /api/admin/x", submitLabel: "Save",
  fields: [
    { name: "id", label: "Row", type: "select", optionsSource: "GET /api/admin/x/list", valueKey: "id", labelKey: "name", when: { progression: "level" } },
    { name: "expRequired", label: "Exp required", type: "money", when: { progression: "exp" } },
    { name: "expRequired", label: "Ladder order", type: "money", when: { progression: "level" } },
    { name: "mode", type: "hidden", value: "x", when: { progression: "exp" } },
    { name: "name", label: "Name", type: "text" },
  ],
};

describe("pruneViewForProgression", () => {
  it("keeps unconditional columns and the matching model's, dropping the other", () => {
    const exp = pruneViewForProgression(table, "exp");
    expect(exp).toEqual({
      kind: "table", source: "GET /api/admin/x/list",
      columns: [{ key: "name", label: "Name" }, { key: "expRequired", label: "Exp required" }],
    });
    const level = pruneViewForProgression(table, "level");
    expect(level).toEqual({
      kind: "table", source: "GET /api/admin/x/list",
      columns: [{ key: "name", label: "Name" }, { key: "levelRequired", label: "Level" }],
    });
  });

  it("prunes every field branch — select, basic and hidden — and strips `when`", () => {
    expect(pruneViewForProgression(form, "level")).toEqual({
      kind: "form", action: "POST /api/admin/x", submitLabel: "Save",
      fields: [
        { name: "id", label: "Row", type: "select", optionsSource: "GET /api/admin/x/list", valueKey: "id", labelKey: "name" },
        { name: "expRequired", label: "Ladder order", type: "money" },
        { name: "name", label: "Name", type: "text" },
      ],
    });
    expect(JSON.stringify(pruneViewForProgression(form, "exp"))).not.toContain("when");
  });

  it("recurses through panels and lists", () => {
    const view: ViewNode = { kind: "panel", title: "P", children: [table, { kind: "list", items: [form] }] };
    const out = JSON.stringify(pruneViewForProgression(view, "level"));
    expect(out).not.toContain("Exp required");
    expect(out).toContain("Level");
    expect(out).toContain("Ladder order");
    expect(out).not.toContain("when");
  });

  it("returns a node with no conditional parts unchanged", () => {
    const plain: ViewNode = { kind: "text", value: "hello" };
    expect(pruneViewForProgression(plain, "exp")).toEqual(plain);
    const unconditional: ViewNode = { kind: "table", source: "GET /api/admin/x/list", columns: [{ key: "a", label: "A" }] };
    expect(pruneViewForProgression(unconditional, "level")).toEqual(unconditional);
  });
});
