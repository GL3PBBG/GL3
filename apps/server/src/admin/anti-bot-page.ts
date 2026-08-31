import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's anti-bot section (spec 2026-08-31-anti-bot-design layers 1–2).
 * Same id discipline as the players page: usernames identify rows, no id
 * column anywhere. Challenge/clear are username-typed forms rather than
 * rowActions so an admin can act on a player who has fallen outside the
 * suspects window (or came from the cluster table, which has no single
 * player per row at all).
 */
export const antiBotPage: PageSchema = {
  id: "core-anti-bot-admin",
  path: "/admin/anti-bot",
  view: {
    kind: "panel",
    title: "Anti-bot",
    children: [
      { kind: "text", value: "Suspects, ranked by bot-likeness over the last 24h of ledger activity: many actions, metronomic gaps, active around the clock. The score orders rows for review — it proves nothing by itself." },
      { kind: "table", source: "GET /api/admin/anti-bot/suspects", columns: [
        { key: "username", label: "Username" },
        { key: "events", label: "Actions" },
        { key: "meanGapSeconds", label: "Mean gap (s)" },
        { key: "gapStddev", label: "Gap stddev" },
        { key: "activeHours", label: "Active hours" },
        { key: "score", label: "Score" },
      ] },
      { kind: "text", value: "Accounts sharing an address (signup or last-seen). Same household is legal; watch for value flowing one way." },
      { kind: "table", source: "GET /api/admin/anti-bot/ip-clusters", columns: [
        { key: "ip", label: "Address" },
        { key: "accounts", label: "Accounts" },
        { key: "usernames", label: "Usernames" },
      ] },
      { kind: "form", action: "POST /api/admin/anti-bot/challenge", submitLabel: "Require human check", fields: [
        { name: "username", label: "Username", type: "text" },
      ] },
      { kind: "form", action: "POST /api/admin/anti-bot/challenge/clear", submitLabel: "Clear human check", fields: [
        { name: "username", label: "Username", type: "text" },
      ] },
    ],
  },
};
