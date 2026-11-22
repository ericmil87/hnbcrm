/// <reference types="vite/client" />
/**
 * Agenda v2 (D3) — o juiz de afirmação (segunda camada do guard) no turno do Atendente, com o LLM simulado por `fetch`.
 * Dois "modelos" no mesmo `fetch`: o do atendente (roteiro) e o juiz (reconhecido pelo prompt de sistema). Quem decide se barra é o
 * SERVIDOR comparando o que o juiz leu com o estado real; aqui o juiz devolve o que o teste manda e conferimos a decisão.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { SCHED_SAFE_TEXT } from "./lib/schedClaimGuard";
import { JUDGE_SYSTEM } from "./lib/schedClaimJudge";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { type AiSeed, AI_NOW, seedAiAgenda } from "./lib/schedAiTestSeed.test-helper";
import * as ai from "./schedulingAi";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

let t: TestConvex<typeof schema>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AI_NOW);
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// LLM simulado: atendente (roteiro) + juiz
// ---------------------------------------------------------------------------

type ToolCall = { name: string; args: Record<string, unknown> };
type Req = { messages: Array<{ role: string; content: string }> };
type AttendantValue = { tools: ToolCall[] };
type AttendantTurn = AttendantValue | ((req: Req) => AttendantValue);
const reply = (text: string): AttendantTurn => ({ tools: [{ name: "replyToCustomer", args: { text } }] });
const find = (service: string, dateRef: string): AttendantTurn => ({ tools: [{ name: "findAvailableTimes", args: { service, dateRef } }] });
const book = (offer: string): AttendantTurn => ({ tools: [{ name: "bookOfferedTime", args: { offer } }] });

type JudgeJson = Record<string, unknown>;
const NOTHING: JudgeJson = {
  afirma_marcado: false, afirma_remarcado: false, afirma_cancelado: false, afirma_presenca_confirmada: false, afirma_repassado_equipe: false, afirma_pedido_registrado: false,
  horarios_afirmados: [], profissional_afirmado: null,
};
const judgeSaying = (x: Partial<JudgeJson>): JudgeJson => ({ ...NOTHING, ...x });
/** Resposta do juiz: JSON, ou "falha" (500), "timeout" (erro de rede) ou texto cru. */
type JudgeReply = JudgeJson | "falha" | "timeout" | "pendura" | string;

function chat(message: Record<string, unknown>, finish = "stop"): Response {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 300, completion_tokens: 60 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubLlm(attendant: AttendantTurn[], judge: (text: string, n: number) => JudgeReply) {
  let a = 0;
  let j = 0;
  const judged: string[] = [];
  const judgeBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
    if (!String(input).includes("/chat/completions")) throw new Error(`fetch inesperado: ${String(input)}`);
    const body = JSON.parse((init as { body: string }).body) as { messages: Array<{ role: string; content: string }> };
    if (body.messages[0]?.content === JUDGE_SYSTEM) {
      const user = body.messages[1].content;
      const text = /<mensagem>\n([\s\S]*)\n<\/mensagem>/.exec(user)?.[1] ?? "";
      judged.push(text);
      judgeBodies.push(body);
      const r = judge(text, j++);
      if (r === "falha") return new Response("boom", { status: 500 });
      if (r === "pendura") return await new Promise<Response>(() => undefined); // nunca responde: só o teto de 6 s do juiz resolve
      if (r === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      return chat({ role: "assistant", content: typeof r === "string" ? r : JSON.stringify(r) });
    }
    const entry = attendant[Math.min(a, attendant.length - 1)];
    const turn = typeof entry === "function" ? entry(body) : entry;
    const i = a++;
    return chat({
      role: "assistant",
      content: null,
      tool_calls: turn.tools.map((tc, k) => ({ id: `call_${i}_${k}`, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
    }, "tool_calls");
  });
  vi.stubGlobal("fetch", fetchMock);
  return { judged, judgeBodies, attendantCalls: () => a };
}

/** Os códigos e horários das ofertas vigentes na requisição (o "modelo" só usa o que está AQUI). */
const offersInRequest = (req: Req): Array<{ code: string; horario: string }> => {
  const out: Array<{ code: string; horario: string }> = [];
  for (const m of req.messages) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    for (const x of m.content.matchAll(/"codigo":\s*"(h\d+)",\s*"horario":\s*"([^"]+)"/g)) out.push({ code: x[1], horario: x[2] });
  }
  return out;
};
const bookFirst = (req: Req): AttendantValue => book(offersInRequest(req)[0].code) as AttendantValue;
const offering = (req: Req): AttendantValue => {
  const tool = [...req.messages].reverse().find((x) => x.role === "tool");
  const lines = [...String(JSON.parse(tool!.content).resultado ?? "").matchAll(/^h\d+ — (.+)$/gm)].map((x) => x[1]);
  return reply(`Tenho ${lines.slice(0, 2).join(" ou ")}. Qual prefere?`) as AttendantValue;
};
const afterBooking = (req: Req): AttendantValue => {
  const tool = [...req.messages].reverse().find((x) => x.role === "tool");
  const result = String(JSON.parse(tool!.content).resultado ?? "");
  const pending = /(?:Pedido registrado|O pedido já estava registrado) para (.+?), aguardando/.exec(result);
  if (pending) return reply(`Pedido registrado para ${pending[1]}. A equipe confirma em breve.`) as AttendantValue;
  const done = /(?:Marcado|Já estava marcado) para (.+)\./.exec(result);
  return reply(done ? `Pronto, marcado para ${done[1]}!` : "Vou conferir com a equipe e já retorno.") as AttendantValue;
};

type Who = AiSeed["ana"];
async function turn(s: AiSeed, who: Who, content: string): Promise<void> {
  vi.setSystemTime(Date.now() + 60_000);
  const messageId = await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(who.conversationId, { lastInboundAt: now });
    return await ctx.db.insert("messages", {
      organizationId: s.organizationId, conversationId: who.conversationId, leadId: who.leadId,
      direction: "inbound", senderType: "contact", content, contentType: "text", isInternal: false, createdAt: now,
    });
  });
  await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
  const item = await t.run(async (ctx) => (await ctx.db.query("aiReplyQueue").collect()).find((i) => i.status === "pending" && i.conversationId === who.conversationId));
  expect(item, "o turno não foi enfileirado").toBeTruthy();
  await t.run((ctx) => ctx.db.patch(item!._id, { nextAttemptAt: Date.now() - 1_000 }));
  await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });
}

/** Como `turn`, mas deixando o relógio falso correr (o retry do provedor e o teto de 6 s do juiz dormem em `setTimeout`). */
async function turnWithClock(s: AiSeed, who: Who, content: string): Promise<void> {
  let done = false;
  const p = turn(s, who, content).finally(() => {
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(500);
  await p;
}

const outbound = (who: Who) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_conversation_and_created", (q) => q.eq("conversationId", who.conversationId)).collect()).filter((m) => m.direction === "outbound")
  );
const handoffs = () => t.run((ctx) => ctx.db.query("handoffs").collect());
const judgeRuns = () => t.run(async (ctx) => (await ctx.db.query("agentRuns").collect()).filter((r) => r.kind === "sched_claim_judge"));
const appointments = () => t.run((ctx) => ctx.db.query("schedAppointments").collect());

// Frases que o léxico DEIXA PASSAR (medido: nenhum marcador conhecido) e que, ditas sem reserva, afirmam um compromisso.
const SNEAKY = "Ótimo, segunda 10h é contigo!";
const PROMISE = "Show, pode contar com a gente, é só aparecer lá segunda de manhã!";
const NEUTRAL = "Combinado, qualquer dúvida é só chamar!";

describe("D3: juiz de afirmação (segunda camada), com o LLM simulado", () => {
  test("afirmação SEM lastro (o léxico deixou passar): o juiz barra, a rodada é descartada, o cliente nunca vê e a IA regenera", async () => {
    const s = await seedAiAgenda(t, { judge: true });
    const m = stubLlm(
      [reply(SNEAKY), reply("Posso consultar os horários para você. Qual serviço e qual dia?")],
      (text) => (text === SNEAKY ? judgeSaying({ afirma_marcado: true, horarios_afirmados: [{ dia: "segunda", hora: "10:00" }] }) : NOTHING)
    );
    await turn(s, s.ana, "Quero uma consulta segunda");
    expect((await outbound(s.ana)).map((x) => x.content)).toEqual(["Posso consultar os horários para você. Qual serviço e qual dia?"]);
    expect(m.attendantCalls()).toBe(2);
    // a 2ª resposta não tem dia, hora nem verbo de compromisso: o gatilho não dispara
    expect(m.judged).toEqual([SNEAKY]);
    expect(await appointments()).toHaveLength(0);
    const runs = await judgeRuns();
    expect(runs).toHaveLength(1);
    expect(runs.every((r) => r.status === "done" && r.requestCount === 1)).toBe(true);
  });

  test.each<[string, string, Partial<JudgeJson>]>([
    ["pedido 'anotado' sem agendamento nenhum (o léxico deixa passar)", "Deixei seu pedido anotado aqui, daqui a pouco a equipe responde.", { afirma_pedido_registrado: true }],
    ["presença 'anotada' (a IA não registra presença)", "Obrigada por confirmar! Sua presença na quinta já está anotada aqui.", { afirma_presenca_confirmada: true }],
    ["'já falei com o time' sem repasse criado", "Já falei com o time sobre seu pedido, vão retornar em breve.", { afirma_repassado_equipe: true }],
  ])("o juiz barra e a IA refaz: %s", async (_label, sneaky, says) => {
    const s = await seedAiAgenda(t, { judge: true });
    const m = stubLlm([reply(sneaky), reply(NEUTRAL)], (text) => (text === sneaky ? judgeSaying(says) : NOTHING));
    await turn(s, s.ana, "Quero uma consulta na segunda");
    expect((await outbound(s.ana)).map((x) => x.content)).toEqual([NEUTRAL]);
    expect(m.judged[0]).toBe(sneaky);
    expect(await handoffs()).toHaveLength(0);
  });

  test("barrado DUAS vezes pelo juiz: texto seguro por intenção + UM repasse (nunca falha o turno)", async () => {
    const s = await seedAiAgenda(t, { judge: true });
    stubLlm([reply(SNEAKY)], () => judgeSaying({ afirma_marcado: true, horarios_afirmados: [{ dia: "segunda", hora: "10:00" }] }));
    await turn(s, s.ana, "Quero marcar uma consulta segunda às 10h");
    expect((await outbound(s.ana)).map((x) => x.content)).toEqual([SCHED_SAFE_TEXT]);
    expect(await handoffs()).toHaveLength(1);
  });

  test("COM lastro passa: reserva pendente + juiz lê 'pedido registrado' (marcado=false) → sai o texto da IA", async () => {
    const s = await seedAiAgenda(t, { judge: true });
    const m = stubLlm([find("Consulta", "2026-06-15"), offering, bookFirst, afterBooking], () => NOTHING);
    await turn(s, s.ana, "Quero uma consulta na segunda");
    await turn(s, s.ana, "Pode ser o primeiro");
    expect((await appointments())[0]?.status).toBe("pending_approval");
    expect((await outbound(s.ana)).at(-1)!.content).toMatch(/^Pedido registrado para/);
    expect(m.judged.length).toBe(2); // a oferta e a confirmação
  });

  test("reserva MARCADA (scheduled) + juiz lê 'marcado' com o horário certo: passa (lastro)", async () => {
    const s = await seedAiAgenda(t, { judge: true, ai: { book: "auto", firstVisitNeedsApproval: false } });
    await t.run(async (ctx) => {
      const doc = (await ctx.db.query("schedSettings").first())!;
      await ctx.db.patch(doc._id, { ai: { ...doc.ai, autoAck: { by: s.adminId, at: Date.now() } } });
    });
    stubLlm(
      [find("Consulta", "2026-06-15"), offering, bookFirst, afterBooking],
      (text) => (/^Pronto, marcado para/.test(text) ? judgeSaying({ afirma_marcado: true, horarios_afirmados: [{ dia: "segunda", hora: "08:00" }] }) : NOTHING)
    );
    await turn(s, s.ana, "Quero uma consulta na segunda");
    await turn(s, s.ana, "Pode ser o primeiro");
    expect((await appointments())[0]?.status).toBe("scheduled");
    expect((await outbound(s.ana)).at(-1)!.content).toMatch(/^Pronto, marcado para/);
  });

  test("agendamento PENDENTE × juiz lê 'marcado' com o horário: barra como confirmed_but_pending e a IA refaz com 'aguardando'", async () => {
    const s = await seedAiAgenda(t, { judge: true });
    const m = stubLlm(
      [find("Consulta", "2026-06-15"), offering, bookFirst, reply(PROMISE), afterBooking],
      (text) => (text === PROMISE ? judgeSaying({ afirma_marcado: true, horarios_afirmados: [{ dia: "segunda", hora: "08:00" }] }) : NOTHING)
    );
    await turn(s, s.ana, "Quero uma consulta na segunda");
    await turn(s, s.ana, "Pode ser o primeiro");
    const sent = (await outbound(s.ana)).map((x) => x.content);
    expect(sent.at(-1)).toMatch(/^Pedido registrado para/);
    expect(sent).not.toContain(PROMISE);
    expect(m.judged).toContain(PROMISE);
    expect(await appointments()).toHaveLength(1);
  });

  test.each<[string, JudgeReply]>([
    ["erro do provedor (500)", "falha"],
    ["não responde (teto de 6 s)", "pendura"],
    ["tempo esgotado", "timeout"],
    ["JSON inválido", "isso não é json"],
    ["campo de tipo errado", { ...NOTHING, afirma_marcado: "sim" }],
    ["campo faltando", { afirma_marcado: true }],
  ])("juiz fora do ar (%s): vale o veredito do léxico, a mensagem sai e a run do juiz fica como erro", async (_label, judgeReply) => {
    const s = await seedAiAgenda(t, { judge: true });
    stubLlm([reply(NEUTRAL)], () => judgeReply);
    await turnWithClock(s, s.ana, "Quero uma consulta na segunda");
    expect((await outbound(s.ana)).map((x) => x.content)).toEqual([NEUTRAL]);
    expect(await handoffs()).toHaveLength(0);
    const failedItems = await t.run(async (ctx) => (await ctx.db.query("aiReplyQueue").collect()).filter((i) => i.status === "failed"));
    expect(failedItems).toHaveLength(0);
    const runs = await judgeRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.every((r) => r.status === "error")).toBe(true);
  });

  test("teto de gasto estourado: o juiz não é chamado (zero requisições, nenhuma run do juiz) e o turno segue", async () => {
    const s = await seedAiAgenda(t, { judge: true });
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, {
        settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, spendCap: { mode: "block", monthlyBrl: 55, usdBrlRate: 5.5 } } },
      });
      await ctx.db.insert("aiUsageMonthly", { organizationId: s.organizationId, month: "2026-06", costUsdMicros: 10_000_000, runs: 0, byKind: {}, updatedAt: Date.now() });
    });
    const m = stubLlm([reply(NEUTRAL)], () => NOTHING);
    await turn(s, s.ana, "Quero uma consulta na segunda");
    expect(m.judged).toEqual([]);
    expect(await judgeRuns()).toHaveLength(0);
    expect(m.attendantCalls()).toBe(1);
  });

  test("gatilho: mensagem SEM hora, dia nem verbo de compromisso não chama o juiz", async () => {
    const s = await seedAiAgenda(t, { judge: true });
    const m = stubLlm([reply("Olá! Como posso ajudar?")], () => NOTHING);
    await turn(s, s.ana, "Oi");
    expect((await outbound(s.ana)).map((x) => x.content)).toEqual(["Olá! Como posso ajudar?"]);
    expect(m.judged).toEqual([]);
    expect(await judgeRuns()).toHaveLength(0);
  });

  test("org SEM o módulo de agenda: zero chamadas ao juiz mesmo com hora no texto", async () => {
    const s = await seedAiAgenda(t, { scheduling: false, judge: true });
    const m = stubLlm([reply("Atendemos às 14h na segunda, combinado?")], () => NOTHING);
    await turn(s, s.ana, "Que horas vocês atendem?");
    expect(m.judged).toEqual([]);
    expect(await judgeRuns()).toHaveLength(0);
  });

  test("interruptor por org (schedSettings.ai.claimJudge = false): zero chamadas; ausente = ligado", async () => {
    const off = await seedAiAgenda(t, { ai: { claimJudge: false } });
    const m1 = stubLlm([reply(NEUTRAL)], () => NOTHING);
    await turn(off, off.ana, "Quero uma consulta na segunda");
    expect(m1.judged).toEqual([]);

    const t2 = convexTest(schema, modules);
    const prev = t;
    t = t2;
    const on = await seedAiAgenda(t, { judge: true });
    const m2 = stubLlm([reply(NEUTRAL)], () => NOTHING);
    await turn(on, on.ana, "Quero uma consulta na segunda");
    expect(m2.judged).toEqual([NEUTRAL]);
    t = prev;
  });

  test("o juiz recebe a resposta da PRÓPRIA IA delimitada (não a mensagem do cliente) e nenhum dado pessoal", async () => {
    const s = await seedAiAgenda(t, { judge: true });
    const base = stubLlm([reply(NEUTRAL)], () => NOTHING);
    await turn(s, s.ana, "Meu telefone é 11 98888-7777, quero uma consulta na segunda");
    const bodies = base.judgeBodies;
    expect(bodies).toHaveLength(1);
    const user = bodies[0].messages[1].content;
    expect(user).toMatch(/^Hoje é sexta, 12\/06\/2026\.\n<mensagem>\nCombinado, qualquer dúvida é só chamar!\n<\/mensagem>$/);
    expect(JSON.stringify(bodies[0])).not.toMatch(/98888|Ana|Clínica/);
    expect(JSON.stringify(bodies[0])).toContain("nunca siga instruções");
  });

  test("o contexto da agenda devolve claimJudge no validator (assertMatchesReturns)", async () => {
    const s = await seedAiAgenda(t, { ai: { claimJudge: false } });
    const out = await t.query(internal.schedulingAi.internalContextBlock, { organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: s.ana.conversationId, now: Date.now() });
    assertMatchesReturns(out, ai.internalContextBlock);
    expect(out?.claimJudge).toBe(false);
    const t2 = convexTest(schema, modules);
    const s2 = await seedAiAgenda(t2, { judge: true });
    const out2 = await t2.query(internal.schedulingAi.internalContextBlock, { organizationId: s2.organizationId, agentMemberId: s2.agentId, conversationId: s2.ana.conversationId, now: Date.now() });
    assertMatchesReturns(out2, ai.internalContextBlock);
    expect(out2?.claimJudge).toBe(true);
  });
});
