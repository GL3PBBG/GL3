import { cardComponent } from "./cards.js";

export function PlayingCard({ code }: { code: string }): JSX.Element {
  const Card = cardComponent(code);
  if (Card === null) {
    // Recoverable by design — see the test. A card is 5:7 width to height.
    return <span data-card aria-label="unknown card" className="card card--unknown" />;
  }
  return (
    <span data-card className="card">
      <Card style={{ height: "100%", width: "100%" }} />
    </span>
  );
}

export function Hand({ codes }: { codes: string[] }): JSX.Element {
  return (
    <span className="hand">
      {codes.map((code, i) => (
        <PlayingCard key={`${code}-${i}`} code={code} />
      ))}
    </span>
  );
}
