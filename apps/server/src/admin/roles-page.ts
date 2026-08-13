import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's role-management section, served through the same payload as plugin
 * adminPages so the client renders core and plugins through one code path.
 */
export const rolesPage: PageSchema = {
  id: "core-roles-admin",
  path: "/admin/roles",
  view: {
    kind: "panel",
    title: "Roles",
    children: [
      { kind: "table", source: "GET /api/admin/roles/table", columns: [
        { key: "id", label: "Role id" },
        { key: "name", label: "Name" },
        { key: "moduleKeys", label: "Grants" },
      ] },
      { kind: "form", action: "POST /api/admin/roles/assign", submitLabel: "Assign role", fields: [
        { name: "username", label: "Username", type: "text" },
        { name: "roleId", label: "Role id (empty clears)", type: "text" },
      ] },
    ],
  },
};
