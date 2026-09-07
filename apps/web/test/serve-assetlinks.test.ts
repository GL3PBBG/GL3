import { describe, expect, it } from "vitest";
import { assetLinksBody, shouldServeIndex } from "../serve.mjs";

const LINKS = JSON.stringify([{
  relation: ["delegate_permission/common.handle_all_urls"],
  target: { namespace: "android_app", package_name: "land.gangster.app", sha256_cert_fingerprints: ["AA:BB"] },
}]);

/**
 * Android App Links verification fetches /.well-known/assetlinks.json from the
 * game host. The package name and certificate fingerprints in it belong to a
 * deployment, so the web container reads them from ASSETLINKS_JSON rather than
 * shipping one operator's file in the engine's bundle.
 */
describe("assetLinksBody", () => {
  it("serves the operator's JSON, normalised", () => {
    expect(assetLinksBody({ ASSETLINKS_JSON: `  ${LINKS}\n` })).toBe(LINKS);
  });
  it("is absent when the variable is unset or blank", () => {
    expect(assetLinksBody({})).toBeNull();
    expect(assetLinksBody({ ASSETLINKS_JSON: "   " })).toBeNull();
  });
  it("refuses malformed JSON rather than serving it", () => {
    expect(assetLinksBody({ ASSETLINKS_JSON: "[{" })).toBeNull();
  });
  it("the path is never the SPA fallback, so unset really means 404", () => {
    expect(shouldServeIndex("/.well-known/assetlinks.json")).toBe(false);
  });
});
