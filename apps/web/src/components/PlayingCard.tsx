import { cardComponent } from "./cards.js";

const SUITS: Record<string, string> = { H: "hearts", D: "diamonds", C: "clubs", S: "spades" };
const RANKS: Record<string, string> = { a: "ace", j: "jack", q: "queen", k: "king" };

/**
 * The spoken name of a card code ("Ha" → "ace of hearts"). The SVG art carries
 * no text at all, so without this a dealt hand is invisible to a screen
 * reader — the player can Hit and Stand but never learn what they hold.
 */
export function cardName(code: string): string {
  if (code === "J1" || code === "J2") return "joker";
  if (code === "B1" || code === "B2") return "face-down card";
  const suit = SUITS[code.charAt(0)];
  if (suit === undefined) return "unknown card";
  const rank = code.slice(1);
  return `${RANKS[rank] ?? rank} of ${suit}`;
}

export function PlayingCard({ code }: { code: string }): JSX.Element {
  const Card = cardComponent(code);
  if (Card === null) {
    // Recoverable by design — see the test. A card is 5:7 width to height.
    return <span data-card aria-label="unknown card" role="img" className="card card--unknown" />;
  }
  // role="img" makes the wrapper one atomic image and its SVG child
  // presentational, so the name below is all a screen reader announces.
  return (
    <span data-card role="img" aria-label={cardName(code)} className="card">
      <Card style={{ height: "100%", width: "100%" }} />
    </span>
  );
}

export function Hand({ codes }: { codes: string[] }): JSX.Element {
  return (
    <span className="hand" role="group" aria-label={`${codes.length} cards`}>
      {codes.map((code, i) => (
        <PlayingCard key={`${code}-${i}`} code={code} />
      ))}
    </span>
  );
}
