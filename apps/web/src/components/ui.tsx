import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { formatAmount, formatMoney } from "../lib/money.js";
import { describeError } from "../lib/errors.js";
import { useMoneyFormat } from "../lib/formatContext.js";
import styles from "./ui.module.css";

/**
 * A titled block. Every page is a stack of these.
 *
 * The pointer's position inside the panel is written to two custom
 * properties so ui.module.css can hang a spotlight under the cursor — a
 * hover-only effect that CSS alone cannot place. Written straight to the
 * element's style rather than through state: it changes on every pointer
 * move and must not re-render the panel's children.
 */
export function Panel({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
  };
  return (
    <section className={styles.panel} onPointerMove={onPointerMove}>
      {title !== undefined ? <h2 className={styles.panelTitle}>{title}</h2> : null}
      {children}
    </section>
  );
}

/**
 * True for one animation after `value` changes from what it was — a figure
 * that ticks over (a crime paid out, a bet settled) gets a flash so the eye
 * lands on the number that moved. The first render is not a change; a page
 * load must not flash every figure on it.
 */
function useTick(value: string): { ticking: boolean; settle: () => void } {
  const previous = useRef(value);
  const [ticking, setTicking] = useState(false);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setTicking(true);
  }, [value]);
  return { ticking, settle: () => { setTicking(false); } };
}

/** A money string rendered as `$1,234` — or whatever `moneyFormat` the loaded
 *  plugins declare (lib/formatContext.tsx). Never converts to Number — see
 *  lib/money.ts. */
export function Money({ value }: { value: string }): JSX.Element {
  const format = useMoneyFormat();
  const { ticking, settle } = useTick(value);
  return (
    <span className={ticking ? `${styles.money} ${styles.tick}` : styles.money} onAnimationEnd={settle}>
      {formatMoney(value, format)}
    </span>
  );
}

/** A bigint-string count (bullets, exp) with thousands separators and no `$`
 *  — the separator still follows `moneyFormat`, since it's a display detail
 *  shared with plain amounts. */
export function Amount({ value }: { value: string }): JSX.Element {
  const format = useMoneyFormat();
  const { ticking, settle } = useTick(value);
  return (
    <span className={ticking ? `${styles.money} ${styles.tick}` : styles.money} onAnimationEnd={settle}>
      {formatAmount(value, format)}
    </span>
  );
}

/**
 * A server timestamp in the viewer's own locale and zone. Every `TimestampSchema`
 * value is ISO-8601 UTC, so `new Date` needs no format hint; the raw string
 * stays in `title`/`dateTime` for anyone comparing against a log.
 */
export function When({ iso }: { iso: string }): JSX.Element {
  return <time dateTime={iso} title={iso}>{new Date(iso).toLocaleString()}</time>;
}

export function Loading({ what = "" }: { what?: string }): JSX.Element {
  return <p className={`${styles.muted} ${styles.loading}`}>Loading{what ? ` ${what}` : ""}…</p>;
}

/** Renders nothing when there is no error, so callers can drop it in unguarded. */
export function ErrorText({ error }: { error: unknown }): JSX.Element | null {
  if (error === null || error === undefined) return null;
  return <p role="alert" className={styles.error}>{describeError(error)}</p>;
}

/**
 * A profile picture.
 *
 * `avatarUrl` is player-supplied. The schema (dto/profile.ts) normalises it and
 * allows only http(s), which makes it safe as an `<img src>` — it is never
 * rendered as an `href`, where even an http(s) URL is an off-site navigation
 * dressed up as part of the game. `referrerPolicy` keeps the viewer's current
 * page out of the request to whatever host the URL names.
 *
 * A URL that fails to load renders nothing, rather than the browser's broken
 * image glyph: a profile with a dead avatar should look like a profile with no
 * avatar.
 */
export function Avatar({ url, alt }: { url: string | null; alt: string }): JSX.Element | null {
  const [broken, setBroken] = useState(false);
  if (url === null || url === "" || broken) return null;
  return (
    <img
      className={styles.avatar}
      src={url}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => { setBroken(true); }}
    />
  );
}

/**
 * An action button that shows the wait instead of the label while locked.
 * `seconds` is the live countdown from useCountdowns, not a server snapshot.
 */
export function CooldownButton({
  label, seconds, disabled = false, onClick,
}: {
  label: string;
  seconds: number;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  const locked = seconds > 0;
  return (
    <button type="button" disabled={locked || disabled} onClick={onClick}>
      {locked ? `${seconds}s` : label}
    </button>
  );
}
