/**
 * `@letele/playing-cards@0.1.0` ships no type declarations at all: its
 * manifest claims `"types": "lib/index.d.ts"`, but `"files": ["dist"]` means
 * `lib/` was never published — the tarball's `dist/` contains exactly one
 * file, `index.esm.js`, with no `.d.ts` anywhere. `skipLibCheck` does not
 * rescue this; it skips checking declaration *contents*, not a missing
 * declaration file, so a bare `import * as deck from "@letele/playing-cards"`
 * fails TS7016 under this project's `strict: true`.
 *
 * All 56 exports are listed explicitly, one per line, rather than an index
 * signature or a single `Record<string, ComponentType<...>>`. Either
 * shortcut would let a typo'd card code compile silently — the exact
 * failure `cards.ts`'s explicit `CARDS` map exists to prevent. Listing every
 * name lets `tsc` verify each one `cards.ts` references is a real export.
 *
 * Names taken from `Object.keys(deck)` at the installed 0.1.0 version, not
 * from memory — 56 entries, matching exactly the 56 codes the SDK's `cards`
 * leaf regex admits (`packages/plugin-sdk/src/pages.ts`): 4 suits (H/D/C/S)
 * x 13 ranks (a, 2-9, 10, j, q, k), plus J1/J2 jokers and B1/B2 backs.
 */
declare module "@letele/playing-cards" {
  import type { ComponentType, CSSProperties } from "react";

  type Card = ComponentType<{ style?: CSSProperties }>;

  export const Ha: Card;
  export const H2: Card;
  export const H3: Card;
  export const H4: Card;
  export const H5: Card;
  export const H6: Card;
  export const H7: Card;
  export const H8: Card;
  export const H9: Card;
  export const H10: Card;
  export const Hj: Card;
  export const Hq: Card;
  export const Hk: Card;

  export const Da: Card;
  export const D2: Card;
  export const D3: Card;
  export const D4: Card;
  export const D5: Card;
  export const D6: Card;
  export const D7: Card;
  export const D8: Card;
  export const D9: Card;
  export const D10: Card;
  export const Dj: Card;
  export const Dq: Card;
  export const Dk: Card;

  export const Ca: Card;
  export const C2: Card;
  export const C3: Card;
  export const C4: Card;
  export const C5: Card;
  export const C6: Card;
  export const C7: Card;
  export const C8: Card;
  export const C9: Card;
  export const C10: Card;
  export const Cj: Card;
  export const Cq: Card;
  export const Ck: Card;

  export const Sa: Card;
  export const S2: Card;
  export const S3: Card;
  export const S4: Card;
  export const S5: Card;
  export const S6: Card;
  export const S7: Card;
  export const S8: Card;
  export const S9: Card;
  export const S10: Card;
  export const Sj: Card;
  export const Sq: Card;
  export const Sk: Card;

  export const J1: Card;
  export const J2: Card;
  export const B1: Card;
  export const B2: Card;
}
