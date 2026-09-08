// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureClient, resetClientConfigForTests, keys } from "@gl3/client";
import type { LocationDto } from "@gl3/shared";
import { Travel } from "../src/pages/Travel.js";

const id = (n: number) => `0192f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const town = (n: number, name: string, minLevel: number): LocationDto => ({id: id(n), name, minLevel, current: n === 1, travelCost: "100", travelCooldownSeconds: 30, cooldownRemaining: 0, bulletCost: "50", bulletStock: 100, combatMode: "open"});
const json = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), {status, headers: {"content-type": "application/json", ...headers}});
let rows: LocationDto[];
let installed: string[];
let gates: {minLevel: number; townMinLevel: number};
let level: number;
let cash: string;
let jailed: boolean;
let availabilityStatus: number;
let action: (url: string) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
let client: QueryClient;
beforeEach(() => {
  configureClient({baseUrl: "", wsUrl: "ws://test/ws", tokenStore: {get: () => null, set: () => {}, clear: () => {}}, onGate: () => {}});
  rows = [town(1, "Harbour", 0), town(2, "Vice Heights", 10), town(3, "Summit", 30)];
  installed = ["travel", "bullets", "theft", "brothel"];
  gates = {minLevel: 15, townMinLevel: 10};
  level = 10; cash = "1000"; jailed = false; availabilityStatus = 200;
  action = (url) => {
    const locationId = url.split("/").at(-1)!;
    rows = rows.map(row => ({...row, current: row.id === locationId, cooldownRemaining: 30}));
    cash = "900";
    return json({locationId, cash});
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return action(url);
    if (url === "/api/auth/me") return json({playerId: id(10), username: "Vito", cash, bank: "0", points: "0", bullets: "0", exp: "0", grants: [], level});
    if (url === "/api/jail") return json({jailed, until: null, remainingSeconds: 0, superMax: false});
    if (url === "/api/locations") return json({locations: rows});
    if (url === "/api/plugins") return json({installed, menu: [], pages: [], events: [], moneyFormat: {symbol: "$", position: "prefix", thousandsSep: ","}});
    if (url === "/api/brothel/availability") return json(gates, availabilityStatus);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
});
afterEach(() => {cleanup(); client.clear(); vi.unstubAllGlobals(); resetClientConfigForTests();});
async function mount() {
  const view = render(createElement(QueryClientProvider, {client}, createElement(MemoryRouter, null, createElement(Travel))));
  await screen.findByRole("heading", {name: "Choose your next city"});
  await waitFor(() => expect(screen.queryByText("Checking your status…")).toBeNull());
  if (installed.includes("brothel")) await waitFor(() => expect(client.getQueryState(keys.brothelAvailability())?.fetchStatus).toBe("idle"));
  return view;
}
function card(name: string) {return within(screen.getByRole("heading", {name, level: 3}).closest("li")!);}
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

it("uses configured town and visitor gates independently, including the boundary", async () => {
  await mount();
  expect(card("Harbour").queryByText(/Brothel/)).toBeNull();
  expect(card("Vice Heights").getByText("Brothel · visit at level 15")).toBeTruthy();
  const places = card("Vice Heights").getByLabelText("Places in Vice Heights");
  expect(within(places).getByText("Bullet shop")).toBeTruthy();
  expect(within(places).getByText("Garage")).toBeTruthy();
  expect(within(places).getByText("Brothel · visit at level 15")).toBeTruthy();
  expect(screen.queryByRole("heading", {name: "Brothel"})).toBeNull();
  expect(screen.getAllByRole("listitem")).toHaveLength(rows.length);
  expect(card("Vice Heights").getByRole("button", {name: "Travel"})).toHaveProperty("disabled", false);
  expect(card("Summit").getByRole("button", {name: "Level 30 required"})).toHaveProperty("disabled", true);
  expect(screen.queryByRole("link", {name: "Brothel →"})).toBeNull();
});

it("reflects renamed towns and changed admin settings without a fixed town list", async () => {
  rows[0]!.name = "New Waterfront";
  gates = {minLevel: 10, townMinLevel: 0};
  await mount();
  expect(card("New Waterfront").getByText("Brothel")).toBeTruthy();
  expect(screen.getByRole("link", {name: "Brothel →"}).getAttribute("href")).toBe("/plugins/brothel.index");
});

it("never requests brothel configuration or displays local services when plugins are absent", async () => {
  installed = ["travel"];
  // Even an old cached config cannot enable an uninstalled venue.
  client.setQueryData(keys.brothelAvailability(), gates);
  await mount();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/brothel/availability")).toBe(false);
  expect(screen.queryByText(/Brothel/)).toBeNull();
  expect(screen.queryByRole("link", {name: /Bullet shop|Garage/})).toBeNull();
  expect(screen.queryByText(/in stock/)).toBeNull();
});

it("does not invent venue availability when an older plugin lacks the endpoint", async () => {
  availabilityStatus = 404;
  await mount();
  expect(screen.getByText("Brothel availability is currently unavailable.")).toBeTruthy();
  expect(card("Vice Heights").queryByText(/Brothel/)).toBeNull();
});

it("reveals arrival only after success and refreshes current city, cash, and local services", async () => {
  level = 15;
  let resolve!: (value: Response) => void;
  const success = action;
  action = () => new Promise<Response>(r => {resolve = r;});
  for (const key of [keys.garage(), keys.bulletShop(), keys.menuBadges(), keys.properties()]) client.setQueryData(key, {});
  await mount();
  fireEvent.click(card("Vice Heights").getByRole("button", {name: "Travel"}));
  expect(screen.queryByRole("status", {name: "Arrival confirmed"})).toBeNull();
  await waitFor(() => expect(writes()).toHaveLength(1));
  resolve(await success(`/api/travel/${id(2)}`));
  await screen.findByText("Welcome to Vice Heights");
  await screen.findByRole("heading", {name: "Vice Heights", level: 1});
  expect(screen.getByRole("link", {name: "Brothel →"})).toBeTruthy();
  expect(screen.getByText("$900")).toBeTruthy();
  expect(screen.getByText("Next trip in 30s")).toBeTruthy();
  for (const key of [keys.garage(), keys.bulletShop(), keys.menuBadges(), keys.properties()]) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  expect(writes()[0]?.[1]?.body).toBeUndefined();
});

it("places a refusal beside the chosen city and releases the optimistic cooldown", async () => {
  action = () => json({error: "insufficient_funds"}, 409);
  await mount();
  fireEvent.click(card("Vice Heights").getByRole("button", {name: "Travel"}));
  await waitFor(() => expect(card("Vice Heights").getByRole("alert")).toBeTruthy());
  expect(card("Vice Heights").getByRole("button", {name: "Travel"})).toHaveProperty("disabled", false);
  expect(screen.queryByText(/Welcome to/)).toBeNull();
  expect(screen.getByRole("heading", {name: "Harbour", level: 1})).toBeTruthy();
});

it("keeps the server's retry-after cooldown after a refusal", async () => {
  action = () => json({error: "cooldown"}, 429, {"retry-after": "7"});
  await mount();
  fireEvent.click(card("Vice Heights").getByRole("button", {name: "Travel"}));
  await screen.findByText("Next trip in 7s");
  expect(card("Vice Heights").getByRole("button", {name: "Wait 7s"})).toHaveProperty("disabled", true);
});

it("shows effective discounted fares and allows a free trip with zero cash", async () => {
  cash = "0";
  rows[1] = {...rows[1]!, travelCost: "0", baseFare: "500", fareLabel: "Driving your Sedan"};
  await mount();
  expect(card("Vice Heights").getByText("$500").closest("s")).toBeTruthy();
  expect(card("Vice Heights").getByText("Driving your Sedan")).toBeTruthy();
  expect(card("Vice Heights").getByRole("button", {name: "Travel"})).toHaveProperty("disabled", false);
});

it("blocks travel from jail and shows why", async () => {
  jailed = true;
  await mount();
  expect(screen.getByText("You can't travel from jail.")).toBeTruthy();
  expect(card("Vice Heights").getByRole("button", {name: "Travel"})).toHaveProperty("disabled", true);
  expect(writes()).toHaveLength(0);
});
