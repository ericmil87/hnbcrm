// @vitest-environment node
/**
 * Guarda: o texto do beta grátis e a tabela antiga (Starter/Pro/Enterprise)
 * não podem voltar à landing nem à página de preços. Preços vêm de
 * `convex/lib/plans.ts`, nunca digitados no componente.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const BANNED = [
  "Beta Aberto",
  "Grátis no Beta",
  "100% Grátis",
  "Começar Grátis",
  "Criar Conta Grátis",
  "Sem limite de tempo",
  "R$ 97",
  "R$ 297",
  "R$97",
  "R$297",
  "Starter",
  "Enterprise",
];

function walk(rel: string): string[] {
  const abs = join(ROOT, rel);
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs).flatMap((name) => walk(join(rel, name)));
}

const FILES = [
  "src/components/LandingPage.tsx",
  "src/pages/PricingPage.tsx",
  ...walk("src/components/landing/pricing"),
].filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

describe("legacyCopyGuard", () => {
  it("encontra os arquivos a vigiar", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of FILES) {
    it(`${file} não tem o texto antigo de beta grátis ou da tabela antiga`, () => {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      const hits: string[] = [];
      lines.forEach((line, i) => {
        for (const term of BANNED) {
          if (line.includes(term)) hits.push(`${file}:${i + 1} — "${term}" voltou; use o catálogo e o texto novo de preços`);
        }
      });
      expect(hits).toEqual([]);
    });
  }
});
