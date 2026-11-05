// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Convex só aceita v.string() ou v.id(...) como chave de v.record no push.
// tsc e convex-test não detectam; o deploy falha com "Records cannot have string literal keys".
const ROOT = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "_generated" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

describe("v.record keys", () => {
  it("usa apenas v.string() ou v.id(...) como chave", () => {
    const bad: string[] = [];
    for (const file of walk(ROOT)) {
      const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
      for (const m of text.matchAll(/v\.record\(\s*([^,]{0,80})/g)) {
        const key = m[1].trim();
        if (!(key.startsWith("v.string()") || key.startsWith("v.id("))) {
          bad.push(`${file.replace(ROOT, "convex")}: v.record(${key}, ...)`);
        }
      }
    }
    expect(
      bad,
      "Convex exige v.string() ou v.id(...) como chave de v.record (união de literais falha no push). Use v.object com as chaves fixas.\n" + bad.join("\n"),
    ).toEqual([]);
  });
});
