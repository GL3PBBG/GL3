import { describe, expect, it } from "vitest";
import {
  SENTENCE_SAFETY_POLL_MS, TABLE_POLL_MS, hospitalRefetchInterval, jailRefetchInterval,
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

describe("the casino table poll", () => {
  it("is a backstop now that the table has a WebSocket behind it", () => {
    // It used to be 2500, because casino published nothing and the poll was
    // both the realtime channel and the clock's heartbeat. The hub now
    // publishes a SILENT `table` event to every seat at the end of each
    // mutating table transaction, which invalidates this query the moment
    // anything happens — so the poll is left with the one job WS cannot do.
    // The table's clock (`advanceTable`) only runs when somebody READS the
    // table, and a table nobody is acting at produces no request to publish
    // from, so this interval caps how long a lapsed turn can sit
    // un-auto-stood.
    expect(TABLE_POLL_MS).toBe(15_000);
  });
});
