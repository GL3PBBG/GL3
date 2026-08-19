import { describe, expect, it } from "vitest";
import { playersPage } from "../src/admin/players-page.js";
import { rolesPage } from "../src/admin/roles-page.js";
import { roundsPage } from "../src/admin/rounds-page.js";
import { CORE_PLUGINS } from "../src/plugins/core-plugins.js";

/**
 * Admin tables must not render raw UUIDs. The ids stay in the *payload* —
 * every `select` field consumes one as its `valueKey` — but a column that
 * shows one is a wall of noise the admin has to read past to find the name,
 * which is how the travel section's "Add town" form got missed entirely.
 *
 * Checked against the manifests rather than the rendered page because the
 * `columns` array is the only place the decision is expressed: a table with
 * no id column cannot grow one without failing here.
 */
const ID_COLUMN_RE = /^id$|Id$/;

function tableColumnKeys(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  const keys: string[] = [];
  if ("kind" in node && node.kind === "table" && "columns" in node && Array.isArray(node.columns)) {
    for (const column of node.columns) {
      if (typeof column === "object" && column !== null && "key" in column) {
        keys.push(String(column.key));
      }
    }
  }
  for (const field of ["children", "items"] as const) {
    if (field in node && Array.isArray(node[field])) {
      for (const child of node[field] as unknown[]) keys.push(...tableColumnKeys(child));
    }
  }
  return keys;
}

describe("admin tables never display an id column", () => {
  const sections: { label: string; view: unknown }[] = [
    ...CORE_PLUGINS.flatMap((manifest) =>
      manifest.adminPages.map((page) => ({ label: `${manifest.id}:${page.id}`, view: page.view })),
    ),
    { label: `core:${rolesPage.id}`, view: rolesPage.view },
    { label: `core:${roundsPage.id}`, view: roundsPage.view },
    { label: `core:${playersPage.id}`, view: playersPage.view },
  ];

  it("covers every core admin page that has one", () => {
    // Guards the walker itself: a refactor that stopped finding adminPages
    // would make every assertion below vacuously pass. The floor equals
    // reality on this branch: nine plugins declare adminPages plus forum's
    // new `forum-admin` section (task 14), ten total, plus roles and rounds
    // hand-written here, is 12.
    expect(sections.length).toBeGreaterThanOrEqual(12);
  });

  for (const section of sections) {
    it(`${section.label} shows no id column`, () => {
      const offenders = tableColumnKeys(section.view).filter((key) => ID_COLUMN_RE.test(key));
      expect(offenders).toEqual([]);
    });
  }
});
