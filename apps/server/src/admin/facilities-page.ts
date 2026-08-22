import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's facility-fee section: the jail and hospital price knobs, which had
 * no admin editor before the wealth-scaled fees landed (operators inserted
 * settings rows by hand). Detectives' equivalent panel lives in its plugin.
 *
 * Reads show EFFECTIVE values (parser output, defaults included) and writes
 * go to the settings table — the boot-time snapshot means an edit takes
 * effect on the next restart, which the intro text says out loud, matching
 * the detectives panel's posture.
 */
export const facilitiesPage: PageSchema = {
  id: "core-facilities-admin",
  path: "/admin/facilities",
  view: {
    kind: "panel",
    title: "Facility fees",
    children: [
      { kind: "text", value: "Bail and discharge fees are wealth-scaled: raised toward the percent of the payer's cash + bank, floored at the per-second rate × remaining seconds, and capped at a multiple of that flat fee. Set the percent to 0 to charge the flat fee to everyone. Edits take effect on the next server restart." },
      { kind: "table", source: "GET /api/admin/facilities/table", columns: [
        { key: "label", label: "Setting" },
        { key: "value", label: "Value" },
      ] },
      { kind: "form", action: "POST /api/admin/facilities", submitLabel: "Update facility fees", fields: [
        { name: "jail_bail_cost_per_second", label: "Bail per second (flat floor)", type: "money" },
        { name: "jail_bail_wealth_percent", label: "Bail: percent of payer's wealth (0–100)", type: "number" },
        { name: "jail_bail_wealth_cap_multiplier", label: "Bail: cap multiple of flat fee", type: "number" },
        { name: "hospital_discharge_cost_per_second", label: "Discharge per second (flat floor)", type: "money" },
        { name: "hospital_discharge_wealth_percent", label: "Discharge: percent of payer's wealth (0–100)", type: "number" },
        { name: "hospital_discharge_wealth_cap_multiplier", label: "Discharge: cap multiple of flat fee", type: "number" },
      ] },
    ],
  },
};
