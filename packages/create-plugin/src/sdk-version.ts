import { spawnSync } from "node:child_process";

export const SDK_PACKAGE = "@gl3/plugin-sdk";
export const REGISTRY_URL = "https://npm.gl3.dev";

/**
 * Fallback peer range when the registry cannot be reached. Restamp this from
 * `npm view @gl3/plugin-sdk version --registry=https://npm.gl3.dev` before a
 * publish of this package; the live lookup is what authors normally get.
 */
export const BAKED_SDK_RANGE = "^1.0.6";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `"1.0.6"` → `"^1.0.6"`. Anything that is not bare `x.y.z` → `null`. */
export function rangeFromVersion(version: string): string | null {
  const trimmed = version.trim();
  return SEMVER.test(trimmed) ? `^${trimmed}` : null;
}

/**
 * The published SDK version, via `npm view`. Never throws: any failure —
 * offline, 404, timeout, no npm on PATH — is `null` and the caller falls back.
 */
export function lookupRegistryVersion(registry: string = REGISTRY_URL, timeoutMs = 10_000): string | null {
  const res = spawnSync("npm", ["view", SDK_PACKAGE, "version", `--registry=${registry}`], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

export interface ResolveSdkRangeOptions {
  /** `--sdk <range>`: used verbatim. */
  override?: string | undefined;
  lookup?: () => string | null;
  warn?: (message: string) => void;
}

export function resolveSdkRange(opts: ResolveSdkRangeOptions = {}): string {
  if (opts.override !== undefined && opts.override !== "") return opts.override;
  const lookup = opts.lookup ?? (() => lookupRegistryVersion());
  const found = lookup();
  const range = found === null ? null : rangeFromVersion(found);
  if (range !== null) return range;
  (opts.warn ?? ((m) => console.warn(m)))(
    `warning: could not read ${SDK_PACKAGE}'s version from ${REGISTRY_URL}; ` +
      `pinning peerDependencies to the baked ${BAKED_SDK_RANGE}. Pass --sdk <range> to override.`,
  );
  return BAKED_SDK_RANGE;
}
