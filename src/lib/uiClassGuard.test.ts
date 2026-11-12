// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guarda de classes de UI: (1) texto abaixo de 12 px (`text-[9|10|11px]`) só nas pré-visualizações
 * que imitam terceiros; o resto usa `text-caption` (12 px) ou `text-micro` (11 px, só em selos);
 * (2) altura de viewport em layout/ui/main sempre com o par `dvh` na mesma linha.
 */
const SRC = resolve(__dirname, "..");
const SMALL_TEXT = /text-\[(?:9|10|11)px\]/;
const VIEWPORT = /h-screen|min-h-screen|100vh/;

const SMALL_TEXT_ALLOWLIST = ["components/campaigns/WhatsAppPreview.tsx", "components/forms/renderer/"];
const VIEWPORT_SCOPE = ["components/layout/", "components/ui/", "main.tsx", "appRoutes.tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((f) => ({ rel: relative(SRC, f).split(sep).join("/"), full: f }));

function offenders(test: (rel: string) => boolean, re: RegExp, skipLine?: (l: string) => boolean) {
  const found: string[] = [];
  for (const { rel, full } of files) {
    if (!test(rel)) continue;
    readFileSync(full, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (re.test(line) && !skipLine?.(line)) found.push(`${rel}:${i + 1} — ${line.trim().slice(0, 100)}`);
      });
  }
  return found;
}

describe("uiClassGuard", () => {
  it("não usa text-[9|10|11px] fora da allowlist (use text-caption ou text-micro)", () => {
    const found = offenders(
      (rel) => rel.startsWith("components/") && !SMALL_TEXT_ALLOWLIST.some((a) => rel.startsWith(a)),
      SMALL_TEXT,
    );
    expect(found).toEqual([]);
  });

  it("altura de viewport em layout/ui/main sempre acompanhada de dvh", () => {
    const found = offenders((rel) => VIEWPORT_SCOPE.some((s) => rel.startsWith(s)), VIEWPORT, (l) => l.includes("dvh"));
    expect(found).toEqual([]);
  });
});
