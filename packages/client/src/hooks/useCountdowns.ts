import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Deadlines, pruneExpired, secondsLeft, seedDeadline, startDeadline,
} from "../lib/countdown.js";

/**
 * Live, per-id second-countdown for crime cooldowns and the jail sentence.
 *
 * The server returns `cooldownRemaining` / `remainingSeconds` as a
 * point-in-time snapshot (`peekCooldown`, a Redis TTL read, see server
 * game/cooldown.ts; a `jailed_until` diff for jail). Without a client-side tick
 * that number is frozen on screen until the next fetch — the button reads "30s"
 * forever even as the real cooldown drains. This hook owns the draining.
 *
 * State is absolute deadlines, not a number this hook ticks downward itself;
 * lib/countdown.ts explains why (throttled tabs and sleep drop ticks, and the
 * drift was permanent). The interval below only forces a re-render, so missed
 * ticks cost display latency and never correctness, and `seed()` re-anchors a
 * *running* timer whenever the server's snapshot disagrees with it.
 */
export function useCountdowns() {
  const [deadlines, setDeadlines] = useState<Deadlines>({});
  // Not derived from `deadlines`: a passing second changes every displayed
  // number without changing any deadline, so the tick needs its own state to
  // drive the re-render.
  const [now, setNow] = useState(() => Date.now());

  // The ticker runs only while something is counting. Shell mounts this hook
  // for the whole session (via useSentenceCountdown), and an unconditional
  // interval re-rendered the nav, HUD and feed every second forever; with no
  // deadlines there is nothing on screen a tick could change. Expiry tears it
  // down again: the last prune empties `deadlines` and the effect cleans up.
  const hasDeadlines = Object.keys(deadlines).length > 0;
  useEffect(() => {
    if (!hasDeadlines) return;
    const tick = setInterval(() => {
      const current = Date.now();
      setNow(current);
      setDeadlines((prev) => pruneExpired(prev, current));
    }, 1000);
    return () => clearInterval(tick);
  }, [hasDeadlines]);

  const remaining = useMemo(() => {
    const seconds: Record<string, number> = {};
    for (const [id, deadline] of Object.entries(deadlines)) seconds[id] = secondsLeft(deadline, now);
    return seconds;
  }, [deadlines, now]);

  /**
   * Re-anchor an id to a server snapshot (ignores 0 / free).
   *
   * `asOfMs` is when that snapshot was read — pass a query's `dataUpdatedAt`.
   * Omitting it treats the snapshot as current, which is only true for a value
   * that just arrived; a cached one served on remount is older than that.
   */
  const seed = useCallback((id: string, seconds: number, asOfMs?: number) => {
    const now = Date.now();
    // With the ticker stopped, `now` state goes stale; a countdown anchored
    // against it would read minutes too long until the first tick corrects it.
    setNow(now);
    setDeadlines((prev) => seedDeadline(prev, id, seconds, now, asOfMs ?? now));
  }, []);

  /** Start a fresh countdown for an id (e.g. when its crime is committed). */
  const start = useCallback((id: string, seconds: number) => {
    const now = Date.now();
    setNow(now);
    setDeadlines((prev) => startDeadline(prev, id, seconds, now));
  }, []);

  return { remaining, seed, start };
}
