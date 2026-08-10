import { describe, expect, it } from "vitest";
import { newId } from "../src/index.js";

/**
 * A plugin cannot import `uuidv7` — the isolation rule allows only
 * `@gl3/plugin-sdk`, `zod` and `drizzle-orm` — and core tables have no
 * database-side id default, so a port that inserts a row needs this.
 */
describe("newId", () => {
  it("returns a distinct uuid on each call", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("is time-ordered, so ids sort by creation", () => {
    const ids = Array.from({ length: 50 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });
});
