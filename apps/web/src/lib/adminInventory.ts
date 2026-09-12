import { z } from "zod";

export const adminItemListSchema = z.object({ rows: z.array(z.object({
  id: z.string(), name: z.string(), itemType: z.string(),
}).catchall(z.string())) });
export type AdminItemRow = z.infer<typeof adminItemListSchema>["rows"][number];
export const adminItemSchema = z.object({
  id: z.string(), name: z.string(), itemType: z.string(), effects: z.unknown(),
});
export type AdminItem = z.infer<typeof adminItemSchema>;
export const adminShopSchema = z.object({ rows: z.array(z.object({
  locationId: z.string(), locationName: z.string(), itemId: z.string(), itemName: z.string(),
  price: z.string(), stock: z.string(),
})) });
export type AdminStock = z.infer<typeof adminShopSchema>["rows"][number];
export const adminLocationsSchema = z.object({ rows: z.array(z.object({ id: z.string(), name: z.string() })) });

export const itemTypes = { weapon: "Firearm", melee: "Melee weapon", armor: "Armor", consumable: "Consumable", misc: "Miscellaneous" };
export type ItemFormType = keyof typeof itemTypes;
export type ItemDraft = Record<string, string> & { name: string; itemType: ItemFormType };
export interface ItemField {
  name: string; label: string; type?: "text" | "number"; required?: boolean;
  min?: number; max?: number; step?: string; hint?: string;
}
export const itemFields: Record<ItemFormType, ItemField[]> = {
  weapon: [
    { name: "damageMin", label: "Minimum damage", required: true, min: 0 },
    { name: "damageMax", label: "Maximum damage", required: true, min: 0 },
    { name: "accuracy", label: "Accuracy (%)", min: 0, max: 100, hint: "Blank uses the combat default." },
    { name: "bulletsPerShot", label: "Bullets per shot", min: 1, hint: "Default: 1" },
    { name: "critChance", label: "Critical chance (%)", min: 0, max: 100, hint: "Default: 0" },
    { name: "critMultiplier", label: "Critical multiplier", min: 1, step: "any", hint: "Default: 1" },
    { name: "armorPierce", label: "Armor penetration", min: 0, hint: "Default: 0" },
    { name: "minRankExp", label: "Required experience", min: 0, hint: "Default: 0" },
    { name: "backfireChance", label: "Backfire chance (%)", min: 0, max: 100, hint: "Blank uses the combat default; 0 disables backfires." },
    { name: "dps", label: "Damage per second", min: 0, step: "any", hint: "Must be positive. Blank uses the standard attack cooldown." },
  ],
  melee: [{ name: "power", label: "Power", required: true, min: 1 }],
  armor: [{ name: "armor", label: "Armor protection", required: true, min: 0 }],
  consumable: [
    { name: "kind", label: "Effect kind", type: "text", hint: "Blank uses healing, or pools when pool changes are set. Custom effect kinds are supported." },
    { name: "heal", label: "Health restored", type: "text", hint: "For healing: 25 or 50%. Leave blank for pool effects." },
    { name: "energy", label: "Energy change", type: "text", hint: "25, -25 or 50%. Negative values are costs." },
    { name: "will", label: "Will change", type: "text", hint: "25, -25 or 50%. Blank leaves this pool unchanged." },
    { name: "brave", label: "Brave change", type: "text", hint: "25, -25 or 50%. Blank leaves this pool unchanged." },
  ],
  misc: [],
};

export function effectsRecord(effects: unknown): Record<string, unknown> {
  return typeof effects === "object" && effects !== null && !Array.isArray(effects)
    ? effects as Record<string, unknown> : {};
}
export function itemFormType(item: AdminItem): ItemFormType | null {
  if (item.itemType === "weapon" && "power" in effectsRecord(item.effects)) return "melee";
  return Object.hasOwn(itemTypes, item.itemType) ? item.itemType as ItemFormType : null;
}
export function itemDraft(item: AdminItem): ItemDraft | null {
  const itemType = itemFormType(item);
  if (itemType === null) return null;
  const effects = effectsRecord(item.effects);
  const pools = effectsRecord(effects["pools"]);
  const draft: ItemDraft = { name: item.name, itemType };
  for (const field of itemFields[itemType]) {
    const value = ["energy", "will", "brave"].includes(field.name) ? pools[field.name] : effects[field.name];
    draft[field.name] = typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
  return draft;
}
export function itemPayload(draft: ItemDraft): Record<string, string> {
  return Object.fromEntries([
    ["name", draft.name.trim()], ["itemType", draft.itemType],
    ...itemFields[draft.itemType].map((field) => [field.name, (draft[field.name] ?? "").trim()]),
  ]);
}
export function rowType(row: AdminItemRow): string {
  return row.itemType === "weapon" && row["power"] ? "melee" : row.itemType;
}
export function itemSummary(row: AdminItemRow): string {
  return [
    ["damage", "Damage"], ["power", "Power"], ["armor", "Armor"],
    ["heal", "Heal"], ["pools", "Pools"],
  ].flatMap(([key, label]) => {
    const value = row[key!];
    return value && value !== "—" ? [`${label}: ${value}`] : [];
  }).join(" · ") || (row["effect"] && row["effect"] !== "—" ? `Effect: ${row["effect"]}` : "No combat stats");
}
