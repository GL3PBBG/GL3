# Plugin SDK — Web Renderer + Override Registry (M5 Stage 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web app consumes `GET /api/plugins` and renders plugin page schemas through one generic component, with an override registry so existing core pages keep their bespoke React.

**Architecture:** The server already serves a payload of `{ menu, pages, events }` from the loader. This plan adds the client half: a `usePlugins()` hook, a `PluginPage` generic renderer driven by the v1 view vocabulary, a page-id → override map, dynamic routing for plugin page paths, and wires the two `plugin.event` stubs (`describe()` in `EventFeed`, `invalidationKeys()` in `ws/invalidation.ts`) to the manifest metadata. The server side gains one small change: `/api/plugins` always registers with an empty payload when no plugins load.

**Tech Stack:** React 18.3, React Query 5 (`@tanstack/react-query`), React Router 7 (`react-router-dom`), zod 3, Vite 6. Web tests are pure-module only (no jsdom, no component rendering) — this plan adds no DOM environment; the manual walkthrough covers rendering.

## Global Constraints

Copied verbatim from the M5 design spec and CLAUDE.md. Every task implicitly includes these.

- **M5 changes no HTTP response** for existing endpoints — same paths, status codes, error strings, bodies. New endpoints (`/api/plugins`) and new client behavior are in scope; existing core responses are not.
- **The v1 view vocabulary is exactly ten node kinds and does not grow.** `panel`, `list`, `keyValue`, `form`, `button`, `cooldownButton`, `money`, `text`, `link`, `error`. A core page needing more gets a bespoke React override, not a bigger schema.
- **Every external boundary is zod-validated.** `GET /api/plugins` response is a new boundary — it must be parsed through a shared zod schema on the client, not trusted raw.
- **Money is `bigint` in TS and a decimal string on the wire.** The `money` view node's `value` is a decimal string; never parse it to a JS number.
- **No `any` in `packages/*`.** In `apps/web`, prefer `unknown` plus a zod parse or type guards over casts.
- **ESM only; relative imports carry a `.js` extension** despite `.ts` sources.
- **Web tests are pure functions only.** No jsdom, no component rendering. Test the pure modules (the renderer-as-data-transform, the describe-template engine, the invalidation map); do not mount React.
- **Run `npm run verify` locally before committing.** CI does not run the integration suite; the green check only exists on this machine.
- **Web manual walkthrough** (Vite dev + `node apps/web/serve.mjs` after `npm run build -w @gl3/web`) is the renderer's acceptance check, because there is no DOM test environment.

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/dto/plugins.ts` | Zod schemas for the `/api/plugins` response (`PluginsPayloadSchema`, `MenuItemSchema`, `PagePayloadSchema`, `EventMetaSchema`) + inferred types. Re-exported from `packages/shared/src/index.ts` (`export * from "./dto/plugins.js"`). |
| `apps/web/src/api/keys.ts` | Add `keys.plugins()` and `keys.pluginPage(pageId)`. |
| `apps/web/src/api/queries.ts` | Add `usePlugins()`. |
| `apps/web/src/plugins/overrides.ts` | The page-id → React component override map (empty in v1; documents the contract). |
| `apps/web/src/plugins/PageRenderer.tsx` | The generic component that renders a `ViewNode` tree. |
| `apps/web/src/plugins/PluginPage.tsx` | The route element: looks up the page by id, checks overrides, else renders via `PageRenderer`. |
| `apps/web/src/plugins/describe.ts` | `describePluginEvent(meta, payload)` — pure template engine over the manifest `describe` string + `payload` + `actorName`. |
| `apps/web/src/plugins/render.ts` | `renderNode(node, handlers)` — pure data-transform that flattens a view node into an intermediate render description. The testable core of `PageRenderer`. |
| `apps/web/src/App.tsx` | Add plugin routes: dynamic `/plugins/*` + a menu-driven registration. |
| `apps/web/src/components/Shell.tsx` | Render plugin menu entries from `usePlugins()`. |
| `apps/web/src/components/EventFeed.tsx` | Replace the `plugin.event` placeholder with the manifest `describe` template. |
| `apps/web/src/ws/invalidation.ts` | Map `plugin.event` to the manifest's `invalidates` key prefixes (signature widens to take the event metadata). |
| `apps/web/test/plugins-render.test.ts` | Pure tests for `render.ts`. |
| `apps/web/test/plugins-describe.test.ts` | Pure tests for `describe.ts`. |
| `apps/web/test/plugins-invalidation.test.ts` | Pure tests for the plugin-event invalidation map. |
| `apps/server/src/plugins/manifest-endpoint.ts` | `registerPluginsEndpoint` always registered (empty payload when no plugins). |
| `apps/server/test/plugin-manifest-endpoint.test.ts` | Add the 200-when-empty case. |

---

### Task 1: Shared DTO schemas for `/api/plugins`

**Files:**
- Create: `packages/shared/src/dto/plugins.ts`
- Modify: `packages/shared/src/index.ts` (add the re-export line), `packages/shared/test/` (DTO tests live alongside other shared tests)
- Test: `packages/shared/test/plugins-dto.test.ts`

**Interfaces:**
- Consumes: `PluginsPayload`, `MenuItem`, `PagePayload`, `EventMeta` interfaces and `ViewNode` (`apps/server/src/plugins/manifest-endpoint.ts` + `packages/plugin-sdk/src/pages.ts`). The DTO schemas must accept the exact shapes the server serializes.
- Produces: `PluginsPayloadSchema`, `MenuItemSchema`, `PagePayloadSchema`, `EventMetaSchema` and inferred types, exported from `@gl3/shared`.

- [ ] **Step 1: Write the failing test**

`packages/shared/test/plugins-dto.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { PluginsPayloadSchema } from "../src/dto/plugins.js";

describe("PluginsPayloadSchema", () => {
  it("accepts a well-formed payload with one page, menu entry and event", () => {
    const payload = {
      menu: [{ pageId: "hello.index", path: "/hello", label: "Hello", order: 90 }],
      pages: [{
        pluginId: "hello", id: "hello.index", path: "/hello",
        view: { kind: "panel", title: "Hello", children: [{ kind: "text", value: "Hi" }] },
      }],
      events: [{ pluginId: "hello", name: "greeted", describe: "{actorName} said hello", invalidates: ["hello"] }],
    };
    expect(PluginsPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("accepts an empty payload", () => {
    expect(PluginsPayloadSchema.parse({ menu: [], pages: [], events: [] }))
      .toEqual({ menu: [], pages: [], events: [] });
  });

  it("rejects a view node with an unknown kind", () => {
    const bad = {
      menu: [], events: [],
      pages: [{ pluginId: "hello", id: "hello.index", path: "/hello",
        view: { kind: "notARealKind", value: "x" } }],
    };
    expect(() => PluginsPayloadSchema.parse(bad)).toThrow();
  });

  it("rejects an order that is not an integer", () => {
    const bad = {
      pages: [], events: [],
      menu: [{ pageId: "x", path: "/x", label: "X", order: 1.5 }],
    };
    expect(() => PluginsPayloadSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/shared plugins-dto`
Expected: FAIL — cannot resolve `../src/dto/plugins.js`.

- [ ] **Step 3: Write `packages/shared/src/dto/plugins.ts`**

The `view` field is a recursive `ViewNode`. The SDK already defines `ViewNodeSchema` in `packages/plugin-sdk/src/pages.ts`, but `@gl3/shared` may not depend on `@gl3/plugin-sdk` (the dependency direction is server→SDK, and shared is the base layer). Recreate the same ten-kind schema here so the DTO is self-contained. It must accept exactly the shapes `PagePayload.view` serializes to (plain JSON objects).

```ts
import { z } from "zod";

const leafOptions = [
  z.object({ kind: z.literal("text"), value: z.string() }).strict(),
  z.object({ kind: z.literal("money"), value: z.string() }).strict(),
  z.object({ kind: z.literal("error"), value: z.string() }).strict(),
  z.object({ kind: z.literal("link"), label: z.string(), to: z.string() }).strict(),
  z.object({ kind: z.literal("button"), label: z.string(), action: z.string() }).strict(),
  z.object({
    kind: z.literal("cooldownButton"), label: z.string(), action: z.string(), cooldownAction: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("keyValue"),
    rows: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
  }).strict(),
  z.object({
    kind: z.literal("form"), action: z.string(), submitLabel: z.string(),
    fields: z.array(z.object({
      name: z.string(), label: z.string(),
      type: z.enum(["text", "number", "money", "password"]),
    }).strict()),
  }).strict(),
] as const;

export const ViewNodeDtoSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    ...leafOptions,
    z.object({
      kind: z.literal("panel"), title: z.string(), children: z.array(ViewNodeDtoSchema),
    }).strict(),
    z.object({ kind: z.literal("list"), items: z.array(ViewNodeDtoSchema) }).strict(),
  ]),
);

export const MenuItemSchema = z.object({
  pageId: z.string().min(1), path: z.string().min(1),
  label: z.string().min(1), order: z.number().int(),
}).strict();

export const PagePayloadSchema = z.object({
  pluginId: z.string().min(1), id: z.string().min(1),
  path: z.string().min(1), view: ViewNodeDtoSchema,
}).strict();

export const EventMetaSchema = z.object({
  pluginId: z.string().min(1), name: z.string().min(1),
  describe: z.string().min(1), invalidates: z.array(z.string().min(1)),
}).strict();

export const PluginsPayloadSchema = z.object({
  menu: z.array(MenuItemSchema),
  pages: z.array(PagePayloadSchema),
  events: z.array(EventMetaSchema),
}).strict();

export type PluginsPayload = z.infer<typeof PluginsPayloadSchema>;
export type MenuItem = z.infer<typeof MenuItemSchema>;
export type PagePayload = z.infer<typeof PagePayloadSchema>;
export type EventMeta = z.infer<typeof EventMetaSchema>;
```

Note: `ViewNodeDtoSchema` is typed `z.ZodType<unknown>` because the recursive `z.lazy` cannot close its own inference loop — the constraint is "accepts the serialized tree," and the inferred type is not used on the client (the renderer works off `ViewNodeDto` = `z.infer`, which is `unknown` and narrowed per-kind at render time). If `z.infer` off the recursive schema errors under this project's TS config, keep the type as `unknown` and let the renderer narrow.

Re-export from `packages/shared/src/index.ts` by adding `export * from "./dto/plugins.js";` — this is the shared barrel; each DTO file (`dto/auth.js`, `dto/bank.js`, …) is already re-exported this way. There is no `dto/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/shared plugins-dto`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove the unknown-kind rejection can fail**

Change the `notARealKind` assertion to expect a valid kind and confirm the test goes red (it now parses something it should reject). Restore. Record the red output.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add packages/shared
git commit -m "$(cat <<'EOF'
feat(shared): add PluginsPayload zod schemas for the /api/plugins response

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `usePlugins()` hook + query keys

**Files:**
- Modify: `apps/web/src/api/keys.ts`, `apps/web/src/api/queries.ts`
- Test: none new (the hook is a thin fetch+parse; the schema is tested in Task 1)

**Interfaces:**
- Consumes: `PluginsPayloadSchema` (Task 1), `api()` (`apps/web/src/api/client.ts`), the existing `useQuery<T>` + `keys.*()` pattern.
- Produces: `keys.plugins()`, `usePlugins()`.

- [ ] **Step 1: Add the key factory**

In `apps/web/src/api/keys.ts`, add:
```ts
export const keys = {
  // ...existing entries...
  plugins: () => ["plugins"] as const,
};
```

- [ ] **Step 2: Add `usePlugins()`**

In `apps/web/src/api/queries.ts`, following the established pattern (explicit `useQuery<T>` generic, `Schema.parse(await api(...))` in the `queryFn`):
```ts
import { PluginsPayloadSchema, type PluginsPayload } from "@gl3/shared";

export function usePlugins() {
  return useQuery<PluginsPayload>({
    queryKey: keys.plugins(),
    queryFn: async () => PluginsPayloadSchema.parse(await api("/api/plugins")),
  });
}
```
Adjust the import path to match how `@gl3/shared` exports its DTOs (check how an existing hook imports a schema — e.g. `useCrimes` imports `CrimeListResponseSchema`).

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors. The hook compiles against the real schema and the existing `api()`/`useQuery` shape.

- [ ] **Step 4: Commit**

```bash
npm run verify
git add apps/web/src/api
git commit -m "$(cat <<'EOF'
feat(web): add usePlugins hook and plugins query key

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `describePluginEvent` — pure template engine

**Files:**
- Create: `apps/web/src/plugins/describe.ts`
- Test: `apps/web/test/plugins-describe.test.ts`

**Interfaces:**
- Consumes: the `describe` template string from `EventMeta` and a plugin event's `payload` + `actorName`.
- Produces: `describePluginEvent(template, values): string`.

- [ ] **Step 1: Write the failing test**

`apps/web/test/plugins-describe.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { describePluginEvent } from "../src/plugins/describe.js";

describe("describePluginEvent", () => {
  it("expands {placeholder} tokens from the values map", () => {
    expect(describePluginEvent("{actorName} said hello ({count})", {
      actorName: "Ron", count: "3",
    })).toBe("Ron said hello (3)");
  });

  it("leaves an unmatched placeholder literal so a manifest typo is visible", () => {
    expect(describePluginEvent("{actorName} {nope}", { actorName: "Ron" }))
      .toBe("Ron {nope}");
  });

  it("does not re-expand a value that itself contains braces", () => {
    // A player-named target "{target}" must not address other placeholders.
    expect(describePluginEvent("{actorName} -> {target}", {
      actorName: "Ron", target: "{count}",
    })).toBe("Ron -> {count}");
  });

  it("stringifies non-string values", () => {
    expect(describePluginEvent("got {n}", { n: 5 })).toBe("got 5");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/web plugins-describe`
Expected: FAIL — cannot resolve `../src/plugins/describe.js`.

- [ ] **Step 3: Implement**

`apps/web/src/plugins/describe.ts`:
```ts
/**
 * Single non-greedy pass over the template. One pass — rather than repeated
 * replacement — stops a payload value that itself contains braces from being
 * re-expanded, which would let a player-supplied string address other
 * placeholders. An unmatched placeholder stays literal so a manifest typo is
 * visible in the feed instead of rendering "undefined".
 *
 * Mirrors `renderDescribe` in the SDK (`@gl3/plugin-sdk/src/events.ts`) so the
 * client and any server-side preview agree.
 */
export function describePluginEvent(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/web plugins-describe`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove the brace-re-entry guard can fail**

Remove the single-pass guarantee by switching to a naive `values[key]` lookup that allows nested expansion (e.g. a `while` loop that re-runs). Confirm test 3 goes red. Restore. Record the red output.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add apps/web/src/plugins/describe.ts apps/web/test/plugins-describe.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add describePluginEvent template engine for plugin events

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `renderNode` — pure view-node-to-description transform

**Files:**
- Create: `apps/web/src/plugins/render.ts`
- Test: `apps/web/test/plugins-render.test.ts`

**Interfaces:**
- Consumes: `ViewNodeDto` (the `view` field of `PagePayload`, typed `unknown` from Task 1).
- Produces: `renderNode(node, handlers)` returning a flat list of render instructions that `PageRenderer` consumes. The handlers object maps action strings to callbacks (so the pure function does not touch the DOM or React).

The renderer is the testable core: `PageRenderer.tsx` (Task 6) is a thin React wrapper over this. Keeping the traversal pure is what lets it run under the no-jsdom web test project.

- [ ] **Step 1: Write the failing test**

`apps/web/test/plugins-render.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { renderNode, type RenderInstruction } from "../src/plugins/render.js";

describe("renderNode", () => {
  it("renders a leaf text node", () => {
    expect(renderNode({ kind: "text", value: "Hi" }, {})).toEqual<RenderInstruction[]>([
      { kind: "text", value: "Hi" },
    ]);
  });

  it("renders a button as a button instruction carrying its action", () => {
    expect(renderNode({ kind: "button", label: "Greet", action: "POST /api/hello/greet" }, {}))
      .toEqual<RenderInstruction[]>([{ kind: "button", label: "Greet", action: "POST /api/hello/greet" }]);
  });

  it("renders a panel by flattening its children in order", () => {
    const node = {
      kind: "panel" as const, title: "P",
      children: [{ kind: "text" as const, value: "a" }, { kind: "text" as const, value: "b" }],
    };
    const out = renderNode(node, {});
    expect(out).toHaveLength(3); // header + 2 children
    expect(out[0]).toEqual({ kind: "panelHeader", title: "P" });
    expect(out[1]).toEqual({ kind: "text", value: "a" });
    expect(out[2]).toEqual({ kind: "text", value: "b" });
  });

  it("renders a list by flattening its items in order with no separator", () => {
    const node = {
      kind: "list" as const,
      items: [{ kind: "money" as const, value: "100" }, { kind: "text" as const, value: "x" }],
    };
    expect(renderNode(node, {})).toEqual<RenderInstruction[]>([
      { kind: "money", value: "100" },
      { kind: "text", value: "x" },
    ]);
  });

  it("renders a money value as a money instruction, value untouched (decimal string)", () => {
    expect(renderNode({ kind: "money", value: "1000000000000" }, {}))
      .toEqual<RenderInstruction[]>([{ kind: "money", value: "1000000000000" }]);
  });

  it("renders a keyValue as one header + one row instruction per row", () => {
    const out = renderNode({ kind: "keyValue", rows: [{ label: "A", value: "1" }] }, {});
    expect(out).toEqual<RenderInstruction[]>([
      { kind: "keyValue", rows: [{ label: "A", value: "1" }] },
    ]);
  });

  it("renders a form with its fields and submit action", () => {
    const out = renderNode({
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      fields: [{ name: "amount", label: "Amount", type: "money" as const }],
    }, {});
    expect(out).toEqual<RenderInstruction[]>([{
      kind: "form", action: "POST /api/x", submitLabel: "Go",
      fields: [{ name: "amount", label: "Amount", type: "money" }],
    }]);
  });

  it("nests arbitrarily deep panels", () => {
    const node = {
      kind: "panel" as const, title: "outer",
      children: [{ kind: "panel" as const, title: "inner",
        children: [{ kind: "text" as const, value: "deep" }] }],
    };
    const out = renderNode(node, {});
    expect(out.some((i) => "value" in i && i.value === "deep")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/web plugins-render`
Expected: FAIL — cannot resolve `../src/plugins/render.js`.

- [ ] **Step 3: Implement `render.ts`**

```ts
/**
 * The flattened instruction set `PageRenderer` turns into React. Each leaf node
 * maps 1:1; `panel` emits a header instruction then its children; `list` emits
 * its items with no separator (the renderer applies spacing). Keeping this a
 * pure transform is what makes it testable without a DOM.
 */
export type RenderInstruction =
  | { kind: "text"; value: string }
  | { kind: "money"; value: string }
  | { kind: "error"; value: string }
  | { kind: "link"; label: string; to: string }
  | { kind: "button"; label: string; action: string }
  | { kind: "cooldownButton"; label: string; action: string; cooldownAction: string }
  | { kind: "keyValue"; rows: { label: string; value: string }[] }
  | { kind: "form"; action: string; submitLabel: string; fields: { name: string; label: string; type: "text" | "number" | "money" | "password" }[] }
  | { kind: "panelHeader"; title: string };

/** Narrow the `unknown` DTO node by `kind`. The DTO schema already rejected shapes the server never sends. */
function isNode(v: unknown, kind: string): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === kind;
}

export function renderNode(node: unknown, _handlers: Record<string, (action: string) => void>): RenderInstruction[] {
  if (isNode(node, "text")) return [{ kind: "text", value: String(node.value) }];
  if (isNode(node, "money")) return [{ kind: "money", value: String(node.value) }];
  if (isNode(node, "error")) return [{ kind: "error", value: String(node.value) }];
  if (isNode(node, "link")) return [{ kind: "link", label: String(node.label), to: String(node.to) }];
  if (isNode(node, "button")) return [{ kind: "button", label: String(node.label), action: String(node.action) }];
  if (isNode(node, "cooldownButton")) return [{ kind: "cooldownButton", label: String(node.label), action: String(node.action), cooldownAction: String(node.cooldownAction) }];
  if (isNode(node, "keyValue")) {
    const rows = Array.isArray(node.rows) ? node.rows.map((r) => ({ label: String((r as Record<string, unknown>).label), value: String((r as Record<string, unknown>).value) })) : [];
    return [{ kind: "keyValue", rows }];
  }
  if (isNode(node, "form")) {
    const fields = Array.isArray(node.fields) ? node.fields.map((f) => ({
      name: String((f as Record<string, unknown>).name),
      label: String((f as Record<string, unknown>).label),
      type: (f as Record<string, unknown>).type as "text" | "number" | "money" | "password",
    })) : [];
    return [{ kind: "form", action: String(node.action), submitLabel: String(node.submitLabel), fields }];
  }
  if (isNode(node, "panel")) {
    const out: RenderInstruction[] = [{ kind: "panelHeader", title: String(node.title) }];
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) out.push(...renderNode(child, _handlers));
    return out;
  }
  if (isNode(node, "list")) {
    const out: RenderInstruction[] = [];
    const items = Array.isArray(node.items) ? node.items : [];
    for (const item of items) out.push(...renderNode(item, _handlers));
    return out;
  }
  // Unreachable for validated payloads: the DTO schema already rejected it.
  return [];
}
```

The `_handlers` parameter is the seam `PageRenderer` will use to wire button/form actions to API calls; the pure transform ignores it but the signature keeps the renderer from needing a wrapper layer.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project @gl3/web plugins-render`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the ordering can fail**

Reverse the children-flatten order in the `panel` branch (emit children before the header). Confirm the panel test goes red (`out[0]` is no longer the header). Restore. Record the red output.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add apps/web/src/plugins/render.ts apps/web/test/plugins-render.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add renderNode view-node transform for the plugin page renderer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Plugin-event invalidation map

**Files:**
- Modify: `apps/web/src/ws/invalidation.ts`, `apps/web/test/invalidation.test.ts`
- Test: `apps/web/test/plugins-invalidation.test.ts` (or fold into the existing `invalidation.test.ts`)

**Interfaces:**
- Consumes: `invalidationKeys(event, viewerId)` (`apps/web/src/ws/invalidation.ts`), `EventMeta` (Task 1), `keys.*()`.
- Produces: `pluginInvalidationKeys(event, eventMetas)` returning the query-key prefixes the event's manifest declares.

The `plugin.event` case currently returns `[]`. The manifest's `invalidates` array is a list of *key prefixes* (strings like `"hello"`), not the full `keys.*()` tuples. The map needs the event metadata (from `usePlugins`) to resolve `pluginId + name` → `invalidates`.

- [ ] **Step 1: Write the failing test**

`apps/web/test/plugins-invalidation.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { pluginInvalidationKeys } from "../src/plugins/invalidation.js";
import type { EventMeta } from "@gl3/shared";

const metas: EventMeta[] = [{
  pluginId: "hello", name: "greeted",
  describe: "{actorName} said hello", invalidates: ["hello"],
}];

describe("pluginInvalidationKeys", () => {
  it("returns the declared prefixes for a matching plugin event", () => {
    const event = {
      type: "plugin.event" as const, id: "e1", at: "2026-01-01T00:00:00Z",
      actorId: "p1", actorName: "Ron", audience: { kind: "global" as const },
      pluginId: "hello", name: "greeted", payload: { count: "3" },
    };
    expect(pluginInvalidationKeys(event, metas)).toEqual([["plugins"], ["hello"]]);
  });

  it("returns only plugins() when the event has no matching metadata", () => {
    const event = {
      type: "plugin.event" as const, id: "e1", at: "2026-01-01T00:00:00Z",
      actorId: "p1", actorName: "Ron", audience: { kind: "global" as const },
      pluginId: "unknown", name: "x", payload: {},
    };
    expect(pluginInvalidationKeys(event, metas)).toEqual([["plugins"]]);
  });

  it("returns only plugins() when the metadata declares no invalidations", () => {
    const metasNone: EventMeta[] = [{ ...metas[0], invalidates: [] }];
    const event = {
      type: "plugin.event" as const, id: "e1", at: "2026-01-01T00:00:00Z",
      actorId: "p1", actorName: "Ron", audience: { kind: "global" as const },
      pluginId: "hello", name: "greeted", payload: {},
    };
    expect(pluginInvalidationKeys(event, metasNone)).toEqual([["plugins"]]);
  });
});
```

Note: every plugin event always invalidates `["plugins"]` (the menu/pages payload can change — a plugin may add a page or event after first boot). The declared prefixes are additional.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project @gl3/web plugins-invalidation`
Expected: FAIL — cannot resolve `../src/plugins/invalidation.js`.

- [ ] **Step 3: Implement**

`apps/web/src/plugins/invalidation.ts`:
```ts
import type { EventMeta } from "@gl3/shared";

type PluginEvent = {
  type: "plugin.event"; pluginId: string; name: string;
};

/**
 * Resolves a plugin event to the query-key prefixes its manifest declares, plus
 * `["plugins"]` (the payload can change as plugins boot). The declared entries
 * are bare prefix strings (`"hello"`), wrapped into single-element key tuples so
 * `queryClient.invalidateQueries({ queryKey: prefix })` matches any key starting
 * with them.
 */
export function pluginInvalidationKeys(
  event: PluginEvent, metas: readonly EventMeta[],
): readonly (readonly string[])[] {
  const meta = metas.find((m) => m.pluginId === event.pluginId && m.name === event.name);
  const declared = meta?.invalidates.map((p) => [p] as const) ?? [];
  return [["plugins"], ...declared];
}
```

Then update `ws/invalidation.ts`'s `plugin.event` case to call this. The challenge: `invalidationKeys(event, viewerId)` does not have the event metadata. Two options — pick based on what `useGameEvents` can provide:

**Option A (preferred):** widen `invalidationKeys` to accept an optional third arg `eventMetas?: readonly EventMeta[]`, defaulting to `[]`. The `plugin.event` case calls `pluginInvalidationKeys(event, eventMetas ?? [])`. `useGameEvents` passes the metas from `usePlugins().data?.events` (it already has access to the query client; read the cached `keys.plugins()` data or pass the hook result through).

**Option B:** keep `invalidationKeys` pure and have `useGameEvents` special-case `plugin.event` after calling `invalidationKeys`, overlaying the plugin invalidations. Less clean — the exhaustive switch stops being the single source.

Read `useGameEvents.ts` to confirm whether it can read `useQueryClient().getQueryData<PluginsPayload>(["plugins"])` synchronously in the message handler (it can — the client is in scope). If so, Option A with the metas read from cache in `useGameEvents`'s message handler is cleanest.

Update the existing `invalidation.test.ts` `plugin.event` case to expect `[["plugins"]]` when called with no metas (the default), so the existing suite stays green.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project @gl3/web plugins-invalidation invalidation`
Expected: PASS — new tests + existing invalidation suite green.

- [ ] **Step 5: Prove the prefix matching can fail**

Remove the `["plugins"]` unconditional entry. Confirm test 2 (no matching metadata) goes red. Restore. Record the red output.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add apps/web/src/plugins/invalidation.ts apps/web/src/ws/invalidation.ts apps/web/test
git commit -m "$(cat <<'EOF'
feat(web): map plugin.event to manifest-declared invalidation keys

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `PageRenderer` + `PluginPage` + override registry

**Files:**
- Create: `apps/web/src/plugins/overrides.ts`, `apps/web/src/plugins/PageRenderer.tsx`, `apps/web/src/plugins/PluginPage.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Shell.tsx`

**Interfaces:**
- Consumes: `usePlugins()` (Task 2), `renderNode` (Task 4), the existing `Panel`/`Loading`/`ErrorText` from `components/ui.tsx`, `api()` for button/form actions, `react-router-dom`'s `useParams`/`Navigate`.
- Produces: a rendered plugin page at its declared path; plugin menu entries in the nav; an override map (empty v1).

This task has no new pure tests — `renderNode` (Task 4) is the tested core; the React components are verified by the manual walkthrough (no jsdom environment exists). `npm run typecheck` is the gate.

- [ ] **Step 1: Write `overrides.ts`**

```ts
import type { ComponentType } from "react";

/**
 * Maps a plugin page id to a hand-written React component. Every existing core
 * page has (or will have) an override; a page id with no override renders
 * through the generic PageRenderer. A page with neither an override nor a
 * parseable schema renders a "no UI installed" panel.
 *
 * v1 ships this empty: the hello-plugin example and any third-party plugin use
 * the generic renderer. Core pages are not yet plugin pages (that is Stage 3).
 */
export const PAGE_OVERRIDES: ReadonlyMap<string, ComponentType> = new Map();
```

- [ ] **Step 2: Write `PageRenderer.tsx`**

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Panel, ErrorText } from "../components/ui.js";
import { renderNode, type RenderInstruction } from "./render.js";
import { api } from "../api/client.js";

/**
 * Renders a flat list of RenderInstructions. Button/form actions are POSTed via
 * `api()` (the actions are `"METHOD /path"` strings declared in the schema).
 */
export function PageRenderer({ instructions }: { instructions: readonly RenderInstruction[] }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});

  async function runAction(action: string, body?: Record<string, unknown>) {
    const [method, path] = action.split(" ");
    setError(null);
    try {
      await api(path, { method: method as "POST" | "PUT" | "DELETE", body });
    } catch (e) {
      setError(e instanceof Error ? e.message : "action failed");
    }
  }

  return (
    <>
      {error !== null && <ErrorText>{error}</ErrorText>}
      {instructions.map((inst, i) => {
        switch (inst.kind) {
          case "panelHeader": return <Panel key={i} title={inst.title}>{/* children follow as siblings */}</Panel>;
          // NOTE: panel children render as siblings after the header; the Panel
          // wrapper is opened here. See PluginPage for the grouping that keeps
          // a panel's children inside its <Panel>.
          case "text": return <p key={i}>{inst.value}</p>;
          case "money": return <p key={i}>{inst.value}</p>;
          case "error": return <ErrorText key={i}>{inst.value}</ErrorText>;
          case "link": return <button key={i} onClick={() => navigate(inst.to)}>{inst.label}</button>;
          case "button": return <button key={i} onClick={() => void runAction(inst.action)}>{inst.label}</button>;
          case "cooldownButton":
            // Full cooldown UX is deferred; v1 renders a plain button gated on
            // the same action. The CooldownButton component needs a ttl peek
            // that the schema does not yet carry.
            return <button key={i} onClick={() => void runAction(inst.action)}>{inst.label}</button>;
          case "keyValue":
            return (
              <dl key={i}>
                {inst.rows.map((r, j) => (<div key={j}><dt>{r.label}</dt><dd>{r.value}</dd></div>))}
              </dl>
            );
          case "form":
            return (
              <form key={i} onSubmit={async (e) => {
                e.preventDefault();
                await runAction(inst.action, formValues);
              }}>
                {inst.fields.map((f) => (
                  <label key={f.name}>{f.label}
                    <input name={f.name} type={f.type === "money" ? "text" : f.type}
                      value={formValues[f.name] ?? ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, [f.name]: e.target.value }))} />
                  </label>
                ))}
                <button type="submit">{inst.submitLabel}</button>
              </form>
            );
          default:
            // exhaustiveness: unreachable for validated nodes
            return null;
        }
      })}
    </>
  );
}
```

The panel-grouping note: `renderNode` flattens panels into `[header, ...children]`. A cleaner approach is to have `PluginPage` reconstruct the tree rather than flatten — if the flatten-then-group is awkward, revise `renderNode` (Task 4) to return a nested structure instead. Pick whichever is simpler to render correctly; the Task 4 tests must be updated to match if the shape changes.

- [ ] **Step 3: Write `PluginPage.tsx`**

```tsx
import { useParams } from "react-router-dom";
import { Panel, Loading, ErrorText } from "../components/ui.js";
import { usePlugins } from "../api/queries.js";
import { PAGE_OVERRIDES } from "./overrides.js";
import { renderNode } from "./render.js";
import { PageRenderer } from "./PageRenderer.js";

/**
 * The route element for any plugin page. Looks up the page by id in the
 * /api/plugins payload, prefers a hand-written override, else renders the view
 * schema generically.
 */
export function PluginPage() {
  const { pageId } = useParams();
  const plugins = usePlugins();

  if (plugins.isLoading) return <Loading />;
  if (plugins.isError) return <ErrorText>Failed to load plugins.</ErrorText>;

  const page = plugins.data?.pages.find((p) => p.id === pageId);
  if (page === undefined) {
    return <Panel title="Not found"><p>This plugin page does not exist.</p></Panel>;
  }

  const Override = PAGE_OVERRIDES.get(page.id);
  if (Override !== undefined) return <Override />;

  try {
    const instructions = renderNode(page.view, {});
    return <PageRenderer instructions={instructions} />;
  } catch {
    return <Panel title={page.id}><p>This plugin has no UI installed.</p></Panel>;
  }
}
```

- [ ] **Step 4: Wire routes in `App.tsx`**

The plugin pages declare their own `path` (e.g. `/hello`), not `/plugins/:pageId`. Two routing strategies:

**Strategy A (path-passthrough):** register a route per plugin page at its declared path. Requires `usePlugins()` to be called above the router (in `App`), then map `pages` to `<Route>` elements. Risk: collisions with existing core routes — the loader already validates plugin basePaths against `/api/auth`, `/api/ws`, etc., but page *frontend* paths are not validated against core *routes*. For v1 with only the hello-plugin (`/hello`), no collision exists.

**Strategy B (namespace):** all plugin pages under `/plugins/:pageId`, with the page's declared `path` used only for the nav link. Simpler routing, but the URL does not match the page's declared path.

Read `App.tsx`'s route block and the page paths the payload carries. If page paths are designed to be top-level (the hello-plugin declares `/hello`), use Strategy A and register dynamically. If there is any collision risk, use Strategy B. The spec says "a third-party plugin must add a working page without forking the web app" — Strategy B satisfies that with less risk. **Pick Strategy B for v1** (namespace under `/plugins/:pageId`), and document that page paths are advisory until a collision-free top-level registration is proven.

In `App.tsx`, inside the `<Route element={<Shell />}>` block:
```tsx
<Route path="plugins/:pageId" element={<PluginPage />} />
```
And import `PluginPage` statically (matching the existing direct-import style).

- [ ] **Step 5: Wire nav in `Shell.tsx`**

In `Shell.tsx`, the nav is a static `LINKS` array. Add plugin menu entries from `usePlugins()` below the core links:
```tsx
const plugins = usePlugins();
// after the existing LINKS map:
{plugins.data?.menu.map((entry) => (
  <NavLink key={entry.pageId} to={`/plugins/${entry.pageId}`}>{entry.label}</NavLink>
))}
```
The plugin entry's `path` is the page's declared path (`/hello`); nav links to `/plugins/<pageId>` (Strategy B). Keep the badge logic untouched.

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build -w @gl3/web`
Expected: Vite build succeeds.

- [ ] **Step 7: Commit**

```bash
npm run verify
git add apps/web/src/plugins apps/web/src/App.tsx apps/web/src/components/Shell.tsx
git commit -m "$(cat <<'EOF'
feat(web): add plugin page renderer, override registry, and nav entries

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wire `EventFeed` describe + always-register `/api/plugins`

**Files:**
- Modify: `apps/web/src/components/EventFeed.tsx`, `apps/server/src/plugins/manifest-endpoint.ts`, `apps/server/src/app.ts`
- Test: `apps/server/test/plugin-manifest-endpoint.test.ts`

**Interfaces:**
- Consumes: `describePluginEvent` (Task 3), `usePlugins()` (Task 2), `EventMeta`.
- Produces: `plugin.event` rendered with its manifest `describe` template; `/api/plugins` returns 200 with an empty payload when no plugins load.

- [ ] **Step 1: Always-register the endpoint (server)**

In `apps/server/src/app.ts`, the endpoint is currently registered only when `loaded !== undefined`. Move `registerPluginsEndpoint` out of the `if` so it always runs, passing an empty payload when no plugins:
```ts
  const loaded = deps.plugins;
  if (loaded !== undefined) {
    registerPluginRoutes(app, loaded.manifests, { db: deps.db, redis: deps.redis, queues: loaded.queues, settings: {} });
  }
  registerPluginsEndpoint(app, loaded?.payload ?? { menu: [], pages: [], events: [] });
```
This is the final-review recommendation #2 — a core-only client fetch gets a consistent 200, not 404.

- [ ] **Step 2: Write the failing test (server)**

Add to `apps/server/test/plugin-manifest-endpoint.test.ts`:
```ts
it("returns an empty 200 payload when no plugins are loaded", async () => {
  const { app } = await bootTestServer({ plugins: [] }); // or a variant that builds with no plugins
  const { token } = await registerAndLogin(app);
  const res = await app.inject({ method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ menu: [], pages: [], events: [] });
});
```
Read the existing test file to match its boot/auth helpers exactly (the brief may name helpers that don't exist — follow the crimes.test.ts inline-register pattern if `registerAndLogin` is absent).

- [ ] **Step 3: Wire `EventFeed.tsx` (client)**

In `EventFeed.tsx`, the `plugin.event` case currently returns a placeholder. Replace with the manifest template. The `describe()` function needs the event metadata — read it from `usePlugins()` inside the component (not inside the pure `describe` switch, which takes only the event). Two-part:

1. Keep the core `describe(event)` switch for the 19 core types.
2. In the component, if `event.type === "plugin.event"`, look up the metadata in `usePlugins().data?.events` and render via `describePluginEvent(meta.describe, { actorName: event.actorName, ...event.payload })`. If no metadata, fall back to the existing placeholder string.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project @gl3/server plugin-manifest-endpoint`
Expected: PASS including the new empty-payload case.

Run: `npm run verify`
Expected: full suite green.

- [ ] **Step 5: Prove the empty-payload test can fail**

Revert the `app.ts` change so the endpoint is gated again. Confirm the new test goes red (404). Restore. Record the red output.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add apps/server/src/app.ts apps/server/test/plugin-manifest-endpoint.test.ts apps/web/src/components/EventFeed.tsx
git commit -m "$(cat <<'EOF'
feat(plugins): always register /api/plugins and render plugin events via manifest describe

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Manual walkthrough + final verification

**Files:** none (verification only)

This is the acceptance gate for the renderer — there is no DOM test environment, so a manual check is the proof.

- [ ] **Step 1: Boot server with the hello plugin**

```bash
export DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3
export REDIS_URL=redis://localhost:6379
export PLUGIN_IDS=hello
npm run build -w @gl3/server
node apps/server/dist/index.js
```
Confirm: server boots, hello migration applies, `/api/plugins` registered.

- [ ] **Step 2: Boot web dev server**

```bash
npm run dev -w @gl3/web
```

- [ ] **Step 3: Walkthrough (two browser sessions if possible)**

1. Register/login. The nav shows a "Hello" entry (from the hello-plugin menu).
2. Click "Hello" → the page renders: a panel titled "Hello" with "Say hello to the server." text and a "Greet" button.
3. Click "Greet" → POST `/api/hello/greet` fires, returns `{ greetings: N }`.
4. The event feed shows "player said hello (N)" rendered via the manifest `describe` template (`{actorName} said hello ({count})`).
5. Open `/api/plugins` directly → returns 200 with the menu/pages/events payload.
6. Reload directly on the plugin page → it renders (no 404, no crash).

- [ ] **Step 4: Production build walkthrough**

```bash
npm run build -w @gl3/web
node apps/web/serve.mjs
```
Repeat the page render + greet. The built bundle serves the plugin page.

- [ ] **Step 5: Core-only (no plugins) walkthrough**

Unset `PLUGIN_IDS`, reboot server. `/api/plugins` returns `200 { menu: [], pages: [], events: [] }`. No plugin nav entries appear. Core pages render unchanged.

- [ ] **Step 6: Final verify**

```bash
npm run verify
```
Expected: full suite green (baseline + the new web pure-module tests).

- [ ] **Step 7: Commit any fixups, then the branch is ready for finishing**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test(plugins): manual walkthrough pass for plugin web renderer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the implementer

- **No jsdom.** Web tests are pure functions. Do not add a DOM environment or component-rendering tests; the manual walkthrough (Task 8) is the renderer's acceptance check. If a task feels like it needs a mounted-component test, extract the pure logic into a function and test that instead (the `renderNode`/`describePluginEvent` split is the model).
- **`registerAndLogin` / `jailPlayer` / `factories.ts` may not exist under those names.** Read `apps/server/test/crimes.test.ts` for how tests authenticate (inline `POST /api/auth/register` with a distinct `remoteAddress`) and jail a player (`db.update(playerStats).set({ jailedUntil: future })`). Reuse those patterns verbatim; do not invent new helpers.
- **The panel-flatten question (Task 6).** `renderNode` flattens panels to `[header, ...children]`. If reconstructing the panel grouping in React is awkward, change `renderNode` to return a nested tree and update the Task 4 tests to match. The shape serves the renderer, not the other way around.
- **Strategy B routing.** Plugin pages live under `/plugins/:pageId` for v1. The page's declared `path` is advisory (used in the payload, linked via pageId). Top-level path registration is deferred until collision-freedom is proven.
- **`apps/web/serve.mjs`** is the zero-dep static server the web container image runs. Validating against it (Task 8, Step 4) confirms the built bundle works outside Vite dev.
