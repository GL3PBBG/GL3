// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyTheme, getBranding, subscribeBranding } from "../src/lib/applyTheme.js";

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

describe("branding", () => {
  it("stores the payload's branding and titles the document with the game name", () => {
    applyTheme({
      preset: "midnight", colors: COLORS, layout: { nav: "top" },
      branding: { gameName: "Mob City", logoLogin: "/assets/aa", logoHeader: "/assets/bb" },
    });
    expect(getBranding()).toEqual({ gameName: "Mob City", logoLogin: "/assets/aa", logoHeader: "/assets/bb" });
    expect(document.title).toBe("Mob City");
  });

  it("falls back to the GL3 defaults when the payload omits branding — old server", () => {
    applyTheme({
      preset: "midnight", colors: COLORS, layout: { nav: "top" },
      branding: { gameName: "Mob City", logoLogin: null, logoHeader: null },
    });
    applyTheme({ preset: "midnight", colors: COLORS, layout: { nav: "top" } });
    expect(getBranding()).toEqual({ gameName: "GL3", logoLogin: null, logoHeader: null });
  });

  it("notifies subscribers on change so useSyncExternalStore re-renders", () => {
    let calls = 0;
    const unsubscribe = subscribeBranding(() => { calls += 1; });
    applyTheme({
      preset: "midnight", colors: COLORS, layout: { nav: "top" },
      branding: { gameName: "Ridgeport", logoLogin: null, logoHeader: null },
    });
    expect(calls).toBe(1);
    unsubscribe();
    applyTheme({
      preset: "midnight", colors: COLORS, layout: { nav: "top" },
      branding: { gameName: "Elsewhere", logoLogin: null, logoHeader: null },
    });
    expect(calls).toBe(1);
  });
});
