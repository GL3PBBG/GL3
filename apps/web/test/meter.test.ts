// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureClient, resetClientConfigForTests } from "@gl3/client";
import { Meter } from "../src/components/Meter.js";
import { KeyValueSourceBlock, MeterSourceBlock } from "../src/plugins/PageRenderer.js";

afterEach(() => { cleanup(); resetClientConfigForTests(); });
beforeEach(() => {
  vi.unstubAllGlobals();
  configureClient({
    baseUrl: "", wsUrl: "ws://test/ws",
    tokenStore: { get: () => null, set: () => {}, clear: () => {} },
    onGate: () => {},
  });
});

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("Meter", () => {
  it("renders label and proportional fill", () => {
    render(createElement(Meter, { label: "Energy", value: 6, max: 12 }));
    expect(screen.getByText("Energy")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("6");
    expect(bar.getAttribute("aria-valuemax")).toBe("12");
  });
});

describe("MeterSourceBlock", () => {
  it("reads valueKey/maxKey from the source and renders a progressbar", async () => {
    stubFetch(200, { values: { energy: "6", energyMax: "12" } });
    render(createElement(MeterSourceBlock, {
      label: "Energy", source: "GET /api/gym/pools", valueKey: "energy", maxKey: "energyMax", refetchSignal: 0,
    }));
    await waitFor(() => {
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("6");
    });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("12");
  });

  it("shows ErrorText on a non-404 failure", async () => {
    stubFetch(500, { error: "boom" });
    render(createElement(MeterSourceBlock, {
      label: "Energy", source: "GET /api/gym/pools", valueKey: "energy", maxKey: "energyMax", refetchSignal: 0,
    }));
    await waitFor(() => { expect(screen.getByRole("alert")).toBeTruthy(); });
  });
});

describe("KeyValueSourceBlock", () => {
  it("renders emptyText when no entry key is present", async () => {
    stubFetch(200, { values: {} });
    render(createElement(KeyValueSourceBlock, {
      source: "GET /api/jobs/board", entries: [{ label: "Rank", key: "rankName" }],
      emptyText: "Unemployed", refetchSignal: 0,
    }));
    expect(await screen.findByText("Unemployed")).toBeTruthy();
  });

  it("renders emptyText on a 404, not ErrorText", async () => {
    stubFetch(404, { error: "not_found" });
    render(createElement(KeyValueSourceBlock, {
      source: "GET /api/jobs/board", entries: [{ label: "Rank", key: "rankName" }],
      emptyText: "Unemployed", refetchSignal: 0,
    }));
    expect(await screen.findByText("Unemployed")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders one row per entry whose key is present", async () => {
    stubFetch(200, { values: { rankName: "Foreman" } });
    render(createElement(KeyValueSourceBlock, {
      source: "GET /api/jobs/board",
      entries: [{ label: "Rank", key: "rankName" }, { label: "Wage", key: "wage" }],
      emptyText: "Unemployed", refetchSignal: 0,
    }));
    await waitFor(() => { expect(screen.getByText("Foreman")).toBeTruthy(); });
    expect(screen.queryByText("Unemployed")).toBeNull();
    // `wage` is absent from `values`, so only the present entry draws a row.
    expect(screen.queryByText("Wage")).toBeNull();
  });
});
