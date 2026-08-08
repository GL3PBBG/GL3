import type { GameEvent } from "@gl3/shared";
import { formatMoney } from "../lib/money.js";
import { useEvents } from "../store/events.js";
import styles from "./EventFeed.module.css";

/**
 * One line of copy per event type. Exhaustive over the union — an unhandled
 * type is a compile error rather than a raw `event.type` string on screen,
 * which is what the previous `default:` branch produced for 18 of the 20 types.
 */
function describe(event: GameEvent): string {
  switch (event.type) {
    case "crime.resolved":
      return event.success
        ? `${event.crimeName}: succeeded, +${formatMoney(event.payout)} (+${event.exp} exp)`
        : `${event.crimeName}: failed`;
    case "player.jailed":
      return `Jailed — ${event.reason}`;
    case "player.released":
      return "Released from jail";
    case "player.travelled":
      return `Travelled (${formatMoney(event.cost)})`;
    case "player.attacked":
      return `Attacked ${event.targetName} for ${event.damage}`;
    case "player.killed":
      return `${event.victimName} was killed`;
    case "bounty.placed":
      return `Bounty of ${formatMoney(event.amount)} placed on ${event.targetName}`;
    case "bounty.claimed":
      return `Bounty on ${event.targetName} claimed for ${formatMoney(event.amount)}`;
    case "gang.created":
      return `${event.actorName} founded ${event.gangName}`;
    case "gang.memberJoined":
      return `${event.actorName} joined the gang`;
    case "gang.memberLeft":
      return `${event.actorName} left the gang`;
    case "mail.received":
      return `Mail from ${event.actorName}: ${event.subject}`;
    case "notification.created":
      return event.body;
    case "news.posted":
      return `News: ${event.title}`;
    case "chat.message":
      return `${event.actorName}: ${event.body}`;
    case "player.joined":
      return `${event.actorName} joined the game`;
    case "player.rankedUp":
      return `Ranked up to ${event.rankName} (+${formatMoney(event.cashReward)})`;
    case "bank.transacted":
      return `Bank ${event.direction}: ${formatMoney(event.amount)}`;
    case "bullets.purchased":
      return `Bought ${event.quantity} bullets for ${formatMoney(event.cost)}`;
  }
}

export function EventFeed(): JSX.Element {
  const events = useEvents();
  return (
    <aside className={styles.feed}>
      <h3 className={styles.heading}>Live feed</h3>
      {events.length === 0 ? <p className={styles.empty}>Nothing yet.</p> : null}
      <ul className={styles.list}>
        {events.map((event) => (
          <li key={event.id} className={styles.item}>
            <time className={styles.time} dateTime={event.at}>
              {new Date(event.at).toLocaleTimeString()}
            </time>{" "}
            {describe(event)}
          </li>
        ))}
      </ul>
    </aside>
  );
}
