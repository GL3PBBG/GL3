import { z } from "zod";

export interface PluginEventDecl {
  /** Event name, unique within the plugin. Reaches the client as `name`. */
  name: string;
  payload: z.ZodTypeAny;
  /** Template over the payload plus `actorName`, e.g. "{actorName} placed a bounty on {target}". */
  describe: string;
  /** React Query key prefixes this event invalidates on the client. */
  invalidates: string[];
}

/**
 * Duck-typed rather than `instanceof z.ZodType`: a plugin may be bundled with
 * its own copy of zod, and `instanceof` across two module instances is false
 * for a perfectly good schema. Every zod schema exposes `safeParse`, which is
 * also the only member the runtime ever calls on a declared payload.
 */
function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof value.safeParse === "function"
  );
}

/**
 * Unlike `provides` and `filters`, an event declaration is plain data apart
 * from `payload`, so it is checked for real here rather than waved through —
 * three of its four fields are ordinary strings. `payload` is the one member
 * zod cannot describe structurally, and `z.custom` carries the type through to
 * `result.data` while still rejecting a value that is not a schema at all.
 * That rejection matters: the loader is required to fail boot naming the
 * plugin id, and without the predicate a non-schema `payload` would instead
 * surface much later as `payload.safeParse is not a function` when the first
 * event of that name is published.
 */
export const PluginEventDeclSchema = z
  .object({
    name: z.string().min(1),
    payload: z.custom<z.ZodTypeAny>(isZodSchema, { message: "payload must be a zod schema" }),
    describe: z.string().min(1),
    invalidates: z.array(z.string().min(1)),
  })
  .strict();

/**
 * One non-greedy pass over the template. A single pass — rather than repeated
 * replacement — is what stops a payload value that itself contains braces from
 * being re-expanded, which would let a player-supplied string address other
 * placeholders. An unmatched placeholder stays literal so a manifest typo is
 * visible in the feed instead of rendering "undefined".
 */
export function renderDescribe(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}
