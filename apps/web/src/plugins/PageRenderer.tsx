import { Fragment, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { TableRowsResponseSchema } from "@gl3/shared";
import { ErrorText, Loading, Money, Panel } from "../components/ui.js";
import { Hand } from "../components/PlayingCard.js";
import { togglePending } from "./pending.js";
import type { FormField, RenderInstruction } from "./render.js";
import styles from "../pages/pages.module.css";

/**
 * A run of instructions that share one `<Panel>`.
 *
 * `renderNode` flattens a panel to `[header, ...children]`, so the panel body is
 * everything between one `panelHeader` and the next. `title: null` is the run
 * before the first header — those instructions render bare, at top level.
 *
 * The limitation this inherits is real and worth naming: a *nested* panel
 * degrades to a *sibling* panel, because `[header, ...children]` cannot say
 * where a nested panel's children end. `panel(A, [a, panel(B, [b]), c])` and
 * `panel(A, [a, panel(B, [b, c])])` flatten to identical instruction lists, so
 * no grouping pass can tell them apart. Siblings are the graceful degradation;
 * making `renderNode` return a nested structure is the fix if it ever matters.
 */
interface PanelGroup {
  readonly title: string | null;
  readonly items: readonly { readonly index: number; readonly inst: RenderInstruction }[];
}

/**
 * `index` is the instruction's position in the *flat* list, not its position in
 * the group: it keys the per-form input state, which has to stay stable and
 * unique across the whole page (see `formValues`).
 */
function groupIntoPanels(instructions: readonly RenderInstruction[]): PanelGroup[] {
  const groups: PanelGroup[] = [];
  let title: string | null = null;
  let items: { index: number; inst: RenderInstruction }[] = [];

  const flush = (): void => {
    // Drops only the leading empty run; an empty panel still renders its header.
    if (title !== null || items.length > 0) groups.push({ title, items });
  };

  instructions.forEach((inst, index) => {
    if (inst.kind === "panelHeader") {
      flush();
      title = inst.title;
      items = [];
      return;
    }
    items.push({ index, inst });
  });
  flush();
  return groups;
}

/**
 * Fetches rows for a `table` instruction. Re-fetches whenever `refetchSignal`
 * increments (i.e. after any successful `runAction` on the same page), so
 * mutation-then-view stays consistent without a full page reload.
 *
 * Uses plain `useState` + `useEffect` + `api()` — same pattern as the rest of
 * `PageRenderer` — instead of react-query, which is not wired into plugin pages.
 */
function TableBlock({ source, columns, refetchSignal }: {
  source: string;
  columns: readonly { readonly key: string; readonly label: string }[];
  refetchSignal: number;
}): JSX.Element {
  const [rows, setRows] = useState<ReadonlyArray<Record<string, string>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // `source` is `"GET /api/..."` — strip the method prefix for `api()`.
  const path = source.replace(/^GET\s+/, "");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api<unknown>(path)
      .then((body) => {
        if (cancelled) return;
        const parsed = TableRowsResponseSchema.parse(body);
        setRows(parsed.rows);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path, refetchSignal]);

  if (loading) return <Loading what="table" />;
  if (error !== null) return <ErrorText error={error} />;
  if (rows.length === 0) return <p className={styles.muted}>No data.</p>;

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          {columns.map((col) => <th key={col.key}>{col.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {columns.map((col) => <td key={col.key}>{row[col.key] ?? ""}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A form field's `select` widget: options fetched from `optionsSource`, the
 * same shape and refetch behaviour as `TableBlock`, so a row added by a
 * sibling form on the page (e.g. "Add town") appears in the select without a
 * reload. Value state stays in the parent's `formValues` — this component owns
 * only the options.
 */
function SelectField({ field, value, onChange, refetchSignal }: {
  field: Extract<FormField, { type: "select" }>;
  value: string;
  onChange: (value: string) => void;
  refetchSignal: number;
}): JSX.Element {
  const [options, setOptions] = useState<ReadonlyArray<{ value: string; label: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const path = field.optionsSource.replace(/^GET\s+/, "");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api<unknown>(path)
      .then((body) => {
        if (cancelled) return;
        const parsed = TableRowsResponseSchema.parse(body);
        setOptions(parsed.rows.map((row) => ({
          value: row[field.valueKey] ?? "",
          label: row[field.labelKey] ?? row[field.valueKey] ?? "",
        })));
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path, field.valueKey, field.labelKey, refetchSignal]);

  if (error !== null) return <ErrorText error={error} />;

  return (
    <select
      name={field.name}
      value={value}
      disabled={loading}
      onChange={(event) => { onChange(event.target.value); }}
    >
      {/* The placeholder doubles as the "clear" option when allowEmpty: the
          submitted "" is what the roles route maps to null. Without allowEmpty
          it is only the unselected state — routes validate the UUID anyway. */}
      <option value="">{field.allowEmpty ? "(none)" : loading ? "Loading…" : "Select…"}</option>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

/**
 * Renders a flat list of RenderInstructions. Button/form actions are sent via
 * `api()` (the actions are `"METHOD /path"` strings declared in the schema).
 */
export function PageRenderer({ instructions }: { instructions: readonly RenderInstruction[] }): JSX.Element {
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  // Keyed `"<instructionIndex>:<fieldName>"`, not by bare field name: two forms
  // on one page may each declare an `amount`, and a page-wide map would make
  // them the same input. Submit maps its own keys back to bare names.
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  // Keyed by instruction index, same as `formValues` and for the same reason:
  // stable and unique across the whole page. One button in flight does not
  // disable the others (see `togglePending`) — only the control that fired.
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());
  // Incremented after every successful `runAction` so TableBlock re-fetches.
  const [refetchSignal, setRefetchSignal] = useState(0);

  async function runAction(index: number, action: string, body?: Record<string, string>): Promise<void> {
    setError(null);
    const [method, path] = action.split(" ");
    if (method === undefined || path === undefined) {
      // Unreachable: the payload was validated against VIEW_ACTION_RE at parse
      // time, so an action here always has both halves. Handled rather than
      // asserted so a schema change upstream degrades to a message.
      setError(new Error(`Plugin action is malformed: ${action}`));
      return;
    }
    // Set before the request, cleared in `finally`: plugin routes carry no
    // idempotency key (NOTES.md rule 1's failure mode reached from the
    // client), so a double-click must not fire a second POST while the first
    // is still in flight, whether it succeeds, fails, or throws.
    setPending((previous) => togglePending(previous, index, true));
    try {
      // The client sets `content-type: application/json` iff `init.body` is
      // present, and the server answers a bodyless request carrying that header
      // with 400 FST_ERR_CTP_EMPTY_JSON_BODY — so a `button` (no body) must not
      // pass the key at all. Nothing reads the response.
      await api<unknown>(path, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      // Any successful action may have mutated table-backed data — bump
      // the signal so every TableBlock on this page re-fetches.
      setRefetchSignal((n) => n + 1);
    } catch (caught) {
      // Kept as the thrown value, not flattened to `.message`: describeError
      // turns an ApiError into player copy ("Not ready yet — 30s to go.")
      // where `.message` would show "429 on_cooldown".
      setError(caught);
    } finally {
      setPending((previous) => togglePending(previous, index, false));
    }
  }

  function renderInstruction(index: number, inst: RenderInstruction): JSX.Element | null {
    switch (inst.kind) {
      case "panelHeader":
        // Consumed by groupIntoPanels; a header never reaches a group's items.
        return null;
      case "text":
        return <p key={index}>{inst.value}</p>;
      case "money":
        return <p key={index}><Money value={inst.value} /></p>;
      case "error":
        // Deliberately not <ErrorText>: that runs describeError, which maps a
        // bare string to "Something went wrong." and would swallow the copy the
        // plugin wrote. ErrorText is for thrown ApiErrors, this is a view node.
        return <p key={index} role="alert" className={styles.bad}>{inst.value}</p>;
      case "link":
        return (
          <button key={index} type="button" onClick={() => { navigate(inst.to); }}>
            {inst.label}
          </button>
        );
      case "button":
        return (
          <button
            key={index}
            type="button"
            disabled={pending.has(index)}
            onClick={() => { void runAction(index, inst.action); }}
          >
            {inst.label}
          </button>
        );
      case "cooldownButton":
        // v1 renders a plain button gated on the same action. CooldownButton and
        // useCountdowns both exist and are ready, but useCountdowns is seeded
        // from server-supplied seconds and the manifest carries no cooldown
        // snapshot — so at render there is nothing to seed the countdown with.
        return (
          <button
            key={index}
            type="button"
            disabled={pending.has(index)}
            onClick={() => { void runAction(index, inst.action); }}
          >
            {inst.label}
          </button>
        );
      case "keyValue":
        return (
          <dl key={index}>
            {inst.rows.map((row, rowIndex) => (
              <div key={rowIndex}>
                <dt className={styles.meta}>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        );
      case "form":
        return (
          <form
            key={index}
            className={styles.formCard}
            onSubmit={(event) => {
              event.preventDefault();
              const body: Record<string, string> = {};
              for (const field of inst.fields) {
                // A hidden field has no input and therefore no `formValues`
                // entry — its constant comes straight off the schema.
                body[field.name] = field.type === "hidden"
                  ? field.value
                  : formValues[`${index}:${field.name}`] ?? "";
              }
              void runAction(index, inst.action, body);
            }}
          >
            {inst.fields.map((field) => {
              const key = `${index}:${field.name}`;
              // Nothing to draw and nothing to label: onSubmit reads the
              // constant off the field itself. Rendering an
              // `<input type="hidden">` would only add a second, unread copy.
              if (field.type === "hidden") return null;
              return (
                <label key={field.name} className={styles.field}>
                  <span className={styles.meta}>{field.label}</span>
                  {field.type === "select" ? (
                    <SelectField
                      field={field}
                      value={formValues[key] ?? ""}
                      onChange={(value) => {
                        setFormValues((previous) => ({ ...previous, [key]: value }));
                      }}
                      refetchSignal={refetchSignal}
                    />
                  ) : (
                    <input
                      name={field.name}
                      // `money` is a decimal string on the wire, so it stays a text
                      // input — a number input would round-trip it through Number.
                      type={field.type === "money" ? "text" : field.type === "decimal" ? "number" : field.type}
                      // `<input type="number">` defaults to step="1", which makes
                      // the browser reject a fractional value on submit. `decimal`
                      // is the same widget with that restriction lifted.
                      {...(field.type === "decimal" ? { step: "any" } : {})}
                      value={formValues[key] ?? ""}
                      onChange={(event) => {
                        const { value } = event.target;
                        setFormValues((previous) => ({ ...previous, [key]: value }));
                      }}
                    />
                  )}
                </label>
              );
            })}
            <button type="submit" disabled={pending.has(index)}>{inst.submitLabel}</button>
          </form>
        );
      case "table":
        return (
          <TableBlock
            key={index}
            source={inst.source}
            columns={inst.columns}
            refetchSignal={refetchSignal}
          />
        );
      case "cards":
        return <Hand key={index} codes={inst.cards} />;
    }
  }

  return (
    <div className={styles.stack}>
      <ErrorText error={error} />
      {groupIntoPanels(instructions).map((group, groupIndex) =>
        group.title === null ? (
          <Fragment key={groupIndex}>
            {group.items.map(({ index, inst }) => renderInstruction(index, inst))}
          </Fragment>
        ) : (
          <Panel key={groupIndex} title={group.title}>
            {group.items.map(({ index, inst }) => renderInstruction(index, inst))}
          </Panel>
        ),
      )}
    </div>
  );
}
