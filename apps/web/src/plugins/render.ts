/**
 * The flattened instruction set `PageRenderer` turns into React. Each leaf node
 * maps 1:1; `panel` emits a header instruction then its children; `list` emits
 * its items with no separator (the renderer applies spacing). Keeping this a
 * pure transform is what makes it testable without a DOM.
 */
/**
 * A select field carries where its options come from; `allowEmpty` is
 * normalised to a required boolean here so the renderer never re-derives the
 * DTO's optionality. A hidden field carries the constant it submits and no
 * label — it draws nothing.
 */
export type FormField =
  | { name: string; label: string; type: "text" | "number" | "decimal" | "money" | "password" }
  | { name: string; type: "hidden"; value: string }
  | { name: string; label: string; type: "select"; optionsSource: string; valueKey: string; labelKey: string; allowEmpty: boolean };

export type RenderInstruction =
  | { kind: "text"; value: string }
  | { kind: "money"; value: string }
  | { kind: "error"; value: string }
  | { kind: "link"; label: string; to: string }
  | { kind: "button"; label: string; action: string }
  | { kind: "cooldownButton"; label: string; action: string; cooldownAction: string }
  | { kind: "keyValue"; rows: { label: string; value: string }[] }
  | { kind: "form"; action: string; submitLabel: string; fields: FormField[] }
  | { kind: "image"; url: string; alt: string; size: "sm" | "md" | "lg" }
  | { kind: "assetBinder"; scope: string; slot: string; entitySource: string; entityLabelKey: string }
  | { kind: "table"; source: string; columns: { key: string; label: string; render: "image" | null }[] }
  | { kind: "cards"; cards: string[] }
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
 * The DTO enum has already rejected anything outside these five, so the fallback
 * is unreachable for a validated payload. It falls back to `text` rather than
 * dropping the field: `text` is the widget that accepts the widest input and
 * hides nothing, so a hypothetical unknown type degrades to a visible plain
 * input instead of a field the player cannot see or fill.
 */
function isSize(v: unknown): v is "sm" | "md" | "lg" {
  return v === "sm" || v === "md" || v === "lg";
}

function isFieldType(v: unknown): v is "text" | "number" | "decimal" | "money" | "password" {
  return v === "text" || v === "number" || v === "decimal" || v === "money" || v === "password";
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
    const fields = childArray(node.fields).map((f): FormField => {
      const name = isRecord(f) ? String(f.name) : "";
      const label = isRecord(f) ? String(f.label) : "";
      if (isRecord(f) && f.type === "hidden") {
        return { name, type: "hidden", value: String(f.value) };
      }
      if (isRecord(f) && f.type === "select") {
        return {
          name,
          label,
          type: "select",
          optionsSource: String(f.optionsSource),
          valueKey: String(f.valueKey),
          labelKey: String(f.labelKey),
          allowEmpty: f.allowEmpty === true,
        };
      }
      return {
        name,
        label,
        type: isRecord(f) && isFieldType(f.type) ? f.type : ("text" as const),
      };
    });
    return [{ kind: "form", action: String(node.action), submitLabel: String(node.submitLabel), fields }];
  }
  if (isNode(node, "cards")) {
    return [{ kind: "cards", cards: childArray(node.cards).map(String) }];
  }
  if (isNode(node, "image")) {
    return [{
      kind: "image",
      url: String(node.url),
      alt: String(node.alt),
      // Normalised to a required value here so the renderer never re-derives
      // the DTO's optionality, the same way `allowEmpty` is above.
      size: isSize(node.size) ? node.size : "md",
    }];
  }
  if (isNode(node, "assetBinder")) {
    return [{
      kind: "assetBinder",
      // Server-filled: the loader stamps the declaring plugin's id before this
      // reaches the wire. An empty string here would mean a node that never
      // went through that stamp, which the bind route then refuses.
      scope: String(node.scope ?? ""),
      slot: String(node.slot),
      entitySource: String(node.entitySource),
      entityLabelKey: String(node.entityLabelKey),
    }];
  }
  if (isNode(node, "table")) {
    const columns = childArray(node.columns).map((c) => ({
      key: isRecord(c) ? String(c.key) : "",
      label: isRecord(c) ? String(c.label) : "",
      render: isRecord(c) && c.render === "image" ? ("image" as const) : null,
    }));
    return [{ kind: "table", source: String(node.source), columns }];
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
