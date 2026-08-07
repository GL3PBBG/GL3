import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_VERSION } from "../src/index.js";

describe("@gl3/shared", () => {
  it("exports a version constant", () => {
    expect(SHARED_PACKAGE_VERSION).toBe("0.0.0");
  });
});
