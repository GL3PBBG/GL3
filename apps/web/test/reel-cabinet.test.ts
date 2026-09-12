// @vitest-environment jsdom
import { cleanup, fireEvent, render as baseRender, screen, act } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
const render = (element: ReactElement) => baseRender(element, { wrapper: MemoryRouter });
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CasinoMachine, ReelDisplay } from "@gl3/shared";
import { ReelCabinet } from "../src/pages/ReelCabinet.js";

const display: ReelDisplay = {
  reels: [0,1,2].map(i => ({ image: "data:image/svg+xml,%3Csvg/%3E", label: "Cherry", held: i === 1, spin: i !== 1, holdMove: i })),
  symbols: ["data:image/svg+xml,%3Csvg/%3E"], collectable: "500",
  rules: { kind: "text", value: "Rules" },
};
const machine: CasinoMachine = {
  id: "00000000-0000-4000-8000-000000000001", gameId: "slots", gameName: "Fruit Machine", credits: "900", wager: "100",
  revision: 1, inRound: true, closed: false, available: true, view: null,
  moves: [0,1,2].map(i => ({ action: { action: "hold", reel: i, held: i !== 1 }, label: `${i === 1 ? "Release" : "Hold"} reel ${i+1}` })).concat([
    { action: { action: "respin" } as never, label: "Respin • free" },
    { action: { action: "collect" } as never, label: "Collect winnings" },
  ]),
};
const send = vi.fn();
const props = { machine, display, send, busy: false, animating: false, jailed: false, reducedMotion: true, wager: "100", onWager: vi.fn(), cashout: createElement("button",null,"Cash out") };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("interactive reel cabinet", () => {
  it("places each hold directly after its reel and sends the corresponding legal move", () => {
    render(createElement(ReelCabinet, props));
    const held = screen.getByRole("button", { name: "Release reel 2" });
    expect(held.getAttribute("aria-pressed")).toBe("true");
    expect(held.previousElementSibling?.getAttribute("aria-label")).toBe("Reel 2: Cherry, held");
    fireEvent.click(held);
    expect(send).toHaveBeenCalledWith("act", { action: { action: "hold", reel: 1, held: false } });
    expect(screen.getAllByRole("button", { name: /(?:Hold|Release) reel/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Respin • free" }));
    expect(send).toHaveBeenLastCalledWith("act", { action: { action: "respin" } });
  });
  it("keeps held reels still and locks controls and hides amounts until the reveal", () => {
    render(createElement(ReelCabinet, { ...props, busy: true, animating: true }));
    expect(screen.getByRole("img", { name: "Reel 1 spinning" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Reel 2: Cherry, held" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Release reel 2" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("$500")).toBeNull();
  });
  it("celebrates a newly settled win after animation, with no animation replay after reload", () => {
    vi.useFakeTimers();
    const { rerender, container } = render(createElement(ReelCabinet, props));
    const won = { ...machine, revision: 2, inRound: false, payout: "1000", credits: "1900", moves: [] };
    rerender(createElement(ReelCabinet, { ...props, machine: won, animating: true, busy: true }));
    expect(container.querySelector("[data-win-effect]")).toBeNull();
    rerender(createElement(ReelCabinet, { ...props, machine: won }));
    expect(container.querySelector('[data-big-win="true"]')).toBeTruthy();
    expect(container.querySelector("[data-win-effect]")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("$1,000 returned");
    act(() => vi.advanceTimersByTime(3601));
    expect(container.querySelector("[data-win-effect]")).toBeNull();
    cleanup();
    const resumed = render(createElement(ReelCabinet, { ...props, machine: won }));
    expect(resumed.container.querySelector("[data-win-effect]")).toBeNull();
  });
  it("celebrates a single-cherry stake return after the reveal, then expires without replay on reload", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    const { rerender, container } = render(createElement(ReelCabinet, props));
    const won = { ...machine, revision: 2, inRound: false, payout: "100", credits: "1000", moves: [] };
    const settledDisplay = { ...display, collectable: "0", reels: display.reels.map(reel => ({ ...reel, held: false, holdMove: null })) };
    const settledProps = { ...props, machine: won, display: settledDisplay, reducedMotion: false };
    rerender(createElement(ReelCabinet, { ...settledProps, animating: true, busy: true }));
    expect(container.querySelector("[data-win-effect]")).toBeNull();
    rerender(createElement(ReelCabinet, settledProps));
    const effect = container.querySelector("[data-win-effect]");
    expect(effect).toBeTruthy();
    expect(effect?.querySelectorAll("i")).toHaveLength(16);
    expect(container.querySelector('[data-big-win="true"]')).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Your stake is back");
    for (const hold of screen.getAllByRole("button", { name: /Hold reel/ })) {
      expect(hold).toHaveProperty("disabled", true);
      expect(hold.getAttribute("aria-pressed")).toBe("false");
    }
    expect(screen.getByRole("button", { name: "Spin" })).toHaveProperty("disabled", false);
    act(() => vi.advanceTimersByTime(1200));
    expect(effect?.querySelector("strong")?.textContent).toBe("$100");
    act(() => vi.advanceTimersByTime(1401));
    expect(container.querySelector("[data-win-effect]")).toBeNull();
    cleanup();
    expect(render(createElement(ReelCabinet, settledProps)).container.querySelector("[data-win-effect]")).toBeNull();
  });
  it("does not celebrate a loss", () => {
    const { rerender, container } = render(createElement(ReelCabinet, props));
    rerender(createElement(ReelCabinet, { ...props, machine: { ...machine, revision: 2, inRound: false, payout: "0", moves: [] } }));
    expect(container.querySelector("[data-win-effect]")).toBeNull();
  });
  it("keeps another spin available during celebration and stops the effect when the next round starts", () => {
    const { rerender, container } = render(createElement(ReelCabinet, props));
    rerender(createElement(ReelCabinet, { ...props, machine: { ...machine, revision: 2, inRound: false, payout: "500", moves: [] } }));
    const spin = screen.getByRole("button", { name: "Spin" });
    expect(spin).toHaveProperty("disabled", false);
    fireEvent.click(spin);
    expect(send).toHaveBeenCalledWith("spin", { wager: "100" });
    rerender(createElement(ReelCabinet, { ...props, machine: { ...machine, revision: 3 }, busy: true, animating: true }));
    expect(container.querySelector("[data-win-effect]")).toBeNull();
  });
});
