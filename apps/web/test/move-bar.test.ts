// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoveBar } from "../src/pages/Casino.js";
import type { GameMoveDto } from "@gl3/shared";

/**
 * `MoveBar` — the generic action bar the generic-moves protocol asks the
 * client to draw in place of a game's hardcoded buttons. Presentational only
 * (an `onMove` callback prop, no react-query wiring), so it is tested the
 * same standalone way `Meter` is.
 */
afterEach(cleanup);

const CHECK: GameMoveDto = { action: { action: "check" }, label: "Check" };
const FOLD: GameMoveDto = { action: { action: "fold" }, label: "Fold" };
const BET: GameMoveDto = { action: { action: "bet" }, label: "Bet…", needsAmount: true };

describe("MoveBar", () => {
  it("renders one button per move, labelled from the move", () => {
    render(createElement(MoveBar, { moves: [CHECK, FOLD], busy: false, onMove: vi.fn() }));
    expect(screen.getByRole("button", { name: "Check" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fold" })).toBeTruthy();
  });

  it("shows no amount input when no move needs one", () => {
    render(createElement(MoveBar, { moves: [CHECK, FOLD], busy: false, onMove: vi.fn() }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows one shared amount input when a move needs it, and disables that move's button until it holds a digit", () => {
    render(createElement(MoveBar, { moves: [CHECK, BET], busy: false, onMove: vi.fn() }));
    const betButton = screen.getByRole("button", { name: "Bet…" });
    expect(betButton).toHaveProperty("disabled", true);
    // A move that doesn't need an amount is never gated by it.
    expect(screen.getByRole("button", { name: "Check" })).toHaveProperty("disabled", false);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "500" } });
    expect(betButton).toHaveProperty("disabled", false);
  });

  it("strips non-digit input from the shared amount field", () => {
    render(createElement(MoveBar, { moves: [BET], busy: false, onMove: vi.fn() }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "5a0b0" } });
    expect(input).toHaveProperty("value", "500");
  });

  it("posts the merged payload for a needsAmount move on click", () => {
    const onMove = vi.fn();
    render(createElement(MoveBar, { moves: [BET], busy: false, onMove }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Bet…" }));
    expect(onMove).toHaveBeenCalledWith({ action: "bet", amount: "500" });
  });

  it("posts the move's action verbatim for a move with no amount", () => {
    const onMove = vi.fn();
    render(createElement(MoveBar, { moves: [CHECK], busy: false, onMove }));
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(onMove).toHaveBeenCalledWith({ action: "check" });
  });

  it("disables every button while busy", () => {
    render(createElement(MoveBar, { moves: [CHECK, FOLD], busy: true, onMove: vi.fn() }));
    expect(screen.getByRole("button", { name: "Check" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Fold" })).toHaveProperty("disabled", true);
  });
});
