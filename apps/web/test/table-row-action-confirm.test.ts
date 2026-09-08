// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  kind: "table", source: "GET /api/x/rows",
  columns: [{ key: "name", label: "Name", render: null, imageSize: "md" }],
  rowActions: [{ label: "Claim", action: "POST /api/x/claim/:id", confirm: "Spend the fee?" }],
}];

function mount(): void {
  render(createElement(MemoryRouter, null, createElement(PageRenderer, { instructions: tableInst })));
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.method === "POST" ? {} : { rows: [{ id: "d1", name: "The Docks" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("TableBlock row-action confirm", () => {
  it("arms into a stacked question + Confirm/Cancel pair, and Cancel disarms without firing", async () => {
    const mock = stubFetch();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Claim" }));

    const question = screen.getByRole("alert");
    expect(question.textContent).toBe("Spend the fee?");
    const confirm = screen.getByRole("button", { name: "Confirm" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    // Question and buttons share one wrapper; the buttons share a second one
    // beneath it, so the pair never wraps apart from each other on a phone.
    const wrapper = question.parentElement;
    expect(wrapper).not.toBeNull();
    expect(confirm.parentElement).toBe(cancel.parentElement);
    expect(confirm.parentElement?.parentElement).toBe(wrapper);
    expect(wrapper?.className).toMatch(/confirm/);
    expect(confirm.parentElement?.className).toMatch(/actions/);

    fireEvent.click(cancel);
    await waitFor(() => { expect(screen.queryByRole("alert")).toBeNull(); });
    expect(screen.getByRole("button", { name: "Claim" })).toBeTruthy();
    expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("Confirm fires the resolved row action", async () => {
    const mock = stubFetch();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Claim" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(mock.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).endsWith("/api/x/claim/d1"))).toBe(true);
    });
  });
});
