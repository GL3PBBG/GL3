import { describe, expect, it, vi } from "vitest";
import { webOnGate } from "../src/lib/clientBoot.js";

describe("webOnGate", () => {
  it("redirects to /verify from elsewhere", () => {
    const assign = vi.fn();
    webOnGate("email_unverified", { pathname: "/crimes", assign });
    expect(assign).toHaveBeenCalledWith("/verify");
  });
  it("does not redirect when already on the gate page", () => {
    const assign = vi.fn();
    webOnGate("email_unverified", { pathname: "/verify", assign });
    webOnGate("challenge_required", { pathname: "/challenge", assign });
    expect(assign).not.toHaveBeenCalled();
  });
});
