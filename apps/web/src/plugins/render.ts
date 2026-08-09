/**
 * The flattened instruction set `PageRenderer` turns into React. Each leaf node
 * maps 1:1; `panel` emits a header instruction then its children; `list` emits
 * its items with no separator (the renderer applies spacing). Keeping this a
 * pure transform is what makes it testable without a DOM.
 */
export type RenderInstruction =
  | { kind: "text"; value: string }
  | { kind: "money"; value: string }
  | { kind: "error"; value: string }
  | { kind: "link"; label: string; to: string }
  | { kind: "button"; label: string; action: string }
  | { kind: "cooldownButton"; label: string; action: string; cooldownAction: string }
  | { kind: "keyValue"; rows: { label: string; value: string }[] }
  | { kind: "form"; action: string; submitLabel: string; fields: { name: string; label: string; type: "text" | "number" | "money" | "password" }[] }
  | { kind: "panelHeader"; title: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Narrow the `unknown` DTO node by `kind`. The DTO schema already rejected shapes the server never sends. */
function isNode(v: unknown, kind: string): v is Record<string, unknown> {
  return isRecord(v) && v.kind === kind;
}

/**
 * `Array.isArray` on an `unknown` narrows to `any[]`, which would leak an
 * implicit `any` into every element. Naming the element type `unknown` keeps the
 * children flowing back through `renderNode`'s own guards.
 */
function childArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * The DTO enum has already rejected anything outside these four, so the fallback
 * is unreachable for a validated payload. It falls back to `text` rather than
 * dropping the field: `text` is the widget that accepts the widest input and
 * hides nothing, so a hypothetical unknown type degrades to a visible plain
 * input instead of a field the player cannot see or fill.
 */
function isFieldType(v: unknown): v is "text" | "number" | "money" | "password" {
  return v === "text" || v === "number" || v === "money" || v === "password";
}

export function renderNode(node: unknown, _handlers: Record<string, (action: string) => void>): RenderInstruction[] {
  if (isNode(node, "text")) return [{ kind: "text", value: String(node.value) }];
  if (isNode(node, "money")) return [{ kind: "money", value: String(node.value) }];
  if (isNode(node, "error")) return [{ kind: "error", value: String(node.value) }];
  if (isNode(node, "link")) return [{ kind: "link", label: String(node.label), to: String(node.to) }];
  if (isNode(node, "button")) return [{ kind: "button", label: String(node.label), action: String(node.action) }];
  if (isNode(node, "cooldownButton")) {
    return [{
      kind: "cooldownButton",
      label: String(node.label),
      action: String(node.action),
      cooldownAction: String(node.cooldownAction),
    }];
  }
  if (isNode(node, "keyValue")) {
    const rows = childArray(node.rows).map((r) => ({
      label: isRecord(r) ? String(r.label) : "",
      value: isRecord(r) ? String(r.value) : "",
    }));
    return [{ kind: "keyValue", rows }];
  }
  if (isNode(node, "form")) {
    const fields = childArray(node.fields).map((f) => ({
      name: isRecord(f) ? String(f.name) : "",
      label: isRecord(f) ? String(f.label) : "",
      type: isRecord(f) && isFieldType(f.type) ? f.type : ("text" as const),
    }));
    return [{ kind: "form", action: String(node.action), submitLabel: String(node.submitLabel), fields }];
  }
  if (isNode(node, "panel")) {
    const out: RenderInstruction[] = [{ kind: "panelHeader", title: String(node.title) }];
    for (const child of childArray(node.children)) out.push(...renderNode(child, _handlers));
    return out;
  }
  if (isNode(node, "list")) {
    const out: RenderInstruction[] = [];
    for (const item of childArray(node.items)) out.push(...renderNode(item, _handlers));
    return out;
  }
  // Unreachable for validated payloads: the DTO schema already rejected it.
  return [];
}
