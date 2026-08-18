import { describe, expect, it } from "vitest";
import {
  BustResponseSchema, CellBlockListResponseSchema, CheckinResponseSchema, WardListResponseSchema,
} from "../src/index.js";

describe("facility DTOs", () => {
  it("parses a ward listing", () => {
    const parsed = WardListResponseSchema.parse({
      patients: [{
        playerId: "018f0000-0000-7000-8000-000000000001",
        username: "Vic", rankName: "Thug",
        until: "2026-08-18T12:00:00.000Z", remainingSeconds: 90, dischargeCost: "90000",
      }],
    });
    expect(parsed.patients[0]?.dischargeCost).toBe("90000");
  });

  it("rejects money sent as a JSON number", () => {
    expect(() => CellBlockListResponseSchema.parse({
      inmates: [{
        playerId: "018f0000-0000-7000-8000-000000000001",
        username: "Vic", rankName: "Thug",
        until: "2026-08-18T12:00:00.000Z", remainingSeconds: 90, bailCost: 90000,
      }],
    })).toThrow();
  });

  it("parses a check-in and a bust outcome", () => {
    expect(CheckinResponseSchema.parse({
      health: 0, maxHealth: 100, hospitalised: true,
      until: "2026-08-18T12:00:00.000Z", remainingSeconds: 300, dischargeCost: "300000",
    }).remainingSeconds).toBe(300);

    expect(BustResponseSchema.parse({ success: false, jailedUntil: "2026-08-18T12:05:00.000Z" })
      .success).toBe(false);
    expect(BustResponseSchema.parse({ success: true, jailedUntil: null }).jailedUntil).toBeNull();
  });
});
