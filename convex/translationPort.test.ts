// @vitest-environment node
/**
 * Teste de BUILD da tradução automática (F1).
 *
 *  1. Só `lib/translationOps.ts` agenda `internal.translation.*` (a porta
 *     `scheduleMessageTranslation` + o desvio da saída). Um agendamento por
 *     fora pula o gate do módulo — a org sem tradução passaria a gastar.
 *  2. O desvio vem ANTES do ramo por canal em `scheduleOutboundDispatch`:
 *     invertido, o texto em pt-BR sairia antes da tradução.
 *  3. Fiação: os 4 receivers, a transcrição e os 2 commits do atendente
 *     chamam a porta; a saída do LLM de tradução passa pelo guard de saída.
 *  4. Paridade dos literais novos (`kind:"translation"`, produto `translation`).
 *
 * HEURÍSTICA (lê os fontes, sem AST; comentários removidos antes).
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;
const read = (rel: string) => readFileSync(path.join(CONVEX_DIR, rel), "utf8");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
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
const rel = (abs: string) => path.relative(CONVEX_DIR, abs).split(path.sep).join("/");

// Os alvos que SÓ são agendados (nunca chamados direto) — por ponto, colchete ou string.
const SCHEDULED_TARGETS = [
  "autoTranslateInbound",
  "autoTranslateDisplay",
  "autoTranslateDraft",
  "translateAndDispatch",
  "internalExpirePendingOutbound",
];
const TARGET_RE = new RegExp(
  `internal\\s*\\.\\s*translation\\s*(\\.\\s*|\\[\\s*["'])(${SCHEDULED_TARGETS.join("|")})\\b|["']translation:(${SCHEDULED_TARGETS.join("|")})["']`,
  "g"
);
// Qualquer agendamento cujo alvo seja `internal.translation.*`.
const SCHEDULE_RE = /\b(runAfter|runAt)\s*\(\s*[^,]+,\s*internal\s*\.\s*translation\b/g;

function hits(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const re of [TARGET_RE, SCHEDULE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) out.push(`${code.slice(0, m.index).split("\n").length}: ${m[0]}`);
  }
  return out;
}

describe("heurística (auto-teste)", () => {
  test("pega agendamento direto, colchete e string", () => {
    expect(hits(`await ctx.scheduler.runAfter(0, internal.translation.autoTranslateInbound, { messageId });`).length).toBeGreaterThan(0);
    expect(hits(`runAfter(0, internal.translation["translateAndDispatch"], {})`).length).toBeGreaterThan(0);
    expect(hits(`const r = "translation:autoTranslateDisplay";`)).toHaveLength(1);
    expect(hits(`await ctx.scheduler.runAt(t, internal.translation.algumaOutra, {})`)).toHaveLength(1);
    expect(hits(`// internal.translation.autoTranslateInbound`)).toEqual([]);
    expect(hits(`await ctx.runMutation(internal.translation.internalSetInboundResult, {})`)).toEqual([]);
  });
});

describe("porta única da tradução", () => {
  test("só lib/translationOps.ts agenda internal.translation.*", () => {
    const violations: string[] = [];
    for (const abs of walk(CONVEX_DIR)) {
      const r = rel(abs);
      if (r === "lib/translationOps.ts") continue;
      for (const h of hits(readFileSync(abs, "utf8"))) violations.push(`${r}:${h}`);
    }
    expect(
      violations,
      "A tradução só é agendada por lib/translationOps.ts (scheduleMessageTranslation / desvio da saída): " +
        "agendar direto pula o gate do módulo e o watchdog."
    ).toEqual([]);
  });

  test("controle positivo: a porta agenda os quatro alvos", () => {
    const src = stripComments(read("lib/translationOps.ts"));
    for (const target of SCHEDULED_TARGETS) expect(src, target).toMatch(new RegExp(`internal\\.translation\\.${target}\\b`));
  });

  test("desvio da saída vem ANTES do ramo por canal", () => {
    const src = stripComments(read("lib/outboundDispatch.ts"));
    const body = src.slice(src.indexOf("export async function scheduleOutboundDispatch"));
    const divert = body.indexOf("maybeDivertOutboundForTranslation(ctx, conversation, messageId)");
    const bail = body.search(/if\s*\(\s*translation\s*!==\s*"dispatch"\s*\)\s*return;/);
    const channel = body.indexOf('conversation.channel === "whatsapp"');
    expect(divert).toBeGreaterThan(-1);
    expect(bail).toBeGreaterThan(divert);
    expect(channel).toBeGreaterThan(bail);
  });

  test("fiação: receivers, transcrição e commits do atendente chamam a porta", () => {
    const conv = stripComments(read("conversations.ts"));
    expect((conv.match(/scheduleMessageTranslation\(ctx, \{ messageId, role: "inbound" \}\)/g) ?? []).length).toBe(4);
    for (const fn of ["internalReceiveMessage", "internalReceiveDeviceMessage", "internalReceiveGroupMessage", "internalReceiveGroupDeviceMessage"]) {
      const start = conv.indexOf(`export const ${fn} = internalMutation(`);
      const next = conv.indexOf("\nexport ", start + 10);
      expect(conv.slice(start, next), fn).toMatch(/scheduleMessageTranslation\(/);
    }
    expect(stripComments(read("transcription.ts"))).toMatch(/scheduleMessageTranslation\(ctx, \{[\s\S]{0,120}role: "inbound"/);
    expect((stripComments(read("attendant.ts")).match(/scheduleMessageTranslation\(ctx, \{ messageId, role: "display"/g) ?? []).length).toBe(2);
    // F3: o rascunho do modo sugerir (commit de sugestão) ganha a versão da equipe.
    expect((stripComments(read("attendant.ts")).match(/scheduleMessageTranslation\(ctx, \{ messageId, role: "draft"/g) ?? []).length).toBe(1);
  });

  test("a única mutation que troca o content de uma outbound traduzida chama a porta de novo", () => {
    const src = stripComments(read("translation.ts"));
    const apply = src.slice(src.indexOf("export const internalApplyOutbound"), src.indexOf("export const internalMarkTranslationFailed"));
    expect(apply).toMatch(/content: translated/);
    expect(apply).toMatch(/scheduleOutboundDispatch\(ctx, conversation, message\._id\)/);
    expect(apply).toMatch(/t\.status !== "pending"/);
  });
});

describe("paridade dos literais novos", () => {
  test('kind "translation" em schema.ts e agentRuns.ts', () => {
    for (const f of ["schema.ts", "agentRuns.ts"]) {
      const src = read(f);
      const kind = src.slice(src.indexOf('v.literal("attendant_draft")'), src.indexOf('v.literal("attendant_draft")') + 200);
      expect(kind, f).toMatch(/v\.literal\("translation"\)/);
    }
  });

  test('produto "translation" em agentRoutes, schema, setProductRouting e getAiStatus', () => {
    expect(read("lib/agentRoutes.ts")).toMatch(/\|\s*"translation";/);
    expect(read("schema.ts")).toMatch(/translation: v\.optional\(productRoutingValidator\)/);
    const ai = read("aiSettings.ts");
    expect(ai).toMatch(/v\.literal\("translation"\)/);
    expect(ai).toMatch(/translation: v\.object\(\{ order: v\.string\(\), model: v\.string\(\) \}\)/);
    expect(ai).toMatch(/translation: productRoutingOf\(/);
    expect(read("lib/llm/registry.ts")).toMatch(/translation: "deepseek-flash-latest"/);
  });

  test("módulo translation fora de assertAnyModule (não é da Central)", () => {
    const src = read("lib/orgModules.ts");
    const any = src.slice(src.indexOf("export async function assertAnyModule"));
    expect(any).not.toMatch(/translation/);
    expect(src).toMatch(/translation: "Tradução automática"/);
  });
});
