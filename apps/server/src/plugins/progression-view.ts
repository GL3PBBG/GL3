import type { ViewNode } from "@gl3/plugin-sdk";
import type { ProgressionModel } from "@gl3/shared";

/**
 * Resolves a view's progression-model gates for one boot. A page is static
 * manifest data, but which model a boot runs — GL3-native exp thresholds, or
 * a level ladder because an `applyExp` claimant is loaded — is boot-static
 * too, so a table column or form field can carry `when: { progression }` and
 * the ones for the other model are dropped here, before the view reaches the
 * wire. The `when` key itself is stripped from the survivors: the wire copy
 * of the view schema tolerates it, but nothing on the client reads it, and a
 * page should be byte-identical to one that never declared a gate.
 *
 * Only `table.columns` and `form.fields` are gated. Gating whole nodes was
 * considered and rejected: the two cases in hand (the ranks admin table and
 * its two forms) each want ONE list with different members, not two
 * alternative nodes — and an empty `columns` array would fail the schema's
 * `.min(1)` on the client.
 */
export function pruneViewForProgression(view: ViewNode, model: ProgressionModel): ViewNode {
  if (view.kind === "panel") {
    return { ...view, children: view.children.map((child) => pruneViewForProgression(child, model)) };
  }
  if (view.kind === "list") {
    return { ...view, items: view.items.map((item) => pruneViewForProgression(item, model)) };
  }
  if (view.kind === "table") {
    return { ...view, columns: view.columns.flatMap((column) => keep(column, model)) };
  }
  if (view.kind === "form") {
    return { ...view, fields: view.fields.flatMap((field) => keep(field, model)) };
  }
  return view;
}

/** `Omit` distributed over a union: a plain `Omit<A | B, K>` keeps only the
 *  keys A and B share, which for `form.fields`' three branches drops `label`. */
type WithoutWhen<T> = T extends unknown ? Omit<T, "when"> : never;

/** One element or none: kept (with `when` removed) if ungated or gated to `model`. */
function keep<T extends { when?: { progression: ProgressionModel } | undefined }>(
  entry: T, model: ProgressionModel,
): WithoutWhen<T>[] {
  const { when, ...rest } = entry;
  if (when !== undefined && when.progression !== model) return [];
  return [rest as WithoutWhen<T>];
}
