import type { PageSchema } from "@gl3/plugin-sdk";

export const gymPage: PageSchema = {
  id: "gym.index",
  path: "/gym",
  menu: { label: "Gym", order: 21, category: "town" },
  view: {
    kind: "panel",
    title: "Gym",
    children: [
      { kind: "slotImage", slot: "page-gym", alt: "Gym", size: "lg" },
      { kind: "meterSource", label: "Energy", source: "GET /api/gym", valueKey: "energy", maxKey: "energyMax" },
      { kind: "form", action: "POST /api/gym/train", submitLabel: "Train", fields: [
        { name: "stat", label: "Stat", type: "select",
          optionsSource: "GET /api/gym/stats", valueKey: "id", labelKey: "name" },
        { name: "reps", label: "Reps", type: "number" },
      ] },
      { kind: "keyValueSource", source: "GET /api/gym", entries: [
        { label: "Strength", key: "strength" },
        { label: "Agility", key: "agility" },
        { label: "Guard", key: "guard" },
        { label: "Labour", key: "labour" },
      ] },
    ],
  },
};
