import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared by global-setup.ts (which builds the template database once per
 * run) and isolated-db.setup.ts (which clones it once per test file). Both
 * need to agree on the same database name without any inter-process
 * communication — Vitest's `globalSetup` runs in the main process while
 * each test file may run in its own worker, so there is no `provide`/env
 * value to hand off. Hashing the migration files' own content instead of
 * using a fixed name means every process computes the identical name
 * independently, and — as a side effect — a schema change automatically
 * produces a new name: there is no fixed template to go stale, because a
 * changed migration set is simply never addressed by its old name again.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function collectFilesSorted(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFilesSorted(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

let cached: string | undefined;

export function templateDatabaseName(): string {
  if (cached) return cached;
  const hash = createHash("sha256");
  for (const file of collectFilesSorted(MIGRATIONS_FOLDER)) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(file));
  }
  cached = `gl3_tmpl_${hash.digest("hex").slice(0, 16)}`;
  return cached;
}

/** Swaps the path (database name) segment of a Postgres connection URL. */
export function withDatabaseName(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}
