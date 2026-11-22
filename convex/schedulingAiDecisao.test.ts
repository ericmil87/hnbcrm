/// <reference types="vite/client" />
/**
 * Agenda v2 (D3) — a IA acompanha a decisão da equipe sobre o pedido do cliente (RELATORIO-RODADA-2, bloco A).
 * Medido: a equipe aprova e o cliente pergunta "e aí, confirmou?" → 0 de 10 confirmavam; recusa → 0 de 10 certo; pedido vencido → a IA
 * não sabia. O "modelo" aqui LÊ o envelope (`horarios_do_cliente`: situação real + o que dizer), como um modelo de verdade, e o juiz é simulado.
 * Nenhum aviso sai ao cliente quando a equipe decide: é a IA quem responde quando ele pergunta.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { JUDGE_SYSTEM } from "./lib/schedClaimJudge";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { type AiSeed, AI_NOW, seedAiAgenda } from "./lib/schedAiTestSeed.test-helper";
import * as ai from "./schedulingAi";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const HOUR = 3_600_000;

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
// LLM simulado (atendente por roteiro que lê o envelope + juiz)
// ---------------------------------------------------------------------------

type ToolCall = { name: string; args: Record<string, unknown> };
type Req = { messages: Array<{ role: string; content: string }> };
type Value = { tools: ToolCall[] };
type Entry = Value | ((req: Req) => Value);
const reply = (text: string): Value => ({ tools: [{ name: "replyToCustomer", args: { text } }] });
const find = (service: string, dateRef: string): Value => ({ tools: [{ name: "findAvailableTimes", args: { service, dateRef } }] });
const book = (offer: string): Value => ({ tools: [{ name: "bookOfferedTime", args: { offer } }] });

type Item = { ref: string; horario: string; servico: string; situacao: string; o_que_dizer: string };
/** `horarios_do_cliente` do ÚLTIMO envelope da requisição (o que um modelo real leria). */
function envelopeOf(req: Req): Item[] {
  const text = [...req.messages].reverse().map((m) => String(m.content)).find((c) => c.includes('"horarios_do_cliente"')) ?? "";
  const start = text.indexOf("[", text.indexOf('"horarios_do_cliente"'));
  if (start < 0) return [];
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "[") depth++;
    if (text[i] === "]" && --depth === 0) return JSON.parse(text.slice(start, i + 1)) as Item[];
  }
  return [];
}
const lastToolResult = (req: Req) => JSON.parse([...req.messages].reverse().find((m) => m.role === "tool")!.content) as Record<string, unknown>;
const offersIn = (req: Req) => {
  const out: Array<{ code: string }> = [];
  for (const m of req.messages) if (m.role === "user") for (const x of String(m.content).matchAll(/"codigo":\s*"(h\d+)",\s*"horario":\s*"([^"]+)"/g)) out.push({ code: x[1] });
  return out;
};
const offering: Entry = (req) => reply(`Tenho ${[...String(lastToolResult(req).resultado ?? "").matchAll(/^h\d+ — (.+)$/gm)].map((x) => x[1]).slice(0, 2).join(" ou ")}. Qual prefere?`);
const bookFirst: Entry = (req) => book(offersIn(req)[0].code);
const afterBooking: Entry = (req) => {
  const m = /(?:Pedido registrado) para (.+?), aguardando/.exec(String(lastToolResult(req).resultado ?? ""));
  return reply(m ? `Pedido registrado para ${m[1]}. A equipe confirma em breve.` : "Vou conferir com a equipe e já retorno.");
};
/** Um modelo que OBEDECE a situação do envelope. */
const followsEnvelope: Entry = (req) => {
  const it = envelopeOf(req)[0];
  if (!it) return reply("Não encontrei nenhum pedido seu por aqui.");
  if (it.situacao === "marcado" || it.situacao === "confirmado") return reply(`Seu horário está marcado para ${it.horario}!`);
  if (it.situacao === "recusado pela equipe") return reply(`Desculpe, a equipe não conseguiu confirmar ${it.horario}. Quer que eu consulte outros horários?`);
  if (it.situacao.startsWith("venceu")) return reply(`O pedido para ${it.horario} venceu sem resposta da equipe. Posso consultar os horários de novo?`);
  return reply(`Seu pedido para ${it.horario} segue aguardando a confirmação da equipe.`);
};
const STALE = "Ainda não, seu pedido segue aguardando a confirmação da equipe. Assim que liberarem, te aviso por aqui.";

type JudgeJson = Record<string, unknown>;
const NOTHING: JudgeJson = {
  afirma_marcado: false, afirma_remarcado: false, afirma_cancelado: false, afirma_presenca_confirmada: false, afirma_repassado_equipe: false,
  afirma_pedido_registrado: false, afirma_aguardando_equipe: false, horarios_afirmados: [], profissional_afirmado: null,
};

function chat(message: Record<string, unknown>, finish = "stop"): Response {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 300, completion_tokens: 60 } }), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** `judge` recebe o texto julgado e devolve o JSON do juiz (ou usa NOTHING). */
function stubLlm(script: Entry[], judge: (text: string) => JudgeJson = () => NOTHING) {
  let a = 0;
  const judged: string[] = [];
  const requests: Req[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: unknown) => {
      if (!String(input).includes("/chat/completions")) throw new Error(`fetch inesperado: ${String(input)}`);
      const body = JSON.parse((init as { body: string }).body) as Req;
      if (body.messages[0]?.content === JUDGE_SYSTEM) {
        const text = /<mensagem>\n([\s\S]*)\n<\/mensagem>/.exec(body.messages[1].content)?.[1] ?? "";
        judged.push(text);
        return chat({ role: "assistant", content: JSON.stringify(judge(text)) });
      }
      requests.push(body);
      const entry = script[Math.min(a, script.length - 1)];
      const turn = typeof entry === "function" ? entry(body) : entry;
      const i = a++;
      return chat({ role: "assistant", content: null, tool_calls: turn.tools.map((tc, k) => ({ id: `call_${i}_${k}`, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) }, "tool_calls");
    })
  );
  return { judged, requests, attendantCalls: () => a };
}

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

const outbound = (who: Who) =>
  t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_conversation_and_created", (q) => q.eq("conversationId", who.conversationId)).collect()).filter((m) => m.direction === "outbound")
  );
const lastReply = async (who: Who) => (await outbound(who)).at(-1)!.content;
const handoffs = () => t.run((ctx) => ctx.db.query("handoffs").collect());
const appointments = () => t.run((ctx) => ctx.db.query("schedAppointments").collect());
const asAdmin = (s: AiSeed) => t.run(async (ctx) => ({ type: "human" as const, member: (await ctx.db.get(s.adminId))!, via: "app" as const }));

/** O cliente pede, a IA oferece e REGISTRA o pedido (pendente de aprovação). Devolve o rótulo do horário do pedido. */
async function requestPending(s: AiSeed, service = "Consulta") {
  const m = stubLlm([find(service, "2026-06-15"), offering, bookFirst, afterBooking]);
  await turn(s, s.ana, "Quero uma consulta na segunda");
  await turn(s, s.ana, "Pode ser o primeiro");
  const appts = await appointments();
  expect(appts.some((a) => a.status === "pending_approval")).toBe(true);
  return { m, appts };
}

async function approve(s: AiSeed, appointmentId: Id<"schedAppointments">) {
  const actor = await asAdmin(s);
  await t.run(async (ctx) => {
    const { setAppointmentStatusCore } = await import("./lib/schedBookingOps");
    await setAppointmentStatusCore(ctx, { appointment: (await ctx.db.get(appointmentId))!, actor, to: "scheduled", now: Date.now() });
  });
}
async function decline(s: AiSeed, appointmentId: Id<"schedAppointments">) {
  const actor = await asAdmin(s);
  await t.run(async (ctx) => {
    const { cancelAppointmentCore } = await import("./lib/schedBookingOps");
    await cancelAppointmentCore(ctx, { appointment: (await ctx.db.get(appointmentId))!, actor, byClass: "staff", reason: "recusado", now: Date.now() });
  });
}
async function expire(s: AiSeed, appointmentId: Id<"schedAppointments">, startTime: number) {
  vi.setSystemTime(startTime + HOUR);
  await t.run(async (ctx) => {
    const { expireProposalCore } = await import("./lib/schedBookingOps");
    expect(await expireProposalCore(ctx, { organizationId: s.organizationId, appointmentId, now: Date.now() })).toBe(true);
  });
}

describe("D3: a IA acompanha a decisão da equipe (envelope com a situação real + o que dizer)", () => {
  test("APROVADO: o envelope traz 'marcado' com a instrução; 'e aí, confirmou?' recebe 'está marcado para …' (e o guard NÃO troca por texto seguro)", async () => {
    const s = await seedAiAgenda(t);
    const { appts } = await requestPending(s);
    await approve(s, appts[0]._id);
    const m = stubLlm([followsEnvelope]);
    await turn(s, s.ana, "e aí, confirmou?");
    const env = envelopeOf(m.requests[0]);
    expect(env).toHaveLength(1);
    expect(env[0]).toMatchObject({ situacao: "marcado", servico: "Consulta" });
    expect(env[0].o_que_dizer).toMatch(/^pode confirmar ao cliente: está marcado para segunda-feira, 15\/06/);
    expect(await lastReply(s.ana)).toMatch(/^Seu horário está marcado para segunda-feira, 15\/06, às \d{2}:\d{2}!$/);
    expect(await handoffs()).toHaveLength(0);
    expect(m.attendantCalls()).toBe(1);
  });

  test("RECUSADO pela equipe: o envelope traz 'recusado pela equipe' (sem motivo nem quem decidiu); a IA pede desculpas e oferece consultar; o texto passa pelo guard", async () => {
    const s = await seedAiAgenda(t);
    const { appts } = await requestPending(s);
    await decline(s, appts[0]._id);
    const m = stubLlm([followsEnvelope]);
    await turn(s, s.ana, "deu certo meu horário?");
    const env = envelopeOf(m.requests[0]);
    expect(env).toHaveLength(1);
    expect(env[0].situacao).toBe("recusado pela equipe");
    expect(env[0].o_que_dizer).toMatch(/peça desculpas.*ofereça consultar outros horários/);
    const raw = JSON.stringify(m.requests[0].messages);
    expect(raw).not.toMatch(/recusado"|cancelReason|Admin|staff/);
    expect(await lastReply(s.ana)).toMatch(/^Desculpe, a equipe não conseguiu confirmar segunda-feira, 15\/06, às \d{2}:\d{2}\. Quer que eu consulte outros horários\?$/);
    expect(await handoffs()).toHaveLength(0);
  });

  test("depois da RECUSA a IA consulta e oferece de novo (a busca NÃO é recusada por 'já tem pedido') e a reserva nova entra", async () => {
    const s = await seedAiAgenda(t);
    const { appts } = await requestPending(s);
    await decline(s, appts[0]._id);
    const m = stubLlm([find("Consulta", "2026-06-16"), offering, bookFirst, afterBooking]);
    await turn(s, s.ana, "então tem outro horário na terça?");
    const found = lastToolResult(m.requests[1]);
    expect(found.status).toBe("ok");
    expect(await lastReply(s.ana)).toMatch(/^Tenho terça-feira, 16\/06/);
    await turn(s, s.ana, "pode ser o primeiro");
    const pending = (await appointments()).filter((a) => a.status === "pending_approval");
    expect(pending).toHaveLength(1);
    expect(pending[0].startTime).not.toBe(appts[0].startTime);
  });

  test("VENCIDO sem decisão: o envelope diz que venceu; a IA oferece consultar de novo; e consultar funciona", async () => {
    const s = await seedAiAgenda(t);
    const { appts } = await requestPending(s);
    await expire(s, appts[0]._id, appts[0].startTime);
    const m = stubLlm([followsEnvelope]);
    await turn(s, s.ana, "e aí, alguma novidade?");
    const env = envelopeOf(m.requests[0]);
    expect(env[0].situacao).toBe("venceu sem resposta da equipe");
    expect(env[0].o_que_dizer).toMatch(/venceu sem resposta.*ofereça consultar os horários de novo/);
    expect(await lastReply(s.ana)).toMatch(/venceu sem resposta da equipe\. Posso consultar os horários de novo\?$/);
  });

  test("antes da decisão o envelope diz 'aguardando a equipe' e manda não dizer que está marcado", async () => {
    const s = await seedAiAgenda(t);
    await requestPending(s);
    const m = stubLlm([followsEnvelope]);
    await turn(s, s.ana, "e aí, confirmou?");
    const env = envelopeOf(m.requests[0]);
    expect(env[0].situacao).toBe("aguardando confirmação da equipe");
    expect(env[0].o_que_dizer).toMatch(/não diga que está marcado/);
    expect(await lastReply(s.ana)).toMatch(/segue aguardando a confirmação da equipe\.$/);
  });

  test("cancelado pelo CLIENTE ou depois de aprovado é 'cancelado' (não 'recusado'); passou de 72 h sai do envelope", async () => {
    const s = await seedAiAgenda(t);
    const { appts } = await requestPending(s);
    await approve(s, appts[0]._id);
    const actor = await asAdmin(s);
    await t.run(async (ctx) => {
      const { cancelAppointmentCore } = await import("./lib/schedBookingOps");
      await cancelAppointmentCore(ctx, { appointment: (await ctx.db.get(appts[0]._id))!, actor, byClass: "staff", reason: "x", now: Date.now() });
    });
    const m = stubLlm([followsEnvelope]);
    await turn(s, s.ana, "meu horário está marcado ainda?");
    expect(envelopeOf(m.requests[0])[0].situacao).toBe("cancelado");
    expect(envelopeOf(m.requests[0])[0].o_que_dizer).toMatch(/não está mais marcado/);
    // 4 dias depois a decisão já não aparece
    vi.setSystemTime(Date.now() + 4 * 24 * HOUR);
    const m2 = stubLlm([reply("Oi! Em que posso ajudar?")]);
    await turn(s, s.ana, "oi");
    expect(envelopeOf(m2.requests[0])).toEqual([]);
  });

  test("a causa medida: sem a situação no contexto a IA repete 'aguardando' (história) — com ela, o juiz barra 'ainda aguardando' e a IA refaz certo", async () => {
    const s = await seedAiAgenda(t, { judge: true });
    const { appts } = await requestPending(s);
    await approve(s, appts[0]._id);
    const m = stubLlm(
      [reply(STALE), followsEnvelope],
      (text) => (text === STALE ? { ...NOTHING, afirma_aguardando_equipe: true, horarios_afirmados: [{ dia: "segunda", hora: "08:00" }] } : { ...NOTHING, afirma_marcado: true, horarios_afirmados: [{ dia: "segunda", hora: "08:00" }] })
    );
    await turn(s, s.ana, "e aí, confirmou?");
    expect(m.judged[0]).toBe(STALE);
    expect(m.attendantCalls()).toBe(2);
    expect(JSON.stringify(m.requests[1].messages.at(-1))).toContain("a situação já mudou");
    expect(await lastReply(s.ana)).toMatch(/^Seu horário está marcado para segunda-feira, 15\/06/);
    expect((await outbound(s.ana)).map((x) => x.content)).not.toContain(STALE);
  });

  test("RECUSADO e a IA insiste em 'ainda aguardando' duas vezes: texto seguro de SITUAÇÃO montado pelo servidor (diz que não foi possível e que dá para consultar outros), sem repasse", async () => {
    const s = await seedAiAgenda(t, { judge: true });
    const { appts } = await requestPending(s);
    await decline(s, appts[0]._id);
    stubLlm([reply(STALE)], () => ({ ...NOTHING, afirma_aguardando_equipe: true }));
    await turn(s, s.ana, "e aí, confirmou?");
    expect(await lastReply(s.ana)).toMatch(/^Não foi possível confirmar o horário de segunda-feira, 15\/06, às \d{2}:\d{2}: a equipe não conseguiu aprovar esse pedido\. Posso consultar outros horários para você\.$/);
    expect(await handoffs()).toHaveLength(0);
  });

  test("APROVADO e a IA erra duas vezes: o texto seguro diz o horário real ('que dia é o meu?' nunca fica sem o dia)", async () => {
    const s = await seedAiAgenda(t);
    const { appts } = await requestPending(s);
    await approve(s, appts[0]._id);
    // sexta às 9h não é o horário dele: o léxico barra duas vezes
    stubLlm([reply("Marquei você para sexta às 9h!")]);
    await turn(s, s.ana, "que dia é mesmo o meu horário?");
    const expected = (await appointments())[0];
    expect(await lastReply(s.ana)).toMatch(/^Seu horário está marcado para segunda-feira, 15\/06, às 0?\d:\d{2}\.$/);
    expect(expected.status).toBe("scheduled");
    expect(await handoffs()).toHaveLength(0);
  });

  test("aprovado: pedir outro horário para o MESMO serviço é remarcação → repasse (a busca é recusada, como antes)", async () => {
    const s = await seedAiAgendaWithApproved();
    async function seedAiAgendaWithApproved() {
      const x = await seedAiAgenda(t);
      const { appts } = await requestPending(x);
      await approve(x, appts[0]._id);
      return x;
    }
    const m = stubLlm([find("Consulta", "2026-06-16"), (req) => (lastToolResult(req).error === "remarcacao_e_com_a_equipe" ? { tools: [{ name: "requestHandoff", args: { reason: "Cliente quer remarcar" } }, { name: "replyToCustomer", args: { text: "Remarcar é com a equipe, já avisei eles." } }] } : reply("erro")) ]);
    await turn(s, s.ana, "quero remarcar para terça");
    expect(lastToolResult(m.requests[1])).toMatchObject({ status: "erro", error: "remarcacao_e_com_a_equipe" });
    expect(await handoffs()).toHaveLength(1);
  });

  test("a IA nunca afirma 'marcado' para o horário RECUSADO (o guard barra e o juiz também)", async () => {
    const s = await seedAiAgenda(t);
    const { appts } = await requestPending(s);
    await decline(s, appts[0]._id);
    const m = stubLlm([reply("Seu horário de segunda às 8h está confirmado!"), followsEnvelope]);
    await turn(s, s.ana, "e aí?");
    expect((await outbound(s.ana)).map((x) => x.content)).not.toContain("Seu horário de segunda às 8h está confirmado!");
    expect(await lastReply(s.ana)).toMatch(/^Desculpe, a equipe não conseguiu confirmar/);
    expect(m.attendantCalls()).toBe(2);
  });
});

describe("D3: grupo aprovado ou recusado", () => {
  async function requestGroup(s: AiSeed) {
    const m = stubLlm([
      { tools: [{ name: "findAvailableTimes", args: { service: "Massagem casal", dateRef: "2026-06-15", people: 2 } }] },
      offering,
      bookFirst,
      afterBooking,
    ]);
    await turn(s, s.ana, "Queremos massagem segunda eu e minha amiga, juntas");
    await turn(s, s.ana, "Pode ser o primeiro");
    const rows = (await appointments()).filter((a) => a.partyKey !== undefined);
    expect(rows).toHaveLength(2);
    return { m, rows };
  }

  test("aprovar UM membro aprova o grupo e o cliente (pessoa principal) vê 'marcado'", async () => {
    const s = await seedAiAgenda(t);
    const { rows } = await requestGroup(s);
    await approve(s, rows.find((r) => r.guestName !== undefined)!._id);
    const m = stubLlm([followsEnvelope]);
    await turn(s, s.ana, "e aí, confirmou pra nós duas?");
    expect(envelopeOf(m.requests[0])).toHaveLength(1); // o acompanhante não tem contato: uma linha só
    expect(envelopeOf(m.requests[0])[0].situacao).toBe("marcado");
    expect(await lastReply(s.ana)).toMatch(/^Seu horário está marcado para/);
  });

  test("recusar o grupo: o envelope diz 'recusado pela equipe' e a IA oferece consultar de novo", async () => {
    const s = await seedAiAgenda(t);
    const { rows } = await requestGroup(s);
    await decline(s, rows.find((r) => r.guestName === undefined)!._id);
    expect((await appointments()).map((a) => a.status)).toEqual(["cancelled", "cancelled"]);
    const m = stubLlm([followsEnvelope]);
    await turn(s, s.ana, "e aí, deu certo pra nós duas?");
    expect(envelopeOf(m.requests[0])).toHaveLength(1);
    expect(envelopeOf(m.requests[0])[0].situacao).toBe("recusado pela equipe");
    expect(await lastReply(s.ana)).toMatch(/^Desculpe, a equipe não conseguiu confirmar/);
  });
});

describe("D3: contexto da agenda (decisões recentes) e limite de tool calls", () => {
  test("o contexto devolve as decisões no validator e classifica: recusado × cancelado × vencido", async () => {
    const s = await seedAiAgenda(t);
    const { appts } = await requestPending(s);
    await decline(s, appts[0]._id);
    const out = await t.query(internal.schedulingAi.internalContextBlock, { organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: s.ana.conversationId, now: Date.now() });
    assertMatchesReturns(out, ai.internalContextBlock);
    expect(out?.upcoming).toEqual([]);
    expect(out?.decided).toMatchObject([{ ref: "d1", kind: "declined", serviceName: "Consulta" }]);
    expect(JSON.stringify(out?.decided)).not.toMatch(/recusado|Admin/);
  });

  test("uma rodada que pede mais ferramentas do que o orçamento é DESCARTADA sem executar e a IA refaz UMA vez (antes: a run falhava)", async () => {
    const s = await seedAiAgenda(t);
    const many: Value = { tools: [{ name: "findAvailableTimes", args: { service: "Consulta", dateRef: "2026-06-15" }, ...{} }, ...Array.from({ length: 6 }, () => ({ name: "updateThisLeadInfo", args: { notes: "x" } }))] };
    const m = stubLlm([many, reply("Posso consultar os horários para você. Qual serviço e qual dia?")]);
    await turn(s, s.ana, "Oi, quero marcar para mim e minha amiga");
    expect(m.attendantCalls()).toBe(2);
    expect(JSON.stringify(m.requests[1].messages.at(-1))).toContain("pediu 7 ferramentas de uma vez e foi DESCARTADA sem executar nada");
    expect(await lastReply(s.ana)).toBe("Posso consultar os horários para você. Qual serviço e qual dia?");
    const runs = await t.run(async (ctx) => (await ctx.db.query("agentRuns").collect()).filter((r) => r.kind === "attendant"));
    expect(runs.every((r) => r.status === "done")).toBe(true);
    // nada foi executado na rodada descartada: sem ofertas gravadas
    const st = await t.run((ctx) => ctx.db.query("schedConversationState").first());
    expect(st?.offers ?? []).toHaveLength(0);
  });

  test("estourou de novo depois da regeneração: falha como antes (a fila repete; nada pela metade)", async () => {
    const s = await seedAiAgenda(t);
    const many: Value = { tools: Array.from({ length: 7 }, () => ({ name: "updateThisLeadInfo", args: { notes: "x" } })) };
    stubLlm([many]);
    await turn(s, s.ana, "Oi");
    expect((await outbound(s.ana)).length).toBe(0);
    const runs = await t.run(async (ctx) => (await ctx.db.query("agentRuns").collect()).filter((r) => r.kind === "attendant"));
    expect(runs.some((r) => r.status === "error")).toBe(true);
  });
});
