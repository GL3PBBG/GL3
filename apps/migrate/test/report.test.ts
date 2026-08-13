import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bumpTable, createReport, finishReport, formatHumanSummary,
  recordDroppedCrimePosition, recordOrphan, recordUnknownTimerKey, writeReportFile,
} from "../src/report.js";

describe("MigrationReport", () => {
  it("accumulates per-table counts, orphans, unknown keys, and dropped positions", () => {
    const report = createReport(false);
    bumpTable(report, "users", "read");
    bumpTable(report, "users", "read");
    bumpTable(report, "users", "written");
    bumpTable(report, "users", "skipped");
    recordOrphan(report, "userInventory", 4, "item 99 does not exist");
    recordUnknownTimerKey(report, "someCustomModuleKey");
    recordDroppedCrimePosition(report, 2, 3);
    report.unknownTables = ["premiumMembership", "blackjackHands"];

    const users = report.tables.find((t) => t.table === "users");
    expect(users).toEqual({ table: "users", read: 2, written: 1, skipped: 1 });
    expect(report.orphans).toEqual([{ table: "userInventory", v2Id: 4, reason: "item 99 does not exist" }]);
    expect(report.unknownTimerKeys).toEqual(["someCustomModuleKey"]);
    expect(report.droppedCrimePositions).toEqual([{ playerV2Id: 2, position: 3 }]);
  });

  it("deduplicates repeated unknown timer keys", () => {
    const report = createReport(false);
    recordUnknownTimerKey(report, "k");
    recordUnknownTimerKey(report, "k");
    expect(report.unknownTimerKeys).toEqual(["k"]);
  });

  it("finishReport sets finishedAt and a non-negative duration", () => {
    const report = createReport(false);
    finishReport(report);
    expect(report.finishedAt).not.toBeNull();
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("writes valid JSON to disk", async () => {
    const report = createReport(true);
    finishReport(report);
    const dir = await mkdtemp(join(tmpdir(), "gl3-migrate-report-"));
    const path = join(dir, "report.json");
    await writeReportFile(report, path);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.dryRun).toBe(true);
  });

  it("formats a human summary mentioning table counts and orphan totals", () => {
    const report = createReport(false);
    bumpTable(report, "users", "written");
    recordOrphan(report, "mail", 4, "recipient 999 does not exist");
    finishReport(report);
    const summary = formatHumanSummary(report);
    expect(summary).toContain("users");
    expect(summary).toContain("1 orphan");
  });
});
