// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "../src/components/MarkdownEditor.js";

// The preview must be truthful: it goes through the exact renderMarkdown →
// DOMPurify pipeline the reader sees, so markdown formats and injected HTML
// is scrubbed, not merely hidden.

afterEach(cleanup);

function editor(value: string, onChange: (next: string) => void = () => {}): void {
  render(createElement(MarkdownEditor, { value, onChange }));
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("MarkdownEditor tabs", () => {
  it("renders the sanitised markdown in the preview tab", () => {
    editor("**bold** <script>window.alert(1)</script>");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    const strong = screen.getByText("bold");
    expect(strong.tagName).toBe("STRONG");
    // eslint-disable-next-line testing-library/no-node-access -- asserting absence of an element with no role
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows a placeholder when previewing an empty draft", () => {
    editor("");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText("Nothing to preview")).toBeTruthy();
  });

  it("keeps the draft when switching back to write", () => {
    editor("draft text");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    expect(textarea().value).toBe("draft text");
  });
});

describe("MarkdownEditor toolbar", () => {
  it("wraps the selection in bold markers", () => {
    const onChange = vi.fn();
    editor("hello world", onChange);
    textarea().setSelectionRange(0, 5);
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(onChange).toHaveBeenCalledWith("**hello** world");
  });

  it("wraps the selection in italic markers", () => {
    const onChange = vi.fn();
    editor("hello world", onChange);
    textarea().setSelectionRange(6, 11);
    fireEvent.click(screen.getByRole("button", { name: "Italic" }));
    expect(onChange).toHaveBeenCalledWith("hello *world*");
  });

  it("turns the selection into a link with a url placeholder", () => {
    const onChange = vi.fn();
    editor("hello world", onChange);
    textarea().setSelectionRange(0, 5);
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(onChange).toHaveBeenCalledWith("[hello](url) world");
  });
});
