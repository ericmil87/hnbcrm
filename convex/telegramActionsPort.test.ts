// @vitest-environment node
/**
 * Teste de BUILD da porta única das ações do Telegram (D6/D8). Os `internal*`
 * do domínio não checam RBAC: chamá-los direto do Telegram deixaria um membro
 * sem `inbox:reply` (ou de outra org) agir por um botão. Toda ação passa por
 * `convex/lib/telegramActions.ts`, que reautoriza antes de cada porta.
 *
 * 1. Nenhum arquivo `convex/telegram*.ts` / `convex/lib/telegram*.ts` além de
 *    `lib/telegramActions.ts` cita as portas do domínio.
 * 2. Em `lib/telegramActions.ts`, toda função que chama uma porta chama
 *    `authorizeTelegramActor(` ANTES (heurística estrutural, sem AST).
 * Exceção: `lib/telegramRelay.ts` só AGENDA funções do próprio Telegram.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;
const PORT = "lib/telegramActions.ts";
const AUTH = "authorizeTelegramActor(";

const FORBIDDEN =
  /internal\s*\.\s*(handoffs|attendant|conversations|tasks|leads)\b|\b(acceptHandoffCore|rejectHandoffCore|rejectHandoffWithInstructionCore|moveLeadToStageCore|applyTaskCompletion|snoozeTaskCore|internalSendMessage\w*|returnToAiCore|requestAiDraftCore|acceptAiDraftCore|discardAiDraftCore|assumeConversationCore)\b/g;
/** Port CALLS (not imports) inside telegramActions. */
const PORT_CALL =
  /\b(acceptHandoffCore|rejectHandoffWithInstructionCore|returnToAiCore|requestAiDraftCore|acceptAiDraftCore|discardAiDraftCore|internalSendMessageCore|assumeConversationCore|applyTaskCompletion|snoozeTaskCore)\s*\(/g;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

function hits(src: string, re: RegExp): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push(`${code.slice(0, m.index).split("\n").length}: ${m[0]}`);
  return out;
}

/** Top-level `async function name(...)` bodies (until the next top-level declaration). */
function functionBodies(src: string): { name: string; body: string }[] {
  const code = stripComments(src);
  const re = /^(?:export\s+)?async function (\w+)/gm;
  const starts: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) starts.push({ name: m[1]!, index: m.index });
  return starts.map((s, i) => {
    const nextDecl = code.slice(s.index + 1).search(/^(?:export\s+)?(?:async\s+)?(?:function|const|type)\s/m);
    const end = i + 1 < starts.length ? starts[i + 1]!.index : nextDecl < 0 ? code.length : s.index + 1 + nextDecl;
    return { name: s.name, body: code.slice(s.index, end) };
  });
}

/** Functions that call a port without calling the authorization door first. */
function unauthorizedPortCalls(src: string): string[] {
  const bad: string[] = [];
  for (const { name, body } of functionBodies(src)) {
    PORT_CALL.lastIndex = 0;
    const first = PORT_CALL.exec(body);
    if (!first) continue;
    const auth = body.indexOf(AUTH);
    // Helpers that receive an already-authorized `actor` are fine: their callers authorized.
    const takesActor = /\(\s*ctx: MutationCtx,\s*actor: TelegramActor/.test(body.slice(0, 200));
    if (takesActor) continue;
    if (auth < 0 || auth > first.index) bad.push(`${name}: ${first[1]}`);
  }
  return bad;
}

const telegramFiles = () => {
  const out: string[] = [];
  for (const f of readdirSync(CONVEX_DIR)) if (/^telegram.*\.ts$/.test(f) && !f.endsWith(".test.ts")) out.push(f);
  for (const f of readdirSync(path.join(CONVEX_DIR, "lib"))) {
    if (/^telegram.*\.ts$/.test(f) && !f.endsWith(".test.ts")) out.push(`lib/${f}`);
  }
  return out;
};

describe("heurística (auto-teste)", () => {
  test("pega referência a internal.<domínio> e às portas", () => {
    expect(hits("runAfter(0, internal.handoffs.internalAcceptHandoff, {})", FORBIDDEN)).toHaveLength(1);
    expect(hits("await acceptHandoffCore(ctx, x)", FORBIDDEN)).toHaveLength(1);
    expect(hits("ctx.runMutation(internal . conversations . internalSendMessage, a)", FORBIDDEN)).toHaveLength(2);
    expect(hits("// acceptHandoffCore(ctx)", FORBIDDEN)).toEqual([]);
    expect(hits("internal.telegram.internalDeliverNotification", FORBIDDEN)).toEqual([]);
  });

  test("porta chamada antes da autorização é pega", () => {
    const bad = `async function onX(ctx: MutationCtx, tap: Tap) {\n  await acceptHandoffCore(ctx, a);\n  const auth = await authorizeTelegramActor(ctx, b);\n}\n`;
    const good = `async function onX(ctx: MutationCtx, tap: Tap) {\n  const auth = await authorizeTelegramActor(ctx, b);\n  await acceptHandoffCore(ctx, a);\n}\n`;
    const none = `async function onX(ctx: MutationCtx, tap: Tap) {\n  await returnToAiCore(ctx, a);\n}\n`;
    expect(unauthorizedPortCalls(bad)).toEqual(["onX: acceptHandoffCore"]);
    expect(unauthorizedPortCalls(good)).toEqual([]);
    expect(unauthorizedPortCalls(none)).toEqual(["onX: returnToAiCore"]);
  });
});

describe("porta única das ações do Telegram", () => {
  test("só lib/telegramActions.ts cita as portas do domínio", () => {
    const violations: string[] = [];
    for (const r of telegramFiles()) {
      if (r === PORT) continue;
      for (const hit of hits(readFileSync(path.join(CONVEX_DIR, r), "utf8"), FORBIDDEN)) violations.push(`${r}:${hit}`);
    }
    expect(
      violations,
      "Ações do Telegram só por convex/lib/telegramActions.ts (D8): os internal* do domínio não checam RBAC.",
    ).toEqual([]);
  });

  test("toda porta em lib/telegramActions.ts vem depois de authorizeTelegramActor", () => {
    const src = readFileSync(path.join(CONVEX_DIR, PORT), "utf8");
    expect(unauthorizedPortCalls(src)).toEqual([]);
  });

  test("controle positivo: a porta autoriza e chama as portas", () => {
    const src = readFileSync(path.join(CONVEX_DIR, PORT), "utf8");
    expect(src).toMatch(/export async function authorizeTelegramActor/);
    expect(hits(src, PORT_CALL).length).toBeGreaterThan(8);
    // O lado da autorização checa membro vivo e RBAC.
    expect(src).toMatch(/isLinkMemberAlive\(/);
    expect(src).toMatch(/hasPermission\(/);
  });
});
