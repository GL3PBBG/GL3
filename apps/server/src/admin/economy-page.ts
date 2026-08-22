import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's economy dashboard — a MIMO (money-in, money-out) read over the
 * transactions ledger. The view here is a stub on purpose: the real dashboard
 * is the bespoke `AdminEconomy` React component (apps/web), reached through
 * the client's PAGE_OVERRIDES map under this page's id — the sanctioned
 * escape hatch for "a core page that needs more than the static vocabulary"
 * (charts and total tiles are not vocabulary kinds). The id and path stay in
 * the sections payload: they are what the Admin tab and the override key off,
 * and the grant gate stays server-side where it has always been.
 *
 * The page's data comes from `GET /api/admin/economy/overview`: supply,
 * 7d/30d window totals, per-reason flows, and a gap-filled 30-day daily
 * series. Net by reason IS the faucet/sink signal — player-to-player
 * transfers post equal-and-opposite rows under the same reason and net to ~0,
 * so no reason classification list to maintain.
 */
export const economyPage: PageSchema = {
  id: "core-economy-admin",
  path: "/admin/economy",
  view: {
    kind: "panel",
    title: "Economy",
    children: [
      { kind: "text", value: "The economy dashboard is rendered by the web client's bespoke page; this payload only declares the page and its grant. If you can read this, the client is older than the server." },
    ],
  },
};
