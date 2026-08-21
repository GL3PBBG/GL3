// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "../src/hooks/useDebouncedValue.js";

// The search box on /players fires a request per settled value. Without the
// reset-on-change behaviour below, every keystroke of a typed name would be a
// separate query — the timer restarting is the whole point of the hook.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDebouncedValue", () => {
  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("al", 300));
    expect(result.current).toBe("al");
  });

  it("withholds a new value until the delay has elapsed", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 300),
      { initialProps: { value: "al" } },
    );

    rerender({ value: "alba" });
    expect(result.current).toBe("al");

    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe("al");

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("alba");
  });

  it("restarts the timer on every change, so only the last value settles", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 300),
      { initialProps: { value: "a" } },
    );

    // Four "keystrokes" 200ms apart: 800ms of typing, none of it long enough
    // to settle. A non-resetting implementation would have emitted by now.
    for (const value of ["al", "alb", "alba", "albat"]) {
      rerender({ value });
      act(() => vi.advanceTimersByTime(200));
    }
    expect(result.current).toBe("a");

    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe("albat");
  });

  it("cancels the pending timer on unmount", () => {
    const { rerender, unmount } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value, 300),
      { initialProps: { value: "al" } },
    );

    rerender({ value: "alba" });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
