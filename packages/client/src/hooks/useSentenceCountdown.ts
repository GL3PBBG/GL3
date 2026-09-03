import { useEffect, useRef } from "react";
import { useCountdowns } from "./useCountdowns.js";
import { countdownSeconds } from "../lib/countdown.js";

/**
 * Live seconds for a server-issued sentence (jail, hospital).
 *
 * Every place that shows one needs the same three things: anchor the deadline
 * to the server's snapshot, tick it locally between anchors, and show 0 rather
 * than the stale snapshot once it runs out.
 *
 * The old 2-second poll hid the middle one — it re-fetched often enough that a
 * component rendering the raw `remainingSeconds` *looked* like it was counting
 * down. With the poll cut to the 30s socket-down backstop, any such component
 * visibly freezes; Shell's jail banner and the dashboard's jail panel both did.
 * Rendering through this hook is what keeps a new call site from repeating it.
 *
 * Pass `undefined` when there is no active sentence: the anchor is skipped and
 * the hook stays at 0 without disturbing the shared deadline map.
 *
 * Pass the query's `dataUpdatedAt` as `asOfMs`: a page mounting reads the
 * cached response first, and anchoring that stale reading at "now" restarts the
 * sentence at full length on screen (see lib/countdown.ts).
 */
export function useSentenceCountdown(
  id: string, snapshotSeconds: number | undefined, asOfMs?: number,
): number {
  const { remaining, seed } = useCountdowns();
  // Not state: it must not itself trigger a render, and the render that reads
  // it is always driven by the tick or by a fresh snapshot anyway.
  const anchored = useRef(false);

  useEffect(() => {
    if (snapshotSeconds === undefined || snapshotSeconds <= 0) return;
    seed(id, snapshotSeconds, asOfMs);
    anchored.current = true;
  }, [id, snapshotSeconds, asOfMs, seed]);

  return countdownSeconds(remaining[id], snapshotSeconds ?? 0, anchored.current);
}
