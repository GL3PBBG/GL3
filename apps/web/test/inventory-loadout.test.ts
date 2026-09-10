// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureClient, resetClientConfigForTests } from "@gl3/client";
import type { InventoryResponse } from "@gl3/shared";
import { Inventory } from "../src/pages/Inventory.js";

const id = (n: number) => `0192f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
let inventory: InventoryResponse;
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
const json = (data: unknown) => new Response(JSON.stringify(data), {headers: {"content-type": "application/json"}});
beforeEach(() => {
  configureClient({baseUrl: "", wsUrl: "ws://test/ws", tokenStore: {get: () => null, set: () => {}, clear: () => {}}, onGate: () => {}});
  inventory = {items: [
    {itemId: id(1), name: "Service pistol", itemType: "weapon", effects: {damageMin: 10, damageMax: 20, accuracy: 70}, qty: 1, imageUrl: "/pistol.webp", actions: [{pluginId: "combat", label: "Gunsmith", to: "/plugins/combat.index"}]},
    {itemId: id(2), name: "Baseball bat", itemType: "weapon", effects: {power: 12}, qty: 1},
    {itemId: id(3), name: "Armored vest", itemType: "armor", effects: {armor: 20}, qty: 1},
  ], equipped: {weaponItemId: id(1), weaponMeleeItemId: id(2), armorItemId: id(3)}};
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/inventory/equip") {
      inventory = {...inventory, equipped: {...inventory.equipped, ...JSON.parse(String(init?.body))}};
      return json(inventory.equipped);
    }
    if (url === "/api/inventory") return json(inventory);
    if (url === "/api/hospital") return json({health: 100, maxHealth: 100, hospitalised: false, until: null, remainingSeconds: 0, dischargeCost: "0"});
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
});
afterEach(() => {cleanup(); client.clear(); vi.unstubAllGlobals(); resetClientConfigForTests();});
async function mount() {
  render(createElement(QueryClientProvider, {client}, createElement(MemoryRouter, null, createElement(Inventory))));
  return within(await screen.findByRole("list", {name: "Equipped gear"}));
}

it("shows the correct item, artwork, stats and plugin actions in each of the three slots", async () => {
  const loadout = await mount();
  expect(loadout.getAllByRole("listitem")).toHaveLength(3);
  expect(loadout.getByRole("heading", {name: "Service pistol"})).toBeTruthy();
  expect(loadout.getByRole("img", {name: "Service pistol"}).getAttribute("src")).toBe("/pistol.webp");
  expect(loadout.getByRole("heading", {name: "Baseball bat"})).toBeTruthy();
  expect(loadout.getByRole("heading", {name: "Armored vest"})).toBeTruthy();
  expect(loadout.getByText("20 armor")).toBeTruthy();
  expect(loadout.getByText("10–20 damage · ~7 shots to kill")).toBeTruthy();
  expect(loadout.getByRole("link", {name: "Gunsmith"}).getAttribute("href")).toBe("/plugins/combat.index");
});

it("opens equipped artwork outside the card and restores keyboard focus on close", async () => {
  const loadout = await mount();
  const opener = loadout.getByRole("button", {name: "View Service pistol full size"});
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", {name: "Service pistol"});
  expect(dialog.parentElement).toBe(document.body);
  expect(document.activeElement).toBe(within(dialog).getByRole("button", {name: "Close"}));
  fireEvent.keyDown(window, {key: "Escape"});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it.each([
  ["firearm", "weaponItemId"], ["melee", "weaponMeleeItemId"], ["armor", "armorItemId"],
] as const)("unequips only the %s slot and refreshes its empty state", async (label, key) => {
  const loadout = await mount();
  fireEvent.click(loadout.getByRole("button", {name: `Unequip ${label}`}));
  await waitFor(() => expect(loadout.queryByRole("button", {name: `Unequip ${label}`})).toBeNull());
  expect(loadout.getByText("Empty slot")).toBeTruthy();
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]![1].body)).toEqual({[key]: null});
  expect(loadout.getAllByText("Equipped")).toHaveLength(2);
});

it("preserves the melee equip action after clearing that slot", async () => {
  inventory.equipped.weaponMeleeItemId = null;
  const loadout = await mount();
  fireEvent.click(screen.getByRole("button", {name: "Equip melee"}));
  await waitFor(() => expect(loadout.getByRole("button", {name: "Unequip melee"})).toBeTruthy());
  const write = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(JSON.parse(write[1].body)).toEqual({weaponMeleeItemId: id(2)});
});

it("allows clearing a slot whose item details are unavailable", async () => {
  inventory.items = inventory.items.filter(item => item.itemId !== id(3));
  const loadout = await mount();
  expect(loadout.getByText("Unavailable item")).toBeTruthy();
  fireEvent.click(loadout.getByRole("button", {name: "Unequip armor"}));
  await waitFor(() => expect(loadout.queryByText("Unavailable item")).toBeNull());
  expect(loadout.getByText("Empty slot")).toBeTruthy();
});

it("lists consumable and non-consumable items alongside an equipped loadout", async () => {
  inventory.items.push(
    {itemId: id(4), name: "First aid kit", itemType: "consumable", effects: {heal: "50%"}, qty: 3},
    {itemId: id(5), name: "Energy drink", itemType: "consumable", effects: {kind: "energy"}, effectLabel: "Restore energy", qty: 2},
    {itemId: id(6), name: "Lockpick", itemType: "misc", effects: {}, qty: 4, actions: [{pluginId: "theft", label: "Steal a car", to: "/plugins/theft.index"}]},
    {itemId: id(7), name: "Collector coin", itemType: "collectible", effects: {}, qty: 1},
  );
  const loadout = await mount();
  expect(loadout.getAllByText("Equipped")).toHaveLength(3);

  const consumables = within(screen.getByRole("heading", {name: "Consumables"}).parentElement!);
  expect(consumables.getAllByRole("listitem")).toHaveLength(2);
  const healRow = consumables.getByText(/First aid kit/).closest("li")!;
  expect(healRow.textContent).toContain("First aid kit ×3");
  expect(within(healRow).getByText("heals 50%")).toBeTruthy();
  expect(within(healRow).getByRole<HTMLButtonElement>("button", {name: "Use"}).disabled).toBe(true);
  const energyRow = consumables.getByText(/Energy drink/).closest("li")!;
  expect(energyRow.textContent).toContain("Energy drink ×2");
  expect(within(energyRow).getByText("Restore energy")).toBeTruthy();
  expect(within(energyRow).getByRole<HTMLButtonElement>("button", {name: "Use"}).disabled).toBe(false);

  const other = within(screen.getByRole("heading", {name: "Other"}).parentElement!);
  expect(other.getAllByRole("listitem")).toHaveLength(2);
  expect(other.getByText(/Lockpick/).textContent).toBe(" Lockpick ×4");
  expect(other.getByText(/Collector coin/).textContent).toBe(" Collector coin ×1");
  expect(other.getByRole("link", {name: "Steal a car"}).getAttribute("href")).toBe("/plugins/theft.index");
  expect(other.queryByRole("button", {name: "Use"})).toBeNull();
});
