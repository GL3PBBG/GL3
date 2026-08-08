import type { ReactNode } from "react";
import { formatAmount, formatMoney } from "../lib/money.js";
import { describeError } from "../lib/errors.js";
import styles from "./ui.module.css";

/** A titled block. Every page is a stack of these. */
export function Panel({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <section className={styles.panel}>
      {title !== undefined ? <h2 className={styles.panelTitle}>{title}</h2> : null}
      {children}
    </section>
  );
}

/** A money string rendered as `$1,234`. Never converts to Number — see lib/money.ts. */
export function Money({ value }: { value: string }): JSX.Element {
  return <span className={styles.money}>{formatMoney(value)}</span>;
}

/** A bigint-string count (bullets, exp) with thousands separators and no `$`. */
export function Amount({ value }: { value: string }): JSX.Element {
  return <span className={styles.money}>{formatAmount(value)}</span>;
}

export function Loading({ what = "" }: { what?: string }): JSX.Element {
  return <p className={styles.muted}>Loading{what ? ` ${what}` : ""}…</p>;
}

/** Renders nothing when there is no error, so callers can drop it in unguarded. */
export function ErrorText({ error }: { error: unknown }): JSX.Element | null {
  if (error === null || error === undefined) return null;
  return <p role="alert" className={styles.error}>{describeError(error)}</p>;
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
