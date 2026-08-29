import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script module, shared with scripts/generate-errors.mjs
import { checkCatalog, collectErrorCodes } from "../../../scripts/error-catalog.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Drift guard for the generated error-code reference: every refusal code a
 * route can emit must have a meaning in manual/reference/error-meanings.json,
 * and every meaning must still correspond to a code in the source. The same
 * check aborts `npm run docs:generate` (scripts/generate-errors.mjs); this
 * copy runs under verify:ci so the drift fails the PR, not the docs deploy.
 */
describe("error-code catalog", () => {
  const catalog = collectErrorCodes(repoRoot) as Map<
    string,
    { statuses: Set<number>; owners: Set<string> }
  >;
  const meanings = JSON.parse(
    readFileSync(path.join(repoRoot, "manual/reference/error-meanings.json"), "utf8"),
  ) as Record<string, string>;

  it("finds a plausible number of codes (extraction did not silently break)", () => {
    // 176 as of 2026-08-29. A regex change that stops matching would crater
    // this; a floor rather than an exact count so adding codes stays free.
    expect(catalog.size).toBeGreaterThan(150);
  });

  it("every thrown code has a documented meaning", () => {
    const { missing } = checkCatalog(catalog, meanings);
    expect(missing).toEqual([]);
  });

  it("no meaning is stale (its code gone from the source)", () => {
    const { stale } = checkCatalog(catalog, meanings);
    expect(stale).toEqual([]);
  });
});
