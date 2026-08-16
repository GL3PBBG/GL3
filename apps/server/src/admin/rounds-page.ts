import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's round-scheduling section, served through the same payload as plugin
 * adminPages so the client renders core and plugins through one code path.
 *
 * No UUID column: the round id travels only as the edit form's select
 * `valueKey`, so the admin picks a round by name. `admin-ids-hidden.test.ts`
 * enforces this with /^id$|Id$/ — `roundId` would fail, `roundName` passes.
 *
 * Dates are `type: "text"`: the field vocabulary has no date type and adding
 * one to the SDK is out of scope. The label carries the format and
 * `z.string().datetime({ offset: true })` on the body is what enforces it.
 *
 * There is deliberately no "end it now" action: setting `endsAt` into the
 * past through the edit form IS how a round ends — the next lazy rollover
 * settles it.
 */
export const roundsPage: PageSchema = {
  id: "core-rounds-admin",
  path: "/admin/rounds",
  view: {
    kind: "panel",
    title: "Rounds",
    children: [
      { kind: "table", source: "GET /api/admin/rounds/table", columns: [
        { key: "name", label: "Name" },
        { key: "startsAt", label: "Starts" },
        { key: "endsAt", label: "Ends" },
        { key: "status", label: "Status" },
      ] },
      { kind: "form", action: "POST /api/admin/rounds", submitLabel: "Create round", fields: [
        { name: "name", label: "Round name", type: "text" },
        { name: "startsAt", label: "Starts at (ISO 8601 UTC, e.g. 2026-09-01T00:00:00Z)", type: "text" },
        { name: "endsAt", label: "Ends at (ISO 8601 UTC)", type: "text" },
      ] },
      { kind: "form", action: "POST /api/admin/rounds/edit", submitLabel: "Edit round", fields: [
        { name: "roundId", label: "Round", type: "select", optionsSource: "GET /api/admin/rounds/table", valueKey: "id", labelKey: "name" },
        { name: "name", label: "Round name", type: "text" },
        { name: "startsAt", label: "Starts at (ISO 8601 UTC)", type: "text" },
        { name: "endsAt", label: "Ends at (ISO 8601 UTC)", type: "text" },
      ] },
    ],
  },
};
