// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureClient, resetClientConfigForTests, keys, invalidationKeys } from "@gl3/client";
import { Garage } from "../src/pages/Garage.js";

const id = (n: number) => `0192f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const car = (n: number, extra: Record<string, string> = {}) => ({
  id: id(n), carName: "Sedan", image: "", damage: "25", locationName: "Brooklyn", saleValue: "7500", repairCost: "500", here: "yes", ...extra,
});
let rows: ReturnType<typeof car>[];
let cash: string;
let jailed: boolean;
let actionResponse: (path: string, body: { garageId: string }) => Response;
let fetchMock: ReturnType<typeof vi.fn>;
let client: QueryClient;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  configureClient({ baseUrl: "", wsUrl: "ws://test/ws", tokenStore: {get: () => null, set: () => {}, clear: () => {}}, onGate: () => {} });
  rows = [car(1), car(2, {carName: "Coupe", here: "no", locationName: "Chicago", damage: "80"})];
  cash = "1000";
  jailed = false;
  actionResponse = (path, body) => {
    if (path.endsWith("/sell")) { rows = rows.filter(row => row.id !== body.garageId); return json({ payout: "7500" }); }
    rows = rows.map(row => row.id === body.garageId ? { ...row, damage: "0", repairCost: "0", saleValue: "10000" } : row);
    cash = "500";
    return json({ cost: "500" });
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return actionResponse(url, JSON.parse(String(init.body)));
    if (url === "/api/garage") return json({rows});
    if (url === "/api/auth/me") return json({playerId: id(10), username: "Vito", cash, bank: "0", points: "0", bullets: "0", exp: "0", grants: [], level: 1});
    if (url === "/api/jail") return json({jailed, until: null, remainingSeconds: 0, superMax: false});
    if (url === "/api/plugins") return json({installed: ["theft", "travel"], menu: [], pages: [], events: [], moneyFormat: {symbol: "$", position: "prefix", thousandsSep: ","}});
    if (url.startsWith("/api/assets/slot/")) return json({url: null});
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); resetClientConfigForTests(); });
async function mount() {
  render(createElement(QueryClientProvider, {client}, createElement(MemoryRouter, null, createElement(Garage))));
  await screen.findByRole("heading", {name: rows.length ? "Sedan" : "Your first set of keys awaits"});
  await waitFor(() => expect(screen.queryByText("Checking your status…")).toBeNull());
}
function card(name: string) { return within(screen.getByRole("heading", {name}).closest("li")!); }
function writes() { return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"); }

it("shows condition as intact percentage and blocks actions on cars in another city", async () => {
  await mount();
  expect(card("Sedan").getByRole("meter").getAttribute("aria-valuenow")).toBe("75");
  expect(card("Coupe").getByRole("meter").getAttribute("aria-valuenow")).toBe("20");
  expect(card("Coupe").getByRole("button", {name: "Repair"})).toHaveProperty("disabled", true);
  expect(card("Coupe").getByRole("button", {name: "Sell"})).toHaveProperty("disabled", true);
  expect(card("Coupe").getByRole("link", {name: "Travel to Chicago"}).getAttribute("href")).toBe("/plugins/travel.index");
  fireEvent.click(screen.getByRole("button", {name: "In this city (1)"}));
  expect(screen.queryByRole("heading", {name: "Coupe"})).toBeNull();
  expect(writes()).toHaveLength(0);
});

it("repairs the selected car and refreshes its condition, quote, and the player's cash", async () => {
  await mount();
  fireEvent.click(card("Sedan").getByRole("button", {name: "Repair"}));
  await screen.findByText("Sedan repaired for", {exact: false});
  expect(writes()).toHaveLength(1);
  expect(writes()[0]![0]).toBe("/api/garage/repair");
  expect(JSON.parse(writes()[0]![1].body)).toEqual({garageId: id(1)});
  expect(card("Sedan").getByRole("meter").getAttribute("aria-valuenow")).toBe("100");
  expect(card("Sedan").getByRole("button", {name: "Repair"})).toHaveProperty("disabled", true);
  expect(client.getQueryData<{cash: string}>(keys.me())?.cash).toBe("500");
});

it("keeps a cancelled sale and reports the server payout after a confirmed sale", async () => {
  await mount();
  fireEvent.click(card("Sedan").getByRole("button", {name: "Sell"}));
  expect(writes()).toHaveLength(0);
  fireEvent.click(card("Sedan").getByRole("button", {name: "Keep car"}));
  expect(screen.queryByRole("button", {name: "Confirm sale"})).toBeNull();
  fireEvent.click(card("Sedan").getByRole("button", {name: "Sell"}));
  fireEvent.click(card("Sedan").getByRole("button", {name: "Confirm sale"}));
  await screen.findByText("Sold Sedan for", {exact: false});
  expect(screen.getByRole("status").textContent).toBe("Sold Sedan for $7,500.");
  expect(screen.queryByRole("heading", {name: "Sedan"})).toBeNull();
  expect(screen.getByRole("heading", {name: "Coupe"})).toBeTruthy();
  expect(writes()[0]![0]).toBe("/api/garage/sell");
  expect(JSON.parse(writes()[0]![1].body)).toEqual({garageId: id(1)});
});

it("places a repair refusal beside the selected car and leaves its condition unchanged", async () => {
  actionResponse = () => json({error: "insufficient_funds"}, 409);
  await mount();
  fireEvent.click(card("Sedan").getByRole("button", {name: "Repair"}));
  await waitFor(() => expect(card("Sedan").getByRole("alert").textContent).toBe("You don't have enough money."));
  expect(card("Sedan").getByRole("meter").getAttribute("aria-valuenow")).toBe("75");
  expect(card("Sedan").getByRole("button", {name: "Repair"})).toHaveProperty("disabled", false);
});

it("handles a concurrent repair returning 204 without inventing a charge", async () => {
  actionResponse = () => { rows[0] = car(1, {damage: "0", repairCost: "0"}); return new Response(null, {status: 204}); };
  await mount();
  fireEvent.click(card("Sedan").getByRole("button", {name: "Repair"}));
  expect(await screen.findByText("Sedan is already pristine. No repair charge.")).toBeTruthy();
  expect(card("Sedan").getByRole("meter").getAttribute("aria-valuenow")).toBe("100");
});

it("disables selling and repair while jailed", async () => {
  jailed = true;
  await mount();
  expect(screen.getByText("You can't sell or repair cars while in jail.")).toBeTruthy();
  expect(card("Sedan").getByRole("button", {name: "Sell"})).toHaveProperty("disabled", true);
  expect(card("Sedan").getByRole("button", {name: "Repair"})).toHaveProperty("disabled", true);
});

it("compares cash and repair costs exactly above Number's safe range", async () => {
  cash = "9007199254740992";
  rows = [car(1, {repairCost: "9007199254740993", saleValue: "9007199254740993"})];
  await mount();
  expect(screen.getByText("Not enough cash for a full repair.")).toBeTruthy();
  expect(card("Sedan").getByRole("button", {name: "Repair"})).toHaveProperty("disabled", true);
  expect(screen.getAllByText("$9,007,199,254,740,993").length).toBeGreaterThan(0);
});

it("offers a route into car theft for an empty garage", async () => {
  rows = [];
  await mount();
  expect(screen.getByRole("link", {name: "Try car theft →"}).getAttribute("href")).toBe("/plugins/theft.index");
  expect(screen.queryByRole("button", {name: "Repair"})).toBeNull();
});

it("uses the theft event's existing garage invalidation prefix", () => {
  const event = {type: "plugin.event", pluginId: "theft", name: "sold"} as Parameters<typeof invalidationKeys>[0];
  expect(invalidationKeys(event, id(10), [{pluginId: "theft", name: "sold", describe: "Sold", invalidates: ["garage", "me"]}])).toContainEqual(keys.garage());
});
