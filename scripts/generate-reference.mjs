// Generates the manual's schema reference pages from @gl3/shared's zod
// schemas. Reads the BUILT package (packages/shared/dist) — run
// `npm run build -w @gl3/shared` first; `npm run docs:generate` does both.
//
// Output (all gitignored, regenerated on every docs build):
//   manual/reference/primitives.md
//   manual/reference/events.md
//   manual/reference/ws.md
//   manual/reference/dto/<module>.md            (one per packages/shared/src/dto file)
//   manual/.vitepress/reference-sidebar.gen.mts (imported by config.mts)
//
// The walker reads zod v3 `_def` internals directly rather than going through
// a JSON-Schema intermediate: the point is readable field tables with named
// primitives (`Money`, `Id`, `Timestamp`) kept as links, which a generic
// converter inlines away.

import { readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "packages/shared/dist");
const refDir = path.join(root, "manual/reference");

/** Filename → page title for the modules whose capitalized name reads badly. */
const TITLES = {
  ws: "WebSocket frames",
  oc: "Organized crime",
  primitives: "Primitives",
  events: "Game events",
  auth: "Auth",
  dto: null,
};

function titleFor(name) {
  if (TITLES[name] !== undefined) return TITLES[name];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// VitePress (github-slugger) heading slug, close enough for our ASCII names.
function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9 _-]/g, "").replace(/ /g, "-");
}

// ---------------------------------------------------------------------------
// Module discovery: import each shared module individually so exports group
// by source file. Module cache means the same schema instance appears in
// every module that re-exports it; first module in this list wins ownership.
// ---------------------------------------------------------------------------

const dtoFiles = (await readdir(path.join(distDir, "dto")))
  .filter((f) => f.endsWith(".js"))
  .sort();

const modules = [
  { name: "primitives", page: "/reference/primitives", file: "primitives.js" },
  { name: "events", page: "/reference/events", file: "events.js" },
  { name: "ws", page: "/reference/ws", file: "ws.js" },
  ...dtoFiles.map((f) => {
    const name = f.replace(/\.js$/, "");
    return { name, page: `/reference/dto/${name}`, file: `dto/${f}` };
  }),
];

for (const m of modules) {
  m.exports = await import(path.join(distDir, m.file));
}

// Registry: schema instance → { page, name, anchor }. First exporter owns it.
const registry = new Map();
for (const m of modules) {
  for (const [key, value] of Object.entries(m.exports)) {
    if (!key.endsWith("Schema") || !value?._def) continue;
    const name = key.replace(/Schema$/, "");
    if (!registry.has(value)) {
      registry.set(value, { page: m.page, name, anchor: slug(name), module: m.name });
    }
  }
}

function linkTo(entry, fromPage) {
  const href = entry.page === fromPage ? `#${entry.anchor}` : `${entry.page}#${entry.anchor}`;
  return `[${entry.name}](${href})`;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

function unwrap(s) {
  // Wrappers that carry no reader-facing meaning on their own.
  for (;;) {
    const d = s._def;
    if (d.typeName === "ZodEffects") s = d.schema;
    else if (d.typeName === "ZodBranded") s = d.type;
    else if (d.typeName === "ZodReadonly") s = d.innerType;
    else if (d.typeName === "ZodCatch") s = d.innerType;
    else if (d.typeName === "ZodPipeline") s = d.out;
    else return s;
  }
}

function stringNotes(checks = []) {
  const notes = [];
  for (const c of checks) {
    if (c.kind === "uuid") notes.push("uuid");
    else if (c.kind === "datetime") notes.push("ISO 8601");
    else if (c.kind === "email") notes.push("email");
    else if (c.kind === "regex") notes.push(`pattern \`${c.regex.source}\``);
    else if (c.kind === "min") notes.push(`min length ${c.value}`);
    else if (c.kind === "max") notes.push(`max length ${c.value}`);
  }
  return notes.length ? ` (${notes.join(", ")})` : "";
}

function numberNotes(checks = []) {
  const notes = [];
  for (const c of checks) {
    if (c.kind === "min") notes.push(`≥ ${c.value}`);
    else if (c.kind === "max") notes.push(`≤ ${c.value}`);
  }
  return notes.length ? ` (${notes.join(", ")})` : "";
}

/**
 * One-line type label for a field. Named schemas render as links; anonymous
 * objects render as a link to the auto-generated subsection the caller emits
 * via `pending`. `seen` breaks recursive schemas (ViewNode).
 */
function typeLabel(s, ctx) {
  const entry = registry.get(s);
  if (entry && s !== ctx.self) return linkTo(entry, ctx.page);
  if (ctx.seen.has(s)) return "_(recursive)_";
  ctx.seen.add(s);
  try {
    const d = s._def;
    switch (d.typeName) {
      case "ZodString":
        return "`string`" + stringNotes(d.checks);
      case "ZodNumber":
        return ((d.checks ?? []).some((c) => c.kind === "int") ? "`integer`" : "`number`") + numberNotes(d.checks);
      case "ZodBoolean":
        return "`boolean`";
      case "ZodBigInt":
        return "`bigint`";
      case "ZodDate":
        return "`Date`";
      case "ZodNull":
        return "`null`";
      case "ZodLiteral":
        return "`" + JSON.stringify(d.value) + "`";
      case "ZodEnum":
        return d.values.map((v) => "`" + JSON.stringify(v) + "`").join(" \\| ");
      case "ZodNativeEnum":
        return Object.values(d.values).filter((v) => typeof v === "string").map((v) => "`" + JSON.stringify(v) + "`").join(" \\| ");
      case "ZodOptional":
        return typeLabel(d.innerType, ctx) + " _(optional)_";
      case "ZodNullable":
        return typeLabel(d.innerType, ctx) + " _(nullable)_";
      case "ZodDefault":
        return typeLabel(d.innerType, ctx) + ` _(default \`${JSON.stringify(d.defaultValue())}\`)_`;
      case "ZodArray":
        return "array of " + typeLabel(d.type, ctx);
      case "ZodTuple":
        return "[" + d.items.map((i) => typeLabel(i, ctx)).join(", ") + "]";
      case "ZodRecord":
        return `record of ${typeLabel(d.keyType, ctx)} → ${typeLabel(d.valueType, ctx)}`;
      case "ZodUnion":
        return d.options.map((o) => typeLabel(o, ctx)).join(" \\| ");
      case "ZodDiscriminatedUnion":
        return `union on \`${d.discriminator}\` (${d.options.length} variants)`;
      case "ZodObject": {
        // Anonymous inline object: emit a subsection and link to it.
        const anchorName = ctx.nameFor(s);
        ctx.pending.push({ name: anchorName, schema: s });
        return `[${anchorName}](#${slug(anchorName)})`;
      }
      case "ZodLazy":
        return typeLabel(d.getter(), ctx);
      case "ZodEffects":
      case "ZodBranded":
      case "ZodReadonly":
      case "ZodCatch":
      case "ZodPipeline":
        return typeLabel(unwrap(s), ctx);
      case "ZodAny":
        return "`any`";
      case "ZodUnknown":
        return "`unknown`";
      case "ZodVoid":
      case "ZodUndefined":
        return "`undefined`";
      case "ZodNever":
        return "`never`";
      default:
        return "`" + d.typeName.replace(/^Zod/, "").toLowerCase() + "`";
    }
  } finally {
    ctx.seen.delete(s);
  }
}

/** Field table for a ZodObject (already unwrapped). */
function objectTable(s, ctx) {
  const shape = s._def.shape();
  let md = "| Field | Type |\n| --- | --- |\n";
  for (const [field, fs] of Object.entries(shape)) {
    md += `| \`${field}\` | ${typeLabel(fs, ctx)} |\n`;
  }
  if (s._def.unknownKeys === "strict") md += "\nUnknown keys are rejected.\n";
  return md + "\n";
}

/**
 * Render one exported schema as a section. Handles objects, discriminated
 * unions (per-variant tables), and falls back to a type line for the rest.
 * `level` is the markdown heading depth for the section title.
 */
function renderSection(name, schema, page, level) {
  const h = "#".repeat(level);
  const ctx = { page, self: schema, seen: new Set(), pending: [], counter: 0, nameFor: null };
  ctx.nameFor = () => `${name}.${(ctx.counter += 1) > 1 ? `object${ctx.counter}` : "object"}`;

  let md = `${h} ${name}\n\n`;
  const s = unwrap(schema._def.typeName === "ZodLazy" ? schema._def.getter() : schema);
  const d = s._def;

  if (d.typeName === "ZodObject") {
    md += objectTable(s, ctx);
  } else if (d.typeName === "ZodDiscriminatedUnion") {
    md += `Discriminated union on \`${d.discriminator}\`.\n\n`;
    for (const variant of d.options) {
      const v = unwrap(variant);
      const disc = v._def.shape()[d.discriminator];
      const label = disc?._def?.typeName === "ZodLiteral" ? String(disc._def.value) : "(variant)";
      md += `${h}# \`${label}\`\n\n`;
      md += objectTable(v, { ...ctx, nameFor: () => `${name}.${label}.object${(ctx.counter += 1)}` });
    }
  } else if (d.typeName === "ZodUnion") {
    md += "One of:\n\n";
    for (const o of d.options) md += `- ${typeLabel(o, ctx)}\n`;
    md += "\n";
  } else {
    md += `Type: ${typeLabel(schema, ctx)}\n\n`;
  }

  // Anonymous inline objects referenced from tables above.
  while (ctx.pending.length > 0) {
    const { name: subName, schema: sub } = ctx.pending.shift();
    md += `${h}# ${subName}\n\n`;
    md += objectTable(sub, ctx);
  }
  return md;
}

// ---------------------------------------------------------------------------
// Page emission
// ---------------------------------------------------------------------------

await rm(path.join(refDir, "dto"), { recursive: true, force: true });
await mkdir(path.join(refDir, "dto"), { recursive: true });

const sidebarDto = [];
const sidebarTop = [];

for (const m of modules) {
  const owned = [...registry.values()].filter((e) => e.module === m.name);
  if (owned.length === 0) continue;

  const title = titleFor(m.name);
  let md = `---\ntitle: ${title}\n---\n\n# ${title}\n\n`;
  md += `> Generated from \`@gl3/shared\` (\`packages/shared/src/${m.file.replace(/\.js$/, ".ts")}\`) — do not edit by hand.\n\n`;

  if (m.name === "events") {
    // GameEventSchema dominates this page; render it per-variant with the
    // event type as the section heading, then everything else.
    const game = m.exports.GameEventSchema;
    const rest = owned.filter((e) => e.name !== "GameEvent");
    md += `## GameEvent\n\nDiscriminated union on \`type\` — ${game._def.options.length} variants. Every variant carries the base fields (\`id\`, \`at\`, \`actorId\`, \`actorName\`, \`audience\`).\n\n`;
    for (const variant of game._def.options) {
      const v = unwrap(variant);
      const label = v._def.shape().type._def.value;
      md += `### \`${label}\`\n\n`;
      md += objectTable(v, { page: m.page, seen: new Set(), pending: [], counter: 0, nameFor: () => `${label}.object` });
    }
    for (const e of rest) {
      const schema = m.exports[e.name + "Schema"];
      md += renderSection(e.name, schema, m.page, 2);
    }
  } else {
    for (const e of owned) {
      const schema = m.exports[e.name + "Schema"];
      md += renderSection(e.name, schema, m.page, 2);
    }
  }

  const outPath = m.page.replace("/reference/", "") + ".md";
  await writeFile(path.join(refDir, outPath), md);

  const item = { text: title, link: m.page };
  if (m.page.includes("/dto/")) sidebarDto.push(item);
  else sidebarTop.push(item);
}

// ---------------------------------------------------------------------------
// Sidebar module for config.mts
// ---------------------------------------------------------------------------

const sidebar = [
  ...sidebarTop,
  { text: "DTOs", collapsed: true, items: sidebarDto },
];
const sidebarSrc =
  "// Generated by scripts/generate-reference.mjs — do not edit.\n" +
  `export const generatedReferenceSidebar = ${JSON.stringify(sidebar, null, 2)}\n`;
await writeFile(path.join(root, "manual/.vitepress/reference-sidebar.gen.mts"), sidebarSrc);

console.log(
  `generated ${sidebarTop.length + sidebarDto.length} reference pages from ${registry.size} schemas`,
);
