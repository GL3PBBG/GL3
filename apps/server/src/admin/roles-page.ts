import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's role-management section, served through the same payload as plugin
 * adminPages so the client renders core and plugins through one code path.
 *
 * No `id` column on the table and no id typed into any field: every reference
 * to a role travels as a `select`'s `valueKey`, so the admin picks a name and
 * the UUID never reaches the screen.
 */
export const rolesPage: PageSchema = {
  id: "core-roles-admin",
  path: "/admin/roles",
  view: {
    kind: "panel",
    title: "Roles",
    children: [
      { kind: "table", source: "GET /api/admin/roles/table", columns: [
        { key: "name", label: "Name" },
        { key: "moduleKeys", label: "Grants" },
      ] },
      { kind: "form", action: "POST /api/admin/roles", submitLabel: "Create role", fields: [
        { name: "name", label: "Role name", type: "text" },
      ] },
      // Grant and revoke are one module at a time: the view vocabulary has no
      // multi-select, and a comma-separated text field would put module keys
      // back in front of the admin as strings to spell correctly.
      { kind: "form", action: "POST /api/admin/roles/grants", submitLabel: "Grant module", fields: [
        { name: "roleId", label: "Role", type: "select", optionsSource: "GET /api/admin/roles/table", valueKey: "id", labelKey: "name" },
        { name: "moduleKey", label: "Module", type: "select", optionsSource: "GET /api/admin/roles/modules", valueKey: "id", labelKey: "name" },
      ] },
      { kind: "form", action: "POST /api/admin/roles/grants/revoke", submitLabel: "Revoke module", fields: [
        { name: "roleId", label: "Role", type: "select", optionsSource: "GET /api/admin/roles/table", valueKey: "id", labelKey: "name" },
        { name: "moduleKey", label: "Module", type: "select", optionsSource: "GET /api/admin/roles/modules", valueKey: "id", labelKey: "name" },
      ] },
      { kind: "form", action: "POST /api/admin/roles/assign", submitLabel: "Assign role", fields: [
        { name: "username", label: "Username", type: "text" },
        { name: "roleId", label: "Role (empty clears)", type: "select", optionsSource: "GET /api/admin/roles/table", valueKey: "id", labelKey: "name", allowEmpty: true },
      ] },
    ],
  },
};
