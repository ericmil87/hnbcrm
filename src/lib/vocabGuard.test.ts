// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BANNED_UI_TERMS } from "./vocab";
import { extractButtonLabels, extractUiStrings, sentenceCaseViolations } from "./uiStrings";
import {
  ALLOWED_PATHS,
  ALLOWED_TERMS,
  MAX_ALLOWED_TERMS,
  PENDING_SCOPE,
  SENTENCE_CASE_SCOPE,
  matchesPath,
} from "./vocabGuard.allowlist";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSources(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const FILES = listSources(SRC).map((f) => relative(ROOT, f).split("\\").join("/"));
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

interface Hit { file: string; line: number; text: string; match: string; use: string }

function scan(file: string): Hit[] {
  const hits: Hit[] = [];
  for (const { text, line } of extractUiStrings(read(file))) {
    for (const { pattern, use } of BANNED_UI_TERMS) {
      const m = pattern.exec(text);
      if (m) hits.push({ file, line, text, match: m[0], use });
    }
  }
  return hits;
}

const isPathAllowed = (file: string) => ALLOWED_PATHS.some((p) => matchesPath(file, p));
const isTermAllowed = (h: Hit) =>
  ALLOWED_TERMS.some((a) => a.file === h.file && h.match.toLowerCase().includes(a.term.toLowerCase()));

describe("vocabGuard: termos banidos em texto visível", () => {
  const all = FILES.filter((f) => !isPathAllowed(f)).flatMap(scan).filter((h) => !isTermAllowed(h));
  const pending = new Set(PENDING_SCOPE);
  const inScope = all.filter((h) => !pending.has(h.file));
  const deferred = all.filter((h) => pending.has(h.file));

  it("nenhum termo banido fora da allowlist", () => {
    const report = inScope.map((h) => `${h.file}:${h.line} — "${h.text}" → use "${h.use}"`);
    expect(report).toEqual([]);
  });

  it("imprime a contagem de PENDING_SCOPE", () => {
    // eslint-disable-next-line no-console
    console.info(`[vocabGuard] PENDING_SCOPE: ${PENDING_SCOPE.length} arquivos, ${deferred.length} ocorrências (TODO(fv2-29))`);
    expect(deferred.length).toBeGreaterThanOrEqual(0);
  });

  it("PENDING_SCOPE só lista arquivos que ainda têm ocorrências (sem entradas mortas)", () => {
    const withHits = new Set(deferred.map((h) => h.file));
    expect(PENDING_SCOPE.filter((f) => !withHits.has(f))).toEqual([]);
  });

  it("allowlist pontual tem no máximo 30 entradas, todas com motivo e arquivo existente", () => {
    expect(ALLOWED_TERMS.length).toBeLessThanOrEqual(MAX_ALLOWED_TERMS);
    for (const a of ALLOWED_TERMS) {
      expect(a.reason.trim().length, `${a.file}: ${a.term}`).toBeGreaterThan(8);
      expect(FILES, `${a.file} não existe`).toContain(a.file);
    }
  });

  it("allowlist por caminho aponta para caminhos que existem ou existirão (sem duplicatas)", () => {
    expect(new Set(ALLOWED_PATHS).size).toBe(ALLOWED_PATHS.length);
  });
});

describe("vocabGuard: sentence case em botões", () => {
  const inScope = (f: string) => SENTENCE_CASE_SCOPE.some((s) => (s.endsWith("/") ? f.startsWith(s) : f === s));

  it("texto de <Button> nas telas do escopo está em sentence case", () => {
    const report: string[] = [];
    for (const file of FILES.filter(inScope).filter((f) => f.endsWith(".tsx"))) {
      for (const { text, line } of extractButtonLabels(read(file))) {
        const bad = sentenceCaseViolations(text);
        if (bad.length > 0) report.push(`${file}:${line} — "${text}" → sentence case (${bad.join(", ")})`);
      }
    }
    expect(report).toEqual([]);
  });

  it("rótulos de navegação (label:) das telas do escopo estão em sentence case", () => {
    const report: string[] = [];
    for (const file of FILES.filter(inScope)) {
      const src = read(file);
      const re = /\blabel:\s*"([^"\n]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const bad = sentenceCaseViolations(m[1]);
        if (bad.length > 0) report.push(`${file} — "${m[1]}" → sentence case (${bad.join(", ")})`);
      }
    }
    expect(report).toEqual([]);
  });
});
