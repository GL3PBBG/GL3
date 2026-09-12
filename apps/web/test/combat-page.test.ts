// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureClient, resetClientConfigForTests } from "@gl3/client";
import { Combat } from "../src/pages/Combat.js";

const id = (n: number) => `0192f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const json = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
let client: QueryClient;
let cooldown: number;
let refusal: boolean;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  configureClient({ baseUrl: "", wsUrl: "ws://test/ws", tokenStore: { get: () => null, set: () => {}, clear: () => {} }, onGate: () => {} });
  cooldown = 0;
  refusal = false;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      cooldown = 5;
      if (refusal) return json({ error: "target_elsewhere" }, 409);
      return json({ hit: true, crit: false, damage: 10, armorAbsorbed: 0, targetHealth: 90, targetKilled: false, payout: "0", bulletsSpent: 1, backfire: false, selfDamage: 0, attackerHealth: 100, weapon: "firearm", weaponName: "Pistol" });
    }
    if (url === "/api/combat/targets") return json({ mode: "open", cooldownRemaining: cooldown, targets: [2, 3].map(n => ({ playerId: id(n), username: `Rival ${n}`, rank: null, health: 100, maxHealth: 100, attackable: true, reason: null })) });
    if (url === "/api/combat/log") return json({ entries: [] });
    if (url === "/api/combat/weapon") return json({ itemId: id(4), name: "Pistol", condition: 100, backfireChance: 0, repairCost: "0", firearm: { itemId: id(4), name: "Pistol", damageMin: 10, damageMax: 10, bulletsPerShot: 1 }, melee: { itemId: id(5), name: "Bat", power: 1, strength: "10", estimate: "15" }, fists: null });
    if (url === "/api/auth/me") return json({ playerId: id(1), username: "Player", cash: "1000", bank: "0", points: "0", bullets: "100", exp: "0", grants: [], level: 10 });
    if (url === "/api/jail") return json({ jailed: false, until: null, remainingSeconds: 0, superMax: false });
    if (url === "/api/hospital") return json({ health: 100, maxHealth: 100, hospitalised: false, until: null, remainingSeconds: 0, dischargeCost: "0" });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); resetClientConfigForTests(); });
async function mount() {
  const view = render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(Combat))));
  await screen.findByText("Firearm: Pistol");
  return view;
}

it("counts down after shooting, locks both weapons across target changes, and unlocks at expiry", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Shoot" }));
  await screen.findByText("Next attack in 5s");
  expect(screen.getAllByRole("button", { name: "5s" })).toHaveLength(2);
  for (const button of screen.getAllByRole("button", { name: "5s" })) expect(button).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: id(3) } });
  expect(screen.getByText("Next attack in 5s")).toBeTruthy();
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now + 2000);
  await screen.findByText("Next attack in 3s", {}, { timeout: 2000 });
  vi.setSystemTime(now + 5000);
  await waitFor(() => expect(screen.getByRole("button", { name: "Shoot" })).toHaveProperty("disabled", false), { timeout: 2000 });
  expect(screen.getByRole("button", { name: "Strike" })).toHaveProperty("disabled", false);
  expect(screen.queryByText(/Next attack in/)).toBeNull();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("restores an active cooldown when opening combat and ages the cached snapshot on return", async () => {
  cooldown = 20;
  const view = await mount();
  await screen.findByText("Next attack in 20s");
  view.unmount();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 5000);
  // Hold the refetch so this assertion exercises the cached snapshot.
  fetchMock.mockImplementation(() => new Promise(() => {}));
  await mount();
  expect(screen.getByText("Next attack in 15s")).toBeTruthy();
});

it("refreshes the cooldown after a refused shot that still consumed it", async () => {
  refusal = true;
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Shoot" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Next attack in 5s")).toBeTruthy();
  for (const button of screen.getAllByRole("button", { name: "5s" })) expect(button).toHaveProperty("disabled", true);
});
