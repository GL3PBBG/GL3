import { describe, expect, it } from "vitest";
import { CORE_PLUGINS } from "../src/plugins/core-plugins.js";

/**
 * An item's `itemType` is the discriminator of the create and update bodies:
 * the route rejects anything but `weapon`, `melee`, `armor` or `consumable`
 * with a 400, and each of the eight forms targets exactly one of them
 * (`melee` is form-level only — it stores as item_type `weapon`). Asking the
 * admin to
 * type it means a form that is wrong on submit for one typo, with the correct
 * value knowable from the form itself.
 *
 * A `hidden` field is what removes that: the constant travels in the schema,
 * the admin sees a form with one fewer box. Checked against the manifest
 * because the field declaration is the only place the decision is expressed.
 */
interface AnyFormField {
  readonly name: string;
  readonly type: string;
  readonly value?: unknown;
}

function formFields(node: unknown): AnyFormField[] {
  if (typeof node !== "object" || node === null) return [];
  const out: AnyFormField[] = [];
  if ("kind" in node && node.kind === "form" && "fields" in node && Array.isArray(node.fields)) {
    for (const field of node.fields) {
      if (typeof field === "object" && field !== null && "name" in field && "type" in field) {
        out.push({
          name: String(field.name),
          type: String(field.type),
          ...("value" in field ? { value: field.value } : {}),
        });
      }
    }
  }
  for (const key of ["children", "items"] as const) {
    if (key in node && Array.isArray(node[key])) {
      for (const child of node[key] as unknown[]) out.push(...formFields(child));
    }
  }
  return out;
}

describe("inventory admin forms carry itemType as a hidden constant", () => {
  const manifest = CORE_PLUGINS.find((plugin) => plugin.id === "inventory");
  const fields = (manifest?.adminPages ?? []).flatMap((page) => formFields(page.view));
  const discriminators = fields.filter((field) => field.name === "itemType");

  it("finds one on every item form", () => {
    // Four create forms and four update forms — "melee" joined both sets as a
    // FORM-level discriminant (stored as item_type "weapon"; the body schema
    // maps it back). Guards the walker as much as the count: a walker that
    // found nothing would make the next test pass vacuously.
    expect(discriminators.length).toBe(8);
  });

  it("declares every one hidden, carrying the type its form creates", () => {
    expect(discriminators.map((field) => [field.type, field.value])).toEqual([
      ["hidden", "weapon"],
      ["hidden", "melee"],
      ["hidden", "armor"],
      ["hidden", "consumable"],
      ["hidden", "weapon"],
      ["hidden", "melee"],
      ["hidden", "armor"],
      ["hidden", "consumable"],
    ]);
  });
});
