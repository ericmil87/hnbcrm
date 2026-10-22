/**
 * Teste de BUILD da porta única de webhooks (perf Convex I/O, onda 2): todo
 * evento passa por `lib/webhookDispatch.scheduleWebhookEvent`, que só agenda
 * `internal.nodeActions.triggerWebhooks` quando a org tem um webhook ativo que
 * casa com o evento. Um `runAfter`/`runAt` direto da action fora do helper
 * volta a gastar 1 job + 1 action Node + 1 runQuery por evento em toda org
 * sem webhook (a maioria).
 *
 * HEURÍSTICA (lê os fontes, sem AST): recorta toda chamada `runAfter(` /
 * `runAt(` por parênteses balanceados e falha se ela citar `triggerWebhooks`.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;
const HELPER = "lib/webhookDispatch.ts";

function sliceBalanced(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}

function findDirectWebhookSchedules(src: string): number[] {
  const lines: number[] = [];
  const re = /\.(?:runAfter|runAt)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const call = sliceBalanced(src, m.index + m[0].length - 1);
    if (/\btriggerWebhooks\b/.test(call)) lines.push(src.slice(0, m.index).split("\n").length);
  }
  return lines;
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

describe("heurística (auto-teste)", () => {
  test("pega agendamento multi-linha e runAt", () => {
    expect(
      findDirectWebhookSchedules(
        `await ctx.scheduler.runAfter(\n  0,\n  internal.nodeActions.triggerWebhooks,\n  { organizationId, event, payload }\n);`
      )
    ).toHaveLength(1);
    expect(findDirectWebhookSchedules(`ctx.scheduler.runAt(t, internal.nodeActions.triggerWebhooks, {})`)).toHaveLength(1);
  });

  test("não confunde outros agendamentos nem o helper", () => {
    expect(findDirectWebhookSchedules(`ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {})`)).toHaveLength(0);
    expect(findDirectWebhookSchedules(`await scheduleWebhookEvent(ctx, { organizationId, event, payload })`)).toHaveLength(0);
  });
});

describe("porta única de webhooks", () => {
  const files = walk(CONVEX_DIR);

  test("nenhum agendamento direto de triggerWebhooks fora de lib/webhookDispatch.ts", () => {
    const violations: string[] = [];
    for (const abs of files) {
      const r = rel(abs);
      if (r === HELPER) continue;
      for (const line of findDirectWebhookSchedules(readFileSync(abs, "utf8"))) violations.push(`${r}:${line}`);
    }
    expect(
      violations,
      "Agende webhook só por scheduleWebhookEvent (convex/lib/webhookDispatch.ts)"
    ).toEqual([]);
  });

  test("controle positivo: o helper é detectado pela heurística", () => {
    const src = readFileSync(path.join(CONVEX_DIR, HELPER), "utf8");
    expect(findDirectWebhookSchedules(src)).toHaveLength(1);
  });

  test("a action filtra com o MESMO predicado do gate", () => {
    const src = readFileSync(path.join(CONVEX_DIR, "webhookTrigger.ts"), "utf8");
    expect(src).toMatch(/import\s*\{[^}]*\bwebhookMatches\b[^}]*\}\s*from\s*["']\.\/lib\/webhookDispatch["']/);
    expect(src).toMatch(/webhookMatches\(/);
  });
});
