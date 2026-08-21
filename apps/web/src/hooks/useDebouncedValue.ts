import { useEffect, useState } from "react";

/**
 * The value, held back until it has stopped changing for `ms`.
 *
 * The effect's cleanup cancels the pending timer, so a change arriving mid-wait
 * restarts the clock rather than letting the earlier value through — which is
 * the whole point for a search box, where every keystroke would otherwise be a
 * request.
 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => { setSettled(value); }, ms);
    return () => { window.clearTimeout(timer); };
  }, [value, ms]);

  return settled;
}
