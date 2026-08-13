import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { idMap } from "../../server/src/db/schema/index.js";
import type { Executor } from "./pg/types.js";

async function findMapping(exec: Executor, v2Table: string, v2Id: number) {
  const [row] = await exec.select().from(idMap).where(and(eq(idMap.v2Table, v2Table), eq(idMap.v2Id, v2Id)));
  return row ?? null;
}

/**
 * The single mechanism that makes the whole migration idempotent (SPEC
 * §1.1, §4.2 item 3): the same V2 row always resolves to the same GL3
 * uuid, on this run or any future re-run, because the mapping itself is
 * durable. `onConflictDoNothing` handles the case where a concurrent
 * writer raced us to the insert (not expected within one migration run,
 * which is single-threaded per phase, but cheap safety); the re-select
 * after it guarantees we always return the row that actually won, not
 * necessarily the uuid we generated.
 */
export async function getOrCreateV3Id(
  exec: Executor,
  v2Table: string,
  v2Id: number,
): Promise<{ v3Id: string; created: boolean }> {
  const existing = await findMapping(exec, v2Table, v2Id);
  if (existing) return { v3Id: existing.v3Id, created: false };

  const candidate = uuidv7();
  await exec.insert(idMap).values({ v2Table, v2Id, v3Id: candidate })
    .onConflictDoNothing({ target: [idMap.v2Table, idMap.v2Id] });

  const row = await findMapping(exec, v2Table, v2Id);
  if (!row) throw new Error(`id_map insert for ${v2Table}:${v2Id} did not persist`);
  return { v3Id: row.v3Id, created: row.v3Id === candidate };
}

export async function lookupV3Id(exec: Executor, v2Table: string, v2Id: number): Promise<string | null> {
  const row = await findMapping(exec, v2Table, v2Id);
  return row?.v3Id ?? null;
}
