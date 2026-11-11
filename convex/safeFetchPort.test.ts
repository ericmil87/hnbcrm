// @vitest-environment node
/**
 * Guard da busca segura (P2.2): destinos escolhidos por terceiros (agenda
 * externa, flyer, material do onboarding) só saem pelo `safeFetch`; o
 * extrator de PDF fica fixado e isolado no runtime Node.
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = __dirname;
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const isUseNode = (src: string) => /^\s*(\/\/[^\n]*\n|\s)*["']use node["'];/.test(src);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "_generated" || name === "__fixtures__" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.includes(".test")) out.push(full);
  }
  return out;
}

describe("porta única do safeFetch", () => {
  test("agenda externa, flyer e onboarding não chamam fetch() cru", () => {
    for (const rel of ["attendantAgenda.ts", "attendantAgendaFetch.ts", "onboardingExtract.ts"]) {
      const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code, rel).not.toMatch(/(^|[^.\w])fetch\s*\(/);
    }
    expect(read("attendantAgenda.ts")).toContain("internal.attendantAgendaFetch.internalFetchAgendaJson");
    expect(read("attendantAgenda.ts")).toContain("internal.attendantAgendaFetch.internalDownloadAgendaImage");
  });

  test("safeFetchNode e pdfExtract são \"use node\" e só arquivos \"use node\" os importam", () => {
    expect(isUseNode(read("lib/safeFetchNode.ts"))).toBe(true);
    expect(isUseNode(read("lib/pdfExtract.ts"))).toBe(true);
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      if (/from\s+["'][./]*(lib\/)?(safeFetchNode|pdfExtract)["']/.test(src) && !isUseNode(src)) {
        offenders.push(file.slice(root.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("o núcleo puro não importa Node (roda no runtime padrão)", () => {
    for (const rel of ["lib/safeFetch.ts", "lib/htmlExtract.ts", "lib/untrustedText.ts"]) {
      expect(read(rel), rel).not.toMatch(/from\s+["']node:/);
      expect(isUseNode(read(rel)), rel).toBe(false);
    }
  });

  test("unpdf fixado em versão exata e Node do deploy fixado", () => {
    const pkg = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"));
    expect(pkg.dependencies.unpdf).toBe("2.1.0");
    const cfg = JSON.parse(readFileSync(join(root, "..", "convex.json"), "utf8"));
    expect(cfg.node?.nodeVersion).toBe("24");
    expect(cfg.node?.externalPackages ?? []).not.toContain("unpdf");
  });
});
