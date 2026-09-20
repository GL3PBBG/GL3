import type { PageSchema } from "@gl3/plugin-sdk";

/** Core's world section (spec 2026-09-20 §5): which authored scene each town runs on. */
export const worldPage: PageSchema = {
  id: "core-world-admin",
  path: "/admin/world",
  view: {
    kind: "panel",
    title: "World scenes",
    children: [
      { kind: "text", value: "A scene key names the street layout a town's 3D client renders. `default` is the auto-laid starter street; an authored template places hooks on fixed plots. Switch a town only once the client ships that template's scene." },
      { kind: "table", source: "GET /api/admin/world/scenes", columns: [
        { key: "name", label: "Town" },
        { key: "sceneKey", label: "Scene" },
      ] },
      { kind: "form", action: "PUT /api/admin/world/scene", submitLabel: "Set scene", fields: [
        { name: "locationId", label: "Town", type: "select", optionsSource: "GET /api/admin/world/scenes", valueKey: "id", labelKey: "name" },
        { name: "sceneKey", label: "Scene", type: "select", optionsSource: "GET /api/admin/world/templates", valueKey: "id", labelKey: "name" },
      ] },
    ],
  },
};
