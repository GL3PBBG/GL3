import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("npm pack", () => {
  it("ships dist and only dist", () => {
    execFileSync("npm", ["run", "build"], { stdio: "pipe" });
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
    const [info] = JSON.parse(out) as { files: { path: string }[] }[];
    const paths = (info?.files ?? []).map((f) => f.path);
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("dist/index.d.ts");
    expect(paths.some((p) => p.startsWith("src/") || p.startsWith("test/"))).toBe(false);
  });
});
