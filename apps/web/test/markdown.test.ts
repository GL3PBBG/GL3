// @vitest-environment jsdom
//
// DOMPurify needs a live DOM to parse against — and specifically jsdom: this
// file is why the project's per-file DOM is jsdom rather than happy-dom, whose
// fragment parser mishandles DOMPurify's traversal (a `<script>` inside a
// `<p>` comes back UNstripped), failing these assertions against code that is
// correct in a real browser. jsdom is what isomorphic-dompurify itself ships.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown.js";

describe("renderMarkdown", () => {
  it("renders basic markdown", () => {
    const html = renderMarkdown("**bold** and *italic*");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders the forum Quote idiom as a real blockquote", () => {
    // ForumTopic's Quote button prepends exactly this shape.
    const html = renderMarkdown("> Ron wrote:\n> hello there\n\nmy reply");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("my reply");
  });

  it("treats a single newline as a line break — chat-style text stays multi-line", () => {
    expect(renderMarkdown("line one\nline two")).toContain("<br>");
  });

  it("strips script tags", () => {
    const html = renderMarkdown("hi <script>alert(1)</script> there");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("hi");
  });

  it("strips inline event handlers", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });

  it("strips javascript: hrefs", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("opens links in a new tab without an opener", () => {
    const html = renderMarkdown("[gl3](https://example.com)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("passes plain text through unharmed", () => {
    expect(renderMarkdown("no funny business here")).toContain("no funny business here");
  });
});
