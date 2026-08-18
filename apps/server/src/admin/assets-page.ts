import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's art section: one upload widget per core-owned slot.
 *
 * These three live here rather than in a plugin because core owns the tables.
 * `items`, `locations` and `ranks` are read by several plugins and owned by
 * none, so whichever plugin declared their art would arbitrarily own everyone
 * else's — and, since the loader stamps a widget's `scope` with the DECLARING
 * plugin's id, a plugin literally cannot declare a binder for the `core` scope
 * even if it wanted to.
 *
 * No id reaches the screen: each picker's `id` travels as the row's key and
 * the admin sees a name, the same rule `admin-ids-hidden.test.ts` enforces for
 * every other admin section.
 */
export const assetsPage: PageSchema = {
  id: "core-assets-admin",
  path: "/admin/assets",
  view: {
    kind: "panel",
    title: "Game art",
    children: [
      { kind: "text", value: "PNG, JPEG or WebP. Uploading the same file twice costs nothing — identical bytes are stored once." },
      { kind: "panel", title: "Items", children: [
        { kind: "assetBinder", slot: "item", entitySource: "GET /api/admin/assets/entities/items", entityLabelKey: "name" },
      ] },
      { kind: "panel", title: "Towns", children: [
        { kind: "assetBinder", slot: "location", entitySource: "GET /api/admin/assets/entities/locations", entityLabelKey: "name" },
      ] },
      { kind: "panel", title: "Ranks", children: [
        { kind: "assetBinder", slot: "rank", entitySource: "GET /api/admin/assets/entities/ranks", entityLabelKey: "name" },
      ] },
    ],
  },
};
