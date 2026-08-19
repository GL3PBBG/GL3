import type { PageSchema } from "@gl3/plugin-sdk";
import { THEME_VARS } from "@gl3/shared";

/**
 * Core's theme section, served through the same payload as plugin adminPages.
 * The table shows what is live (preset plus any overrides); the form replaces
 * the whole configuration — a blank override field clears that override, so
 * "back to the preset" is submitting the form with the field emptied.
 */
export const themePage: PageSchema = {
  id: "core-theme-admin",
  path: "/admin/theme",
  view: {
    kind: "panel",
    title: "Theme",
    children: [
      { kind: "text", value: "One theme for the whole game, every player sees it. Preset picks the palette; a hex override (#rrggbb) replaces that one color, blank falls back to the preset. Changes land on the next page load." },
      { kind: "table", source: "GET /api/admin/theme/table", columns: [
        { key: "setting", label: "Setting" },
        { key: "value", label: "Value" },
      ] },
      { kind: "form", action: "POST /api/admin/theme", submitLabel: "Save theme", fields: [
        { name: "preset", label: "Preset", type: "select", optionsSource: "GET /api/admin/theme/presets", valueKey: "id", labelKey: "name" },
        { name: "navPosition", label: "Menu position", type: "select", optionsSource: "GET /api/admin/theme/nav-options", valueKey: "id", labelKey: "name" },
        ...THEME_VARS.map((v) => ({
          name: v, label: `Override --${v} (#rrggbb, blank = preset)`, type: "text" as const,
        })),
      ] },
    ],
  },
};
