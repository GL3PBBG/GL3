import type { Slot } from "@gl3/shared";

export interface Rect { x0: number; x1: number; y0: number; y1: number }

/** Axis-aligned rectangle of a slot's `max` footprint at its facing: 0/π keep w along x; ±π/2 swap. */
export function slotRect(slot: Pick<Slot, "position" | "facing" | "max">): Rect {
  const swap = Math.abs(Math.abs(slot.facing) - Math.PI / 2) < 1e-9;
  const w = swap ? slot.max.d : slot.max.w;
  const d = swap ? slot.max.w : slot.max.d;
  return { x0: slot.position.x - w / 2, x1: slot.position.x + w / 2, y0: slot.position.y - d / 2, y1: slot.position.y + d / 2 };
}

export const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
