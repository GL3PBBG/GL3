import { describe, expect, it } from "vitest";
import { renderLegal } from "../src/legal/render.js";
import { TERMS_TEMPLATE } from "../src/legal/terms.js";
import { PRIVACY_TEMPLATE } from "../src/legal/privacy.js";

describe("renderLegal", () => {
  it("substitutes every placeholder and reports none missing", () => {
    const out = renderLegal("Hi {{operatorName}} at {{contactEmail}} ({{gameName}}, {{jurisdiction}}, {{effectiveDate}})", {
      operatorName: "Acme", contactEmail: "a@b.co", gameName: "GL", jurisdiction: "Ohio", effectiveDate: "2026-09-07",
    });
    expect(out.markdown).toBe("Hi Acme at a@b.co (GL, Ohio, 2026-09-07)");
    expect(out.missing).toEqual([]);
  });

  it("renders an unset placeholder visibly and lists it once", () => {
    const out = renderLegal("{{operatorName}} / {{operatorName}} / {{contactEmail}}", { contactEmail: "a@b.co" });
    expect(out.markdown).toBe("[operator name not set] / [operator name not set] / a@b.co");
    expect(out.missing).toEqual(["operatorName"]);
  });

  it("does not treat a placeholder inside a value as a template", () => {
    const out = renderLegal("{{operatorName}}", { operatorName: "{{contactEmail}}" });
    expect(out.markdown).toBe("{{contactEmail}}");
  });

  it("both shipped templates use only known placeholders", () => {
    for (const t of [TERMS_TEMPLATE, PRIVACY_TEMPLATE]) {
      const found = [...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      for (const name of found) expect(["gameName", "operatorName", "contactEmail", "jurisdiction", "effectiveDate"]).toContain(name);
      expect(t).toContain("{{operatorName}}");
      expect(t).toContain("{{contactEmail}}");
    }
  });
});
