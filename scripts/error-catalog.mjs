// Extracts every refusal code the server can emit, for the generated
// error-code reference (scripts/generate-errors.mjs) and its drift guard
// (apps/server/test/error-catalog.test.ts). Pure fs + regex — no DB.
//
// Two throw shapes exist:
//   plugins:  new PluginError("code", status)
//   core:     reply.code(status).send({ error: "code" })  (and variants)
// Codes built from variables are invisible to this scan; none exist today,
// and the meanings-coverage guard fails loudly the day a literal one appears
// undocumented, which keeps the pressure on using literals.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const PLUGIN_THROW = /new PluginError\(\s*"([a-z0-9_]+)"\s*,\s*(\d{3})/g;
// A template-literal code (crimes' `insufficient_${pool}`) is cataloged as
// `prefix_<var>` — a family of codes, one per interpolated value.
const PLUGIN_THROW_TEMPLATE = /new PluginError\(\s*`([a-z0-9_]*)\$\{[^}]+\}([a-z0-9_]*)`\s*,\s*(\d{3})/g;
// `error: "x"` inside a send; the status is best-effort — captured only when
// `.code(NNN)` appears on the same statement (one line back is enough in
// practice; core routes chain `reply.code(NNN).send({ error: ... })`).
const CORE_ERROR = /error:\s*"([a-z0-9_]+)"/g;
const CORE_STATUS = /\.code\(\s*(\d{3})\s*\)[\s\S]{0,120}?error:\s*"([a-z0-9_]+)"/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "test") continue;
      yield* walk(p);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      yield p;
    }
  }
}

/**
 * Scan the tree and return Map<code, { statuses: Set<number>, owners: Set<string> }>.
 * `owner` is the plugin id for packages/plugins/<id>/..., "core" otherwise.
 */
export function collectErrorCodes(repoRoot) {
  const catalog = new Map();
  const add = (code, status, owner) => {
    let e = catalog.get(code);
    if (!e) catalog.set(code, (e = { statuses: new Set(), owners: new Set() }));
    if (status) e.statuses.add(Number(status));
    e.owners.add(owner);
  };

  const pluginsDir = path.join(repoRoot, "packages/plugins");
  for (const id of readdirSync(pluginsDir)) {
    const src = path.join(pluginsDir, id, "src");
    let files;
    try { files = [...walk(src)]; } catch { continue; }
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(PLUGIN_THROW)) add(m[1], m[2], id);
      for (const m of text.matchAll(PLUGIN_THROW_TEMPLATE)) add(`${m[1]}<var>${m[2]}`, m[3], id);
    }
  }

  const coreSrc = path.join(repoRoot, "apps/server/src");
  for (const f of walk(coreSrc)) {
    const text = readFileSync(f, "utf8");
    const statuses = new Map();
    for (const m of text.matchAll(CORE_STATUS)) statuses.set(m[2], m[1]);
    for (const m of text.matchAll(CORE_ERROR)) add(m[1], statuses.get(m[1]), "core");
  }

  return catalog;
}

/**
 * Both directions of drift between the catalog and the meanings map:
 * `missing` = codes in the source with no meaning ("owner:code" or bare
 * "code" key), `stale` = meaning keys matching no code in the source.
 */
export function checkCatalog(catalog, meanings) {
  const missing = [];
  const usedKeys = new Set();
  for (const [code, entry] of catalog) {
    let covered = false;
    for (const owner of entry.owners) {
      if (meanings[`${owner}:${code}`] !== undefined) { usedKeys.add(`${owner}:${code}`); covered = true; }
    }
    if (meanings[code] !== undefined) { usedKeys.add(code); covered = true; }
    if (!covered) missing.push(code);
  }
  const stale = Object.keys(meanings).filter((k) => !usedKeys.has(k));
  return { missing, stale };
}
