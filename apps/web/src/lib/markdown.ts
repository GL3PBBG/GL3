import DOMPurify from "dompurify";
import { marked } from "marked";

// Every anchor leaving sanitisation opens in a new tab with no opener — user
// text links out of the app, never navigates it.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/**
 * User-typed text → sanitised HTML, for every surface a player can write on
 * (forum posts, mail, bios, gang pages, news).
 *
 * `breaks: true` because these are chat-shaped texts: a lone newline is a
 * deliberate line break, not a markdown soft-wrap. DOMPurify runs LAST, over
 * marked's output, so raw HTML in the source gets the same scrubbing as
 * anything markdown generates.
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}
