/**
 * The flattened instruction set `PageRenderer` turns into React. Each leaf node
 * maps 1:1; `panel` emits a header instruction then its children; `list` emits
 * its items with no separator (the renderer applies spacing). Keeping this a
 * pure transform is what makes it testable without a DOM.
 */
/**
 * A select field carries where its options come from; `allowEmpty` and
 * `prefillForm` are normalised to required booleans here so the renderer never
 * re-derives the DTO's optionality. A hidden field carries the constant it
 * submits and no label — it draws nothing.
 */
export type FormField =
  | { name: string; label: string; type: "text" | "number" | "decimal" | "money" | "password" }
  | { name: string; type: "hidden"; value: string }
  | { name: string; label: string; type: "select"; optionsSource: string; valueKey: string; labelKey: string; allowEmpty: boolean; prefillForm: boolean };

export type RenderInstruction =
  | { kind: "text"; value: string }
  | { kind: "money"; value: string }
  | { kind: "error"; value: string }
  | { kind: "link"; label: string; to: string }
  | { kind: "button"; label: string; action: string }
  | { kind: "cooldownButton"; label: string; action: string; cooldownAction: string }
  | { kind: "keyValue"; rows: { label: string; value: string }[] }
  | { kind: "meter"; label: string; value: number; max: number }
  | { kind: "meterSource"; label: string; source: string; valueKey: string; maxKey: string }
  | {
      kind: "keyValueSource";
      source: string;
      entries: { label: string; key: string }[];
      emptyText: string | null;
    }
  | { kind: "form"; action: string; submitLabel: string; valuesSource: string | null; fields: FormField[] }
  | { kind: "image"; url: string; alt: string; size: "sm" | "md" | "lg" }
  | { kind: "slotImage"; scope: string; slot: string; alt: string; size: "sm" | "md" | "lg" }
  | { kind: "assetBinder"; scope: string; slot: string; entitySource: string | null; entityLabelKey: string | null }
  | {
      kind: "table";
      source: string;
      columns: { key: string; label: string; render: "image" | "countdown" | null; imageSize: "sm" | "md" | "lg" }[];
      rowActions: { label: string; action: string; confirm: string | null }[];
    }
  | { kind: "cards"; cards: string[]; size: "sm" | "md" | "lg"; caption: string | null }
  | { kind: "panelHeader"; title: string; layout: "row" | null };

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

/** `meter.value`/`max` arrive as validated numbers, but the renderer still
 * narrows defensively like every other kind here rather than trusting the
 * wire — an unparseable value falls back to 0. */
function asNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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
  if (isNode(node, "meter")) {
    return [{
      kind: "meter",
      label: String(node.label),
      value: asNumber(node.value),
      // Zero would divide-by-zero downstream; the schema already requires
      // `max` positive, so this fallback is unreachable for a validated
      // payload and only guards a malformed one, the same posture as
      // `isFieldType`'s "text" fallback above.
      max: asNumber(node.max) > 0 ? asNumber(node.max) : 1,
    }];
  }
  if (isNode(node, "meterSource")) {
    return [{
      kind: "meterSource",
      label: String(node.label),
      source: String(node.source),
      valueKey: String(node.valueKey),
      maxKey: String(node.maxKey),
    }];
  }
  if (isNode(node, "keyValueSource")) {
    const entries = childArray(node.entries).map((e) => ({
      label: isRecord(e) ? String(e.label) : "",
      key: isRecord(e) ? String(e.key) : "",
    }));
    return [{
      kind: "keyValueSource",
      source: String(node.source),
      entries,
      emptyText: typeof node.emptyText === "string" ? node.emptyText : null,
    }];
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
          // Same optional-to-required normalisation as `allowEmpty` above.
          prefillForm: f.prefillForm === true,
        };
      }
      return {
        name,
        label,
        type: isRecord(f) && isFieldType(f.type) ? f.type : ("text" as const),
      };
    });
    return [{
      kind: "form",
      action: String(node.action),
      submitLabel: String(node.submitLabel),
      valuesSource: typeof node.valuesSource === "string" ? node.valuesSource : null,
      fields,
    }];
  }
  if (isNode(node, "cards")) {
    return [{
      kind: "cards",
      cards: childArray(node.cards).map(String),
      // Normalised to required values here, like `image.size` below and
      // `allowEmpty` above: the renderer never re-derives the DTO's
      // optionality at the point of drawing.
      size: isSize(node.size) ? node.size : "md",
      caption: node.caption === undefined ? null : String(node.caption),
    }];
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
  if (isNode(node, "slotImage")) {
    return [{
      kind: "slotImage",
      scope: String(node.scope ?? ""),
      slot: String(node.slot),
      alt: String(node.alt),
      size: isSize(node.size) ? node.size : "lg",
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
      // Null for a singleton slot: one image, so no picker is rendered.
      entitySource: node.entitySource === undefined ? null : String(node.entitySource),
      entityLabelKey: node.entityLabelKey === undefined ? null : String(node.entityLabelKey),
    }];
  }
  if (isNode(node, "table")) {
    const columns = childArray(node.columns).map((c) => ({
      key: isRecord(c) ? String(c.key) : "",
      label: isRecord(c) ? String(c.label) : "",
      render: isRecord(c) && c.render === "image" ? ("image" as const)
        : isRecord(c) && c.render === "countdown" ? ("countdown" as const) : null,
      // Normalised to a required value, like `render` above and `allowEmpty`
      // on a select field: the renderer never re-derives the DTO's optionality.
      imageSize: isRecord(c) && isSize(c.imageSize) ? c.imageSize : "sm",
    }));
    // Normalised like `columns`: absent → [], absent confirm → null, so the
    // renderer never re-derives the DTO's optionality.
    const rowActions = childArray(node.rowActions).flatMap((a) =>
      isRecord(a)
        ? [{
            label: String(a.label),
            action: String(a.action),
            confirm: a.confirm === undefined ? null : String(a.confirm),
          }]
        : [],
    );
    return [{ kind: "table", source: String(node.source), columns, rowActions }];
  }
  if (isNode(node, "panel")) {
    const out: RenderInstruction[] = [{
      kind: "panelHeader",
      title: String(node.title),
      // The header carries the layout because flattening is what the panel
      // becomes: `groupIntoPanels` reads it back off the header to decide how
      // to lay out the run of instructions that follows.
      layout: node.layout === "row" ? "row" : null,
    }];
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
