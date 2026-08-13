import { describe, expect, it } from "vitest";
import { createDb } from "../../server/src/db/client.js";
import { createIsolatedPgTarget } from "./helpers/fixtures.js";
import { getOrCreateV3Id, lookupV3Id } from "../src/id-map.js";

describe("getOrCreateV3Id / lookupV3Id", () => {
  it("creates a new mapping on first call and reuses it on the second", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      const first = await getOrCreateV3Id(db, "users", 42);
      expect(first.created).toBe(true);
      expect(first.v3Id).toMatch(/^[0-9a-f-]{36}$/);

      const second = await getOrCreateV3Id(db, "users", 42);
      expect(second.created).toBe(false);
      expect(second.v3Id).toBe(first.v3Id); // same V2 row -> same GL3 uuid, always

      await sql.end();
    } finally {
      await target.teardown();
    }
  });

  it("keeps separate tables' id spaces distinct even with the same v2Id", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      const user = await getOrCreateV3Id(db, "users", 1);
      const gang = await getOrCreateV3Id(db, "gangs", 1);
      expect(user.v3Id).not.toBe(gang.v3Id);
      await sql.end();
    } finally {
      await target.teardown();
    }
  });

  it("lookupV3Id returns null for an id that was never mapped", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      expect(await lookupV3Id(db, "users", 999)).toBeNull();
      await sql.end();
    } finally {
      await target.teardown();
    }
  });
});
