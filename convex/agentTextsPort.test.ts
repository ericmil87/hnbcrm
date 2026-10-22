/**
 * Teste de BUILD da porta única dos textos do agente IA (perf Convex I/O, onda 2):
 * `agentProfile.systemPrompt`/`.knowledge` saíram do doc do membro para a tabela
 * `agentProfileTexts`, com dual-read POR MEMBRO (`textsMigratedAt`). Ler o campo
 * direto do doc devolveria `undefined` num membro migrado (o atendente perderia a
 * persona em silêncio), e gravá-lo no doc reintroduziria os 35 KB que a migração
 * tirou de todo leitor de metadados.
 *
 * HEURÍSTICA (lê os fontes de `convex/` e `src/`, sem AST):
 *  1. LEITURA: `agentProfile.systemPrompt` / `profile?.knowledge` (com `!`/`?.`),
 *     por colchete (`agentProfile["systemPrompt"]`) e por desestruturação
 *     (`const { systemPrompt, … } = agent.agentProfile`, inclusive multilinha).
 *  2. ESCRITA: literal `agentProfile: { … }` (recortado por chaves balanceadas)
 *     que contém a CHAVE `systemPrompt`/`knowledge` (`chave:` ou forma curta).
 * Limite: perfil montado noutra variável com outro nome escapa — revisão de
 * código continua valendo.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO_DIR = path.resolve(__dirname, "..");
const SCAN_DIRS = ["convex", "src"];

// Caminhos relativos à raiz do repo (testes ficam fora da varredura).
const ALLOWED: Record<string, string> = {
  "convex/lib/agentProfileTexts.ts": "a porta única (readAgentTexts/writeAgentTexts)",
  "convex/opsAgentProfile.ts": "ops de migração/rollback (lê o legado do doc para mover)",
  "convex/schema.ts": "validator (campos legados)",
};

const READ_RE = /\b(?:agentProfile|profile)\s*[!?]*\s*\.\s*(?:systemPrompt|knowledge)\b/;
const BRACKET_RE =
  /\b(?:agentProfile|profile)\s*[!?]*\s*(?:\?\.)?\s*\[\s*["'`](?:systemPrompt|knowledge)["'`]\s*\]/;
// `{ … systemPrompt … } = <expr terminando em agentProfile/profile>` (sem chave
// aninhada no padrão — basta para `const { systemPrompt, ...rest } = x.agentProfile`).
const DESTRUCTURE_RE =
  /\{[^{}]*\b(?:systemPrompt|knowledge)\b[^{}]*\}\s*=\s*[\w$.?!]*\b(?:agentProfile|profile)\b(?![\w$])(?!\s*[.[(])/g;
const KEY_RE = /(?<![.\w$])["']?(?:systemPrompt|knowledge)["']?\s*(?::|,|\})/;

function sliceBalanced(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}

type Violation = { file: string; line: number; kind: "read" | "write"; snippet: string };

function findViolations(src: string, file = "<mem>"): Violation[] {
  const out: Violation[] = [];
  src.split("\n").forEach((text, i) => {
    if (READ_RE.test(text) || BRACKET_RE.test(text)) {
      out.push({ file, line: i + 1, kind: "read", snippet: text.trim() });
    }
  });
  for (const d of src.matchAll(DESTRUCTURE_RE)) {
    out.push({
      file,
      line: src.slice(0, d.index).split("\n").length,
      kind: "read",
      snippet: d[0].replace(/\s+/g, " ").slice(0, 100),
    });
  }
  const re = /\bagentProfile\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const literal = sliceBalanced(src, m.index + m[0].length - 1);
    if (KEY_RE.test(literal)) {
      out.push({
        file,
        line: src.slice(0, m.index).split("\n").length,
        kind: "write",
        snippet: literal.replace(/\s+/g, " ").slice(0, 100),
      });
    }
  }
  return out;
}

function listSources(dir: string, base = dir): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (statSync(full).isDirectory()) {
      if (name === "_generated" || name === "node_modules" || name === "__fixtures__") continue;
      files.push(...listSources(full, base));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      files.push(rel);
    }
  }
  return files;
}

describe("porta única dos textos do agente IA", () => {
  test("detector pega leitura e escrita direta (sanidade da heurística)", () => {
    expect(findViolations("const p = agent.agentProfile!.systemPrompt ?? null;")).toHaveLength(1);
    expect(findViolations("x = profile?.knowledge;")).toHaveLength(1);
    expect(
      findViolations("await ctx.db.patch(id, { agentProfile: { ...p, knowledge: text } });")
    ).toHaveLength(1);
    expect(findViolations("insert('teamMembers', { agentProfile: { kind, systemPrompt } })")).toHaveLength(1);
    // não confunde com outros objetos nem com o resultado do helper
    expect(findViolations("const t = await readAgentTexts(ctx, m); t.systemPrompt;")).toHaveLength(0);
    expect(findViolations("persona.systemPrompt; context.knowledge;")).toHaveLength(0);
    expect(findViolations("agentProfile: { ...p, textsMigratedAt: now }")).toHaveLength(0);
    // colchete e desestruturação
    expect(findViolations('const s = agent.agentProfile["systemPrompt"];')).toHaveLength(1);
    expect(findViolations("x = profile?.['knowledge'];")).toHaveLength(1);
    expect(findViolations("const { systemPrompt, ...rest } = agent.agentProfile;")).toHaveLength(1);
    expect(
      findViolations("const {\n  mode,\n  knowledge,\n} = member.agentProfile!;")
    ).toHaveLength(1);
    expect(findViolations("const { knowledge } = await readAgentTexts(ctx, m);")).toHaveLength(0);
    expect(findViolations("const { mode, botGuard } = agent.agentProfile;")).toHaveLength(0);
    expect(findViolations("const { systemPrompt } = persona;")).toHaveLength(0);
  });

  test("nenhum módulo fora da porta lê ou grava systemPrompt/knowledge do doc", () => {
    const violations: Violation[] = [];
    for (const dir of SCAN_DIRS) {
      for (const rel of listSources(path.join(REPO_DIR, dir), REPO_DIR)) {
        if (ALLOWED[rel]) continue;
        violations.push(...findViolations(readFileSync(path.join(REPO_DIR, rel), "utf8"), rel));
      }
    }
    expect(
      violations.map((v) => `${v.file}:${v.line} [${v.kind}] ${v.snippet}`),
      "Use readAgentTexts/writeAgentTexts de lib/agentProfileTexts.ts"
    ).toEqual([]);
  });
});
