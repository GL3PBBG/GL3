import type { PageSchema } from "@gl3/plugin-sdk";

export const housesPage: PageSchema = {
  id: "houses.index",
  path: "/houses",
  menu: { label: "Houses", order: 22, category: "town" },
  view: {
    kind: "panel",
    title: "Houses",
    children: [
      { kind: "slotImage", slot: "page-houses", alt: "Houses", size: "lg" },
      { kind: "keyValueSource", source: "GET /api/houses/board", entries: [
        { label: "House", key: "houseName" },
        { label: "Will ceiling", key: "houseWill" },
      ], emptyText: "Default House" },
      { kind: "table", source: "GET /api/houses/board", columns: [
        { key: "image", label: "", render: "image", imageSize: "md" },
        { key: "name", label: "House" },
        { key: "price", label: "Price" },
        { key: "will", label: "Will ceiling" },
      ] },
      { kind: "form", action: "POST /api/houses/buy", submitLabel: "Buy", fields: [
        { name: "houseId", label: "House", type: "select",
          optionsSource: "GET /api/houses/board", valueKey: "id", labelKey: "name" },
      ] },
      { kind: "text", value: "Selling refunds your current house in full and returns you to the Default House." },
      { kind: "button", label: "Sell current house", action: "POST /api/houses/sell" },
    ],
  },
};

export const adminPage: PageSchema = {
  id: "houses-admin",
  path: "/admin/houses",
  view: {
    kind: "panel",
    title: "Houses",
    children: [
      { kind: "table", source: "GET /api/admin/houses/list", columns: [
        { key: "name", label: "Name" },
        { key: "price", label: "Price" },
        { key: "will", label: "Will ceiling" },
      ], rowActions: [
        { label: "Delete", action: "DELETE /api/admin/houses/:id", confirm: "Delete this house?" },
      ] },
      { kind: "form", action: "POST /api/admin/houses", submitLabel: "Add house", fields: [
        { name: "name", label: "Name", type: "text" },
        { name: "price", label: "Price", type: "money" },
        { name: "will", label: "Will ceiling", type: "number" },
      ] },
      { kind: "form", action: "POST /api/admin/houses/update", submitLabel: "Update house", fields: [
        { name: "id", label: "House", type: "select",
          optionsSource: "GET /api/admin/houses/list", valueKey: "id", labelKey: "name" },
        { name: "name", label: "Rename to (optional)", type: "text" },
        { name: "price", label: "Price", type: "money" },
        { name: "will", label: "Will ceiling", type: "number" },
      ] },
    ],
  },
};
