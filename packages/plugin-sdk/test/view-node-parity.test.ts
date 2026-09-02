import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ViewNodeDtoSchema } from "@gl3/shared";
import { ViewNodeSchema } from "../src/pages.js";

/**
 * The view-node vocabulary is defined TWICE — `leafOptions` in
 * `packages/plugin-sdk/src/pages.ts` and `leafOptions` in
 * `packages/shared/src/dto/plugins.ts` — and the two must agree. The SDK's copy
 * validates a node at AUTHORING time, when `definePlugin` checks a manifest;
 * shared's copy validates it on the WIRE, when the browser runs
 * `PluginsPayloadSchema.parse` over the whole plugin payload.
 *
 * Skew between them is not "an older package lacks a feature". It is two
 * validators disagreeing about what is valid, and it fails at a distance: the
 * hub accepts the node, the browser rejects it, and because that parse is
 * all-or-nothing one bad leaf takes down the entire payload — nav included, not
 * just the page that used it.
 *
 * That is not hypothetical. The `cards` leaf shipped in the SDK and never
 * reached shared, and nothing caught it until a human tried to render a hand
 * (`@gl3/shared@0.1.6` carries the fix). Shared's own comment concedes the
 * coupling — "Kept identical to the SDK's copy" — which is a comment doing a
 * test's job. This is the test.
 *
 * Neither `leafOptions` array is exported, so rather than restating the
 * vocabulary here — which would just add a THIRD hand-maintained copy of the
 * thing under test — both sets are read back out of the schemas themselves: a
 * `discriminatedUnion` handed an unknown discriminator reports every value it
 * would have accepted.
 */
function leafKindsOf(schema: z.ZodType<unknown>): Set<string> {
  const result = schema.safeParse({ kind: "__definitely_not_a_view_node_kind__" });
  if (result.success) {
    throw new Error("schema accepted an unknown `kind` — it is not a discriminated union");
  }
  const issue = result.error.issues[0];
  if (issue === undefined || issue.code !== z.ZodIssueCode.invalid_union_discriminator) {
    throw new Error(`expected invalid_union_discriminator, got ${issue?.code ?? "no issue"}`);
  }
  return new Set(issue.options.map(String));
}

describe("view node vocabulary parity", () => {
  it("defines the same leaf kinds in the SDK and on the wire", () => {
    const sdk = leafKindsOf(ViewNodeSchema);
    const wire = leafKindsOf(ViewNodeDtoSchema);

    // Reported as sorted arrays rather than sets: a failure should name the
    // kinds that drifted, not print "Set(12) !== Set(11)".
    expect([...wire].sort(), "kinds in @gl3/plugin-sdk but not @gl3/shared").toEqual([...sdk].sort());
  });

  it("still includes `cards`, the leaf whose absence from shared caused the bug", () => {
    expect(leafKindsOf(ViewNodeSchema)).toContain("cards");
    expect(leafKindsOf(ViewNodeDtoSchema)).toContain("cards");
  });

  // The kind-set check above cannot see a PROPERTY that exists in one copy
  // and not the other — both leaves are `.strict()`, so a property shared
  // lacks fails the whole payload parse in the browser, the exact `cards`
  // failure one level down. Parse a representative node through both.
  it("accepts `table.rowActions` in both the SDK and on the wire", () => {
    const node = {
      kind: "table",
      source: "GET /api/admin/example/rows",
      columns: [{ key: "name", label: "Name" }],
      rowActions: [
        { label: "Delete", action: "DELETE /api/admin/example/rows/:id", confirm: "Delete this row?" },
      ],
    };
    expect(ViewNodeSchema.safeParse(node).success).toBe(true);
    expect(ViewNodeDtoSchema.safeParse(node).success).toBe(true);
  });

  // The casino table's layout props, and the same property-level gap as
  // `table.rowActions` above: both are `.strict()`, so a `size`/`caption` the
  // wire schema lacked would take down the whole payload in the browser while
  // the hub accepted the page at boot.
  it("accepts a captioned, sized `cards` hand in both the SDK and on the wire", () => {
    const node = { kind: "cards", cards: ["Sa", "B1"], size: "sm", caption: "Seat 2 — 17, playing" };
    expect(ViewNodeSchema.safeParse(node).success).toBe(true);
    expect(ViewNodeDtoSchema.safeParse(node).success).toBe(true);
  });

  // `when` is pruned server-side at boot (progression-view.ts) and should never
  // reach the wire — but the wire copy accepts it anyway, so a view that DID
  // leak past the pruner shows an extra column rather than blanking the
  // whole payload (the all-or-nothing parse this file exists to guard).
  it("accepts a column and field `when` in both the SDK and on the wire", () => {
    const table = {
      kind: "table", source: "GET /api/admin/example/rows",
      columns: [{ key: "expRequired", label: "Exp required", when: { progression: "exp" } }],
    };
    const form = {
      kind: "form", action: "POST /api/admin/example", submitLabel: "Save",
      fields: [
        { name: "a", label: "A", type: "money", when: { progression: "level" } },
        { name: "b", label: "B", type: "select", optionsSource: "GET /api/admin/example/rows", valueKey: "id", labelKey: "name", when: { progression: "exp" } },
        { name: "c", type: "hidden", value: "x", when: { progression: "exp" } },
      ],
    };
    for (const node of [table, form]) {
      expect(ViewNodeSchema.safeParse(node).success).toBe(true);
      expect(ViewNodeDtoSchema.safeParse(node).success).toBe(true);
    }
  });

  it("accepts `panel.layout` in both the SDK and on the wire", () => {
    const node = {
      kind: "panel",
      title: "The other seats",
      layout: "row",
      children: [{ kind: "cards", cards: ["Sa"], size: "sm" }],
    };
    expect(ViewNodeSchema.safeParse(node).success).toBe(true);
    expect(ViewNodeDtoSchema.safeParse(node).success).toBe(true);
  });

  // Property-level parity for the prefill field, same rationale as
  // `table.rowActions` above: both leaves are `.strict()`, so a field one
  // copy lacks takes down the whole payload in the browser.
  it("accepts `form.valuesSource` in both the SDK and on the wire", () => {
    const node = {
      kind: "form",
      action: "POST /api/admin/example/settings",
      submitLabel: "Save",
      valuesSource: "GET /api/admin/example/settings",
      fields: [{ name: "pool_size", label: "Offers per town", type: "text" }],
    };
    expect(ViewNodeSchema.safeParse(node).success).toBe(true);
    expect(ViewNodeDtoSchema.safeParse(node).success).toBe(true);
  });

  // First reject-parity case: prefill fetches on mount, so a mutating verb
  // must fail in BOTH copies — a drift where one accepts POST would let a
  // page mutate on render on whichever side is looser.
  it("rejects a non-GET `form.valuesSource` in both the SDK and on the wire", () => {
    const node = {
      kind: "form",
      action: "POST /api/admin/example/settings",
      submitLabel: "Save",
      valuesSource: "POST /api/admin/example/settings",
      fields: [{ name: "pool_size", label: "Offers per town", type: "text" }],
    };
    expect(ViewNodeSchema.safeParse(node).success).toBe(false);
    expect(ViewNodeDtoSchema.safeParse(node).success).toBe(false);
  });
});
