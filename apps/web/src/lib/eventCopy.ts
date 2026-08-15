import type { EventMeta, GameEvent } from "@gl3/shared";
import { describePluginEvent } from "../plugins/describe.js";
import { formatMoney } from "./money.js";

/**
 * One line of copy per event type. Exhaustive over the union — an unhandled
 * type is a compile error rather than a raw `event.type` string on screen,
 * which is what the previous `default:` branch produced for 20 of the 22 types.
 *
 * `eventMetas` is the manifest's event metadata, which only `plugin.event`
 * consults. It is a parameter rather than a `usePlugins()` call inside this
 * function because `describeEvent` runs inside a `.map` callback in EventFeed,
 * and a conditional hook call in a loop violates the rules of hooks — same
 * threading as `invalidationKeys` in ws/invalidation.ts. It defaults to empty
 * so a caller that renders only core events need not know about the manifest.
 *
 * Lives here rather than in EventFeed.tsx so it is reachable from the @gl3/web
 * test project, which is node-only with no DOM (vitest.workspace.ts) — the
 * same split as lib/mail.ts, lib/ranks.ts and ws/invalidation.ts. The
 * `plugin.event` case below carries two properties worth pinning: the
 * (pluginId, name) match and the actorName-shadowing guard.
 */
export function describeEvent(event: GameEvent, eventMetas: readonly EventMeta[] = []): string {
  switch (event.type) {
    case "crime.resolved":
      return event.success
        ? `${event.crimeName}: succeeded, +${formatMoney(event.payout)} (+${event.exp} exp)`
        : `${event.crimeName}: failed`;
    case "player.jailed":
      return `Jailed — ${event.reason}`;
    case "player.released":
      return "Released from jail";
    case "player.discharged":
      return "Discharged from hospital";
    case "player.travelled":
      return `Travelled (${formatMoney(event.cost)})`;
    case "player.attacked":
      return `Attacked ${event.targetName} for ${event.damage}`;
    case "player.backfired":
      // Attacker-only event, so the copy is second person. The target is
      // never named: the shot never reached them.
      return event.hospitalised
        ? `Your weapon backfired for ${event.selfDamage} — hospitalised`
        : `Your weapon backfired for ${event.selfDamage}`;
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
    case "oc.updated":
      // State-refresh signal (slot filled, status flip) — the page re-renders
      // via invalidation, no toast needed.
      return "";
    case "oc.resolved":
      return event.success
        ? `Heist succeeded — your share: ${formatMoney(event.share)}.`
        : "Heist failed — you were jailed.";
    case "plugin.event": {
      // The copy is the plugin's own `describe` template from GET /api/plugins;
      // only the manifest knows how to word a plugin's event. Matched on
      // (pluginId, name) rather than name alone because two plugins may each
      // declare a "pinged". No match falls back to the envelope's own fields —
      // that happens when the manifest has not loaded yet, or when the event
      // came from a plugin the client's cached manifest does not know about.
      const meta = eventMetas.find((m) => m.pluginId === event.pluginId && m.name === event.name);
      if (meta === undefined) return `${event.actorName}: ${event.pluginId}.${event.name}`;
      // `actorName` is spread last on purpose: `event.payload` is
      // `z.record(z.unknown())` and may carry player-supplied strings, so the
      // other order would let a payload with its own `actorName` key overwrite
      // the envelope's authoritative one and render an attacker-chosen name
      // where the feed promises the acting player's.
      //
      // Known limitation: a money field in a payload renders as its raw
      // decimal string, unlike the core cases above, which run formatMoney.
      // The manifest carries no per-field type, so there is nothing to key
      // formatting off.
      return describePluginEvent(meta.describe, { ...event.payload, actorName: event.actorName });
    }
  }
}
