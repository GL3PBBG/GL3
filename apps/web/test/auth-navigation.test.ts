// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureClient, keys, useDeleteAccount, useLogout, useMe } from "@gl3/client";
import { Outlet, useNavigate } from "react-router-dom";
import { App } from "../src/App.js";

vi.mock("@gl3/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@gl3/client")>(),
  useGameEvents: vi.fn(),
}));
vi.mock("../src/components/BrandMark.js", () => ({ BrandMark: () => null }));
vi.mock("../src/components/Shell.js", () => ({
  Shell: () => {
    const logout = useLogout();
    return createElement("main", null,
      createElement("button", { onClick: () => logout.mutate() }, "Log out"),
      createElement(Outlet));
  },
}));
vi.mock("../src/pages/Dashboard.js", () => ({
  Dashboard: () => createElement("p", null, `Playing as ${useMe().data?.username}`),
}));
vi.mock("../src/pages/Profile.js", () => ({
  Profile: () => {
    const navigate = useNavigate();
    const deletion = useDeleteAccount({
      onDeleted: () => navigate("/login", { state: { accountDeleted: true } }),
    });
    return createElement("button", { onClick: () => deletion.mutate({ password: "password" }) }, "Delete account");
  },
}));

let token: string | null;
let logoutFails: boolean;
let queryClient: QueryClient;
const player = {
  playerId: "01900000-0000-4000-8000-00000000000a", username: "Alice",
  cash: "10", bank: "0", points: "0", bullets: "0", exp: "0", grants: [], level: 0,
};

beforeEach(() => {
  token = "old-session";
  logoutFails = false;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  configureClient({
    baseUrl: "", wsUrl: "ws://localhost/ws", onGate: vi.fn(),
    tokenStore: { get: () => token, set: (value) => { token = value; }, clear: () => { token = null; } },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/me") {
      return token
        ? Response.json({ ...player, username: token === "old-session" ? "Alice" : "Bob" })
        : Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (url === "/api/auth/logout") {
      if (logoutFails) throw new Error("Network unavailable");
      return new Response(null, { status: 204 });
    }
    if (url === "/api/auth/delete") return new Response(null, { status: 204 });
    if (url === "/api/auth/login" || url === "/api/auth/register") {
      const body = JSON.parse(init?.body as string);
      if (body.password === "wrong") return Response.json({ error: "invalid_credentials" }, { status: 401 });
      return Response.json({ token: "new-session", playerId: player.playerId, username: "Bob" });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
});

function openApp(path: string) {
  window.history.replaceState(null, "", path);
  render(createElement(QueryClientProvider, { client: queryClient }, createElement(App)));
}

async function login(password = "password") {
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "Bob" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
}

describe("session navigation", () => {
  it.each([false, true])("logs out and immediately signs in without a refresh (network failure: %s)", async (failure) => {
    logoutFails = failure;
    openApp("/");
    await screen.findByText("Playing as Alice");
    queryClient.setQueryData(["private-player-data"], { secret: "Alice's data" });
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await screen.findByRole("button", { name: "Log in" });
    expect(window.location.pathname).toBe("/login");
    expect(token).toBeNull();
    expect(queryClient.getQueryData(["private-player-data"])).toBeUndefined();
    await login();
    await screen.findByText("Playing as Bob");
    expect(window.location.pathname).toBe("/");
  });

  it("redirects a signed-out deep link to login and enters the game after login", async () => {
    token = null;
    openApp("/bank");
    await screen.findByRole("button", { name: "Log in" });
    expect(window.location.pathname).toBe("/login");
    await login();
    await screen.findByText("Playing as Bob");
    expect(window.location.pathname).toBe("/");
  });

  it("enters the game after registration", async () => {
    token = null;
    openApp("/login");
    fireEvent.click(await screen.findByRole("button", { name: "Need an account?" }));
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "Bob" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "bob@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await screen.findByText("Playing as Bob");
    expect(window.location.pathname).toBe("/");
  });

  it("redirects an existing session away from login", async () => {
    openApp("/login");
    await screen.findByText("Playing as Alice");
    expect(window.location.pathname).toBe("/");
  });

  it("keeps failed login on the login page", async () => {
    token = null;
    openApp("/login");
    await login("wrong");
    await screen.findByText("Wrong username or password.");
    expect(window.location.pathname).toBe("/login");
    expect(token).toBeNull();
  });

  it("preserves the account-deleted notice and allows login afterward", async () => {
    openApp("/profile");
    fireEvent.click(await screen.findByRole("button", { name: "Delete account" }));
    await screen.findByText("Your account has been deleted.");
    expect(window.location.pathname).toBe("/login");
    await login();
    await screen.findByText("Playing as Bob");
  });

  it("discards an authenticated response that arrives after logout", async () => {
    openApp("/");
    await screen.findByText("Playing as Alice");
    let finishRequest!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRequest = resolve; }));
    let refetch!: Promise<void>;
    act(() => { refetch = queryClient.refetchQueries({ queryKey: keys.me() }); });
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await screen.findByRole("button", { name: "Log in" });
    await act(async () => {
      finishRequest(Response.json(player));
      await refetch;
    });
    await waitFor(() => expect(queryClient.getQueryData(keys.me())).toBeUndefined());
    expect(window.location.pathname).toBe("/login");
    await login();
    await screen.findByText("Playing as Bob");
  });
});
