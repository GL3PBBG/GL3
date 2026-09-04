import { describe, expect, it } from "vitest";
import { bannerSlotFor } from "../src/pageBanners.js";

describe("bannerSlotFor", () => {
  it("matches a full /plugins/<pageId> route exactly", () => {
    expect(bannerSlotFor("/plugins/crimes.index")).toEqual({ slot: "page-crimes", alt: "Crimes" });
  });

  it("matches a /plugins route with no dot suffix exactly", () => {
    expect(bannerSlotFor("/plugins/hospital")).toEqual({ slot: "page-hospital", alt: "Hospital" });
  });

  it("matches a single-segment core route exactly", () => {
    expect(bannerSlotFor("/bank")).toEqual({ slot: "page-bank", alt: "Bank" });
  });

  it("falls back to the first path segment for a sub-route", () => {
    expect(bannerSlotFor("/mail/thread-42")).toEqual({ slot: "page-mail", alt: "Mail" });
  });

  it("matches the players page's old address", () => {
    expect(bannerSlotFor("/online")).toEqual({ slot: "page-players", alt: "Players" });
  });

  it("returns null for jail, which draws its own state-dependent banner", () => {
    expect(bannerSlotFor("/plugins/jail")).toBeNull();
  });

  it("returns null for a /plugins route with no banner entry", () => {
    expect(bannerSlotFor("/plugins/gym.index")).toBeNull();
  });

  it("returns null for an unknown route", () => {
    expect(bannerSlotFor("/nowhere")).toBeNull();
  });
});
