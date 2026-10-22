// @vitest-environment node
/**
 * Teste de BUILD da porta única de envio (Meta Messaging F0.2, D4): toda porta
 * de saída (sendMessage, internalSendMessage, internalSendTemplate,
 * forward/commit via lib/outboundSideEffects, agendadas, redispatch de ops)
 * chama `scheduleOutboundDispatch` (`lib/outboundDispatch.ts`), que escolhe o
 * dispatcher pelo `conversation.channel`. Chamar `scheduleWhatsappDispatch` ou
 * agendar `internal.whatsapp.internalDispatchMessage` direto volta a amarrar o
 * envio ao WhatsApp: uma conversa do Instagram/Messenger ficaria com a mensagem
 * gravada e nunca enviada (falha silenciosa).
 *
 * Exceções com motivo:
 *  - `lib/outboundDispatch.ts`: a própria porta.
 *  - `lib/whatsappDispatch.ts`: o pacing do WhatsApp, chamado pela porta.
 *  - `whatsapp.ts`: o dispatcher do WhatsApp reagenda A SI MESMO no retry
 *    (`internalRescheduleDispatch`, backoff da Meta) — não é porta de envio.
 *
 * HEURÍSTICA (lê os fontes, sem AST; comentários removidos antes).
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;
const PORT = "lib/outboundDispatch.ts";
const ALLOWED: Record<string, RegExp[]> = {
  [PORT]: [/\bscheduleWhatsappDispatch\s*\(/],
  "lib/whatsappDispatch.ts": [/\bscheduleWhatsappDispatch\s*\(/, /internal\.whatsapp\.internalDispatchMessage\b/],
  "whatsapp.ts": [/internal\.whatsapp\.internalDispatchMessage\b/],
};
const FORBIDDEN: RegExp[] = [
  /\bscheduleWhatsappDispatch\s*\(/g,
  /internal\.whatsapp\.internalDispatchMessage\b/g,
];

function stripComments(src: string): string {
  // Preserva as quebras de linha para o número da linha continuar certo.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

function findDirectDispatches(src: string, allowed: RegExp[] = []): string[] {
  const code = stripComments(src);
  const hits: string[] = [];
  for (const re of FORBIDDEN) {
    if (allowed.some((a) => a.source === re.source)) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      hits.push(`${code.slice(0, m.index).split("\n").length}: ${m[0]}`);
    }
  }
  return hits;
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
  test("pega chamada direta e agendamento do dispatcher", () => {
    expect(findDirectDispatches(`await scheduleWhatsappDispatch(ctx, conversation, messageId);`)).toHaveLength(1);
    expect(
      findDirectDispatches(
        `await ctx.scheduler.runAfter(\n  0,\n  internal.whatsapp.internalDispatchMessage,\n  { messageId }\n);`
      )
    ).toEqual(["3: internal.whatsapp.internalDispatchMessage"]);
  });

  test("ignora comentário e a porta", () => {
    expect(findDirectDispatches(`// scheduleWhatsappDispatch(ctx, c, m)\n/* internal.whatsapp.internalDispatchMessage */`)).toEqual([]);
    expect(findDirectDispatches(`await scheduleOutboundDispatch(ctx, conversation, messageId);`)).toEqual([]);
  });
});

describe("porta única de envio", () => {
  const files = walk(CONVEX_DIR);

  test("nenhum despacho direto do WhatsApp fora de lib/outboundDispatch.ts", () => {
    const violations: string[] = [];
    for (const abs of files) {
      const r = rel(abs);
      for (const hit of findDirectDispatches(readFileSync(abs, "utf8"), ALLOWED[r] ?? [])) {
        violations.push(`${r}:${hit}`);
      }
    }
    expect(
      violations,
      "Envio de mensagem só pela porta única scheduleOutboundDispatch (convex/lib/outboundDispatch.ts): " +
        "ela escolhe o dispatcher pelo canal da conversa. Chamar scheduleWhatsappDispatch ou agendar " +
        "internal.whatsapp.internalDispatchMessage direto prende o envio ao WhatsApp e deixa mensagens " +
        "de outros canais gravadas sem nunca sair."
    ).toEqual([]);
  });

  test("controle positivo: a porta chama o pacing do WhatsApp", () => {
    const src = readFileSync(path.join(CONVEX_DIR, PORT), "utf8");
    expect(findDirectDispatches(src)).toHaveLength(1);
  });

  test("os pontos de envio importam só a porta", () => {
    for (const r of [
      "conversations.ts",
      "lib/outboundSideEffects.ts",
      "scheduledMessages.ts",
      "opsMigration.ts",
    ]) {
      const src = readFileSync(path.join(CONVEX_DIR, r), "utf8");
      expect(src, r).toMatch(/\bscheduleOutboundDispatch\s*\(/);
      expect(src, r).not.toMatch(/from\s*["'][./]*(lib\/)?whatsappDispatch["']/);
    }
  });
});
