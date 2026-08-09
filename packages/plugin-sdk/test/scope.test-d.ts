import type { PluginTx } from "../src/index.js";
import { expectTypeOf } from "vitest";

// The escape hatch the spec forbids: no raw handle, and no schema-bound query
// builder to reach `players` or `ledger` through.
expectTypeOf<PluginTx>().not.toHaveProperty("redis");
// @ts-expect-error — `query` is unreachable because PluginDbTx carries no schema.
type _NoQuery = PluginTx["db"]["query"];
