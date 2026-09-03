import { describe, expect, it } from "vitest";
import { playersPage } from "../src/admin/players-page.js";
import { rolesPage } from "../src/admin/roles-page.js";
import { roundsPage } from "../src/admin/rounds-page.js";
import { CORE_PLUGINS, MCCODES_PLUGINS } from "../src/plugins/core-plugins.js";

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
    // CORE_PLUGINS is FRAMEWORK_PLUGINS + GAMEPLAY_PLUGINS only (v2's
    // historical set) and never included the MCCodes family — walking it
    // alone let houses'/education's/jobs' admin sections go uncensused here
    // even after they shipped. MCCODES_PLUGINS is the gl3 union's other
    // half (`apps/server/src/plugins/core-plugins.ts`); walking both is what
    // it takes to reach every admin section a `gl3`-profile boot can serve.
    ...[...CORE_PLUGINS, ...MCCODES_PLUGINS].flatMap((manifest) =>
      manifest.adminPages.map((page) => ({ label: `${manifest.id}:${page.id}`, view: page.view })),
    ),
    { label: `core:${rolesPage.id}`, view: rolesPage.view },
    { label: `core:${roundsPage.id}`, view: roundsPage.view },
    { label: `core:${playersPage.id}`, view: playersPage.view },
  ];

  it("covers every core admin page that has one", () => {
    // Guards the walker itself: a refactor that stopped finding adminPages
    // would make every assertion below vacuously pass. `toBeGreaterThanOrEqual`
    // is what let two prior floor bumps land while the walker still only
    // covered `CORE_PLUGINS` (`FRAMEWORK_PLUGINS + GAMEPLAY_PLUGINS`, v2's
    // historical set) — houses'/education's/jobs' admin sections went
    // uncensused here the whole time despite the comments implying
    // otherwise, because a floor that only ever needs to be met, not
    // matched, tolerates a walker that quietly stopped finding some of its
    // targets. `toBe` closes that: this is now an EXACT count, restated by
    // actually running the walker (not by arithmetic) each time a plugin
    // gains or loses an admin section. Current count, walking
    // `CORE_PLUGINS` + `MCCODES_PLUGINS`: 15 pre-existing (nine plugins'
    // adminPages, forum's `forum-admin`, membership's `membership-admin`,
    // plus roles/rounds/players hand-written here) + 3 from the MCCodes
    // family (houses' `houses-admin`, education's `education-admin`, jobs'
    // `jobs-admin` — gym, temple, mccodes-attributes and progression
    // declare none) = 18, + combat's `combat-admin` (settings panel) = 19.
    expect(sections.length).toBe(19);
  });

  for (const section of sections) {
    it(`${section.label} shows no id column`, () => {
      const offenders = tableColumnKeys(section.view).filter((key) => ID_COLUMN_RE.test(key));
      expect(offenders).toEqual([]);
    });
  }
});
