/**
 * Pure geometry for the inline-SVG charts on /stats. No DOM, no React — the
 * page only turns these numbers into elements, so every edge case (an empty
 * day range, a series that is all zeros, a money figure past 2^53) is
 * testable without a renderer.
 *
 * Everything here works in **fractions of the series maximum** (0..1) before
 * touching pixels. That split is what lets money — which arrives as a decimal
 * string because it is a Postgres bigint (see lib/money.ts) — be scaled with
 * BigInt arithmetic and only become a float once it is already bounded.
 */

/** A bar's box in SVG user units, origin top-left, growing up from the baseline. */
export interface BarGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarLayout {
  /** Plot width in user units. */
  width: number;
  /** Plot height in user units — a fraction of 1 fills exactly this. */
  height: number;
  /** Gap between adjacent bars. The surface separates marks; no stroke does. */
  gap?: number;
  /** Bars never fill their slot — the leftover band is deliberate air. */
  maxBarWidth?: number;
}

const DEFAULT_GAP = 2;
const DEFAULT_MAX_BAR_WIDTH = 24;

/**
 * Scale to the largest value. An all-zero (or empty) series returns all
 * zeros rather than dividing by it — fourteen empty days is the normal state
 * of a fresh game, not an error.
 */
export function countFractions(values: readonly number[]): number[] {
  let max = 0;
  for (const value of values) if (Number.isFinite(value) && value > max) max = value;
  if (max <= 0) return values.map(() => 0);
  return values.map((value) => (Number.isFinite(value) && value > 0 ? value / max : 0));
}

/**
 * The money counterpart. Values are decimal strings straight off the wire and
 * may exceed `Number.MAX_SAFE_INTEGER`, so the ratio is taken in BigInt and
 * only the *result* — already bounded to 0..1 — becomes a float. Converting
 * the inputs with `Number()` first would collapse neighbouring large values
 * onto the same bar height.
 */
const FRACTION_SCALE = 1_000_000n;

export function moneyFractions(values: readonly string[]): number[] {
  const amounts = values.map((value) => BigInt(value));
  let max = 0n;
  for (const amount of amounts) if (amount > max) max = amount;
  if (max <= 0n) return amounts.map(() => 0);
  return amounts.map((amount) => (
    amount > 0n ? Number((amount * FRACTION_SCALE) / max) / Number(FRACTION_SCALE) : 0
  ));
}

/** Index of the largest value, or -1 when there is nothing to point at. */
export function indexOfMax(fractions: readonly number[]): number {
  let best = -1;
  let bestValue = 0;
  for (let i = 0; i < fractions.length; i += 1) {
    const value = fractions[i] ?? 0;
    if (value > bestValue) { best = i; bestValue = value; }
  }
  return best;
}

/**
 * Place one bar per fraction across `width`. A fraction of 1 is exactly
 * `height` tall, so the tallest bar always reaches the top of the plot.
 */
export function layoutBars(fractions: readonly number[], layout: BarLayout): BarGeometry[] {
  const gap = layout.gap ?? DEFAULT_GAP;
  const maxBarWidth = layout.maxBarWidth ?? DEFAULT_MAX_BAR_WIDTH;
  if (fractions.length === 0) return [];

  const slot = layout.width / fractions.length;
  const barWidth = Math.max(1, Math.min(maxBarWidth, slot - gap));

  return fractions.map((fraction, i) => {
    const clamped = Math.min(1, Math.max(0, fraction));
    const height = clamped * layout.height;
    return {
      x: i * slot + (slot - barWidth) / 2,
      y: layout.height - height,
      width: barWidth,
      height,
    };
  });
}

/**
 * A bar as an SVG path: rounded at the data end, square at the baseline. The
 * radius is clamped so a short bar becomes a lozenge rather than folding its
 * own corners inside out.
 */
export function barPath(bar: BarGeometry, radius = 4): string {
  if (bar.height <= 0) return "";
  const r = Math.max(0, Math.min(radius, bar.width / 2, bar.height));
  const { x, y, width: w, height: h } = bar;
  return [
    `M${x} ${y + h}`,
    `L${x} ${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    `L${x + w - r} ${y}`,
    `Q${x + w} ${y} ${x + w} ${y + r}`,
    `L${x + w} ${y + h}`,
    "Z",
  ].join(" ");
}

export interface Point { x: number; y: number }

/** Evenly spaced points for a sparkline; a single point sits at the left edge. */
export function sparklinePoints(fractions: readonly number[], layout: { width: number; height: number }): Point[] {
  if (fractions.length === 0) return [];
  const step = fractions.length === 1 ? 0 : layout.width / (fractions.length - 1);
  return fractions.map((fraction, i) => ({
    x: i * step,
    y: layout.height - Math.min(1, Math.max(0, fraction)) * layout.height,
  }));
}

/** Polyline `d` for the points above. Empty input yields an empty path, not `NaN`. */
export function sparklinePath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  return points.map((point, i) => `${i === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
}

/**
 * The signed counterpart of moneyFractions, for a series that crosses zero
 * (a daily net-flow series is faucets AND sinks). Values scale against the
 * largest MAGNITUDE in either direction, so +1 and −1 are the two extremes —
 * the BigInt ratio keeps figures past 2^53 distinct, same as moneyFractions.
 */
export function signedFractions(values: readonly string[]): number[] {
  const amounts = values.map((value) => BigInt(value));
  let maxAbs = 0n;
  for (const amount of amounts) {
    const magnitude = amount < 0n ? -amount : amount;
    if (magnitude > maxAbs) maxAbs = magnitude;
  }
  if (maxAbs <= 0n) return amounts.map(() => 0);
  return amounts.map((amount) => (
    Number((amount * FRACTION_SCALE) / maxAbs) / Number(FRACTION_SCALE)
  ));
}

export interface SignedBarLayout extends BarLayout {
  /**
   * Where the zero line sits, computed by layoutSignedBars from the fractions
   * themselves: proportional to how much of the range is negative, so an
   * all-positive series uses the whole height like an ordinary bar chart and
   * a series with both signs splits the plot by its actual extremes.
   */
  zeroY: number;
}

/**
 * Bars for a signed series: positive fractions rise from the zero line,
 * negative ones hang below it. A fraction's magnitude maps to the distance
 * from the zero line to ITS edge (up for positive, down for negative), so the
 * series' max in each direction touches its edge exactly. Zero days get a
 * zero-height bar, which barPathDown/barPath render as nothing.
 */
export function layoutSignedBars(
  fractions: readonly number[], layout: Omit<SignedBarLayout, "zeroY">,
): { bars: BarGeometry[]; zeroY: number } {
  const gap = layout.gap ?? DEFAULT_GAP;
  const maxBarWidth = layout.maxBarWidth ?? DEFAULT_MAX_BAR_WIDTH;
  if (fractions.length === 0) return { bars: [], zeroY: layout.height };

  let up = 0, down = 0;
  for (const fraction of fractions) {
    const clamped = Math.min(1, Math.max(-1, Number.isFinite(fraction) ? fraction : 0));
    if (clamped > up) up = clamped;
    if (-clamped > down) down = -clamped;
  }
  // All-zero series: zeroY at the bottom, same degenerate shape as a plain
  // bar chart with no data.
  // ONE scale factor for both directions, or a −0.5 bar would draw at a
  // different pixels-per-unit than a +0.5 bar. The extremes must touch their
  // edges exactly, which fixes the scale and the zero line together:
  // up × scale == zeroY and down × scale == height − zeroY.
  const scale = up + down === 0 ? 0 : layout.height / (up + down);
  const zeroY = layout.height - down * scale;

  const slot = layout.width / fractions.length;
  const barWidth = Math.max(1, Math.min(maxBarWidth, slot - gap));

  const bars = fractions.map((fraction, i) => {
    const clamped = Math.min(1, Math.max(-1, Number.isFinite(fraction) ? fraction : 0));
    const x = i * slot + (slot - barWidth) / 2;
    const height = Math.abs(clamped) * scale;
    return clamped >= 0
      ? { x, y: zeroY - height, width: barWidth, height }
      : { x, y: zeroY, width: barWidth, height };
  });
  return { bars, zeroY };
}

/**
 * barPath's mirror for the bars that hang below the zero line: rounded at the
 * data end (the bottom), square at the baseline (the top).
 */
export function barPathDown(bar: BarGeometry, radius = 4): string {
  if (bar.height <= 0) return "";
  const r = Math.max(0, Math.min(radius, bar.width / 2, bar.height));
  const { x, y, width: w, height: h } = bar;
  return [
    `M${x} ${y}`,
    `L${x} ${y + h - r}`,
    `Q${x} ${y + h} ${x + r} ${y + h}`,
    `L${x + w - r} ${y + h}`,
    `Q${x + w} ${y + h} ${x + w} ${y + h - r}`,
    `L${x + w} ${y}`,
    "Z",
  ].join(" ");
}

/**
 * The money supply at the end of each day, derived rather than queried: the
 * ledger's invariant (sum of movements == balances) makes each day's net flow
 * the supply delta, so walking today's supply backwards through the nets
 * reconstructs history without a snapshot table. `dailyNets` is ASCENDING;
 * the result is the same length, supplyNow at the last index.
 */
export function supplySeries(supplyNow: string, dailyNets: readonly string[]): string[] {
  const nets = dailyNets.map((value) => BigInt(value));
  const out: string[] = [];
  let remaining = BigInt(supplyNow);
  // Walk from the newest day backwards, subtracting each day's net to get the
  // balance BEFORE it, then emit oldest-first by unshifting.
  for (let i = nets.length - 1; i >= 0; i -= 1) {
    out.unshift(remaining.toString());
    remaining -= nets[i]!;
  }
  return out;
}
