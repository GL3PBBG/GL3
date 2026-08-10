import { uuidv7 } from "uuidv7";

/**
 * A time-ordered uuid, the id every table in this schema uses. Exposed here
 * because a plugin package may import only `@gl3/plugin-sdk`, `zod` and
 * `drizzle-orm` — it cannot reach `uuidv7` itself — and core tables have no
 * database-side default for `id`. Deliberately NOT `crypto.randomUUID()`:
 * that is v4, which has no time ordering, and mixing the two would make
 * `ORDER BY id` mean different things for different rows in one table.
 */
export function newId(): string {
  return uuidv7();
}
