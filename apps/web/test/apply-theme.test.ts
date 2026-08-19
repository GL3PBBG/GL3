// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { applyTheme } from "../src/lib/applyTheme.js";

// theme.css's :root block is the fallback; applyTheme paints the server's
// resolved palette over it as inline custom properties on the same element.

const COLORS = {
  bg: "#000000", fg: "#ffffff", accent: "#ff0000", success: "#00ff00",
  danger: "#0000ff", muted: "#777777", panel: "#111111", line: "#222222",
};

describe("applyTheme", () => {
  it("sets every theme variable as --<name> on the document element", () => {
    applyTheme({ preset: "midnight", colors: COLORS, layout: { nav: "top" } });
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--bg")).toBe("#000000");
    expect(style.getPropertyValue("--fg")).toBe("#ffffff");
    expect(style.getPropertyValue("--accent")).toBe("#ff0000");
    expect(style.getPropertyValue("--success")).toBe("#00ff00");
    expect(style.getPropertyValue("--danger")).toBe("#0000ff");
    expect(style.getPropertyValue("--muted")).toBe("#777777");
    expect(style.getPropertyValue("--panel")).toBe("#111111");
    expect(style.getPropertyValue("--line")).toBe("#222222");
  });

  it("stamps the nav position as data-nav so CSS can relayout without React knowing", () => {
    applyTheme({ preset: "midnight", colors: COLORS, layout: { nav: "left" } });
    expect(document.documentElement.getAttribute("data-nav")).toBe("left");
    applyTheme({ preset: "midnight", colors: COLORS, layout: { nav: "top" } });
    expect(document.documentElement.getAttribute("data-nav")).toBe("top");
  });
});
