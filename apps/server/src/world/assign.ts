import type { WorldHook } from "@gl3/plugin-sdk";
import type { Footprint, SceneTemplate, Slot } from "@gl3/shared";
import { CORE_HOOKS, LAYOUT, type PlacedCore, type PlacedGeometry } from "./layout.js";

export interface Assignment {
  placed: PlacedGeometry[];
  core: PlacedCore[];
  dropped: { hook: WorldHook; reason: "no_slot" }[];
}

const footprintOf = (hook: WorldHook): Footprint =>
  hook.footprint ?? (hook.kind === "npc" ? LAYOUT.defaultFootprint.npc : LAYOUT.defaultFootprint.building);
const fits = (slot: Slot, fp: Footprint): boolean => slot.max.w >= fp.w && slot.max.d >= fp.d;

/**
 * Template placement (spec 2026-09-20 §3). Pure. `hooks` is already in
 * `(order, pluginId, id)` order. Each hook takes the first free slot that
 * accepts its kind and fits its footprint, preferring its own zone; a
 * building or npc then falls back to any zone, a prop never does. An
 * unplaced hook is returned in `dropped`, not thrown — the city stays
 * usable and the caller logs it.
 */
export function assignHooks(template: SceneTemplate, hooks: readonly WorldHook[], coreHooks: boolean): Assignment {
  const free = new Set(template.slots.map((s) => s.id));
  const placed: PlacedGeometry[] = [];
  const dropped: Assignment["dropped"] = [];

  const claim = (pred: (s: Slot) => boolean): Slot | null => {
    for (const s of template.slots) if (free.has(s.id) && pred(s)) { free.delete(s.id); return s; }
    return null;
  };

  for (const hook of hooks) {
    const fp = footprintOf(hook);
    const candidate = (s: Slot) => s.accepts === hook.kind && fits(s, fp);
    let slot = hook.zone === undefined ? null : claim((s) => candidate(s) && s.zone === hook.zone);
    if (slot === null && hook.kind !== "prop") slot = claim(candidate);
    if (slot === null) { dropped.push({ hook, reason: "no_slot" }); continue; }
    placed.push({ hook, footprint: fp, position: slot.position, facing: slot.facing });
  }

  const core: PlacedCore[] = coreHooks
    ? [template.facilities.jail, template.facilities.hospital].map((f, i) => {
        const hook = CORE_HOOKS[i]!;
        return { hook, footprint: hook.footprint ?? LAYOUT.defaultFootprint.building, position: f.position, facing: f.facing, yard: f.yard };
      })
    : [];
  return { placed, core, dropped };
}
