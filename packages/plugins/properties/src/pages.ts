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
      {
        kind: "panel",
        title: "Venues",
        children: [
          { kind: "text", value: "A town has a venue — a casino, a bullet factory — only where a property row exists for it. Nobody owning the row means it is state-run and any player standing in that town can buy it; no row at all means the town does not have one and its door is not on the street. Removing a venue is refused while a player owns it: disown it first." },
          { kind: "table", source: "GET /api/admin/properties/venues", columns: [
            { key: "locationName", label: "Town" },
            { key: "typeName", label: "Type" },
            { key: "owner", label: "Owner" },
          ] },
          { kind: "form", action: "POST /api/admin/properties/venues", submitLabel: "Add venue", fields: [
            { name: "locationId", label: "Town", type: "select",
              optionsSource: "GET /api/admin/properties/locations", valueKey: "locationId", labelKey: "locationName", allowEmpty: false },
            { name: "pluginId", label: "Type", type: "select",
              optionsSource: "GET /api/admin/properties/types", valueKey: "pluginId", labelKey: "name", allowEmpty: false },
          ] },
          { kind: "form", action: "POST /api/admin/properties/venues/remove", submitLabel: "Remove venue", fields: [
            { name: "locationId", label: "Town", type: "select",
              optionsSource: "GET /api/admin/properties/locations", valueKey: "locationId", labelKey: "locationName", allowEmpty: false },
            { name: "pluginId", label: "Type", type: "select",
              optionsSource: "GET /api/admin/properties/types", valueKey: "pluginId", labelKey: "name", allowEmpty: false },
          ] },
        ],
      },
      { kind: "text", value: "Franchise skim: the share of every owner CREDIT destroyed rather than paid, so property income partly drains the economy instead of purely pooling at owners. Debits (a casino house paying out) are never skimmed. 0 restores full payout. Unlike every other setting this one applies immediately — no restart." },
      { kind: "table", source: "GET /api/admin/properties/settings", columns: [
        { key: "label", label: "Setting" },
        { key: "value", label: "Value" },
      ] },
      { kind: "form", action: "POST /api/admin/properties/settings", submitLabel: "Update skim", fields: [
        { name: "skim_percent", label: "Skim percent of owner income (0–100)", type: "number" },
      ] },
    ],
  },
};
