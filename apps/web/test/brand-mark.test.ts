// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandMark } from "../src/components/BrandMark.js";
import { applyTheme } from "../src/lib/applyTheme.js";

// BrandMark is the one component behind every "GL3" that used to be
// hardcoded: the auth pages' big mark and the Shell header's small one. A
// bound logo replaces the text entirely; the game name survives as alt text.

const COLORS = {
  bg: "#000000", fg: "#ffffff", accent: "#ff0000", success: "#00ff00",
  danger: "#0000ff", muted: "#777777", panel: "#111111", line: "#222222",
};

function setBranding(branding: { gameName: string; logoLogin: string | null; logoHeader: string | null }): void {
  applyTheme({ preset: "midnight", colors: COLORS, layout: { nav: "top" }, branding });
}

afterEach(cleanup);

describe("BrandMark", () => {
  it("renders the game name as an h1 when no logo is bound", () => {
    setBranding({ gameName: "Mob City", logoLogin: null, logoHeader: null });
    render(createElement(BrandMark, { variant: "login" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Mob City");
  });

  it("renders the bound logo for its own variant, alt-labelled with the game name", () => {
    setBranding({ gameName: "Mob City", logoLogin: "/assets/aa", logoHeader: null });
    render(createElement(BrandMark, { variant: "login" }));
    expect(screen.getByRole("img", { name: "Mob City" }).getAttribute("src")).toBe("/assets/aa");
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeNull();
  });

  it("the header variant ignores the login logo — the two sizes are independent", () => {
    setBranding({ gameName: "Mob City", logoLogin: "/assets/aa", logoHeader: null });
    render(createElement(BrandMark, { variant: "header" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Mob City");
  });
});
