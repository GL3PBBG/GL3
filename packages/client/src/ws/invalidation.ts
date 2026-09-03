import type { EventMeta, GameEvent } from "@gl3/shared";
import { keys } from "../api/keys.js";
import { pluginInvalidationKeys } from "../plugins/invalidation.js";

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
 * whose surfaces have no server routes at all (bounties, chat): they reach
 * the event feed and invalidate nothing.
 *
 * `eventMetas` is the manifest's event metadata, which only `plugin.event`
 * consults; it defaults to empty so every core call site stays a two-argument
 * one and a client that has not loaded the manifest yet still gets an answer.
 */
export function invalidationKeys(
  event: GameEvent, viewerId: string, eventMetas: readonly EventMeta[] = [],
): readonly (readonly string[])[] {
  switch (event.type) {
    case "crime.resolved":
      // Carries jailedUntil, so it is also the authoritative "you got caught"
      // signal — the jail query must not wait for a separate player.jailed.
      return [keys.me(), keys.crimes(), keys.jail()];
    case "player.jailed":
    case "player.released":
      return [keys.jail(), keys.crimes()];
    case "player.discharged":
      // The sentence ended and health came back; /hospital is the whole page
      // for the discharged player and health lives on /api/auth/me.
      return [keys.hospital(), keys.me()];
    case "player.travelled":
      // Stock is per-location and the shop query is not keyed by location, so
      // without this a traveller keeps seeing the city they left.
      return [keys.me(), keys.locations(), keys.shop(), keys.bulletShop()];
    case "bank.transacted":
      return [keys.me()];
    case "bullets.purchased":
      // Stock is per-location and shown in the shop, so the list is stale too.
      return [keys.me(), keys.locations(), keys.bulletShop()];
    case "player.rankedUp":
      return [keys.me(), keys.ranks()];
    case "player.levelUp":
      // Exp, pools and max hp all moved — ranks stay deliberately absent:
      // a levelUp boot never touches the rank ladder.
      return [keys.me()];
    case "player.attacked":
      // Bullets moved and the target's health did, so the list a player is
      // looking at is stale; the log gains a row for both parties. Hospital is
      // in here because combat settles an elapsed sentence for both
      // participants itself (combat's own settleHospitalIfElapsed), which
      // publishes nothing — so this is the only signal the target gets when
      // an attack beats the sweeper to their discharge.
      return [keys.me(), keys.combatTargets(), keys.combatLog(), keys.hospital()];
    case "player.backfired":
      // Same surfaces as a landed shot, minus anything about the target: the
      // attacker spent bullets, took the damage themselves, and the log gained
      // a row. `hospital` because a backfire can put the ATTACKER there — the
      // one path in combat that hospitalises the shooter.
      return [keys.me(), keys.combatTargets(), keys.combatLog(), keys.hospital()];
    case "player.killed":
      // The victim is now hospitalised — for them that is the whole page, and
      // for the killer it is why the target vanished from the list.
      return [keys.me(), keys.combatTargets(), keys.combatLog(), keys.hospital()];
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
      return [keys.bounties()];
    case "bounty.claimed":
      // Audience is killer + placer; the killer's cash moved.
      return [keys.bounties(), keys.me()];
    case "oc.updated":
    case "oc.resolved":
      // A heist crew is individual players, not a gang — refresh the /oc
      // page (slot grid / invites) and the wallet (payout / refund moves cash).
      return [keys.oc(), keys.me()];
    case "round.started":
      return [keys.rounds(), keys.leaderboards(), keys.me()];
    case "round.finished":
      return [keys.rounds(), keys.leaderboards(), keys.notifications(), keys.me()];
    case "chat.message":
    case "player.joined":
      return [];
    case "plugin.event":
      // The keys are the plugin's own declaration, not this table's: only the
      // manifest knows what a plugin's event touches. Always includes
      // keys.plugins() — see plugins/invalidation.ts for why.
      return pluginInvalidationKeys(event, eventMetas);
  }
}
