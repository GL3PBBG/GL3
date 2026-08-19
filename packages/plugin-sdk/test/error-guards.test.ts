import { describe, expect, it } from "vitest";
import {
  InsufficientFundsError,
  InsufficientGangFundsError,
  JobAlreadyAppliedError,
  PluginError,
  isInsufficientFundsError,
  isInsufficientGangFundsError,
  isJobAlreadyAppliedError,
  isPluginError,
} from "../src/errors.js";

/**
 * A plugin loaded through `PLUGIN_PACKAGES` resolves its OWN copy of
 * @gl3/plugin-sdk out of the operator's plugin directory. These stand in for
 * the classes that second copy would define: same brand (a `Symbol.for` key
 * is shared process-wide), same `name`, different class object — so
 * `instanceof` against our copy is false for every one of them.
 *
 * That is not a hypothetical: `plugins/routes.ts` maps a plugin's thrown error
 * to its HTTP status, and before the brand it did so with `instanceof`, which
 * would have turned every deliberate 400/409/423 from such a plugin into a 500.
 */
class ForeignPluginError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "PluginError";
    Object.defineProperty(this, Symbol.for("gl3.plugin-sdk.PluginError"), { value: true });
  }
}

/** A plugin built against 0.1.0-0.1.8, whose SDK copy predates the brand. */
class LegacyPluginError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "PluginError";
  }
}

describe("isPluginError", () => {
  it("accepts our own instance", () => {
    expect(isPluginError(new PluginError("jailed", 423))).toBe(true);
  });

  it("accepts a branded error from another copy of the SDK", () => {
    const foreign = new ForeignPluginError("insufficient_funds", 409);
    // The regression this guard exists for, stated outright.
    expect(foreign instanceof PluginError).toBe(false);
    expect(isPluginError(foreign)).toBe(true);
  });

  it("accepts an unbranded error from an SDK copy older than the brand", () => {
    expect(isPluginError(new LegacyPluginError("too_soon", 429))).toBe(true);
  });

  it("rejects an unrelated error that merely borrows the name", () => {
    // `name` alone is not enough: the caller goes on to read `code` and
    // `status`, and a match here would produce `reply.code(undefined)`.
    const impostor = new Error("nope");
    impostor.name = "PluginError";
    expect(isPluginError(impostor)).toBe(false);
  });

  it("rejects ordinary errors and non-errors", () => {
    expect(isPluginError(new Error("boom"))).toBe(false);
    expect(isPluginError(null)).toBe(false);
    expect(isPluginError(undefined)).toBe(false);
    expect(isPluginError("PluginError")).toBe(false);
    expect(isPluginError({ code: "x", status: 400 })).toBe(false);
  });
});

describe("the remaining guards", () => {
  it("accept their own instances", () => {
    expect(isInsufficientFundsError(new InsufficientFundsError("p1", "cash"))).toBe(true);
    expect(isInsufficientGangFundsError(new InsufficientGangFundsError("g1", "cash"))).toBe(true);
    expect(isJobAlreadyAppliedError(new JobAlreadyAppliedError("oc", "job-1"))).toBe(true);
  });

  it("do not confuse the player-side and gang-side fund errors", () => {
    const player = new InsufficientFundsError("p1", "cash");
    const gang = new InsufficientGangFundsError("g1", "cash");
    expect(isInsufficientGangFundsError(player)).toBe(false);
    expect(isInsufficientFundsError(gang)).toBe(false);
  });

  it("reject unrelated errors", () => {
    expect(isInsufficientFundsError(new Error("boom"))).toBe(false);
    expect(isJobAlreadyAppliedError(null)).toBe(false);
  });
});
