import { NAV_CATEGORIES } from "@gl3/shared";
import { describe, expect, it } from "vitest";
import {
  buildNav, categoryBadge, categoryForPath, labelForPath, linkFor, navKeyFor,
  PLUGIN_CATEGORY, type PluginMenuEntry,
} from "../src/lib/nav.js";

function entry(pageId: string, label: string, order: number, category?: string): PluginMenuEntry {
  return { pageId, path: `/plugins/${pageId}`, label, order, ...(category === undefined ? {} : { category }) };
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
    // Gameplay destinations are plugin-declared now: the Crimes category is
    // exactly what the payload routes into it.
    const crimes = nav.find((c) => c.id === "crimes")!;
    expect(crimes.items.map((i) => i.label)).toEqual(["Car theft"]);
    const account = nav.find((c) => c.id === "account")!;
    expect(account.items.map((i) => i.label)).toContain("Membership");
    // No unmapped plugin pages, so no trailing catch-all category.
    expect(nav.some((c) => c.id === "more")).toBe(false);
  });

  it("files a page into the category it declares for itself", () => {
    const nav = buildNav([entry("fixer.index", "The Fixer", 46, "crimes")], { admin: false });
    const crimes = nav.find((c) => c.id === "crimes")!;
    expect(crimes.items.at(-1)).toEqual({ to: "/plugins/fixer.index", label: "The Fixer" });
    expect(nav.some((c) => c.id === "more")).toBe(false);
  });

  it("lets a declared category beat the fallback map", () => {
    const nav = buildNav([entry("theft.index", "Car theft", 40, "town")], { admin: false });
    expect(nav.find((c) => c.id === "town")!.items.at(-1)?.label).toBe("Car theft");
    // Nothing routed into Crimes, so the category does not materialize at all.
    expect(nav.some((c) => c.id === "crimes")).toBe(false);
  });

  it("drops a page declaring an unknown category into More, not out of the nav", () => {
    const nav = buildNav([entry("rogue.index", "Rogue", 10, "smuggling")], { admin: false });
    expect(nav.at(-1)!.id).toBe("more");
    expect(nav.at(-1)!.items).toEqual([{ to: "/plugins/rogue.index", label: "Rogue" }]);
  });

  it("renders every category the SDK lets a plugin declare", () => {
    for (const id of NAV_CATEGORIES) {
      const nav = buildNav([entry("probe.index", "Probe", 1, id)], { admin: true });
      expect(nav.find((c) => c.id === id)?.items.some((i) => i.label === "Probe")).toBe(true);
    }
  });

  it("keeps the fallback map pointing only at categories that exist", () => {
    for (const id of Object.values(PLUGIN_CATEGORY)) {
      expect(NAV_CATEGORIES).toContain(id);
    }
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

  it("places the payload's jail and hospital pages in Town — services, not crimes", () => {
    const withServices = buildNav([
      entry("jail", "Jail", 38, "town"),
      entry("hospital", "Hospital", 39, "town"),
    ], { admin: true });
    expect(categoryForPath(withServices, "/plugins/jail")?.id).toBe("town");
    expect(categoryForPath(withServices, "/plugins/hospital")?.id).toBe("town");
  });

  it("a framework payload leaves no crimes category and a services-only Town", () => {
    expect(nav.some((c) => c.id === "crimes")).toBe(false);
    expect(nav.some((c) => c.id === "actions")).toBe(false);
    expect(nav.find((c) => c.id === "town")!.items.map((i) => i.label)).toEqual(["Bank", "Shop"]);
  });

  it("folds the gameplay plugin pages into Crimes and drops the empty Actions category", () => {
    const withGameplay = buildNav([
      entry("crimes.index", "Crimes", 10, "crimes"),
      entry("combat.index", "Combat", 12, "crimes"),
      entry("bounties.index", "Bounties", 14, "crimes"),
      entry("detectives.index", "Detectives", 16, "crimes"),
      entry("oc.index", "Heists", 18, "crimes"),
    ], { admin: false });
    expect(withGameplay.some((c) => c.id === "actions")).toBe(false);
    for (const path of ["/plugins/combat.index", "/plugins/bounties.index", "/plugins/detectives.index", "/plugins/oc.index"]) {
      expect(categoryForPath(withGameplay, path)?.id).toBe("crimes");
    }
  });

  it("renders Actions only when a plugin page routes into it", () => {
    // The routing table is injectable — the seam a server-declared category
    // field (phase two) plugs into — so route an arena page the way its
    // plugin would and prove the category materializes in place, between
    // Crimes and Town.
    const nav = buildNav([entry("pvp.arena", "Arena", 50)], {
      admin: false,
      pluginCategory: { "pvp.arena": "actions" },
    });
    const actions = nav.find((c) => c.id === "actions");
    expect(actions?.items.map((i) => i.label)).toEqual(["Arena"]);
    expect(nav.indexOf(actions!)).toBe(nav.findIndex((c) => c.id === "town") - 1);
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
