import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live, per-id second-countdown for crime cooldowns.
 *
 * The server returns `cooldownRemaining` as a point-in-time snapshot from
 * `peekCooldown` (a Redis TTL read, see server game/cooldown.ts). Without a
 * client-side tick that number is frozen on screen until the next fetch —
 * the button reads "30s" forever even as the real cooldown drains. This hook
 * owns the draining.
 *
 * Seeds from the fetched snapshot (so a page load mid-cooldown starts ticking
 * correctly) and lets a caller `start(id, seconds)` a fresh timer when a crime
 * is committed. One interval drives every active id; ids that reach 0 are
 * dropped from state so the button re-enables.
 */
export function useCountdowns() {
  const [remaining, setRemaining] = useState<Record<string, number>>({});
  // setRemaining inside the interval closure reads a stale `remaining` unless we
  // route through a ref — the functional-updater form below avoids that without
  // resubscribing the interval every tick.
  const remainingRef = useRef(remaining);
  remainingRef.current = remaining;

  useEffect(() => {
    const tick = window.setInterval(() => {
      setRemaining((prev) => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [id, seconds] of Object.entries(prev)) {
          if (seconds > 1) {
            next[id] = seconds - 1;
            changed = true;
          } else {
            changed = true; // dropping a finished timer re-enables the button
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => window.clearInterval(tick);
  }, []);

  /** Seed remaining seconds for an id from a fresh snapshot (no-op if 0/free). */
  const seed = useCallback((id: string, seconds: number) => {
    if (seconds > 0) {
      setRemaining((prev) => (prev[id] === undefined ? { ...prev, [id]: seconds } : prev));
    }
  }, []);

  /** Start a fresh countdown for an id (e.g. when its crime is committed). */
  const start = useCallback((id: string, seconds: number) => {
    setRemaining((prev) => ({ ...prev, [id]: seconds }));
  }, []);

  return { remaining, seed, start };
}
