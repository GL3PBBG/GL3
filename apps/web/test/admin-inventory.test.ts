// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { configureClient, resetClientConfigForTests } from "@gl3/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminInventory } from "../src/pages/AdminInventory.js";
import type { AdminItem } from "../src/lib/adminInventory.js";

const base = "/api/admin/inventory";
let client: QueryClient;
let details: Record<string, AdminItem>;
let posts: { url: string; body: Record<string, string> }[];
let failDetail: boolean;
let failSave: boolean;
let deleted: string[];
let stock: { locationId: string; locationName: string; itemId: string; itemName: string; price: string; stock: string }[];

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  posts = []; deleted = []; failDetail = false; failSave = false;
  details = {
    gun: { id: "gun", name: "Lupara", itemType: "weapon", effects: { damageMin: 10, damageMax: 20, accuracy: 0, bulletsPerShot: 2, critChance: 5, critMultiplier: 1.5, armorPierce: 3, minRankExp: 100, backfireChance: 0, dps: 0.5 } },
    melee: { id: "melee", name: "Bat", itemType: "weapon", effects: { power: 40 } },
    tonic: { id: "tonic", name: "Tonic", itemType: "consumable", effects: { kind: "pools", pools: { energy: "50%", brave: -10 } } },
    armor: { id: "armor", name: "Vest", itemType: "armor", effects: { armor: 30 } },
  };
  stock = [{ locationId: "town", locationName: "Palermo", itemId: "gun", itemName: "Lupara", price: "9007199254740993", stock: "12" }];
  configureClient({ baseUrl: "", wsUrl: "ws://test/ws", tokenStore: { get: () => "token", set: () => {}, clear: () => {} }, onGate: () => {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(init.body as string) });
      return failSave ? Response.json({ error: "invalid_effects" }, { status: 400 }) : Response.json({ id: "created" });
    }
    if (init?.method === "DELETE") { deleted.push(url); return new Response(null, { status: 204 }); }
    if (url === `${base}/items`) return Response.json({ rows: Object.values(details).map((item) => ({
      id: item.id, name: item.name, itemType: item.itemType,
      power: item.id === "melee" ? "40" : "", damage: item.id === "gun" ? "10–20" : "",
    })) });
    if (url === `${base}/shop`) return Response.json({ rows: stock });
    if (url === `${base}/locations`) return Response.json({ rows: [{ id: "town", name: "Palermo" }, { id: "other", name: "Rome" }] });
    const item = details[url.split("/").at(-1)!];
    if (item && !failDetail) return Response.json(item);
    return Response.json({ error: "item_not_found" }, { status: 404 });
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); resetClientConfigForTests(); });
function mount() { render(createElement(QueryClientProvider, { client }, createElement(AdminInventory))); }
async function edit(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${name}` }));
  await screen.findByRole("button", { name: "Save changes" });
}
function value(label: string) { return (screen.getByLabelText(label) as HTMLInputElement).value; }

describe("admin inventory editor", () => {
  it("prefills all firearm stats and sends them unchanged when renaming", async () => {
    mount(); await edit("Lupara");
    expect(value("Name")).toBe("Lupara");
    expect(value("Minimum damage")).toBe("10");
    expect(value("Maximum damage")).toBe("20");
    expect(value("Accuracy (%)")).toBe("0");
    expect(value("Critical multiplier")).toBe("1.5");
    expect(value("Backfire chance (%)")).toBe("0");
    expect(value("Damage per second")).toBe("0.5");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Lupara" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("New Lupara saved.");
    expect(posts[0]).toEqual({ url: `${base}/items/update`, body: {
      id: "gun", name: "New Lupara", itemType: "weapon", damageMin: "10", damageMax: "20", accuracy: "0",
      bulletsPerShot: "2", critChance: "5", critMultiplier: "1.5", armorPierce: "3", minRankExp: "100", backfireChance: "0", dps: "0.5",
    } });
  });

  it("keeps optional stats blank and retains unsaved changes on focus", async () => {
    details["gun"]!.effects = { damageMin: 4, damageMax: 6 };
    mount(); await edit("Lupara");
    expect(value("Accuracy (%)")).toBe("");
    expect(value("Backfire chance (%)")).toBe("");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
    focusManager.setFocused(false); focusManager.setFocused(true);
    expect(value("Name")).toBe("Draft");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(posts).toHaveLength(0);
  });

  it("chooses melee fields automatically and supports deliberate conversion", async () => {
    mount(); await edit("Bat");
    expect(value("Item type")).toBe("melee");
    expect(value("Power")).toBe("40");
    expect(screen.queryByLabelText("Minimum damage")).toBeNull();
    fireEvent.change(screen.getByLabelText("Item type"), { target: { value: "weapon" } });
    fireEvent.change(screen.getByLabelText("Minimum damage"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Maximum damage"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ id: "melee", itemType: "weapon", damageMin: "2", damageMax: "3" });
    expect(posts[0]!.body).not.toHaveProperty("power");
  });

  it("prefills percent and negative pool changes", async () => {
    mount(); await edit("Tonic");
    expect(value("Effect kind")).toBe("pools");
    expect(value("Energy change")).toBe("50%");
    expect(value("Brave change")).toBe("-10");
    expect(value("Will change")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ id: "tonic", name: "Tonic", itemType: "consumable", kind: "pools", energy: "50%", brave: "-10", will: "", heal: "" });
  });

  it("shows an error instead of a blank editor when loading fails", async () => {
    failDetail = true; mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Lupara" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    failDetail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByLabelText("Name");
    expect(value("Name")).toBe("Lupara");
  });

  it("retains the draft after a failed save", async () => {
    failSave = true; mount(); await edit("Vest");
    fireEvent.change(screen.getByLabelText("Armor protection"), { target: { value: "44" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    expect(value("Armor protection")).toBe("44");
    expect(value("Item type")).toBe("armor");
  });

  it("filters the catalogue and creates only the selected type's fields", async () => {
    mount(); await screen.findByRole("button", { name: "Edit Vest" });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "armor" } });
    expect(screen.queryByRole("button", { name: "Edit Lupara" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create item" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Key" } });
    fireEvent.change(screen.getByLabelText("Item type"), { target: { value: "misc" } });
    fireEvent.click(screen.getByRole("button", { name: "Create item" }));
    await screen.findByText("Key created.");
    expect(posts[0]).toEqual({ url: `${base}/items`, body: { name: "Key", itemType: "misc" } });
  });

  it("requires confirmation before removing an item", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Lupara" }));
    expect(deleted).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(deleted).toEqual([`${base}/items/gun`]));
  });

  it("prefills shop stock without losing large price precision", async () => {
    mount(); fireEvent.click(screen.getByRole("button", { name: "Shop stock" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Lupara at Palermo" }));
    expect(value("Price")).toBe("9007199254740993");
    expect(value("Stock quantity")).toBe("12");
    fireEvent.change(screen.getByLabelText("Stock quantity"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save listing" }));
    await screen.findByText("Shop listing saved.");
    expect(posts[0]!.body).toEqual({ locationId: "town", itemId: "gun", price: "9007199254740993", stock: "0" });
  });

  it("loads an existing shop pair and clears its figures when choosing a new pair", async () => {
    mount(); fireEvent.click(screen.getByRole("button", { name: "Shop stock" }));
    await screen.findByRole("button", { name: "Edit Lupara at Palermo" });
    fireEvent.click(screen.getByRole("button", { name: "Add listing" }));
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "town" } });
    fireEvent.change(screen.getByLabelText("Item"), { target: { value: "gun" } });
    expect(value("Price")).toBe("9007199254740993");
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "other" } });
    expect(value("Price")).toBe("");
    expect(value("Stock quantity")).toBe("");
  });
});
