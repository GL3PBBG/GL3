import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's player-moderation section, served through the same payload as plugin
 * adminPages. Same id discipline as the roles page: no id column on the
 * table — ids travel only inside the Unban rowAction's `:id`.
 *
 * Ban is a form, not a rowAction: it needs a reason (and an optional expiry),
 * and rowActions carry no fields. Username-typed like the roles page's
 * "Assign role", which also keeps a player outside the table's recency window
 * bannable.
 */
export const playersPage: PageSchema = {
  id: "core-players-admin",
  path: "/admin/players",
  view: {
    kind: "panel",
    title: "Players",
    children: [
      { kind: "table", source: "GET /api/admin/players/table", columns: [
        { key: "username", label: "Username" },
        { key: "role", label: "Role" },
        { key: "lastSeen", label: "Last seen" },
        { key: "verified", label: "Verified" },
        { key: "banned", label: "Banned" },
      ], rowActions: [
        { label: "Unban", action: "POST /api/admin/players/:id/unban", confirm: "Lift this player's ban?" },
      ] },
      { kind: "form", action: "POST /api/admin/players/ban", submitLabel: "Ban player", fields: [
        { name: "username", label: "Username", type: "text" },
        { name: "reason", label: "Reason", type: "text" },
        { name: "expiresHours", label: "Expires (hours, empty = permanent)", type: "number" },
      ] },
    ],
  },
};
