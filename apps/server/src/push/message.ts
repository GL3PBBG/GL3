import type { GameEvent } from "@gl3/shared";

export interface PushContent {
  title: string;
  body: string;
  /** A client destination, resolved by the app's own route registry. */
  path: string;
}

/** Android collapses a long body anyway; 140 keeps the tray entry readable. */
export const NOTIFICATION_BODY_MAX = 140;

/**
 * One character of the budget is spent on the ellipsis, so the cut happens at
 * `max - 1` and prefers the last space inside that window. A body whose first
 * `max - 1` characters contain no space at all is cut mid-word rather than
 * shipped whole — a single 300-character "word" is not a sentence to preserve.
 */
export function truncateBody(text: string, max = NOTIFICATION_BODY_MAX): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max - 1);
  const space = window.lastIndexOf(" ");
  const head = space > 0 ? window.slice(0, space) : window;
  return `${head.trimEnd()}…`;
}

/**
 * PURE: no I/O, no database, no clock. `null` means "do not push this event
 * to this recipient" — every unlisted event type returns `null`, so adding a
 * pushed event is a change to this one switch and nothing else.
 *
 * The self-suppression arms are per event, NOT a global rule. Combat
 * publishes player.attacked and player.killed twice, once to each side, so
 * without the skip an attacker is told they were attacked. But
 * notification.created's actor IS the notified player and oc.resolved's actor
 * is the heist leader, both legitimate recipients — a blanket rule would
 * silence both.
 *
 * Plugin destinations are `/plugins/<pageId>`, never the advisory `path` a
 * plugin declares (apps/web/src/App.tsx:110). `gangs.index` sits behind the
 * advisory path `/gang`, which is exactly why the id is used. `hospital` is a
 * core-profile page id, not a plugin one (plugins/manifest-endpoint.ts).
 */
export function pushMessageFor(event: GameEvent, recipientId: string): PushContent | null {
  switch (event.type) {
    case "mail.received":
      return { title: `New mail from ${event.actorName}`, body: event.subject, path: "/mail" };

    case "notification.created":
      return { title: "Gangster Land", body: truncateBody(event.body), path: "/notifications" };

    case "player.attacked":
      if (recipientId === event.actorId) return null;
      return {
        title: "You were attacked",
        body: `${event.actorName} hit you for ${event.damage} damage`,
        path: "/plugins/hospital",
      };

    case "player.killed":
      if (recipientId === event.actorId) return null;
      return { title: "You were killed", body: `${event.actorName} killed you`, path: "/plugins/hospital" };

    case "bounty.claimed":
      if (recipientId === event.actorId) return null;
      return {
        title: "Bounty claimed",
        // Money crosses the wire as a decimal string, never a JSON number.
        body: `${event.actorName} collected the bounty on ${event.targetName} for $${event.amount}`,
        path: "/plugins/bounties.index",
      };

    case "oc.resolved":
      return {
        title: "Heist resolved",
        body: event.success ? `The crew got away with $${event.share}` : "The heist went bad",
        path: "/plugins/oc.index",
      };

    case "gang.memberJoined":
      if (recipientId === event.actorId) return null;
      return { title: "New gang member", body: `${event.actorName} joined your gang`, path: "/plugins/gangs.index" };

    default:
      return null;
  }
}
