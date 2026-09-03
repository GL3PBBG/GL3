import { describe, expect, it } from "vitest";
import type { GameEvent } from "@gl3/shared";
import { eventTone } from "../src/lib/eventCopy.js";

// The toast's colour is the one place an event's outcome is read as a
// category rather than as copy. Pinned so a crime that pays out can never
// pop red, and an unknown plugin event never guesses.
describe("eventTone", () => {
  it("reads a crime's outcome from its success flag", () => {
    const base = { id: "1", at: "2026-01-01T00:00:00.000Z", playerId: "p", crimeId: "c", crimeName: "Pickpocket" };
    expect(eventTone({ ...base, type: "crime.resolved", success: true, payout: "10", exp: 1 } as GameEvent)).toBe("good");
    expect(eventTone({ ...base, type: "crime.resolved", success: false, payout: "0", exp: 0 } as GameEvent)).toBe("bad");
  });

  it("jail is bad, release is good, a plugin event is neutral", () => {
    expect(eventTone({ id: "2", at: "", type: "player.jailed", playerId: "p", reason: "caught", until: "" } as unknown as GameEvent)).toBe("bad");
    expect(eventTone({ id: "3", at: "", type: "player.released", playerId: "p" } as unknown as GameEvent)).toBe("good");
    expect(eventTone({ id: "4", at: "", type: "plugin.event", pluginId: "x", name: "y", playerId: "p", data: {} } as unknown as GameEvent)).toBe("neutral");
  });
});
