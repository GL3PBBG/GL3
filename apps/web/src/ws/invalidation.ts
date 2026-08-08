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
 * `viewerId` is the receiving player's own id. It is needed because the profile
 * query is keyed by player id and the viewer's gang membership lives on their
 * profile, not on `/api/auth/me` — so a gang event has to name *which* profile
 * went stale, and the only one this client caches for that purpose is its own.
 *
 * Returning an empty array is still a deliberate answer for the event types
 * whose surfaces have no server routes at all (attacks, bounties, chat): they
 * reach the event feed and invalidate nothing.
 */
export function invalidationKeys(
  event: GameEvent, viewerId: string,
): readonly (readonly string[])[] {
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
    case "gang.created":
      return [keys.profile(viewerId), keys.gang(event.gangId)];
    case "gang.memberJoined":
    case "gang.memberLeft":
      // The roster and the log both move, and so does the gang row — its
      // memberCount is part of GangDto. The viewer's own profile is in here
      // because these events also reach the joiner/leaver themselves, and
      // that is where their gangId lives; for the other members it costs one
      // refetch of a query the Gang page is already holding.
      return [
        keys.gangMembers(event.gangId), keys.gangLogs(event.gangId),
        keys.gang(event.gangId), keys.profile(viewerId),
      ];
    case "mail.received":
      return [keys.mail()];
    case "notification.created":
      // A gang invite arrives as a notification and nothing else — there is
      // no invite event — so the invite list is stale on exactly this signal.
      return [keys.notifications(), keys.gangInvites()];
    case "news.posted":
      return [keys.news()];
    case "bounty.placed":
    case "bounty.claimed":
    case "chat.message":
    case "player.joined":
      return [];
  }
}
