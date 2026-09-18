// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageRenderer } from "../src/plugins/PageRenderer.js";
import { configureClient, resetClientConfigForTests, type RenderInstruction } from "@gl3/client";

afterEach(() => { cleanup(); resetClientConfigForTests(); vi.unstubAllGlobals(); });
beforeEach(() => {
  configureClient({
    baseUrl: "", wsUrl: "ws://test/ws",
    tokenStore: { get: () => null, set: () => {}, clear: () => {} },
    onGate: () => {},
  });
});

const tableInst: RenderInstruction[] = [{
  kind: "table", source: "GET /api/travel/destinations",
  columns: [{ key: "name", label: "Name", render: null, imageSize: "sm" }],
  rowActions: [{
    label: "Travel", action: "POST /api/travel/:id", confirm: null,
    disabledKey: "cannotTravel", cooldownKey: "cooldownUntil",
  }],
}];

function mount(): void {
  render(createElement(MemoryRouter, null, createElement(PageRenderer, { instructions: tableInst })));
}

function stubRows(rows: () => Record<string, string>[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify({ rows: rows() }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("TableBlock row-action disabledKey / cooldownKey", () => {
  it("disables the button when the disabledKey field is the string \"true\"", async () => {
    stubRows(() => [
      { id: "a", name: "Here", cannotTravel: "true", cooldownUntil: "" },
      { id: "b", name: "The Docks", cannotTravel: "false", cooldownUntil: "" },
    ]);
    mount();
    const buttons = await screen.findAllByRole("button", { name: "Travel" });
    expect(buttons).toHaveLength(2);
    // Row order is the server's; the blocked row is first.
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it("replaces the label with a live countdown while the cooldownKey is in the future", async () => {
    stubRows(() => [
      { id: "a", name: "The Docks", cannotTravel: "", cooldownUntil: new Date(Date.now() + 90_000).toISOString() },
    ]);
    mount();
    const button = await screen.findByRole("button", { name: "1m 30s" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Travel" })).toBeNull();
  });

  it("refetches the table once when a live row-action cooldown reaches zero", async () => {
    let settled = false;
    const mock = stubRows(() =>
      settled
        ? [{ id: "a", name: "The Docks", cannotTravel: "", cooldownUntil: "" }]
        : [{ id: "a", name: "The Docks", cannotTravel: "", cooldownUntil: new Date(Date.now() + 1_100).toISOString() }]);
    mount();
    await waitFor(() => { expect(mock).toHaveBeenCalledTimes(1); });
    settled = true;
    await waitFor(() => { expect(mock).toHaveBeenCalledTimes(2); }, { timeout: 4000 });
    await waitFor(() => { expect(screen.getByRole("button", { name: "Travel" })).toBeTruthy(); });
  });

  it("renders exactly as before when neither key is declared", async () => {
    stubRows(() => [{ id: "a", name: "The Docks" }]);
    render(createElement(MemoryRouter, null, createElement(PageRenderer, {
      instructions: [{
        kind: "table", source: "GET /api/travel/destinations",
        columns: [{ key: "name", label: "Name", render: null, imageSize: "sm" }],
        rowActions: [{
          label: "Travel", action: "POST /api/travel/:id", confirm: null,
          disabledKey: null, cooldownKey: null,
        }],
      }] satisfies RenderInstruction[],
    })));
    const button = await screen.findByRole("button", { name: "Travel" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
