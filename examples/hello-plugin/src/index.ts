import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { greetings } from "./schema.js";

export default definePlugin({
  id: "hello",
  version: "1.0.0",
  basePaths: ["/api/hello"],
  tables: { greetings: "p_hello_greetings" },
  migrations: [{
    name: "0001_init",
    sql: `CREATE TABLE p_hello_greetings (
            player_id uuid PRIMARY KEY,
            count integer NOT NULL DEFAULT 0,
            last_at timestamptz NOT NULL DEFAULT now()
          )`,
  }],
  routes: [
    route({
      method: "POST",
      path: "/api/hello/greet",
      accessInJail: false,
      handler: async (ctx) => {
        const player = ctx.player;
        if (player === null) throw new PluginError("unauthorized", 401);

        const count = await ctx.transaction(async (tx) => {
          const [row] = await tx.db
            .insert(greetings)
            .values({ playerId: player.id, count: 1 })
            .onConflictDoUpdate({
              target: greetings.playerId,
              set: { count: sql`${greetings.count} + 1`, lastAt: sql`now()` },
            })
            .returning({ count: greetings.count });
          const total = row?.count ?? 1;

          // Buffered — the loader publishes this after the transaction commits.
          await tx.events.publish({
            name: "greeted",
            actorId: player.id,
            actorName: player.username,
            audience: { kind: "global" },
            payload: { count: String(total) },
          });
          return total;
        });

        return { status: 200, body: { greetings: count } };
      },
    }),
  ],
  pages: [{
    id: "hello.index",
    path: "/hello",
    menu: { label: "Hello", order: 90 },
    view: {
      kind: "panel",
      title: "Hello",
      children: [
        { kind: "text", value: "Say hello to the server." },
        { kind: "button", label: "Greet", action: "POST /api/hello/greet" },
      ],
    },
  }, {
    /**
     * The renderer's reference page, and permanently so.
     *
     * There is no DOM test environment in this repo by design — the web tests
     * are pure functions over `renderNode`'s output, and the renderer's own
     * acceptance check is a human at a browser. `hello.index` above exercises
     * two of the nine instruction kinds, so a walkthrough of it alone leaves
     * seven never having rendered. This page exists so that a change to
     * `PageRenderer` can be eyeballed against a single page that uses the
     * whole vocabulary. Keep it exhaustive: if a kind or a grouping shape is
     * added to the view schema, add it here too.
     *
     * It is laid out to cover every panel-grouping shape as well as every
     * kind, because grouping is a function of *order*, not of nesting.
     * `renderNode` flattens `panel` to `[panelHeader, ...children]`, and
     * `groupIntoPanels` assigns everything after a header to that panel until
     * the next header — so a node's position decides which panel it lands in.
     * Hence, in order: a bare leading run (rendered at top level, before any
     * header), three consecutive panels, and a trailing panel with an empty
     * body.
     */
    id: "hello.allNodes",
    path: "/hello/nodes",
    menu: { label: "Hello: all nodes", order: 91 },
    view: {
      // `list` is the only non-panel container in the vocabulary; it emits its
      // items with no wrapper of its own, which is what lets the leading run
      // sit outside every panel.
      kind: "list",
      items: [
        // --- Leading run: no `panelHeader` precedes these, so they render
        // bare at top level. `error` in particular has to live here — placed
        // after a panel it would render inside it.
        { kind: "text", value: "Every render instruction the web renderer emits, on one page." },
        { kind: "error", value: "This is an `error` node, not a thrown error — the plugin's own copy." },
        {
          kind: "link",
          label: "Back to the Hello page",
          // The namespaced route, not this plugin's declared `path`. Under v1
          // routing every plugin page is served from `/plugins/:pageId` and the
          // declared `path` is advisory — linking to `/hello` would validate
          // fine here and land on the app's 404.
          to: "/plugins/hello.index",
        },

        // --- Panel 1 of 3 consecutive panels.
        {
          kind: "panel",
          title: "Leaves",
          children: [
            { kind: "text", value: "A `text` leaf." },
            // MoneySchema (`/^-?\d+$/`), never a decimal string: the renderer
            // hands this to formatMoney, which throws on anything else.
            { kind: "money", value: "1234567" },
            { kind: "money", value: "-2500" },
            {
              kind: "keyValue",
              rows: [
                { label: "Kind", value: "keyValue" },
                { label: "Renders as", value: "a definition list" },
              ],
            },
          ],
        },

        // --- Panel 2: the two action leaves, side by side so the plain
        // `button` and the v1 `cooldownButton` can be compared on screen.
        {
          kind: "panel",
          title: "Actions",
          children: [
            { kind: "button", label: "Greet (button)", action: "POST /api/hello/greet" },
            {
              kind: "cooldownButton",
              label: "Greet (cooldownButton)",
              action: "POST /api/hello/greet",
              // A bare cooldown key segment (COOLDOWN_ACTION_RE), not an HTTP
              // action: it is the middle segment of `cooldown:<action>:<id>`.
              // v1 renders this as a plain button — the manifest carries no
              // cooldown snapshot to seed a countdown from.
              cooldownAction: "hello_greet",
            },
          ],
        },

        // --- Panel 3: the form, which is the only node that sends a JSON
        // body — a bodyless `button` deliberately does not. `/api/hello/greet`
        // takes no body but ignores one, so it is a safe target. The fields
        // cover all four declared types; `money` is the interesting one, since
        // the renderer maps it to a *text* input rather than a number input.
        {
          kind: "panel",
          title: "Form",
          children: [
            {
              kind: "form",
              action: "POST /api/hello/greet",
              submitLabel: "Submit form",
              fields: [
                { name: "note", label: "Note (text)", type: "text" },
                { name: "times", label: "Times (number)", type: "number" },
                { name: "amount", label: "Amount (money)", type: "money" },
                { name: "secret", label: "Secret (password)", type: "password" },
              ],
            },
          ],
        },

        // --- Trailing panel with an empty body: the heading must still
        // render. `groupIntoPanels` drops only the *leading* empty run.
        { kind: "panel", title: "Empty panel (heading only)", children: [] },
      ],
    },
  }],
  events: [{
    name: "greeted",
    payload: z.object({ count: z.string() }),
    describe: "{actorName} said hello ({count})",
    invalidates: ["hello"],
  }],
});
