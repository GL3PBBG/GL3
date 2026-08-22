import type { PageSchema } from "@gl3/plugin-sdk";

export const theftPage: PageSchema = {
  id: "theft.index",
  path: "/theft",
  menu: { label: "Car theft", order: 40 },
  view: {
    kind: "panel",
    title: "Car theft",
    children: [
      { kind: "slotImage", slot: "page-theft", alt: "Car theft", size: "lg" },
      { kind: "text", value: "Pick a tier. A better tier pays more and gets you caught more." },
      { kind: "table", source: "GET /api/theft/tiers", columns: [
        { key: "image", label: "", render: "image", imageSize: "md" },
        { key: "name", label: "Tier" },
        { key: "successChance", label: "Success %" },
        { key: "maxDamage", label: "Max damage" },
        { key: "minCarValue", label: "Min value" },
        { key: "maxCarValue", label: "Max value" },
        { key: "cars", label: "Cars" },
      ] },
      { kind: "form", action: "POST /api/theft/steal", submitLabel: "Steal a car", fields: [
        { name: "tierId", label: "Tier", type: "select",
          optionsSource: "GET /api/theft/tiers", valueKey: "id", labelKey: "name" },
      ] },
    ],
  },
};

export const garagePage: PageSchema = {
  id: "theft.garage",
  path: "/garage",
  menu: { label: "Garage", order: 41 },
  view: {
    kind: "panel",
    title: "Garage",
    children: [
      { kind: "slotImage", slot: "page-garage", alt: "Garage", size: "lg" },
      { kind: "text", value: "Cars stay in the city you stole them in. Sell or repair them there." },
      { kind: "table", source: "GET /api/garage", columns: [
        { key: "image", label: "", render: "image", imageSize: "md" },
        { key: "carName", label: "Car" },
        { key: "damage", label: "Damage" },
        { key: "locationName", label: "City" },
        { key: "saleValue", label: "Sells for" },
        { key: "repairCost", label: "Repair cost" },
        { key: "here", label: "In this city" },
      ] },
      { kind: "form", action: "POST /api/garage/sell", submitLabel: "Sell", fields: [
        { name: "garageId", label: "Car", type: "select",
          optionsSource: "GET /api/garage", valueKey: "id", labelKey: "carName" },
      ] },
      { kind: "form", action: "POST /api/garage/repair", submitLabel: "Repair", fields: [
        { name: "garageId", label: "Car", type: "select",
          optionsSource: "GET /api/garage", valueKey: "id", labelKey: "carName" },
      ] },
    ],
  },
};

export const adminPage: PageSchema = {
  id: "theft-admin",
  path: "/admin/theft",
  view: {
    kind: "panel",
    title: "Car theft",
    children: [
      { kind: "panel", title: "Cars", children: [
        { kind: "table", source: "GET /api/admin/theft/cars", columns: [
          { key: "name", label: "Name" },
          { key: "value", label: "Value" },
          { key: "theftWeight", label: "Weight" },
        ], rowActions: [
          { label: "Delete", action: "DELETE /api/admin/theft/cars/:id", confirm: "Delete this car? Refused while one sits in any garage." },
        ] },
        { kind: "form", action: "POST /api/admin/theft/cars", submitLabel: "Add car", fields: [
          { name: "name", label: "Name", type: "text" },
          { name: "value", label: "Value", type: "money" },
          { name: "theftWeight", label: "Theft weight", type: "number" },
        ] },
        { kind: "form", action: "POST /api/admin/theft/cars/update", submitLabel: "Update car", fields: [
          { name: "id", label: "Car", type: "select",
            optionsSource: "GET /api/admin/theft/cars", valueKey: "id", labelKey: "name" },
          { name: "name", label: "Rename to (optional)", type: "text" },
          { name: "value", label: "Value", type: "money" },
          { name: "theftWeight", label: "Theft weight", type: "number" },
        ] },
      ] },
      { kind: "panel", title: "Tiers", children: [
        { kind: "table", source: "GET /api/admin/theft/tiers", columns: [
          { key: "name", label: "Name" },
          { key: "successChance", label: "Success %" },
          { key: "maxDamage", label: "Max damage" },
          { key: "minCarValue", label: "Min value" },
          { key: "maxCarValue", label: "Max value" },
        ], rowActions: [
          { label: "Delete", action: "DELETE /api/admin/theft/tiers/:id", confirm: "Delete this theft tier?" },
        ] },
        { kind: "form", action: "POST /api/admin/theft/tiers", submitLabel: "Add tier", fields: [
          { name: "name", label: "Name", type: "text" },
          { name: "successChance", label: "Success %", type: "number" },
          { name: "maxDamage", label: "Max damage", type: "number" },
          { name: "minCarValue", label: "Min value", type: "money" },
          { name: "maxCarValue", label: "Max value", type: "money" },
        ] },
        { kind: "form", action: "POST /api/admin/theft/tiers/update", submitLabel: "Update tier", fields: [
          { name: "id", label: "Tier", type: "select",
            optionsSource: "GET /api/admin/theft/tiers", valueKey: "id", labelKey: "name" },
          { name: "name", label: "Rename to (optional)", type: "text" },
          { name: "successChance", label: "Success %", type: "number" },
          { name: "maxDamage", label: "Max damage", type: "number" },
          { name: "minCarValue", label: "Min value", type: "money" },
          { name: "maxCarValue", label: "Max value", type: "money" },
        ] },
      ] },
    ],
  },
};
