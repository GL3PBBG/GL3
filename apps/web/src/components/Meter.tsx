import styles from "./Meter.module.css";

/**
 * A labeled progress bar. Shared by the `meter`/`meterSource` view nodes
 * (`plugins/PageRenderer.tsx`) and the Shell's attribute pool bars, so a
 * gym-plugin page and the always-on HUD draw pools identically.
 *
 * `max` is clamped away from zero and `value` away from the resulting range —
 * a stale or out-of-range read (a pool mid-spend, a plugin's own bug) must
 * still draw a fill between 0% and 100%, never NaN or past either end.
 * `aria-valuenow`/`aria-valuemax` carry the raw, unclamped numbers: they are
 * the fact being reported, not the drawn approximation of it.
 */
export function Meter({ label, value, max, compact = false }: {
  label: string; value: number; max: number;
  /** The Shell's icon HUD: no text caption (the caller pairs the bar with
   * an icon and a tooltip), a narrower track. aria-label still carries the
   * full label, so the compact bar reads identically to a screen reader. */
  compact?: boolean;
}): JSX.Element {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  const pct = (clamped / safeMax) * 100;
  return (
    <div className={compact ? `${styles.meter} ${styles.compact}` : styles.meter} title={`${label} ${value}/${max}`}>
      {compact ? null : <span className={styles.meterLabel}>{label}</span>}
      <div
        className={styles.meterTrack}
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div className={styles.meterFill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
