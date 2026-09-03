import { useEffect, useRef, useState } from "react";
import type { GameEvent } from "@gl3/shared";
import { describeEvent, eventTone, type EventTone, useEvents, usePlugins } from "@gl3/client";
import styles from "./EventToasts.module.css";

const TOAST_MS = 5000;
const MAX_TOASTS = 3;

type Toast = { id: string; text: string; tone: EventTone };

/**
 * Pop-up copies of live-feed lines, for the layouts where the feed itself is
 * below the fold (the phone: the aside stacks under the page). On a desktop
 * the feed is beside the page and already in view, so the stylesheet hides
 * this whole component there — the events are the same either way.
 *
 * Every event already in the store when this mounts is skipped: those are
 * history, and a page load must not fire a stack of stale toasts. Only ids
 * that appear afterwards pop. Purely visual — the feed's role="log" is what
 * announces to a screen reader, so this is aria-hidden to avoid saying each
 * outcome twice.
 */
export function EventToasts(): JSX.Element | null {
  const events = useEvents();
  const plugins = usePlugins();
  const eventMetas = plugins.data?.events ?? [];
  const [toasts, setToasts] = useState<Toast[]>([]);
  // `null` until the first render has seeded it: the seed must include
  // whatever the store held at mount, not the empty array of a fresh ref.
  const seen = useRef<Set<string> | null>(null);
  // Live timeouts, cleared only on unmount — NOT in the effect's own cleanup,
  // which runs on every new event and would cancel the previous toast's
  // countdown, leaving it on screen until tapped.
  const timers = useRef<Set<number>>(new Set());
  useEffect(() => () => { for (const timer of timers.current) window.clearTimeout(timer); }, []);

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(events.map((event) => event.id));
      return;
    }
    const fresh: GameEvent[] = [];
    for (const event of events) {
      if (seen.current.has(event.id)) continue;
      seen.current.add(event.id);
      fresh.push(event);
    }
    if (fresh.length === 0) return;
    // The store is newest-first; toasts stack newest on top, so the newest
    // of a burst is what stays visible when the cap trims the rest.
    setToasts((current) => [
      ...fresh.map((event) => ({ id: event.id, text: describeEvent(event, eventMetas), tone: eventTone(event) })),
      ...current,
    ].slice(0, MAX_TOASTS));
    // Each fresh toast times itself out; a tap dismisses sooner.
    for (const event of fresh) {
      const timer = window.setTimeout(() => { timers.current.delete(timer); dismiss(event.id); }, TOAST_MS);
      timers.current.add(timer);
    }
    // eventMetas is derived from a query result; it re-resolves with the
    // events list rather than being a reason to re-run on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  function dismiss(id: string): void {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  if (toasts.length === 0) return null;
  return (
    <div className={styles.stack} aria-hidden="true">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`${styles.toast} ${styles[toast.tone]}`}
          onClick={() => { dismiss(toast.id); }}
        >
          {toast.text}
        </button>
      ))}
    </div>
  );
}
