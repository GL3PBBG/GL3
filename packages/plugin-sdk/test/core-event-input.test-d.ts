import type { CoreEventInput, PluginTx } from "../src/index.js";
import { expectTypeOf } from "vitest";

/**
 * `CoreEventInput` is derived from `@gl3/shared`'s `GameEvent`, not restated,
 * so it cannot drift silently. What it CAN do is stop being a union minus the
 * right fields — these are the three properties that make it usable.
 */

// 1. `id` and `at` are core's to fill, and must not be askable of a plugin.
expectTypeOf<CoreEventInput>().not.toHaveProperty("id");
expectTypeOf<CoreEventInput>().not.toHaveProperty("at");

// 2. The envelope is excluded — `plugin.event` has its own input type.
type PluginEventVariant = Extract<CoreEventInput, { type: "plugin.event" }>;
expectTypeOf<PluginEventVariant>().toEqualTypeOf<never>();

// 3. A representative core variant is accepted whole, with `id`/`at` absent.
expectTypeOf<{
  type: "news.posted";
  actorId: string;
  actorName: string;
  audience: { kind: "global" };
  newsId: string;
  title: string;
}>().toMatchTypeOf<CoreEventInput>();

// 4. The method exists on the tx surface with the derived input type.
expectTypeOf<PluginTx["events"]["publishCore"]>()
  .parameters.toEqualTypeOf<[CoreEventInput]>();
