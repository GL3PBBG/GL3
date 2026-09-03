import { describe, expect, it } from "vitest";
import { facilityArrival, HOSPITAL_PATH, JAIL_PATH } from "../src/lib/facilityRedirect.js";

const free = { jailed: false, hospitalised: false } as const;

describe("facilityArrival", () => {
  it("redirects to jail on the free → jailed flip", () => {
    expect(facilityArrival(free, { jailed: true, hospitalised: false })).toBe(JAIL_PATH);
  });

  it("redirects to hospital on the healthy → hospitalised flip", () => {
    expect(facilityArrival(free, { jailed: false, hospitalised: true })).toBe(HOSPITAL_PATH);
  });

  it("never redirects on first load, even when already inside", () => {
    // A jailed player reloading /bank stays on /bank — the banner nags, the
    // router does not.
    const unknown = { jailed: undefined, hospitalised: undefined } as const;
    expect(facilityArrival(unknown, { jailed: true, hospitalised: false })).toBeNull();
    expect(facilityArrival(unknown, { jailed: false, hospitalised: true })).toBeNull();
  });

  it("does not redirect while the state merely persists", () => {
    const inside = { jailed: true, hospitalised: false } as const;
    expect(facilityArrival(inside, inside)).toBeNull();
    expect(facilityArrival(free, free)).toBeNull();
  });

  it("does not redirect on release or discharge", () => {
    expect(facilityArrival({ jailed: true, hospitalised: false }, free)).toBeNull();
    expect(facilityArrival({ jailed: false, hospitalised: true }, free)).toBeNull();
  });

  it("prefers jail when both flip in the same tick", () => {
    expect(facilityArrival(free, { jailed: true, hospitalised: true })).toBe(JAIL_PATH);
  });

  it("treats a half-known previous state per facility", () => {
    // The hospital query resolved before the jail one: a jail flip is still
    // unknown, a hospital flip is real.
    expect(facilityArrival({ jailed: undefined, hospitalised: false }, { jailed: true, hospitalised: true }))
      .toBe(HOSPITAL_PATH);
  });
});
