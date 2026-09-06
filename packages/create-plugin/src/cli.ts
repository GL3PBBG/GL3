import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { isValidPluginId, loadTemplates, render } from "./scaffold.js";
import { resolveSdkRange } from "./sdk-version.js";
import { dirIsUsable, gitInit, npmInstall, writeFiles } from "./write.js";

export const USAGE = `Usage: create-plugin <id> [dir] [--no-install] [--sdk <range>]

  <id>          plugin id: lowercase kebab-case, 2-32 chars (/^[a-z][a-z0-9-]*$/)
                becomes @gl3-plugins/<id>, p_<id>_*, /api/<id>, /api/admin/<id>
  [dir]         target directory (default: gl3-plugin-<id>); must be absent or empty
  --no-install  write files and git init, skip npm install
  --sdk <range> peerDependencies range for @gl3/plugin-sdk (default: read from npm.gl3.dev)
`;

export interface CliOptions {
  id: string;
  dir: string;
  install: boolean;
  sdk?: string | undefined;
}

export type ParsedArgs = { ok: true; opts: CliOptions } | { ok: false; message: string };

export function parseCliArgs(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { install: { type: "boolean", default: true }, sdk: { type: "string" } },
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const [id, dir, ...rest] = parsed.positionals;
  if (id === undefined) return { ok: false, message: "missing <id>" };
  if (!isValidPluginId(id)) {
    return { ok: false, message: `invalid id "${id}": must be lowercase kebab-case, 2-32 chars, matching /^[a-z][a-z0-9-]*$/` };
  }
  if (rest.length > 0) return { ok: false, message: `unexpected argument "${rest[0]}"` };
  return {
    ok: true,
    opts: { id, dir: dir ?? `gl3-plugin-${id}`, install: parsed.values.install !== false, sdk: parsed.values.sdk },
  };
}

function nextSteps(id: string, dir: string): string {
  return `
Created @gl3-plugins/${id} in ./${dir}

  cd ${dir}
  createdb gl3_${id}_test                      # on the NATIVE postgres
  TEST_DATABASE_URL=postgres://gl3:gl3@localhost:5432/gl3_${id}_test npm test

Before publishing, boot the engine once against a spare database with
PLUGIN_DIR + PLUGIN_PACKAGES=@gl3-plugins/${id} — see README.md.
`;
}

// exit codes: 0 ok · 1 bad args / unusable dir · 2 npm install failed after files were written · 3 unexpected failure after validation
export async function main(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(`create-plugin: ${parsed.message}\n\n${USAGE}`);
    return 1;
  }
  const { id, dir, install, sdk } = parsed.opts;
  const target = resolve(process.cwd(), dir);
  if (!dirIsUsable(target)) {
    console.error(`create-plugin: ${dir} exists and is not an empty directory`);
    return 1;
  }
  try {
    const sdkRange = resolveSdkRange({ override: sdk, warn: (m) => console.error(m) });
    writeFiles(target, render(loadTemplates(), { id, sdkRange }));
    gitInit(target, (m) => console.error(m));
    if (install && !npmInstall(target)) {
      console.error(`create-plugin: files written to ${dir}, but \`npm install\` failed — fix the cause and run it again there.`);
      return 2;
    }
    console.log(nextSteps(id, dir));
    return 0;
  } catch (err) {
    console.error(
      `create-plugin: failed while scaffolding ${dir}: ${err instanceof Error ? err.message : String(err)} — the tree may be partial; remove it before retrying.`,
    );
    return 3;
  }
}

/** Run only when this module is the process entry point, not when `bin/create-plugin.js` imports it. */
const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntryPoint) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
