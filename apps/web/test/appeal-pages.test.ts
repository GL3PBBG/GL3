// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@gl3/client";
import type { GameEvent } from "@gl3/shared";
import { Crimes, CrimeOutcome } from "../src/pages/Crimes.js";
import { Dashboard } from "../src/pages/Dashboard.js";

const state = vi.hoisted(() => ({ events: [] as GameEvent[], queries: {} as Record<string, any>, mutate: vi.fn() }));
vi.mock("@gl3/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@gl3/client")>(),
  useEvents: () => state.events,
  useMe: () => state.queries.me,
  useCrimes: () => state.queries.crimes,
  useJail: () => state.queries.jail,
  useHospital: () => state.queries.hospital,
  useRanks: () => state.queries.ranks,
  useLocations: () => state.queries.locations,
  usePlugins: () => state.queries.plugins,
  useProfile: () => state.queries.profile,
  useDashboardWidgets: () => state.queries.widgets,
  useCommitCrime: () => ({ mutate: state.mutate, isPending: false, error: null }),
}));
const result: Extract<GameEvent, { type: "crime.resolved" }> = {
  id: "event-1", at: "2026-09-08T12:00:00Z", actorId: "me", actorName: "Vito", audience: { kind: "player", playerId: "me" },
  type: "crime.resolved", crimeId: "crime-1", crimeName: "Corner hustle", success: true,
  payout: "2500", exp: "12", bullets: "3", jailedUntil: null,
};
const query = (data: unknown) => ({ data, dataUpdatedAt: Date.now(), isLoading: false, isError: false, refetch: vi.fn() });
const mount = (component: typeof Crimes | typeof Dashboard) => render(createElement(MemoryRouter, null, createElement(component)));
beforeEach(() => {
  state.events = [];
  state.mutate.mockReset();
  state.queries = {
    me: query({ playerId: "me", username: "Vito", cash: "125000", bank: "80000", bullets: "450", exp: "40", level: 1 }),
    profile: query({ avatarUrl: null, gangName: "The Outfit" }),
    crimes: query({ crimes: [
      { id: "crime-1", name: "Corner hustle", description: "Collect a little street money.", chance: "65", minPayout: "100", maxPayout: "3000", cooldownSeconds: 30, cooldownRemaining: 0 },
      { id: "crime-2", name: "Warehouse job", description: "", chance: "40", minPayout: "300", maxPayout: "5000", cooldownSeconds: 30, cooldownRemaining: 0 },
    ] }),
    jail: query({ jailed: false, remainingSeconds: 0 }),
    hospital: query({ hospitalised: false, remainingSeconds: 0 }),
    plugins: query({ installed: ["crimes", "travel", "bank", "bullets"], progression: "exp" }),
    ranks: query({ ranks: [
      { id: "rank-1", name: "Street rookie", expRequired: "0", cashReward: "0", bulletReward: 0 },
      { id: "rank-2", name: "Enforcer", expRequired: "100", cashReward: "500", bulletReward: 10 },
    ] }),
    locations: query({ locations: [
      { id: "city-1", name: "Brooklyn", current: true, minLevel: 0, travelCost: "100", cooldownRemaining: 0, bulletStock: 100, bulletCost: "50", combatMode: "open" },
      { id: "city-2", name: "Chicago", current: false, minLevel: 3, travelCost: "1000", cooldownRemaining: 0 },
    ] }),
    widgets: query({ widgets: [{ pluginId: "news", title: "Street news", view: { kind: "panel", title: "Street news", children: [{ kind: "text", value: "The city is awake." }] } }] }),
  };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("reveals confirmed results beneath the correct crime, ignoring history and other players", () => {
  state.events = [{ ...result, id: "old" }];
  const view = mount(Crimes);
  expect(screen.queryByText("Job pulled off")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Commit" })[1]!);
  expect(screen.getByText("Job queued. Waiting for the outcome…")).toBeTruthy();
  expect(screen.queryByText("Job pulled off")).toBeNull();
  state.events = [{ ...result, actorId: "someone-else", id: "other" }, ...state.events];
  view.rerender(createElement(MemoryRouter, null, createElement(Crimes)));
  expect(screen.queryByText("Job pulled off")).toBeNull();
  state.events = [{ ...result, crimeId: "crime-2", crimeName: "Warehouse job" }, ...state.events];
  view.rerender(createElement(MemoryRouter, null, createElement(Crimes)));
  const row = screen.getByText("Warehouse job", { selector: "strong" }).closest("li")!;
  expect(within(row).getByText("Job pulled off")).toBeTruthy();
  expect(within(row).getByText("$2,500")).toBeTruthy();
  expect(within(row).getByText("12")).toBeTruthy();
  expect(screen.queryByText("Job queued. Waiting for the outcome…")).toBeNull();
});

it("shows insufficient-brave feedback beside the attempted crime and releases its optimistic cooldown", () => {
  state.mutate.mockImplementation((_id, options) => options.onError(new ApiError(409, "insufficient_brave")));
  mount(Crimes);
  fireEvent.click(screen.getAllByRole("button", { name: "Commit" })[0]!);
  expect(screen.queryByText("Job queued. Waiting for the outcome…")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Commit" }).every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  expect(screen.queryByText("Job pulled off")).toBeNull();
  const row = screen.getByText("Corner hustle", { selector: "strong" }).closest("li")!;
  expect(within(row).getByRole("alert").textContent).toBe("You're not feeling brave enough — it comes back over time.");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("clears the previous refusal when another crime is attempted", () => {
  state.mutate.mockImplementationOnce((_id, options) => options.onError(new ApiError(409, "insufficient_brave")));
  mount(Crimes);
  fireEvent.click(screen.getAllByRole("button", { name: "Commit" })[0]!);
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Commit" })[1]!);
  expect(screen.queryByRole("alert")).toBeNull();
  const row = screen.getByText("Warehouse job", { selector: "strong" }).closest("li")!;
  expect(within(row).getByText("Job queued. Waiting for the outcome…")).toBeTruthy();
});

it("keeps the refusal visible if a refetch removes the attempted crime", () => {
  state.mutate.mockImplementation((_id, options) => options.onError(new ApiError(409, "insufficient_brave")));
  const view = mount(Crimes);
  fireEvent.click(screen.getAllByRole("button", { name: "Commit" })[0]!);
  state.queries.crimes.data.crimes = [];
  view.rerender(createElement(MemoryRouter, null, createElement(Crimes)));
  expect(screen.getByRole("alert").textContent).toContain("not feeling brave enough");
});

it("shows jail and actual rewards together when a successful crime still gets the player caught", () => {
  const view = render(createElement(CrimeOutcome, { result: { ...result, jailedUntil: "2026-09-08T12:05:00Z" } }));
  expect(screen.getByText("Paid, but caught")).toBeTruthy();
  expect(screen.getByText("$2,500")).toBeTruthy();
  expect(view.container.querySelector('[data-outcome="caught"]')).not.toBeNull();
});

it("distinguishes a resource shortfall from a failed crime or arrest", () => {
  const view = render(createElement(CrimeOutcome, { result: { ...result, success: false, cause: "insufficient_pool", payout: "0", exp: "0", bullets: "0" } }));
  expect(screen.getByText("Job called off")).toBeTruthy();
  expect(screen.queryByText("Caught in the act")).toBeNull();
  expect(view.container.querySelector('[data-outcome="neutral"]')).not.toBeNull();
});

it("shows earned XP even when the job fails without arrest", () => {
  render(createElement(CrimeOutcome, { result: { ...result, success: false, payout: "0", exp: "2", bullets: "0" } }));
  expect(screen.getByText("The job fell through")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy();
  expect(screen.queryByText("Bullets gained")).toBeNull();
});

it("shows identity, real rank progress, the next city gate, and plugin widgets once", () => {
  mount(Dashboard);
  expect(screen.getByRole("heading", { name: "Vito" })).toBeTruthy();
  expect(screen.getByText("Street rookie · The Outfit")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Rank progress" }).getAttribute("aria-valuenow")).toBe("40");
  expect(screen.getByText("60")).toBeTruthy();
  expect(screen.getByText("Chicago")).toBeTruthy();
  expect(screen.getAllByRole("heading", { name: "Street news" })).toHaveLength(1);
  expect(screen.getByText("The city is awake.")).toBeTruthy();
  expect(screen.queryByText("Ready to travel")).toBeNull(); // Only other city is level-locked.
});

it("keeps the level progression model free of invented XP thresholds", () => {
  state.queries.plugins.data.progression = "level";
  mount(Dashboard);
  expect(screen.queryByRole("progressbar", { name: "Rank progress" })).toBeNull();
  expect(screen.getByText("Unlocks at level 2. You are level 1.")).toBeTruthy();
});

it("hides shortcuts and city/bank/bullet panels when their plugins are absent", () => {
  state.queries.plugins.data.installed = [];
  mount(Dashboard);
  expect(screen.queryByText("Work the streets")).toBeNull();
  expect(screen.queryByText("Change the scenery")).toBeNull();
  expect(screen.queryByText("Secure your earnings")).toBeNull();
  expect(screen.queryByText("Your city")).toBeNull();
  expect(screen.queryByText("In the bank")).toBeNull();
  expect(screen.getByRole("link", { name: /Check the competition/ })).toBeTruthy();
});

it.each(["jail", "hospital"])("never marks street actions ready while in %s", (facility) => {
  state.queries[facility].data[facility === "jail" ? "jailed" : "hospitalised"] = true;
  state.queries[facility].data.remainingSeconds = 60;
  mount(Dashboard);
  expect(screen.queryByText("Cooldown ready")).toBeNull();
  expect(screen.queryByText("Ready to travel")).toBeNull();
  expect(screen.getByRole("link", { name: facility === "jail" ? "View release options" : "View recovery options" })).toBeTruthy();
});

it("counts down readiness locally and does not restart a stale cached cooldown", () => {
  vi.useFakeTimers();
  state.queries.crimes.data.crimes[0].cooldownRemaining = 30;
  state.queries.crimes.dataUpdatedAt = Date.now() - 28_000;
  mount(Dashboard);
  expect(screen.getByText("Wait 2s")).toBeTruthy();
  act(() => vi.advanceTimersByTime(2100));
  expect(screen.getByText("Cooldown ready")).toBeTruthy();
});

it("does not claim actions are ready when facility or crime checks fail", () => {
  state.queries.jail.isError = true;
  state.queries.crimes.isError = true;
  mount(Dashboard);
  expect(screen.queryByText("Cooldown ready")).toBeNull();
  expect(screen.queryByText("Ready to travel")).toBeNull();
});
