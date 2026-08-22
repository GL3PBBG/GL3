import { describe, expect, it } from "vitest";
import {
  FormValuesResponseSchema,
  TableRowsResponseSchema,
  ViewNodeDtoSchema,
} from "../src/index.js";

describe("form prefill wire schemas", () => {
  it("form accepts an optional GET-shaped valuesSource and rejects a POST one", () => {
    const base = {
      kind: "form", action: "POST /api/admin/fixer/settings", submitLabel: "Save",
      fields: [{ name: "pool_size", label: "Offers per town", type: "text" }],
    };
    expect(ViewNodeDtoSchema.safeParse(base).success).toBe(true);
    expect(ViewNodeDtoSchema.safeParse({ ...base, valuesSource: "GET /api/admin/fixer/settings" }).success).toBe(true);
    expect(ViewNodeDtoSchema.safeParse({ ...base, valuesSource: "POST /api/admin/fixer/settings" }).success).toBe(false);
  });

  it("TableRowsResponse tolerates values riding alongside rows", () => {
    const body = { rows: [{ key: "cost", label: "Cost", value: "500" }], values: { cost: "500" } };
    expect(TableRowsResponseSchema.safeParse(body).success).toBe(true);
    expect(TableRowsResponseSchema.safeParse({ rows: [] }).success).toBe(true);
    expect(TableRowsResponseSchema.safeParse({ rows: [], values: { a: 1 } }).success).toBe(false);
  });

  it("FormValuesResponse requires values and tolerates rows alongside", () => {
    expect(FormValuesResponseSchema.safeParse({ values: { a: "1" }, rows: [] }).success).toBe(true);
    expect(FormValuesResponseSchema.safeParse({ rows: [] }).success).toBe(false);
  });
});
