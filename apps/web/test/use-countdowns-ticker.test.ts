// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCountdowns } from "../src/hooks/useCountdowns.js";

// The interval in useCountdowns exists only to drain visible countdowns. With
// nothing counting it must not run at all — Shell mounts this hook (via
// useSentenceCountdown) for the whole session, and an unconditional ticker
// re-renders the nav, HUD and feed every second forever.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCountdowns ticker lifecycle", () => {
  it("schedules no interval while nothing is counting", () => {
    renderHook(() => useCountdowns());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ticks while a countdown is live and stops once it expires", () => {
    const { result } = renderHook(() => useCountdowns());

    act(() => result.current.start("crime", 2));
    expect(vi.getTimerCount()).toBe(1);
    expect(result.current.remaining.crime).toBe(2);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.remaining.crime).toBe(1);

    // Deadline passes → pruned on its tick → interval torn down again.
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.remaining.crime).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not re-render an idle consumer as time passes", () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useCountdowns();
    });
    const rendersAfterMount = renders;

    act(() => vi.advanceTimersByTime(10_000));
    expect(renders).toBe(rendersAfterMount);
  });

  it("shows the true remaining seconds when a countdown starts after a long idle stretch", () => {
    // `now` state is only refreshed by the ticker; with the ticker stopped it
    // goes stale, and a countdown started 10 minutes into an idle session
    // would read as 630s if `remaining` were computed against mount-time now.
    const { result } = renderHook(() => useCountdowns());

    act(() => vi.advanceTimersByTime(600_000));
    act(() => result.current.start("crime", 30));
    expect(result.current.remaining.crime).toBe(30);
  });

  it("shows the true remaining seconds when seeded after a long idle stretch", () => {
    const { result } = renderHook(() => useCountdowns());

    act(() => vi.advanceTimersByTime(600_000));
    act(() => result.current.seed("jail", 45));
    expect(result.current.remaining.jail).toBe(45);
  });
});
