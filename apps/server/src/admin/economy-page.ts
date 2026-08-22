import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's economy dashboard — a MIMO (money-in, money-out) read over the
 * transactions ledger. Pure observation: no forms, no row actions, no admin
 * writes. The three tables answer the three questions an economy tuner asks,
 * in the order they arise: how much money exists (supply), where it is being
 * created and destroyed (flows by reason), and which way the trend is running
 * (daily net).
 *
 * Net by reason IS the faucet/sink signal. Player-to-player transfers post
 * equal-and-opposite rows under the same reason, so they net to ~0, while a
 * pure faucet (crime.payout) nets positive and a pure sink (travel.cost) nets
 * negative — no reason classification list to maintain.
 */
export const economyPage: PageSchema = {
  id: "core-economy-admin",
  path: "/admin/economy",
  view: {
    kind: "panel",
    title: "Economy",
    children: [
      {
        kind: "table",
        source: "GET /api/admin/economy/supply/table",
        columns: [
          { key: "label", label: "Money supply" },
          { key: "value", label: "Amount" },
        ],
      },
      {
        kind: "text",
        value: "Net flow by ledger reason over the last 7 days (cash and bank; points excluded). Positive net = faucet (money created), negative = sink (money destroyed), ~0 = transfer between players.",
      },
      {
        kind: "table",
        source: "GET /api/admin/economy/flows/table",
        columns: [
          { key: "reason", label: "Reason" },
          { key: "net", label: "Net (7d)" },
          { key: "inflow", label: "Inflow" },
          { key: "outflow", label: "Outflow" },
          { key: "count", label: "Rows" },
        ],
      },
      {
        kind: "table",
        source: "GET /api/admin/economy/daily/table",
        columns: [
          { key: "day", label: "Day (UTC)" },
          { key: "net", label: "Net flow" },
        ],
      },
    ],
  },
};
