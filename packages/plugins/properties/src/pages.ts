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
        { key: "cost", label: "Cost" },
        { key: "rate", label: "Rate" },
        { key: "profit", label: "Profit" },
      ] },
      { kind: "form", action: "POST /api/admin/properties", submitLabel: "Add property", fields: [
        { name: "locationId", label: "Location", type: "select",
          optionsSource: "GET /api/admin/properties/locations", valueKey: "locationId", labelKey: "locationName", allowEmpty: false },
        { name: "pluginId", label: "Type", type: "select",
          optionsSource: "GET /api/admin/properties/types", valueKey: "pluginId", labelKey: "name", allowEmpty: false },
        { name: "cost", label: "Cost", type: "money" },
        { name: "rate", label: "Rate", type: "money" },
      ] },
      { kind: "form", action: "POST /api/admin/properties/update", submitLabel: "Update property", fields: [
        { name: "id", label: "Property", type: "select",
          optionsSource: "GET /api/admin/properties", valueKey: "id", labelKey: "locationName" },
        { name: "pluginId", label: "Type (optional)", type: "select",
          optionsSource: "GET /api/admin/properties/types", valueKey: "pluginId", labelKey: "name", allowEmpty: true },
        { name: "cost", label: "Cost", type: "money" },
        { name: "rate", label: "Rate", type: "money" },
      ] },
    ],
  },
};
