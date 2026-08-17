import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * The casino's admin section: what the running process is configured with, and
 * what is on the tables right now. Two tables and no form, deliberately.
 *
 * SETTINGS ARE READ-ONLY HERE. `apps/server/src/settings/load.ts` reads the
 * whole `settings` table ONCE at boot into a plain record, and
 * `ctx.settings.get` answers from that record for the life of the process — so
 * a form that wrote a settings row would appear to work and change nothing
 * until a restart, which is worse than no form. The table shows the value the
 * process is actually using, plus where it came from; changing one is still a
 * settings-row edit followed by a restart.
 *
 * OPEN HANDS is a read-only list for the same reason `bounties` has no admin
 * cancel: settling someone else's hand from here would move money outside the
 * route that escrowed it. An abandoned hand is forfeited lazily by the
 * player's own next `play` (spec §4.4), so the `Stale` column is a diagnostic,
 * not a queue anyone has to work.
 *
 * No column is an id — the section renders a game, a player, a town and a
 * wager, all of them names. `apps/server/test/admin-ids-hidden.test.ts`
 * enforces that repo-wide.
 */
export const adminPage: PageSchema = {
  id: "casino-admin",
  path: "/admin/casino",
  view: {
    kind: "panel",
    title: "Casino",
    children: [
      { kind: "panel", title: "Settings", children: [
        { kind: "text", value: "Read-only: settings load at boot, so an edit needs a settings row and a restart." },
        { kind: "table", source: "GET /api/admin/casino/settings", columns: [
          { key: "label", label: "Setting" },
          { key: "key", label: "Key" },
          { key: "value", label: "In force" },
          { key: "source", label: "Source" },
        ] },
      ] },
      { kind: "panel", title: "Open hands", children: [
        { kind: "table", source: "GET /api/admin/casino", columns: [
          { key: "game", label: "Game" },
          { key: "player", label: "Player" },
          { key: "town", label: "Town" },
          { key: "wager", label: "Wager" },
          { key: "openedAt", label: "Opened" },
          { key: "stale", label: "Stale" },
        ] },
      ] },
    ],
  },
};
