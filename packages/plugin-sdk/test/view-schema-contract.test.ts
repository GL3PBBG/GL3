import { ViewNodeDtoSchema } from "@gl3/shared";
import type { z } from "zod";
import { describe, expect, it } from "vitest";
import { ViewNodeSchema } from "../src/pages.js";

/**
 * The ten-kind view vocabulary exists twice — `packages/plugin-sdk/src/pages.ts`
 * (what a plugin author writes) and `packages/shared/src/dto/plugins.ts` (what
 * the browser parses off `GET /api/plugins`). The duplication is deliberate:
 * `@gl3/shared` is the base layer and may not depend on `@gl3/plugin-sdk`, so the
 * DTO has to be self-contained. This test is the guard that keeps the copies
 * honest, and it lives here because `@gl3/plugin-sdk` is the one package allowed
 * to import both.
 *
 * Why it is worth a file of its own: `PluginsPayloadSchema.parse` is
 * all-or-nothing over `pages[]`. One field drifting on one side does not spoil
 * one node — it fails the whole payload, taking every plugin page *and* the
 * plugin nav down together, in the browser, from a one-line edit that passes
 * boot. There was nothing in the suite that would notice.
 *
 * The corpus is copied from `hello.allNodes` (`examples/hello-plugin`) rather
 * than imported: a `packages/*` test must not depend on an example app.
 */

/** A schema's verdict, phrased so a failing diff names the side that disagreed. */
function describeVerdict(name: string, success: boolean, issues: readonly z.ZodIssue[]): string {
  if (success) return `${name}: accepted`;
  const detail = issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
  return `${name}: rejected — ${detail}`;
}

function sdkVerdict(node: unknown): string {
  const result = ViewNodeSchema.safeParse(node);
  return describeVerdict("SDK", result.success, result.success ? [] : result.error.issues);
}

function dtoVerdict(node: unknown): string {
  const result = ViewNodeDtoSchema.safeParse(node);
  return describeVerdict("DTO", result.success, result.success ? [] : result.error.issues);
}

/** Every one of the eleven kinds, in the order the vocabulary declares them. */
const ACCEPTED: readonly (readonly [string, unknown])[] = [
  ["text", { kind: "text", value: "A text leaf." }],
  ["money", { kind: "money", value: "1234567" }],
  ["money with a negative amount", { kind: "money", value: "-2500" }],
  ["error", { kind: "error", value: "The plugin's own copy." }],
  ["link", { kind: "link", label: "Back", to: "/plugins/hello.index" }],
  ["button", { kind: "button", label: "Greet", action: "POST /api/hello/greet" }],
  [
    "cooldownButton",
    {
      kind: "cooldownButton",
      label: "Greet",
      action: "POST /api/hello/greet",
      cooldownAction: "hello_greet",
    },
  ],
  [
    "keyValue",
    {
      kind: "keyValue",
      rows: [
        { label: "Kind", value: "keyValue" },
        { label: "Renders as", value: "a definition list" },
      ],
    },
  ],
  [
    "form",
    {
      kind: "form",
      action: "POST /api/hello/greet",
      submitLabel: "Submit form",
      fields: [
        { name: "note", label: "Note", type: "text" },
        { name: "times", label: "Times", type: "number" },
        { name: "amount", label: "Amount", type: "money" },
        { name: "secret", label: "Secret", type: "password" },
      ],
    },
  ],
  [
    "form with a select field",
    {
      kind: "form",
      action: "POST /api/hello/greet",
      submitLabel: "Submit form",
      fields: [
        {
          name: "thingId",
          label: "Thing",
          type: "select",
          optionsSource: "GET /api/hello/things",
          valueKey: "id",
          labelKey: "name",
        },
      ],
    },
  ],
  [
    "form with a select field allowing empty",
    {
      kind: "form",
      action: "POST /api/hello/greet",
      submitLabel: "Submit form",
      fields: [
        {
          name: "thingId",
          label: "Thing (empty clears)",
          type: "select",
          optionsSource: "GET /api/hello/things",
          valueKey: "id",
          labelKey: "name",
          allowEmpty: true,
        },
      ],
    },
  ],
  ["panel", { kind: "panel", title: "Leaves", children: [{ kind: "text", value: "A leaf." }] }],
  ["panel with an empty body", { kind: "panel", title: "Empty", children: [] }],
  ["list", { kind: "list", items: [{ kind: "text", value: "An item." }] }],
  ["table", { kind: "table", source: "GET /api/admin/things", columns: [{ key: "id", label: "Id" }] }],
];

/**
 * Each entry probes a *different* field or rule, so a drift confined to one part
 * of one node is still caught. Both schemas must reject every one; a case only
 * one side rejects is exactly the drift this file exists to name.
 */
const REJECTED: readonly (readonly [string, unknown])[] = [
  ["an unknown kind", { kind: "notARealKind", value: "x" }],
  ["a node with no kind at all", { value: "x" }],
  ["an unknown extra property on a strict leaf", { kind: "text", value: "x", extra: "sneak" }],
  ["a missing required field", { kind: "link", to: "/plugins/hello.index" }],
  ["a field of the wrong type", { kind: "text", value: 42 }],
  ["a link.to that is protocol-relative", { kind: "link", label: "L", to: "//evil.example" }],
  ["a link.to that is backslash-relative", { kind: "link", label: "L", to: "/\\evil.example" }],
  ["an action carrying no method", { kind: "button", label: "B", action: "/api/hello/greet" }],
  [
    "an action pointing at an absolute URL",
    { kind: "button", label: "B", action: "POST https://evil.example/steal" },
  ],
  [
    "a cooldownAction carrying a Redis key separator",
    {
      kind: "cooldownButton",
      label: "Greet",
      action: "POST /api/hello/greet",
      cooldownAction: "crime:other",
    },
  ],
  ["a money value with a decimal point", { kind: "money", value: "10.00" }],
  ["a money value that is not numeric", { kind: "money", value: "lots" }],
  [
    "a keyValue row with an unknown property",
    { kind: "keyValue", rows: [{ label: "K", value: "V", extra: "sneak" }] },
  ],
  [
    "a form field type outside the enum",
    {
      kind: "form",
      action: "POST /api/hello/greet",
      submitLabel: "Go",
      fields: [{ name: "email", label: "Email", type: "email" }],
    },
  ],
  [
    "a form whose fields are not an array",
    { kind: "form", action: "POST /api/hello/greet", submitLabel: "Go", fields: "none" },
  ],
  [
    "a select field with no optionsSource",
    {
      kind: "form",
      action: "POST /api/hello/greet",
      submitLabel: "Go",
      fields: [{ name: "thingId", label: "Thing", type: "select", valueKey: "id", labelKey: "name" }],
    },
  ],
  [
    "a select optionsSource pointing at an absolute URL",
    {
      kind: "form",
      action: "POST /api/hello/greet",
      submitLabel: "Go",
      fields: [
        {
          name: "thingId",
          label: "Thing",
          type: "select",
          optionsSource: "GET https://evil.example/steal",
          valueKey: "id",
          labelKey: "name",
        },
      ],
    },
  ],
  [
    "a select optionsSource that is not a GET",
    {
      kind: "form",
      action: "POST /api/hello/greet",
      submitLabel: "Go",
      fields: [
        {
          name: "thingId",
          label: "Thing",
          type: "select",
          optionsSource: "POST /api/hello/things",
          valueKey: "id",
          labelKey: "name",
        },
      ],
    },
  ],
  [
    "a basic form field smuggling select-only properties",
    {
      kind: "form",
      action: "POST /api/hello/greet",
      submitLabel: "Go",
      fields: [
        { name: "note", label: "Note", type: "text", optionsSource: "GET /api/hello/things" },
      ],
    },
  ],
  [
    "a bad node nested inside a panel",
    { kind: "panel", title: "P", children: [{ kind: "text", value: "ok" }, { kind: "nope" }] },
  ],
  [
    "a bad node nested inside a list",
    { kind: "list", items: [{ kind: "money", value: "1.5" }] },
  ],
  ["a panel with no title", { kind: "panel", children: [] }],
];

describe("view vocabulary contract between the SDK and the DTO", () => {
  it("covers all eleven kinds in the accept corpus", () => {
    const kinds = new Set(
      ACCEPTED.map(([, node]) =>
        typeof node === "object" && node !== null && "kind" in node ? node.kind : undefined,
      ),
    );
    expect(kinds).toEqual(
      new Set([
        "text",
        "money",
        "error",
        "link",
        "button",
        "cooldownButton",
        "keyValue",
        "form",
        "panel",
        "list",
        "table",
      ]),
    );
  });

  it.each(ACCEPTED)("both schemas accept %s", (_label, node) => {
    expect([sdkVerdict(node), dtoVerdict(node)]).toEqual(["SDK: accepted", "DTO: accepted"]);
  });

  // The reject corpus asserts agreement on the verdict, not on the wording:
  // the two files phrase a handful of issues differently and always will. A
  // side that *accepts* is the drift; a side that rejects for its own reasons
  // is not.
  it.each(REJECTED)("both schemas reject %s", (_label, node) => {
    const verdicts = [
      ViewNodeSchema.safeParse(node).success ? "SDK: accepted" : "SDK: rejected",
      ViewNodeDtoSchema.safeParse(node).success ? "DTO: accepted" : "DTO: rejected",
    ];
    expect(verdicts).toEqual(["SDK: rejected", "DTO: rejected"]);
  });
});
