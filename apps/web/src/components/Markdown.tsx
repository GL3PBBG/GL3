import { renderMarkdown } from "../lib/markdown.js";
import styles from "../pages/pages.module.css";

/**
 * The one place `dangerouslySetInnerHTML` is allowed: the HTML has just come
 * out of DOMPurify (lib/markdown.ts). Never hand this component anything that
 * hasn't.
 */
export function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div
      className={styles.markdown}
      // eslint-disable-next-line react/no-danger -- sanitised in renderMarkdown
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}
