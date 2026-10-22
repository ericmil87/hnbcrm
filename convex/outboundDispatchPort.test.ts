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
 *  - Meta Messaging (F1), mesma regra: `lib/metaDispatch.ts` agenda o
 *    dispatcher do Instagram/Messenger (chamado só pela porta) e
 *    `metaMessaging.ts` só pode reagendá-lo dentro de `internalRescheduleMetaDispatch`.
 *
 * HEURÍSTICA (lê os fontes, sem AST; comentários removidos antes).
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;
const PORT = "lib/outboundDispatch.ts";
// Qualquer menção ao pacing do WhatsApp (pega import com alias, chamada e referência).
const SCHEDULE_WA = /\bscheduleWhatsappDispatch\b/g;
// O dispatcher do WhatsApp por ponto, colchete ou chave literal.
const DISPATCH_WA =
  /internal\s*\.\s*whatsapp\s*(\.\s*|\[\s*["'])internalDispatchMessage\b|["']whatsapp:internalDispatchMessage["']/g;
// Instagram/Messenger: o agendamento da porta e o dispatcher da Meta, nos mesmos formatos.
const SCHEDULE_META = /\bscheduleMetaMessagingDispatch\b/g;
const DISPATCH_META =
  /internal\s*\.\s*metaMessaging\s*(\.\s*|\[\s*["'])internalDispatchMessage\b|["']metaMessaging:internalDispatchMessage["']/g;
const FORBIDDEN: RegExp[] = [SCHEDULE_WA, DISPATCH_WA, SCHEDULE_META, DISPATCH_META];

const ALLOWED: Record<string, RegExp[]> = {
  [PORT]: [SCHEDULE_WA, SCHEDULE_META],
  "lib/whatsappDispatch.ts": [SCHEDULE_WA, DISPATCH_WA],
  "lib/metaDispatch.ts": [SCHEDULE_META, DISPATCH_META],
};
// `whatsapp.ts`: a exceção vale só para o reagendamento do próprio retry, dentro desta função.
const SELF_RESCHEDULE_FN = "internalRescheduleDispatch";
// `metaMessaging.ts`: idem, só dentro do reagendamento do dispatcher da Meta.
const META_SELF_RESCHEDULE_FN = "internalRescheduleMetaDispatch";

/** Apaga (em branco) o corpo de `export const <name>` até o próximo `export` na coluna 0. */
function cutExportedFunction(src: string, name: string): string {
  const start = src.search(new RegExp(`^export const ${name}\\b`, "m"));
  if (start < 0) return src;
  const next = src.slice(start + 1).search(/^export\s/m);
  const end = next < 0 ? src.length : start + 1 + next;
  return src.slice(0, start) + src.slice(start, end).replace(/[^\n]/g, " ") + src.slice(end);
}

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
    if (allowed.includes(re)) continue;
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

  test("pega import com alias e acesso por colchete", () => {
    expect(findDirectDispatches(`import { scheduleWhatsappDispatch as sw } from "./lib/whatsappDispatch";`)).toHaveLength(1);
    expect(findDirectDispatches(`await ctx.scheduler.runAfter(0, internal.whatsapp["internalDispatchMessage"], {});`)).toHaveLength(1);
    expect(findDirectDispatches(`const ref = "whatsapp:internalDispatchMessage";`)).toHaveLength(1);
    expect(findDirectDispatches(`internal . whatsapp . internalDispatchMessage`)).toHaveLength(1);
  });

  test("a exceção de whatsapp.ts vale só dentro de internalRescheduleDispatch", () => {
    const call = `    runAfter(1, internal.whatsapp.internalDispatchMessage, {});\n`;
    const inside = `export const ${SELF_RESCHEDULE_FN} = internalMutation({\n${call}});\n`;
    const outside = `export const outra = internalMutation({\n${call}});\n`;
    expect(findDirectDispatches(cutExportedFunction(inside, SELF_RESCHEDULE_FN))).toEqual([]);
    expect(findDirectDispatches(cutExportedFunction(inside + outside, SELF_RESCHEDULE_FN))).toHaveLength(1);
    expect(findDirectDispatches(cutExportedFunction(outside + inside, SELF_RESCHEDULE_FN))).toHaveLength(1);
  });


  test("pega o agendamento e o dispatcher da Meta em todos os formatos", () => {
    expect(findDirectDispatches(`await scheduleMetaMessagingDispatch(ctx, conversation, messageId);`)).toHaveLength(1);
    expect(findDirectDispatches(`import { scheduleMetaMessagingDispatch as sm } from "./lib/metaDispatch";`)).toHaveLength(1);
    expect(findDirectDispatches(`runAfter(0, internal.metaMessaging.internalDispatchMessage, {});`)).toHaveLength(1);
    expect(findDirectDispatches(`runAfter(0, internal.metaMessaging["internalDispatchMessage"], {});`)).toHaveLength(1);
    expect(findDirectDispatches(`const ref = "metaMessaging:internalDispatchMessage";`)).toHaveLength(1);
    expect(findDirectDispatches(`internal . metaMessaging . internalDispatchMessage`)).toHaveLength(1);
  });

  test("a exceção de metaMessaging.ts vale só dentro de internalRescheduleMetaDispatch", () => {
    const call = `    runAfter(1, internal.metaMessaging.internalDispatchMessage, {});\n`;
    const inside = `export const ${META_SELF_RESCHEDULE_FN} = internalMutation({\n${call}});\n`;
    const outside = `export const outra = internalMutation({\n${call}});\n`;
    expect(findDirectDispatches(cutExportedFunction(inside, META_SELF_RESCHEDULE_FN))).toEqual([]);
    expect(findDirectDispatches(cutExportedFunction(inside + outside, META_SELF_RESCHEDULE_FN))).toHaveLength(1);
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
      let src = readFileSync(abs, "utf8");
      if (r === "whatsapp.ts") src = cutExportedFunction(src, SELF_RESCHEDULE_FN);
      if (r === "metaMessaging.ts") src = cutExportedFunction(src, META_SELF_RESCHEDULE_FN);
      for (const hit of findDirectDispatches(src, ALLOWED[r] ?? [])) {
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

  test("controle positivo: a porta chama o pacing do WhatsApp e o da Meta", () => {
    const src = readFileSync(path.join(CONVEX_DIR, PORT), "utf8");
    // import + chamada de cada um.
    expect(findDirectDispatches(src)).toHaveLength(4);
  });

  test("controle positivo: o reagendamento da Meta existe e agenda o próprio dispatcher", () => {
    const src = readFileSync(path.join(CONVEX_DIR, "metaMessaging.ts"), "utf8");
    expect(findDirectDispatches(src).length).toBeGreaterThan(0);
    expect(findDirectDispatches(cutExportedFunction(src, META_SELF_RESCHEDULE_FN))).toEqual([]);
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
