// @vitest-environment node
/**
 * Teste de BUILD do Jev (docs/architecture/jev.md). Lê o código-fonte e quebra o build quando:
 *  - a URL do Jev aparece fora de `lib/jev/types.ts` (uma constante só — o alpha pode mudar);
 *  - `callJev` é importado fora de `convex/jev.ts`/`aiDiagnostics.ts` (porta única de rede);
 *  - algo além de `convex/jev.ts` referencia `internal.jev.*` (FASE 0 = SEM CALLER; a fase 1 muda
 *    a lista `CALLERS_PERMITIDOS` de propósito, com a justificativa no PR);
 *  - `JEV_KINDS` e o validator de `kind` de `jev.ts` divergem;
 *  - `agentRuns.kind` perde `"jev"` no schema ou em `internalStartRun`;
 *  - `lib/jev/` passa a ler segredo/ambiente ou a tocar o banco (puro por construção).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { JEV_KINDS } from "./lib/jev/types";

const ROOT = __dirname;
const SKIP = new Set(["_generated", "node_modules", "__fixtures__"]);
function sources(dir = ROOT, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");
const read = (p: string) => readFileSync(p, "utf8");
const files = sources();

describe("Jev — porta única (teste de build)", () => {
  test("a URL do Jev vive só em lib/jev/types.ts", () => {
    const hits = files.filter((f) => /api\/alpha\/decisions|api\/v1\/systemone/.test(read(f))).map(rel);
    expect(hits).toEqual(["lib/jev/types.ts"]);
  });

  test("callJev só é importado por jev.ts e aiDiagnostics.ts (e pelo index do próprio módulo)", () => {
    const importers = files
      .filter((f) => /from\s+["'][^"']*jev\/(client|index)["']|from\s+["']\.\/client["']/.test(read(f)))
      .map(rel)
      .filter((f) => f !== "lib/jev/index.ts") // o próprio reexport do módulo
      .sort();
    expect(importers).toEqual(["aiDiagnostics.ts", "jev.ts"].sort());
  });

  // FASE 0: ninguém chama o Jev. A fase 1 acrescenta `attendant.ts` (ou o arquivo escolhido) AQUI, de propósito.
  const CALLERS_PERMITIDOS = ["jev.ts"];
  test("fase 0 sem caller: só jev.ts referencia internal.jev.*", () => {
    const callers = files.filter((f) => /\binternal\.jev\./.test(read(f))).map(rel).sort();
    expect(callers).toEqual(CALLERS_PERMITIDOS);
  });

  test("lib/jev é puro: não lê env, não importa _generated nem toca ctx.db", () => {
    const pure = files.filter((f) => rel(f).startsWith("lib/jev/"));
    expect(pure.length).toBeGreaterThanOrEqual(7);
    for (const f of pure) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(src, `${rel(f)} lê process.env`).not.toMatch(/process\.env/);
      expect(src, `${rel(f)} importa _generated`).not.toMatch(/_generated/);
      expect(src, `${rel(f)} toca o banco`).not.toMatch(/ctx\.db|ctx\.run(Query|Mutation|Action)/);
    }
  });

  test("a chave só é lida em jev.ts e aiDiagnostics.ts, e nunca vai para log", () => {
    for (const f of files.filter((x) => /jev/i.test(rel(x)) || rel(x) === "aiDiagnostics.ts")) {
      const src = read(f);
      if (!/OPENROUTER_API_KEY/.test(src)) continue;
      expect(["jev.ts", "aiDiagnostics.ts"], rel(f)).toContain(rel(f));
      expect(src, rel(f)).not.toMatch(/console\.(log|error|warn|info)\([^)]*apiKey/);
    }
  });
});

describe("Jev — paridades", () => {
  test("JEV_KINDS == validator de kind em jev.ts", () => {
    const src = read(join(ROOT, "jev.ts"));
    const block = /const kindValidator = v\.union\(([\s\S]*?)\n\);/.exec(src)?.[1] ?? "";
    const kinds = [...block.matchAll(/v\.literal\("([a-z_]+)"\)/g)].map((m) => m[1]);
    expect(kinds).toEqual([...JEV_KINDS]);
  });

  test('agentRuns.kind inclui "jev" no schema e em internalStartRun', () => {
    for (const file of ["schema.ts", "agentRuns.ts"]) {
      expect(read(join(ROOT, file)), file).toMatch(/v\.literal\("jev"\)/);
    }
  });

  test("jevDecisions está na retenção, fora do backup e na purga da org", () => {
    expect(read(join(ROOT, "retention.ts"))).toMatch(/"jevDecisions"/);
    expect(read(join(ROOT, "lib/exportSanitize.ts"))).toMatch(/"jevDecisions"/);
    expect(read(join(ROOT, "opsPurge.ts"))).toMatch(/table: "jevDecisions"/);
  });
});
