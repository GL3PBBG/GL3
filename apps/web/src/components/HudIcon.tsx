/**
 * The HUD's stat glyphs — bespoke 24x24 stroke paths in the same hand as
 * NavMenu's category icons (two-ish strokes each, `currentColor`, no icon
 * package). Drawn from the game's own vocabulary: a banded cash stack, a
 * bank portico, a single cartridge, a cut diamond, a bolt/eye/flame for the
 * three pools, rank chevrons, a map pin, a clock for time-driven plugin
 * entries. The icon never carries meaning alone — every HUD stat pairs it
 * with visually-hidden label text, so a screen reader hears exactly what
 * the old text HUD said.
 */
const PATHS: Record<string, readonly string[]> = {
  // A strapped stack of bills, side-on.
  cash: ["M3 8h18v10H3Z", "M3 12h18", "M9 8v10", "M15 8v10"],
  // A bank portico: pediment, columns, base.
  bank: ["m3 9 9-5 9 5", "M4 9v8", "M9 9v8", "M15 9v8", "M20 9v8", "M3 20h18"],
  // One cartridge, nose right.
  bullet: ["M4 9h9l6 3-6 3H4Z", "M8 9v6"],
  // A cut diamond.
  points: ["M6 4h12l4 5-10 11L2 9Z", "M2 9h20", "m9 4 3 5 3-5", "m12 9-0 11"],
  // Pools.
  energy: ["M13 2 5 13h5l-2 9 8-11h-5Z"],
  will: ["M12 5C7 5 3 9 2 12c1 3 5 7 10 7s9-4 10-7c-1-3-5-7-10-7Z", "M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6"],
  brave: ["M12 2c1 4-3 5-3 9a3 3 0 0 0 6 0c0-2-1-3-1-5 3 2 5 5 5 8a7 7 0 0 1-14 0c0-5 5-7 7-12Z"],
  // Rank chevrons (sleeve stripes) and a map pin.
  rank: ["m5 7 7 4 7-4", "m5 12 7 4 7-4"],
  location: ["M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z", "M12 8a2 2 0 1 0 0 4 2 2 0 1 0 0-4"],
  // Time-driven plugin HUD entries (course days, wages due).
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18", "M12 7v5l3 2"],
};

export function HudIcon({ id }: { id: string }): JSX.Element | null {
  const paths = PATHS[id];
  if (paths === undefined) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
