import { describe, expect, it } from "vitest";
import {
  buildNav, categoryBadge, categoryForPath, labelForPath, linkFor, navKeyFor,
  type PluginMenuEntry,
} from "../src/lib/nav.js";

function entry(pageId: string, label: string, order: number): PluginMenuEntry {
  return { pageId, path: `/plugins/${pageId}`, label, order };
}

describe("navKeyFor", () => {
  it("keys core routes on the first segment", () => {
    expect(navKeyFor("/")).toBe("/");
    expect(navKeyFor("/crimes")).toBe("/crimes");
    expect(navKeyFor("/mail/01h-thread")).toBe("/mail");
  });

  it("keys plugin routes on the first two segments", () => {
    expect(navKeyFor("/plugins/theft.index")).toBe("/plugins/theft.index");
  });

  it("decodes an encoded plugin pageId", () => {
    expect(navKeyFor("/plugins/some%20page")).toBe("/plugins/some page");
  });

  it("treats a bare /plugins as a core miss rather than crashing", () => {
    expect(navKeyFor("/plugins")).toBe("/plugins");
    expect(navKeyFor("/plugins/")).toBe("/plugins");
  });
});

describe("buildNav", () => {
  it("files the mapped plugin pages into their categories and keeps the rest core", () => {
    const nav = buildNav(
      [entry("theft.index", "Car theft", 40), entry("membership.index", "Membership", 60)],
      { admin: false },
    );
    const crimes = nav.find((c) => c.id === "crimes")!;
    expect(crimes.items.map((i) => i.label)).toEqual(["Crimes", "Car theft"]);
    const town = nav.find((c) => c.id === "town")!;
    expect(town.items.map((i) => i.label)).toContain("Membership");
    // No unmapped plugin pages, so no trailing catch-all category.
    expect(nav.some((c) => c.id === "more")).toBe(false);
  });

  it("collects unmapped plugin pages under a trailing More category", () => {
    const nav = buildNav([entry("custom.shop", "Custom shop", 10)], { admin: false });
    const more = nav.at(-1)!;
    expect(more.id).toBe("more");
    expect(more.items).toEqual([{ to: "/plugins/custom.shop", label: "Custom shop" }]);
  });

  it("drops the Admin link for players without grants", () => {
    const without = buildNav([], { admin: false }).find((c) => c.id === "account")!;
    expect(without.items.some((i) => i.to === "/admin")).toBe(false);
    const withAdmin = buildNav([], { admin: true }).find((c) => c.id === "account")!;
    expect(withAdmin.items.some((i) => i.to === "/admin")).toBe(true);
  });

  it("keeps plugin nav paths raw and encodes only at the link edge", () => {
    const nav = buildNav([entry("weird id", "Weird", 1)], { admin: false });
    const item = nav.at(-1)!.items[0]!;
    // Raw in the data — the same literal a menu.badges subscriber writes and
    // the form navKeyFor reduces a location to.
    expect(item.to).toBe("/plugins/weird id");
    expect(linkFor(item)).toBe("/plugins/weird%20id");
    expect(navKeyFor("/plugins/weird%20id")).toBe(item.to);
    // A badge written the documented way still lands on the item.
    const badges = { "/plugins/weird id": 2 };
    expect(categoryBadge(nav.at(-1)!, badges)).toBe(2);
  });
});

describe("category and label lookup", () => {
  const nav = buildNav([], { admin: true });

  it("places jail and hospital in Town — services, not crimes", () => {
    expect(categoryForPath(nav, "/jail")?.id).toBe("town");
    expect(categoryForPath(nav, "/hospital")?.id).toBe("town");
    expect(categoryForPath(nav, "/crimes")?.id).toBe("crimes");
  });

  it("resolves subroutes to their section's category", () => {
    expect(categoryForPath(nav, "/mail/01h-thread")?.id).toBe("social");
    expect(labelForPath(nav, "/mail/01h-thread")).toBe("Mail");
  });

  it("resolves the dashboard and plugin pages", () => {
    expect(categoryForPath(nav, "/")?.id).toBe("home");
    const withTheft = buildNav([entry("theft.index", "Car theft", 40)], { admin: false });
    expect(categoryForPath(withTheft, "/plugins/theft.index")?.id).toBe("crimes");
    expect(labelForPath(withTheft, "/plugins/theft.index")).toBe("Car theft");
  });

  it("returns null/undefined for routes the nav does not know", () => {
    expect(categoryForPath(nav, "/online")).toBeNull();
    expect(labelForPath(nav, "/online")).toBeUndefined();
  });
});

describe("categoryBadge", () => {
  it("rolls its items' unread counts up to the category button", () => {
    const nav = buildNav([], { admin: false });
    const social = nav.find((c) => c.id === "social")!;
    expect(categoryBadge(social, { "/mail": 3, "/notifications": 1 })).toBe(4);
    expect(categoryBadge(social, {})).toBe(0);
  });
});
