import type { GameEvent } from "@gl3/shared";
import { keys } from "../api/keys.js";

/**
 * Which cached queries a live event makes stale.
 *
 * Pure on purpose: the socket plumbing in useGameEvents is untestable without a
 * server, but *this* — the part that decides whether committing a crime
 * refreshes the player's cash — is a table lookup, so it lives here and is
 * covered by test/invalidation.test.ts.
 *
 * Returning an empty array is a deliberate answer, not a gap: events for Pass 2
 * surfaces (mail, notifications, news, gangs) have no cached query to refresh
 * yet. They still reach the event feed; they just invalidate nothing.
 */
export function invalidationKeys(event: GameEvent): readonly (readonly string[])[] {
  switch (event.type) {
    case "crime.resolved":
      // Carries jailedUntil, so it is also the authoritative "you got caught"
      // signal — the jail query must not wait for a separate player.jailed.
      return [keys.me(), keys.crimes(), keys.jail()];
    case "player.jailed":
    case "player.released":
      return [keys.jail(), keys.crimes()];
    case "player.travelled":
      return [keys.me(), keys.locations()];
    case "bank.transacted":
      return [keys.me()];
    case "bullets.purchased":
      // Stock is per-location and shown in the shop, so the list is stale too.
      return [keys.me(), keys.locations()];
    case "player.rankedUp":
      return [keys.me(), keys.ranks()];
    case "player.attacked":
    case "player.killed":
      return [keys.me()];
    case "bounty.placed":
    case "bounty.claimed":
    case "gang.created":
    case "gang.memberJoined":
    case "gang.memberLeft":
    case "mail.received":
    case "notification.created":
    case "news.posted":
    case "chat.message":
    case "player.joined":
      return [];
  }
}
