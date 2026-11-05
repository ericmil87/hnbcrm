// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("themeLegacy", () => {
  it("src/index.css has no .light selector", () => {
    expect(read("src/index.css")).not.toMatch(/(^|[\s,}])\.light\b/m);
  });

  it("no file in src uses the [.light_&] variant", () => {
    const offenders = walk(join(root, "src"))
      .filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith("themeLegacy.test.ts"))
      .filter((f) => readFileSync(f, "utf8").includes("[.light_&]"));
    expect(offenders).toEqual([]);
  });

  it("tailwind.config.js has no darkMode", () => {
    expect(read("tailwind.config.js")).not.toContain("darkMode");
  });
});
