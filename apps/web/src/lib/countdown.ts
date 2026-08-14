/**
 * Deadline arithmetic for the live countdowns (crime cooldown, jail sentence).
 *
 * The first version of this counted `setInterval(1000)` ticks and subtracted
 * one per tick. Two things make that wrong in a real browser: background tabs
 * throttle timers to as little as one tick per minute, and a suspended laptop
 * stops them altogether. The displayed number then drifts slow and never
 * recovers — a jail sentence that expired minutes ago still reads "1:58".
 *
 * So a timer is stored as an *absolute deadline* and the remaining seconds are
 * derived from `Date.now()` on every render. Skipped ticks then cost nothing:
 * the next render is correct regardless of how many were missed. The interval
 * that drives re-rendering becomes a repaint trigger, not the source of truth.
 *
 * The state is a plain `Record<id, epochMs>`; the reducers below return the
 * *same object* when nothing changed so React can bail out of the re-render.
 */
export type Deadlines = Readonly<Record<string, number>>;

/**
 * Seconds still to run, rounded up so a sub-second remainder never displays as
 * free, and floored at 0 so a passed deadline is never negative.
 */
export function secondsLeft(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

/** Start (or restart) a timer — used when an action is taken, e.g. a commit. */
export function startDeadline(
  deadlines: Deadlines, id: string, seconds: number, nowMs: number,
): Deadlines {
  return { ...deadlines, [id]: nowMs + seconds * 1000 };
}

/**
 * How far the server's snapshot may sit from the local deadline before we
 * adopt it. Every poll is a round trip old, so a 1s disagreement is normal and
 * re-anchoring on it would make the display stutter once per poll.
 */
const DRIFT_TOLERANCE_SECONDS = 2;

/**
 * Re-anchor a timer to a server snapshot.
 *
 * Unlike the old `seed`, this corrects a timer that is *already* running — a
 * local clock that drifted has no way back otherwise, which is precisely how a
 * jail countdown got stuck. `seconds <= 0` is still ignored: a `GET /api/crimes`
 * issued before a commit lands reports a 0s cooldown, and adopting it would
 * re-enable the button straight into a 429.
 */
export function seedDeadline(
  deadlines: Deadlines, id: string, seconds: number, nowMs: number,
): Deadlines {
  if (seconds <= 0) return deadlines;
  const current = deadlines[id];
  if (current !== undefined
    && Math.abs(secondsLeft(current, nowMs) - seconds) < DRIFT_TOLERANCE_SECONDS) {
    return deadlines;
  }
  return { ...deadlines, [id]: nowMs + seconds * 1000 };
}

/**
 * The seconds to display for a countdown whose id may already be pruned.
 *
 * `pruneExpired` drops a deadline the moment it passes, so `remaining[id]`
 * goes undefined exactly at expiry. A naive `remaining[id] ?? snapshot` then
 * falls back to the server's *old* snapshot: the clock reaches 0:00 and jumps
 * straight back to the full sentence until the next fetch anchors it again.
 * Once a countdown has been anchored, a missing id means finished — not
 * unknown — which is what `anchored` distinguishes.
 */
export function countdownSeconds(
  live: number | undefined, snapshot: number, anchored: boolean,
): number {
  if (live !== undefined) return live;
  return anchored ? 0 : snapshot;
}

/** Drop finished timers so the button they gate re-enables. */
export function pruneExpired(deadlines: Deadlines, nowMs: number): Deadlines {
  const live: Record<string, number> = {};
  let dropped = false;
  for (const [id, deadline] of Object.entries(deadlines)) {
    if (deadline > nowMs) live[id] = deadline;
    else dropped = true;
  }
  return dropped ? live : deadlines;
}
