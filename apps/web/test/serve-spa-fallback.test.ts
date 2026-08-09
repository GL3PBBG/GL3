import { describe, expect, it } from "vitest";
// The production static server (Dockerfile.web's CMD). Plain ESM, outside
// tsc's coverage by design — see the header comment in serve.mjs. Importing it
// is safe because the `server.listen` call is behind a main-module guard; if
// that guard ever regresses, this file starts binding a port in the worker.
import { shouldServeIndex } from "../serve.mjs";

/**
 * `shouldServeIndex` decides whether a path that matched no file on disk is a
 * client-side route (serve index.html, let React Router handle it) or a missing
 * asset (404 honestly).
 *
 * It exists as an exported pure function because the bug it now encodes was
 * invisible to every other check in this repo: serve.mjs runs only inside the
 * container image, which cannot be built on the dev box, and Vite's dev server
 * does not share its fallback logic. So the production 404 reproduced nowhere
 * — not in dev, not in CI, not in a test — until a plugin page with a dotted id
 * was opened against the built bundle.
 */
describe("shouldServeIndex", () => {
  it("falls back for a plugin page whose id contains a dot", () => {
    // The regression. `extname("/plugins/hello.index")` is ".index", so an
    // extension-presence test classifies this as an asset and 404s it. Plugin
    // page ids are dotted by convention and v1 routing serves every one of them
    // from /plugins/:pageId, so this broke all plugin pages in production.
    expect(shouldServeIndex("/plugins/hello.index")).toBe(true);
    expect(shouldServeIndex("/plugins/hello.allNodes")).toBe(true);
  });

  it("falls back for an extensionless client route", () => {
    expect(shouldServeIndex("/")).toBe(true);
    expect(shouldServeIndex("/gang")).toBe(true);
    expect(shouldServeIndex("/players/7f3a2b1c")).toBe(true);
    expect(shouldServeIndex("/nope-does-not-exist")).toBe(true);
  });

  it("404s a missing asset carrying a known extension", () => {
    // Serving index.html here would answer a script request with HTML: the
    // browser reports a MIME error and renders a blank page, hiding a broken
    // build behind what looks like an app bug.
    expect(shouldServeIndex("/assets/index-abc123.js")).toBe(false);
    expect(shouldServeIndex("/assets/index-abc123.css")).toBe(false);
    expect(shouldServeIndex("/favicon.ico")).toBe(false);
    expect(shouldServeIndex("/fonts/inter.woff2")).toBe(false);
    expect(shouldServeIndex("/index.html")).toBe(false);
    expect(shouldServeIndex("/assets/index-abc123.js.map")).toBe(false);
  });

  it("treats a known extension as an asset regardless of case", () => {
    // extname preserves case, so an uppercase asset would otherwise miss the
    // lookup and get index.html — the MIME-error failure above, in the harder
    // to spot direction.
    expect(shouldServeIndex("/assets/APP.JS")).toBe(false);
    expect(shouldServeIndex("/FAVICON.ICO")).toBe(false);
  });

  it("falls back for an unknown extension, which is what a dotted route is", () => {
    // The rule is "known asset extension", not "any extension": the server can
    // only serve what CONTENT_TYPES has a type for, so anything else was never
    // an asset it could have returned.
    expect(shouldServeIndex("/plugins/some.plugin.page")).toBe(true);
    expect(shouldServeIndex("/players/user.name")).toBe(true);
  });
});
