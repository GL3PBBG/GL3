import * as deck from "@letele/playing-cards";
import type { ComponentType, CSSProperties } from "react";

export type CardComponent = ComponentType<{ style?: CSSProperties }>;

/**
 * An EXPLICIT map, not `deck[code]` (the library's README shows a dynamic
 * lookup). This buys compile-time typo safety, not bundle size: the map
 * below statically references all 56 exports, so there is no unused export
 * for either form to strip — a card code that isn't a real export fails
 * `tsc` here instead of silently resolving to `undefined` at render time.
 */
const CARDS: Record<string, CardComponent> = {
  Ha: deck.Ha, H2: deck.H2, H3: deck.H3, H4: deck.H4, H5: deck.H5, H6: deck.H6, H7: deck.H7,
  H8: deck.H8, H9: deck.H9, H10: deck.H10, Hj: deck.Hj, Hq: deck.Hq, Hk: deck.Hk,
  Da: deck.Da, D2: deck.D2, D3: deck.D3, D4: deck.D4, D5: deck.D5, D6: deck.D6, D7: deck.D7,
  D8: deck.D8, D9: deck.D9, D10: deck.D10, Dj: deck.Dj, Dq: deck.Dq, Dk: deck.Dk,
  Ca: deck.Ca, C2: deck.C2, C3: deck.C3, C4: deck.C4, C5: deck.C5, C6: deck.C6, C7: deck.C7,
  C8: deck.C8, C9: deck.C9, C10: deck.C10, Cj: deck.Cj, Cq: deck.Cq, Ck: deck.Ck,
  Sa: deck.Sa, S2: deck.S2, S3: deck.S3, S4: deck.S4, S5: deck.S5, S6: deck.S6, S7: deck.S7,
  S8: deck.S8, S9: deck.S9, S10: deck.S10, Sj: deck.Sj, Sq: deck.Sq, Sk: deck.Sk,
  J1: deck.J1, J2: deck.J2, B1: deck.B1, B2: deck.B2,
};

export const CARD_CODES: readonly string[] = Object.keys(CARDS);

export function cardComponent(code: string): CardComponent | null {
  return CARDS[code] ?? null;
}
