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
            actorName: "player",
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
  }],
  events: [{
    name: "greeted",
    payload: z.object({ count: z.string() }),
    describe: "{actorName} said hello ({count})",
    invalidates: ["hello"],
  }],
});
