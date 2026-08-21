import { useRef, useState } from "react";
import styles from "../pages/pages.module.css";
import { Markdown } from "./Markdown.js";

/**
 * Markdown textarea with a Write/Preview toggle and a minimal formatting
 * toolbar. The preview renders through the same renderMarkdown → DOMPurify
 * pipeline readers see (components/Markdown.tsx), so it is truthful by
 * construction. Draft state lives in the parent; only the tab is local.
 */
export function MarkdownEditor({
  value, onChange, maxLength, rows,
}: {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
  rows?: number;
}): JSX.Element {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const box = useRef<HTMLTextAreaElement>(null);

  // Wraps the current selection (or insertion point) in markdown markers.
  // Plain string surgery on the controlled value — the parent's onChange is
  // the only writer, same as typing.
  const wrap = (before: string, after: string): void => {
    const el = box.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    onChange(value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end));
  };

  return (
    <div className={styles.editor}>
      <div className={styles.tabs}>
        <button
          type="button"
          aria-pressed={tab === "write"}
          className={tab === "write" ? styles.tabActive : styles.tabIdle}
          onClick={() => { setTab("write"); }}
        >
          Write
        </button>
        <button
          type="button"
          aria-pressed={tab === "preview"}
          className={tab === "preview" ? styles.tabActive : styles.tabIdle}
          onClick={() => { setTab("preview"); }}
        >
          Preview
        </button>
        {tab === "write" && (
          <span className={styles.editorTools}>
            <button type="button" aria-label="Bold" className={styles.tabIdle} onClick={() => { wrap("**", "**"); }}>B</button>
            <button type="button" aria-label="Italic" className={styles.tabIdle} onClick={() => { wrap("*", "*"); }}><em>I</em></button>
            <button type="button" aria-label="Link" className={styles.tabIdle} onClick={() => { wrap("[", "](url)"); }}>🔗</button>
          </span>
        )}
      </div>
      {tab === "write" ? (
        <textarea
          ref={box}
          maxLength={maxLength}
          rows={rows}
          value={value}
          onChange={(event) => { onChange(event.target.value); }}
        />
      ) : value.trim() === "" ? (
        <p className={styles.meta}>Nothing to preview</p>
      ) : (
        <Markdown text={value} />
      )}
    </div>
  );
}
