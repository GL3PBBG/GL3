import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface TemplateFile {
  /** Path relative to the templates root, `/`-separated, dotfiles still `_`-prefixed. */
  path: string;
  content: string;
}

export interface RenderedFile {
  /** Path relative to the generated package root, `/`-separated. */
  path: string;
  content: string;
}

export interface RenderOptions {
  id: string;
  sdkRange: string;
}

/** `PLUGIN_ID_PATTERN` from the SDK, plus a length bound the SDK leaves to npm. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function isValidPluginId(id: string): boolean {
  return id.length >= 2 && id.length <= 32 && PLUGIN_ID_PATTERN.test(id) && !id.endsWith("-");
}

export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

/** Every path `render` produces, sorted. Extend when a template is added. */
export const GENERATED_FILES: readonly string[] = [
  ".gitignore",
  ".npmrc",
  "README.md",
  "package.json",
  "scripts/e2e-dynamic.md",
  "src/index.ts",
  "src/migrations.ts",
  "src/schema.ts",
  "test/helpers.ts",
  "test/manifest.test.ts",
  "test/pack.test.ts",
  "tsconfig.json",
  "vitest.config.ts",
];

/** npm strips `.gitignore` from tarballs, so dotfiles ship `_`-prefixed. */
const DOTFILE_RENAMES: Readonly<Record<string, string>> = {
  _npmrc: ".npmrc",
  _gitignore: ".gitignore",
};

const TOKENS = ["__ID__", "__SDK_RANGE__"] as const;

function walk(root: string, dir: string, out: TemplateFile[]): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(root, abs, out);
    else out.push({ path: relative(root, abs).split(sep).join("/"), content: readFileSync(abs, "utf8") });
  }
}

export function loadTemplates(dir: string = TEMPLATES_DIR): TemplateFile[] {
  const out: TemplateFile[] = [];
  walk(dir, dir, out);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function outputPath(templatePath: string): string {
  const parts = templatePath.split("/");
  const last = parts[parts.length - 1] ?? "";
  const renamed = DOTFILE_RENAMES[last];
  if (renamed !== undefined) parts[parts.length - 1] = renamed;
  return parts.join("/");
}

export function render(templates: readonly TemplateFile[], opts: RenderOptions): RenderedFile[] {
  const values: Record<(typeof TOKENS)[number], string> = {
    __ID__: opts.id,
    __SDK_RANGE__: opts.sdkRange,
  };
  return templates
    .map((t) => {
      let content = t.content;
      for (const token of TOKENS) content = content.split(token).join(values[token]);
      return { path: outputPath(t.path), content };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
