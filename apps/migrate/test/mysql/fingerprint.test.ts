import { describe, expect, it } from "vitest";
import { createIsolatedMysqlFixture } from "../helpers/fixtures.js";
import { createMysqlPool } from "../../src/mysql/client.js";
import { fingerprintV2Schema } from "../../src/mysql/fingerprint.js";

describe("fingerprintV2Schema", () => {
  it("passes on the full fixture and reports the genuinely custom table as unknown", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = await createMysqlPool(fixture.url);
      const result = await fingerprintV2Schema(pool);
      expect(result.ok).toBe(true);
      expect(result.missingTables).toEqual([]);
      expect(result.unknownTables.sort()).toEqual(["blackjackHands"]);
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });

  it("fails when users, userStats, or userTimers is missing", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = await createMysqlPool(fixture.url);
      await pool.query("DROP TABLE userTimers");
      const result = await fingerprintV2Schema(pool);
      expect(result.ok).toBe(false);
      expect(result.missingTables).toEqual(["userTimers"]);
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });

  it("fails when a required column is missing from a present table", async () => {
    const fixture = await createIsolatedMysqlFixture();
    try {
      const pool = await createMysqlPool(fixture.url);
      await pool.query("ALTER TABLE userStats DROP COLUMN US_crimes");
      const result = await fingerprintV2Schema(pool);
      expect(result.ok).toBe(false);
      expect(result.missingColumns.userStats).toEqual(["US_crimes"]);
      await pool.end();
    } finally {
      await fixture.teardown();
    }
  });
});
