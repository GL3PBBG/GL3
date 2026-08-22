import type { PageSchema } from "@gl3/plugin-sdk";

/**
 * Core's wealth-tax section, the second page under the `economy` grant beside
 * the MIMO dashboard. Same posture as the facilities page: reads show
 * EFFECTIVE values through the same parsers the settle pass uses, writes go
 * to the settings table, and the boot-time snapshot makes an edit
 * restart-to-apply — which the intro text says out loud.
 */
export const wealthTaxPage: PageSchema = {
  id: "core-economy-tax-admin",
  path: "/admin/economy/tax",
  view: {
    kind: "panel",
    title: "Wealth tax",
    children: [
      { kind: "text", value: "Once per UTC day, every player and gang bank above the threshold pays the percent on the EXCESS only — banked money decays slowly, pocket cash stays stealable, so depositing remains a tradeoff. Taxed money is destroyed and shows in the Economy dashboard under reason economy.wealth_tax. Set the percent to 0 to switch the tax off. Edits take effect on the next server restart." },
      { kind: "table", source: "GET /api/admin/economy/tax/table", columns: [
        { key: "label", label: "Setting" },
        { key: "value", label: "Value" },
      ] },
      { kind: "form", action: "POST /api/admin/economy/tax", submitLabel: "Update wealth tax", fields: [
        { name: "percent", label: "Percent of excess bank per day (0–100)", type: "number" },
        { name: "threshold", label: "Threshold above which the excess is taxed", type: "money" },
      ] },
    ],
  },
};
