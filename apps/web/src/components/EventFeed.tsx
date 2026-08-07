import type { GameEvent } from "@gl3/shared";
import { useEvents } from "../store/events.js";

function describe(event: GameEvent): string {
  switch (event.type) {
    case "crime.resolved":
      return event.success
        ? `${event.crimeName}: succeeded, +$${event.payout} (+${event.exp} exp)`
        : `${event.crimeName}: failed`;
    default:
      return event.type;
  }
}

export function EventFeed(): JSX.Element {
  const events = useEvents();
  return (
    <aside>
      <h3>Live feed</h3>
      {events.length === 0 ? <p>Nothing yet.</p> : null}
      <ul>
        {events.map((event) => (
          <li key={event.id}>
            <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time> {describe(event)}
          </li>
        ))}
      </ul>
    </aside>
  );
}
