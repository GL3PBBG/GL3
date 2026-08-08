import { describe, expect, it } from "vitest";
import { JobAlreadyAppliedError, PluginError } from "../src/index.js";

// Both classes are public SDK surface the loader reads fields off directly:
// `PluginError` becomes `reply.code(status).send({ error: code, ...extra })`,
// which is how ported modules keep their existing responses byte for byte, and
// `JobAlreadyAppliedError` is what a worker matches on to treat an
// at-least-once redelivery as success. A silent change to `name`, to a field,
// or to the `extra` default would break either contract at a distance.

describe("PluginError", () => {
  it("is a real Error, so an unhandled one still gets a stack and a message", () => {
    const err = new PluginError("insufficient_funds", 409);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PluginError");
    expect(err.message).toBe("insufficient_funds");
  });

  it("carries the code, status and extra the loader puts in the response", () => {
    const err = new PluginError("on_cooldown", 429, { retryAfter: 30 });
    expect(err.code).toBe("on_cooldown");
    expect(err.status).toBe(429);
    expect(err.extra).toEqual({ retryAfter: 30 });
  });

  it("defaults extra to {} so the loader never spreads undefined into a body", () => {
    expect(new PluginError("not_found", 404).extra).toEqual({});
  });
});

describe("JobAlreadyAppliedError", () => {
  it("is a real Error identifying the plugin and job already applied", () => {
    const err = new JobAlreadyAppliedError("bounties", "job-42");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("JobAlreadyAppliedError");
    expect(err.pluginId).toBe("bounties");
    expect(err.jobId).toBe("job-42");
    expect(err.message).toMatch(/job-42/);
  });
});
