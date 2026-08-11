import { describe, expect, it } from "vitest";
import { settings } from "../src/db/schema/index.js";
import { loadSettings } from "../src/settings/load.js";
import { testDb } from "./helpers/db.js";

describe("loadSettings", () => {
  it("returns an empty record when the table is empty", async () => {
    const { db } = await testDb();
    await db.delete(settings);
    expect(await loadSettings(db)).toEqual({});
  });

  it("reads every row into a key→value record", async () => {
    const { db } = await testDb();
    await db.delete(settings);
    await db.insert(settings).values([
      { key: "combat.cooldown_seconds", value: "60" },
      { key: "combat.hospital_seconds", value: "300" },
    ]);

    const loaded = await loadSettings(db);

    expect(loaded).toEqual({
      "combat.cooldown_seconds": "60",
      "combat.hospital_seconds": "300",
    });
  });
});
