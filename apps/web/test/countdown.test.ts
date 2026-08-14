import { describe, expect, it } from "vitest";
import {
  countdownSeconds, pruneExpired, seedDeadline, secondsLeft, startDeadline,
} from "../src/lib/countdown.js";

const T0 = 1_800_000_000_000;

describe("secondsLeft", () => {
  it("derives the remaining seconds from wall-clock, not from a tick count", () => {
    expect(secondsLeft(T0 + 120_000, T0)).toBe(120);
    // A tab that was throttled or asleep for two minutes gets the truth back
    // on its very next render, because nothing here counts intervals.
    expect(secondsLeft(T0 + 120_000, T0 + 119_000)).toBe(1);
    expect(secondsLeft(T0 + 120_000, T0 + 121_000)).toBe(0);
  });

  it("rounds up, so a sub-second remainder never reads as free", () => {
    expect(secondsLeft(T0 + 200, T0)).toBe(1);
  });
});

describe("startDeadline", () => {
  it("anchors an id to now + seconds", () => {
    expect(startDeadline({}, "crime", 300, T0)).toEqual({ crime: T0 + 300_000 });
  });

  it("replaces an existing deadline unconditionally", () => {
    expect(startDeadline({ crime: T0 + 10_000 }, "crime", 300, T0)).toEqual({ crime: T0 + 300_000 });
  });
});

describe("seedDeadline", () => {
  it("anchors an id that is not running", () => {
    expect(seedDeadline({}, "jail", 45, T0)).toEqual({ jail: T0 + 45_000 });
  });

  it("re-anchors a drifted timer to the server's number", () => {
    // The local clock believes 118s remain; the server says 60. Whatever the
    // cause (throttled tab, sleep, dropped ticks), the server is the truth and
    // the drift has to be correctable — the old guard made it permanent.
    const drifted = { jail: T0 + 118_000 };
    expect(seedDeadline(drifted, "jail", 60, T0)).toEqual({ jail: T0 + 60_000 });
  });

  it("ignores a snapshot that merely lags by a second", () => {
    // Every poll is a round trip old. Re-anchoring on that would make the
    // display stutter once per poll for no gain.
    const running = { jail: T0 + 60_000 };
    expect(seedDeadline(running, "jail", 59, T0)).toBe(running);
  });

  it("ignores zero, so a stale snapshot cannot unlock an optimistic timer", () => {
    // `GET /api/crimes` issued before the commit lands still reports 0s
    // cooldown; adopting it would re-enable the button into a 429.
    const running = { crime: T0 + 300_000 };
    expect(seedDeadline(running, "crime", 0, T0)).toBe(running);
    expect(seedDeadline({}, "crime", 0, T0)).toEqual({});
  });
});

describe("pruneExpired", () => {
  it("drops deadlines that have passed", () => {
    expect(pruneExpired({ crime: T0 - 1, jail: T0 + 5_000 }, T0)).toEqual({ jail: T0 + 5_000 });
  });

  it("returns the same object when nothing expired, to keep render identity", () => {
    const live = { jail: T0 + 5_000 };
    expect(pruneExpired(live, T0)).toBe(live);
  });
});

describe("countdownSeconds", () => {
  it("prefers the live tick over the server snapshot", () => {
    // The snapshot is a round trip old the moment it arrives; the local tick
    // is what the player is actually watching.
    expect(countdownSeconds(57, 60, true)).toBe(57);
  });

  it("shows the snapshot before the first anchor, so nothing flashes 0:00", () => {
    // One render happens between the query resolving and the seeding effect
    // running. Reading 0 there would blink the sentence away and back.
    expect(countdownSeconds(undefined, 60, false)).toBe(60);
  });

  it("reads 0 once an anchored countdown expires, not the stale snapshot", () => {
    // This is the regression: pruneExpired drops the id at expiry, and falling
    // back to the snapshot made the clock hit 0:00 and jump back to the full
    // sentence until the next fetch — up to 30s with the socket down.
    expect(countdownSeconds(undefined, 60, true)).toBe(0);
  });
});
