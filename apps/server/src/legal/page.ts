import type { PageSchema } from "@gl3/plugin-sdk";

/** Core's legal section: the four placeholders the shipped Terms and Privacy templates need. */
export const legalPage: PageSchema = {
  id: "core-legal-admin",
  path: "/admin/legal",
  view: {
    kind: "panel",
    title: "Terms & privacy",
    children: [
      { kind: "text", value: "The game ships generic Terms of Service and Privacy Policy templates at /terms and /privacy. Fill in the operator details below; an unset field renders as a visible [not set] marker on the public pages. The templates are a starting point, not legal advice — review both documents with a lawyer before publishing your game. Changes land on the next page load." },
      { kind: "table", source: "GET /api/admin/legal/settings", columns: [
        { key: "setting", label: "Setting" },
        { key: "value", label: "Value" },
      ] },
      { kind: "form", action: "POST /api/admin/legal/settings", submitLabel: "Save legal details", valuesSource: "GET /api/admin/legal/settings", fields: [
        { name: "operatorName", label: "Operator (legal entity or person running the game)", type: "text" },
        { name: "contactEmail", label: "Contact email", type: "text" },
        { name: "jurisdiction", label: "Governing law / jurisdiction", type: "text" },
        { name: "effectiveDate", label: "Effective date (YYYY-MM-DD)", type: "text" },
      ] },
    ],
  },
};
