import type { PageSchema } from "@gl3/plugin-sdk";

export const educationPage: PageSchema = {
  id: "education.index",
  path: "/education",
  menu: { label: "Education", order: 23, category: "town" },
  view: {
    kind: "panel",
    title: "Education",
    children: [
      { kind: "keyValueSource", source: "GET /api/education/board", entries: [
        { label: "Course", key: "activeName" },
        { label: "Days remaining", key: "daysRemaining" },
      ], emptyText: "Not studying" },
      { kind: "table", source: "GET /api/education/board", columns: [
        { key: "name", label: "Course" },
        { key: "description", label: "Description" },
        { key: "cost", label: "Cost" },
        { key: "days", label: "Days" },
        { key: "strengthGain", label: "Strength" },
        { key: "agilityGain", label: "Agility" },
        { key: "guardGain", label: "Guard" },
        { key: "labourGain", label: "Labour" },
        { key: "iqGain", label: "IQ" },
        { key: "status", label: "Status" },
      ] },
      { kind: "form", action: "POST /api/education/start", submitLabel: "Start course", fields: [
        { name: "courseId", label: "Course", type: "select",
          optionsSource: "GET /api/education/board", valueKey: "id", labelKey: "name" },
      ] },
    ],
  },
};

export const adminPage: PageSchema = {
  id: "education-admin",
  path: "/admin/education",
  view: {
    kind: "panel",
    title: "Education",
    children: [
      { kind: "table", source: "GET /api/admin/education/list", columns: [
        { key: "name", label: "Name" },
        { key: "description", label: "Description" },
        { key: "cost", label: "Cost" },
        { key: "days", label: "Days" },
        { key: "strengthGain", label: "Strength" },
        { key: "agilityGain", label: "Agility" },
        { key: "guardGain", label: "Guard" },
        { key: "labourGain", label: "Labour" },
        { key: "iqGain", label: "IQ" },
      ], rowActions: [
        { label: "Delete", action: "DELETE /api/admin/education/:id", confirm: "Delete this course?" },
      ] },
      { kind: "form", action: "POST /api/admin/education", submitLabel: "Add course", fields: [
        { name: "name", label: "Name", type: "text" },
        { name: "description", label: "Description", type: "text" },
        { name: "cost", label: "Cost", type: "money" },
        { name: "days", label: "Days", type: "number" },
        { name: "strengthGain", label: "Strength gain", type: "number" },
        { name: "agilityGain", label: "Agility gain", type: "number" },
        { name: "guardGain", label: "Guard gain", type: "number" },
        { name: "labourGain", label: "Labour gain", type: "number" },
        { name: "iqGain", label: "IQ gain", type: "number" },
      ] },
      { kind: "form", action: "POST /api/admin/education/update", submitLabel: "Update course", fields: [
        { name: "id", label: "Course", type: "select",
          optionsSource: "GET /api/admin/education/list", valueKey: "id", labelKey: "name" },
        { name: "name", label: "Rename to (optional)", type: "text" },
        { name: "description", label: "New description (optional)", type: "text" },
        { name: "cost", label: "Cost", type: "money" },
        { name: "days", label: "Days", type: "number" },
        { name: "strengthGain", label: "Strength gain", type: "number" },
        { name: "agilityGain", label: "Agility gain", type: "number" },
        { name: "guardGain", label: "Guard gain", type: "number" },
        { name: "labourGain", label: "Labour gain", type: "number" },
        { name: "iqGain", label: "IQ gain", type: "number" },
      ] },
    ],
  },
};
