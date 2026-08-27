import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * All three exchanges are declared unconditionally — a disabled one answers
 * its own 403 `exchange_disabled` toast rather than being hidden by a
 * conditional node (spec ruling: no per-exchange conditional view exists).
 */
export const templePage: PageSchema = {
  id: "temple.index",
  path: "/temple",
  menu: { label: "Temple", order: 25, category: "town" },
  view: {
    kind: "panel",
    title: "Temple",
    children: [
      { kind: "keyValueSource", source: "GET /api/temple", entries: [
        { label: "Offered here", key: "exchanges" },
      ], emptyText: "Nothing offered" },
      { kind: "button", label: "Refill energy", action: "POST /api/temple/refill" },
      { kind: "form", action: "POST /api/temple/iq", submitLabel: "Exchange for IQ", fields: [
        { name: "points", label: "Points", type: "number" },
      ] },
      { kind: "form", action: "POST /api/temple/money", submitLabel: "Exchange for cash", fields: [
        { name: "points", label: "Points", type: "number" },
      ] },
    ],
  },
};
