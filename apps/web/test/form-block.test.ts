// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageRenderer } from "../src/plugins/PageRenderer.js";
import type { RenderInstruction } from "../src/plugins/render.js";

afterEach(cleanup);

const formInst = (valuesSource: string | null): RenderInstruction[] => [{
  kind: "form", action: "POST /api/admin/x/settings", submitLabel: "Save",
  valuesSource,
  fields: [
    { name: "cost", label: "Cost", type: "money" },
    { name: "mode", type: "hidden", value: "std" },
  ],
}];

function mount(instructions: RenderInstruction[]): void {
  render(createElement(MemoryRouter, null, createElement(PageRenderer, { instructions })));
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = handler(url, init);
    if (body instanceof Error) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe("FormBlock prefill", () => {
  it("seeds fields from valuesSource and never touches hidden fields", async () => {
    stubFetch(() => ({ values: { cost: "500", mode: "EVIL" } }));
    mount(formInst("GET /api/admin/x/settings"));
    await waitFor(() => {
      expect(screen.getByLabelText("Cost")).toHaveProperty("value", "500");
    });
    // hidden field renders nothing and submits its declared constant — no
    // input exists for it to have been seeded into.
    expect(screen.queryByDisplayValue("EVIL")).toBeNull();
  });

  it("renders blank without a valuesSource and fetches nothing", () => {
    const mock = stubFetch(() => ({ values: {} }));
    mount(formInst(null));
    expect(mock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Cost")).toHaveProperty("value", "");
  });

  it("degrades to blank on fetch failure and on shape mismatch", async () => {
    stubFetch(() => new Error("boom"));
    mount(formInst("GET /api/admin/x/settings"));
    await waitFor(() => { expect(screen.getByLabelText("Cost")).toHaveProperty("value", ""); });

    cleanup();
    stubFetch(() => ({ rows: [] })); // no `values` key
    mount(formInst("GET /api/admin/x/settings"));
    await waitFor(() => { expect(screen.getByLabelText("Cost")).toHaveProperty("value", ""); });
  });

  it("refetches after a successful submit and shows what the server stored", async () => {
    let stored = "500";
    stubFetch((url, init) => {
      if (init?.method === "POST") { stored = "750"; return {}; } // server clamps
      return { values: { cost: stored } };
    });
    mount(formInst("GET /api/admin/x/settings"));
    await waitFor(() => { expect(screen.getByLabelText("Cost")).toHaveProperty("value", "500"); });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => { expect(screen.getByLabelText("Cost")).toHaveProperty("value", "750"); });
  });
});
