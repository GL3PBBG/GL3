import { describe, expect, it } from "vitest";
import {
  SENTENCE_SAFETY_POLL_MS, hospitalRefetchInterval, jailRefetchInterval,
} from "../src/api/queries.js";

describe("sentence safety polling", () => {
  it("polls slowly while jailed", () => {
    expect(jailRefetchInterval({ jailed: true, until: null, remainingSeconds: 10 }))
      .toBe(SENTENCE_SAFETY_POLL_MS);
  });

  it("does not poll once free", () => {
    expect(jailRefetchInterval({ jailed: false, until: null, remainingSeconds: 0 })).toBe(false);
  });

  it("does not poll before the first response", () => {
    expect(jailRefetchInterval(undefined)).toBe(false);
    expect(hospitalRefetchInterval(undefined)).toBe(false);
  });

  it("polls slowly while hospitalised, and not at all when healthy", () => {
    expect(hospitalRefetchInterval({ hospitalised: true, until: null, remainingSeconds: 10 }))
      .toBe(SENTENCE_SAFETY_POLL_MS);
    // The bug this replaces: the hospital query polled unconditionally, so a
    // healthy player on /hospital hit the server every 2 seconds forever.
    expect(hospitalRefetchInterval({ hospitalised: false, until: null, remainingSeconds: 0 }))
      .toBe(false);
  });

  it("is far slower than the WebSocket it backs up", () => {
    expect(SENTENCE_SAFETY_POLL_MS).toBeGreaterThanOrEqual(30_000);
  });
});
