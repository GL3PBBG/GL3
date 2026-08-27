import type { PageSchema } from "@gl3/plugin-sdk";

export const jobsPage: PageSchema = {
  id: "jobs.index",
  path: "/jobs",
  menu: { label: "Jobs", order: 24, category: "town" },
  view: {
    kind: "panel",
    title: "Jobs",
    children: [
      { kind: "keyValueSource", source: "GET /api/jobs/board", entries: [
        { label: "Job", key: "jobName" },
        { label: "Rank", key: "rankName" },
        { label: "Pay", key: "pay" },
      ], emptyText: "Unemployed" },
      { kind: "table", source: "GET /api/jobs/board", columns: [
        { key: "jobName", label: "Job" },
        { key: "rankName", label: "Rank" },
        { key: "pay", label: "Pay" },
        { key: "strengthReq", label: "Strength" },
        { key: "labourReq", label: "Labour" },
        { key: "iqReq", label: "IQ" },
      ] },
      { kind: "form", action: "POST /api/jobs/interview", submitLabel: "Interview", fields: [
        { name: "jobId", label: "Job", type: "select",
          optionsSource: "GET /api/jobs/list", valueKey: "id", labelKey: "name" },
      ] },
      { kind: "button", label: "Promote", action: "POST /api/jobs/promote" },
      { kind: "button", label: "Quit", action: "POST /api/jobs/quit" },
    ],
  },
};

export const adminPage: PageSchema = {
  id: "jobs-admin",
  path: "/admin/jobs",
  view: {
    kind: "panel",
    title: "Jobs",
    children: [
      { kind: "panel", title: "Jobs", children: [
        { kind: "table", source: "GET /api/admin/jobs/list", columns: [
          { key: "name", label: "Name" },
          { key: "description", label: "Description" },
        ], rowActions: [
          { label: "Delete", action: "DELETE /api/admin/jobs/:id", confirm: "Delete this job?" },
        ] },
        { kind: "form", action: "POST /api/admin/jobs", submitLabel: "Add job", fields: [
          { name: "name", label: "Name", type: "text" },
          { name: "description", label: "Description", type: "text" },
          { name: "firstRankId", label: "Entry rank", type: "select",
            optionsSource: "GET /api/admin/jobs/ranks/list", valueKey: "id", labelKey: "rankLabel" },
        ] },
        { kind: "form", action: "POST /api/admin/jobs/update", submitLabel: "Update job", fields: [
          { name: "id", label: "Job", type: "select",
            optionsSource: "GET /api/admin/jobs/list", valueKey: "id", labelKey: "name" },
          { name: "name", label: "Rename to (optional)", type: "text" },
          { name: "description", label: "New description (optional)", type: "text" },
          { name: "firstRankId", label: "Entry rank", type: "select",
            optionsSource: "GET /api/admin/jobs/ranks/list", valueKey: "id", labelKey: "rankLabel" },
        ] },
      ] },
      { kind: "panel", title: "Ranks", children: [
        { kind: "table", source: "GET /api/admin/jobs/ranks/list", columns: [
          { key: "jobName", label: "Job" },
          { key: "name", label: "Rank" },
          { key: "pay", label: "Pay" },
          { key: "strengthGain", label: "Strength gain" },
          { key: "labourGain", label: "Labour gain" },
          { key: "iqGain", label: "IQ gain" },
          { key: "strengthReq", label: "Strength req" },
          { key: "labourReq", label: "Labour req" },
          { key: "iqReq", label: "IQ req" },
        ], rowActions: [
          { label: "Delete", action: "DELETE /api/admin/jobs/ranks/:id", confirm: "Delete this rank?" },
        ] },
        { kind: "form", action: "POST /api/admin/jobs/ranks", submitLabel: "Add rank", fields: [
          { name: "jobId", label: "Job", type: "select",
            optionsSource: "GET /api/admin/jobs/list", valueKey: "id", labelKey: "name" },
          { name: "name", label: "Name", type: "text" },
          { name: "pay", label: "Pay", type: "money" },
          { name: "strengthGain", label: "Strength gain", type: "number" },
          { name: "labourGain", label: "Labour gain", type: "number" },
          { name: "iqGain", label: "IQ gain", type: "number" },
          { name: "strengthReq", label: "Strength req", type: "number" },
          { name: "labourReq", label: "Labour req", type: "number" },
          { name: "iqReq", label: "IQ req", type: "number" },
        ] },
        { kind: "form", action: "POST /api/admin/jobs/ranks/update", submitLabel: "Update rank", fields: [
          { name: "id", label: "Rank", type: "select",
            optionsSource: "GET /api/admin/jobs/ranks/list", valueKey: "id", labelKey: "rankLabel" },
          { name: "jobId", label: "Job", type: "select",
            optionsSource: "GET /api/admin/jobs/list", valueKey: "id", labelKey: "name" },
          { name: "name", label: "Rename to (optional)", type: "text" },
          { name: "pay", label: "Pay", type: "money" },
          { name: "strengthGain", label: "Strength gain", type: "number" },
          { name: "labourGain", label: "Labour gain", type: "number" },
          { name: "iqGain", label: "IQ gain", type: "number" },
          { name: "strengthReq", label: "Strength req", type: "number" },
          { name: "labourReq", label: "Labour req", type: "number" },
          { name: "iqReq", label: "IQ req", type: "number" },
        ] },
      ] },
    ],
  },
};
