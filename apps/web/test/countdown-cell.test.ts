// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageRenderer } from "../src/plugins/PageRenderer.js";
import type { RenderInstruction } from "../src/plugins/render.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
beforeEach(() => { vi.unstubAllGlobals(); });

const tableInst = (): RenderInstruction[] => [{
  kind: "table", source: "GET /api/fixer/status",
  columns: [
    { key: "job", label: "Job", render: null, imageSize: "sm" },
    { key: "resolvesIn", label: "Resolves", render: "countdown", imageSize: "sm" },
  ],
  rowActions: [],
}];

function mount(): void {
  render(createElement(MemoryRouter, null, createElement(PageRenderer, { instructions: tableInst() })));
}

function stubRows(rows: () => Record<string, string>[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify({ rows: rows() }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("countdown table cell", () => {
  it("renders remaining time from an ISO timestamp and passes non-dates through", async () => {
    stubRows(() => [
      { job: "Package Run", resolvesIn: new Date(Date.now() + 90_000).toISOString() },
      { job: "Done job", resolvesIn: "—" },
    ]);
    mount();
    await waitFor(() => { expect(screen.getByText("1m 30s")).toBeTruthy(); });
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("refetches the table once when a live countdown reaches zero", async () => {
    // Real timers for mount (waitFor needs them), then a short deadline the
    // 1s interval crosses on its first tick.
    let settled = false;
    const mock = stubRows(() =>
      settled
        ? [{ job: "Package Run", resolvesIn: "—" }]
        : [{ job: "Package Run", resolvesIn: new Date(Date.now() + 1_100).toISOString() }]);
    mount();
    await waitFor(() => { expect(mock).toHaveBeenCalledTimes(1); });
    settled = true;
    // First interval tick (~1s) crosses the deadline and fires the refetch.
    await waitFor(() => { expect(mock).toHaveBeenCalledTimes(2); }, { timeout: 4000 });
    await waitFor(() => { expect(screen.getByText("—")).toBeTruthy(); });
  });

  it("never refetches for a deadline already past at mount", async () => {
    const mock = stubRows(() =>
      [{ job: "Stale row", resolvesIn: new Date(Date.now() - 5_000).toISOString() }]);
    mount();
    await waitFor(() => { expect(screen.getByText("due")).toBeTruthy(); });
    await new Promise((r) => setTimeout(r, 1500));
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
