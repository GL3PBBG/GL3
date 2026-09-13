import { ViewNodeDtoSchema } from "@gl3/shared";
import { renderNode } from "@gl3/client";
import { checkoutDestination } from "../src/plugins/checkout.js";
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageRenderer } from "../src/plugins/PageRenderer.js";
import { configureClient, resetClientConfigForTests, type RenderInstruction } from "@gl3/client";

afterEach(() => { cleanup(); resetClientConfigForTests(); });
beforeEach(() => {
  configureClient({
    baseUrl: "", wsUrl: "ws://test/ws",
    tokenStore: { get: () => null, set: () => {}, clear: () => {} },
    onGate: () => {},
  });
});

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

describe("FormBlock numeric bounds", () => {
  it("passes a number field's min/max through to the input", () => {
    stubFetch(() => ({}));
    mount([{
      kind: "form", action: "POST /api/gym/train", submitLabel: "Train", valuesSource: null,
      fields: [{ name: "reps", label: "Reps", type: "number", min: 1, max: 1000 }],
    }]);
    const input = screen.getByLabelText("Reps") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.min).toBe("1");
    expect(input.max).toBe("1000");
  });

  it("leaves min/max unset on a number field that declares none", () => {
    stubFetch(() => ({}));
    mount([{
      kind: "form", action: "POST /api/x", submitLabel: "Go", valuesSource: null,
      fields: [{ name: "delta", label: "Delta", type: "number" }],
    }]);
    const input = screen.getByLabelText("Delta") as HTMLInputElement;
    expect(input.min).toBe("");
    expect(input.max).toBe("");
  });
});

describe("action success notifies the host", () => {
  // The Shell's chrome (pool bars, cash) reads app-level queries this
  // signal lets the host invalidate.
  it("calls onActionSuccess after a 2xx action", async () => {
    stubFetch(() => ({ ok: true }));
    const onActionSuccess = vi.fn();
    render(createElement(MemoryRouter, null, createElement(PageRenderer, {
      instructions: [{ kind: "button", label: "Train", action: "POST /api/gym/train" }],
      onActionSuccess,
    })));
    fireEvent.click(screen.getByRole("button", { name: "Train" }));
    await waitFor(() => { expect(onActionSuccess).toHaveBeenCalledTimes(1); });
  });

  it("does not call onActionSuccess when the action fails", async () => {
    stubFetch(() => new Error("boom"));
    const onActionSuccess = vi.fn();
    render(createElement(MemoryRouter, null, createElement(PageRenderer, {
      instructions: [{ kind: "button", label: "Train", action: "POST /api/gym/train" }],
      onActionSuccess,
    })));
    fireEvent.click(screen.getByRole("button", { name: "Train" }));
    await waitFor(() => { expect(screen.getByRole("alert")).toBeTruthy(); });
    expect(onActionSuccess).not.toHaveBeenCalled();
  });
});


describe("checkout destinations", () => {
  it("accepts hosted Stripe checkout and ignores normal action responses", () => {
    expect(checkoutDestination({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123#secret" })).toBe("https://checkout.stripe.com/c/pay/cs_test_123#secret");
    expect(checkoutDestination({ ok: true })).toBeNull();
  });
  it.each(["javascript:alert(1)", "https://checkout.stripe.com.evil.test/pay", "https://checkout.stripe.com@evil.test", "http://checkout.stripe.com/pay", "https://checkout.stripe.com:8443/pay", "https://user@checkout.stripe.com/pay"])("rejects %s", checkoutUrl => {
    expect(() => checkoutDestination({ checkoutUrl })).toThrow();
  });
});

describe("product list choices", () => {
  it("shows all products with optional crossed-out prices and submits the selected pack", async () => {
    const fetch = stubFetch((_url, init) => init?.method === "POST" ? { ok: true } : { rows: [
      { id: "small", name: "Starter", description: "100 points", price: "€5.00", original: "€9.99" },
      { id: "large", name: "Big pack", description: "500 points", price: "€20.00" },
    ] });
    mount(renderNode(ViewNodeDtoSchema.parse({ kind: "form", action: "POST /api/purchases", submitLabel: "Continue to checkout",
      fields: [{ name: "packId", label: "Points pack", type: "select", presentation: "list",
        optionsSource: "GET /api/packs", valueKey: "id", labelKey: "name", descriptionKey: "description",
        priceKey: "price", originalPriceKey: "original", allowEmpty: false, prefillForm: false }] }), {}));
    const choices = await screen.findAllByRole("radio");
    expect(choices).toHaveLength(2);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("€9.99").tagName).toBe("S");
    expect(screen.getByText("€5.00").tagName).toBe("STRONG");
    fireEvent.click(choices[1]!);
    fireEvent.click(screen.getByText("Continue to checkout"));
    await waitFor(() => { expect(fetch).toHaveBeenCalledWith("/api/purchases", expect.objectContaining({
      method: "POST", body: JSON.stringify({ packId: "large" }),
    })); });
  });
});
