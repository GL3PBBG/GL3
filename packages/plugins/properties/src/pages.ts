import type { PageSchema } from "@gl3/plugin-sdk";

export const adminPage: PageSchema = {
  id: "properties-admin",
  path: "/admin/properties",
  view: {
    kind: "panel",
    title: "Properties",
    children: [
      { kind: "table", source: "GET /api/admin/properties", columns: [
        { key: "locationName", label: "Location" },
        { key: "plugin", label: "Type" },
        { key: "ownerName", label: "Owner" },
        { key: "cost", label: "Lever" },
        { key: "profit", label: "Profit" },
      ], rowActions: [
        { label: "Delete", action: "DELETE /api/admin/properties/:id", confirm: "Delete this property? Refused while a player owns it." },
      ] },
      { kind: "form", action: "POST /api/admin/properties", submitLabel: "Add property", fields: [
        { name: "locationId", label: "Location", type: "select",
          optionsSource: "GET /api/admin/properties/locations", valueKey: "locationId", labelKey: "locationName", allowEmpty: false },
        { name: "pluginId", label: "Type", type: "select",
          optionsSource: "GET /api/admin/properties/types", valueKey: "pluginId", labelKey: "name", allowEmpty: false },
        { name: "cost", label: "Lever", type: "money" },
      ] },
      { kind: "form", action: "POST /api/admin/properties/update", submitLabel: "Update property", fields: [
        { name: "id", label: "Property", type: "select",
          optionsSource: "GET /api/admin/properties", valueKey: "id", labelKey: "label" },
        { name: "pluginId", label: "Type (optional)", type: "select",
          optionsSource: "GET /api/admin/properties/types", valueKey: "pluginId", labelKey: "name", allowEmpty: true },
        { name: "cost", label: "Lever", type: "money" },
      ] },
    ],
  },
};
