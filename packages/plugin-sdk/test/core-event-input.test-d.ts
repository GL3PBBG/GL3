import type { GameEvent } from "@gl3/shared";
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

/**
 * 3. A representative core variant survives whole, with `id`/`at` absent —
 * and nothing else. `toMatchTypeOf` alone cannot tell a correctly-distributed
 * `CoreEventInput` from a regression to a plain, non-distributing `Omit`:
 * `Omit` over a union collapses to the union's common keys (`type` — widened
 * to the literal union of every variant's `type` — plus `actorId`,
 * `actorName`, `audience`), and a same-or-wider-property object still
 * structurally matches that collapsed type, because excess properties are
 * not checked in a generic assignability position. `toMatchTypeOf` from
 * assertion 3's original form would pass either way.
 *
 * Extracting a single variant closes the gap. Under the collapsed type,
 * `type` is a union of every variant's literal (not just `"news.posted"`),
 * which does not extend `{ type: "news.posted" }` — so
 * `Extract<CollapsedType, { type: "news.posted" }>` is `never`, and `never`
 * fails `toEqualTypeOf` against the real shape below. Compared against
 * `GameEvent`'s own `news.posted` variant (minus `id`/`at`) rather than a
 * hand-restated shape, so this assertion can't drift from the source either.
 */
type NewsPostedInput = Extract<CoreEventInput, { type: "news.posted" }>;
expectTypeOf<NewsPostedInput>().toEqualTypeOf<
  Omit<Extract<GameEvent, { type: "news.posted" }>, "id" | "at">
>();

// 4. The method exists on the tx surface with the derived input type.
expectTypeOf<PluginTx["events"]["publishCore"]>()
  .parameters.toEqualTypeOf<[CoreEventInput]>();
