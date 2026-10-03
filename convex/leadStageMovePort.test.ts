/**
 * Teste de BUILD da porta única de etapa (T03): toda mudança de
 * `leads.stageId` passa por `lib/leadStageMove.moveLeadToStageCore`, que
 * carimba fechamento, grava `stageEnteredAt`, audita com o ator real e emite
 * `lead.won`/`lead.lost`. Um `ctx.db.patch(…, { stageId })` fora dele é
 * exatamente o bug que a T03 fechou (REST, tool da IA, avanço pós-BANT e
 * copiloto moviam sem carimbar — a receita sumia da Central).
 *
 * HEURÍSTICA (lê os fontes, sem AST — robusta a formatação):
 *  1. acha toda chamada `.patch(` / `.replace(` em `convex/**.ts` (fora de
 *     testes e `_generated`) e recorta a chamada INTEIRA por parênteses
 *     balanceados (multi-linha, qualquer indentação);
 *  2. INLINE: a chamada contém a CHAVE `stageId` — `stageId:` ou a forma
 *     curta `stageId,` / `stageId }` — sem ponto antes (`args.stageId` como
 *     id do documento a patchear NÃO conta);
 *  3. VARIÁVEL: se o último argumento é um identificador (`patch(id, p)`),
 *     procura a declaração `const|let p = { … }` ANTES da chamada e aplica a
 *     mesma regra ao literal; também pega `p.stageId = …`,
 *     `p["stageId"] = …` e `Object.assign(p, { stageId … })`.
 * Limite conhecido: objeto montado em outra função e passado pronto escapa —
 * por isso a revisão de código continua valendo. Criação de lead é `insert`,
 * não `patch`, e não entra aqui.
 *
 * EXCEÇÕES: lista EXPLÍCITA abaixo (arquivo → motivo). Patch legítimo de
 * OUTRA tabela com campo `stageId` entra aqui com justificativa.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;

const ALLOWED: Record<string, string> = {
  "lib/leadStageMove.ts": "a porta única (moveLeadToStageCore)",
};

const KEY_RE = /(?<![.\w$])["']?stageId["']?\s*(?::|,|\})/;

function sliceBalanced(src: string, openIdx: number, open: string, close: string): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}

type Violation = { file: string; line: number; kind: "inline" | "variable"; snippet: string };

function findStageIdPatches(src: string, file = "<mem>"): Violation[] {
  const out: Violation[] = [];
  const re = /\.(?:patch|replace)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const openIdx = m.index + m[0].length - 1;
    const call = sliceBalanced(src, openIdx, "(", ")");
    const line = src.slice(0, m.index).split("\n").length;
    const snippet = call.replace(/\s+/g, " ").slice(0, 100);
    if (KEY_RE.test(call)) {
      out.push({ file, line, kind: "inline", snippet });
      continue;
    }
    const lastArg = /,\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(call.replace(/\s+/g, " ").trim());
    if (!lastArg) continue;
    const name = lastArg[1];
    const before = src.slice(0, m.index);
    const decls = [...before.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\b[^=;]*=\\s*\\{`, "g"))];
    const decl = decls.at(-1);
    const literal = decl ? sliceBalanced(before, decl.index! + decl[0].length - 1, "{", "}") : "";
    const reassigned =
      new RegExp(`\\b${name}(?:\\.stageId|\\[["']stageId["']\\])\\s*=`).test(before) ||
      new RegExp(`Object\\.assign\\(\\s*${name}\\s*,[\\s\\S]{0,400}?\\bstageId\\b`).test(before);
    if (KEY_RE.test(literal) || reassigned) out.push({ file, line, kind: "variable", snippet });
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "__fixtures__" || entry === "node_modules") continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

describe("heurística (auto-teste)", () => {
  test("pega patch inline multi-linha, forma curta, variável e Object.assign", () => {
    expect(findStageIdPatches(`await ctx.db.patch(lead._id, {\n  title,\n    stageId: target._id,\n})`)).toHaveLength(1);
    expect(findStageIdPatches(`ctx.db.patch(id, { stageId })`)).toHaveLength(1);
    expect(findStageIdPatches(`ctx.db.patch(id,{stageId,updatedAt})`)).toHaveLength(1);
    expect(findStageIdPatches(`ctx.db.patch(id, { "stageId": s })`)).toHaveLength(1);
    expect(findStageIdPatches(`ctx.db.patch(id, { 'stageId': s })`)).toHaveLength(1);
    expect(
      findStageIdPatches(`const patch: Record<string, unknown> = {\n stageId: s,\n};\nawait ctx.db.patch(id, patch);`)
    ).toHaveLength(1);
    expect(findStageIdPatches(`const p = {};\np.stageId = s;\nawait ctx.db.patch(id, p);`)).toHaveLength(1);
    expect(findStageIdPatches(`const p = {};\nObject.assign(p, { stageId: s });\nawait ctx.db.patch(id, p);`)).toHaveLength(1);
  });

  test("não confunde id do documento nem outros campos", () => {
    expect(findStageIdPatches(`await ctx.db.patch(args.stageId, { name: "x", updatedAt: now })`)).toHaveLength(0);
    expect(findStageIdPatches(`await ctx.db.patch(id, { initialStageId: s, qualifiedStageId: q })`)).toHaveLength(0);
    expect(findStageIdPatches(`const stageFields = { name };\nawait ctx.db.patch(row._id, stageFields);\nlet stageId: X;`)).toHaveLength(0);
  });
});

describe("porta única de etapa", () => {
  const files = walk(CONVEX_DIR);

  test("nenhum patch de stageId fora de lib/leadStageMove.ts (e das exceções listadas)", () => {
    const violations: Violation[] = [];
    for (const abs of files) {
      const rel = path.relative(CONVEX_DIR, abs).split(path.sep).join("/");
      if (ALLOWED[rel]) continue;
      violations.push(...findStageIdPatches(readFileSync(abs, "utf8"), rel));
    }
    expect(
      violations,
      "Mudança de etapa fora da porta única — use moveLeadToStageCore (convex/lib/leadStageMove.ts)"
    ).toEqual([]);
  });

  test("controle positivo: o núcleo é detectado pela heurística", () => {
    const core = readFileSync(path.join(CONVEX_DIR, "lib/leadStageMove.ts"), "utf8");
    expect(findStageIdPatches(core).length).toBeGreaterThan(0);
  });

  test("toda exceção listada aponta para um arquivo que existe", () => {
    for (const key of Object.keys(ALLOWED)) {
      expect(files.some((f) => path.relative(CONVEX_DIR, f).split(path.sep).join("/") === key), key).toBe(true);
    }
  });
});
