import type { SceneTemplate } from "@gl3/shared";
import { DISTRICT_CORNER_V1 } from "./district-corner-v1.js";
import { validateTemplate } from "./validate.js";

export const SCENE_TEMPLATES: ReadonlyMap<string, SceneTemplate> = new Map([[DISTRICT_CORNER_V1.key, DISTRICT_CORNER_V1]]);

/** Boot guard: a template with a violation is a build defect. */
export function assertTemplatesValid(): void {
  const problems: string[] = [];
  for (const t of SCENE_TEMPLATES.values()) for (const m of validateTemplate(t)) problems.push(`${t.key}: ${m}`);
  if (problems.length > 0) throw new Error(`invalid scene template(s):\n${problems.join("\n")}`);
}
