import type { PageSchema } from "@gl3/plugin-sdk";

export const membershipPage: PageSchema = {
  id: "membership.index",
  path: "/membership",
  menu: { label: "Membership", order: 60 },
  view: {
    kind: "panel",
    title: "Premium membership",
    children: [
      { kind: "slotImage", slot: "page-membership", alt: "Premium membership", size: "lg" },
      { kind: "table", source: "GET /api/membership/status", columns: [
        { key: "status", label: "Status" },
        { key: "expiresAt", label: "Expires" },
      ] },
      { kind: "panel", title: "Benefits", children: [
        { kind: "table", source: "GET /api/membership/benefits", columns: [
          { key: "title", label: "Benefit" },
          { key: "description", label: "" },
        ] },
      ] },
      { kind: "panel", title: "Packages", children: [
        { kind: "table", source: "GET /api/membership/packages", columns: [
          { key: "name", label: "Package" },
          { key: "costPoints", label: "Cost (points)" },
          { key: "duration", label: "Duration" },
        ] },
        { kind: "form", action: "POST /api/membership/buy", submitLabel: "Buy", fields: [
          { name: "packageId", label: "Package", type: "select",
            optionsSource: "GET /api/membership/packages", valueKey: "id", labelKey: "name" },
        ] },
        { kind: "form", action: "POST /api/membership/gift", submitLabel: "Gift", fields: [
          { name: "packageId", label: "Package", type: "select",
            optionsSource: "GET /api/membership/packages", valueKey: "id", labelKey: "name" },
          { name: "recipientName", label: "Recipient username", type: "text" },
        ] },
      ] },
    ],
  },
};

export const adminPage: PageSchema = {
  id: "membership-admin",
  path: "/admin/membership",
  view: {
    kind: "panel",
    title: "Membership",
    children: [
      { kind: "panel", title: "Packages", children: [
        { kind: "table", source: "GET /api/admin/membership/packages", columns: [
          { key: "name", label: "Name" },
          { key: "costPoints", label: "Cost (points)" },
          { key: "durationSeconds", label: "Duration (seconds)" },
        ], rowActions: [
          { label: "Delete", action: "DELETE /api/admin/membership/packages/:id", confirm: "Delete this package?" },
        ] },
        { kind: "form", action: "POST /api/admin/membership/packages", submitLabel: "Add package", fields: [
          { name: "name", label: "Name", type: "text" },
          { name: "costPoints", label: "Cost (points)", type: "number" },
          { name: "durationSeconds", label: "Duration (seconds)", type: "number" },
        ] },
        { kind: "form", action: "POST /api/admin/membership/packages/update", submitLabel: "Update package", fields: [
          { name: "id", label: "Package", type: "select",
            optionsSource: "GET /api/admin/membership/packages", valueKey: "id", labelKey: "name" },
          { name: "name", label: "Rename to (optional)", type: "text" },
          { name: "costPoints", label: "Cost (points)", type: "number" },
          { name: "durationSeconds", label: "Duration (seconds)", type: "number" },
        ] },
      ] },
    ],
  },
};
