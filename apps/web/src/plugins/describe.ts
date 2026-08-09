/**
 * Single non-greedy pass over the template. One pass — rather than repeated
 * replacement — stops a payload value that itself contains braces from being
 * re-expanded, which would let a player-supplied string address other
 * placeholders. An unmatched placeholder stays literal so a manifest typo is
 * visible in the feed instead of rendering "undefined".
 *
 * Mirrors `renderDescribe` in the SDK (`@gl3/plugin-sdk/src/events.ts`) so the
 * client and any server-side preview agree.
 */
export function describePluginEvent(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}
