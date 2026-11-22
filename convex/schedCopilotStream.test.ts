/// <reference types="vite/client" />
/**
 * Agenda v2, E1: o laço COMPLETO do Copiloto (`POST /api/copilot/stream`) com o modelo simulado por `fetch`
 * (nenhuma chamada real). Confere o que o modelo RECEBE (tools por módulo e por permissão do membro) e o que ele
 * consegue FAZER (a escrita só gera a ação pendente; tool fora do turno não executa).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { type AgendaSeed, identityOf, type Person, seedAgenda } from "./lib/schedTestSeed.test-helper";
import { addLocalDays, atLocalMinutes, localDateOf, weekdayOf } from "./lib/schedTime";
import { makeRef, SCHED_COPILOT_READ_NAMES, SCHED_COPILOT_WRITE_NAMES } from "./lib/schedCopilotTools";
import { api } from "./_generated/api";
import { buildSearchText } from "./lib/searchText";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TZ = "America/Sao_Paulo";
const NOW = Date.now();

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-FAKE-test-key");
  vi.stubEnv("LLM_PLATFORM_ORDER", "openrouter-only");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function sseBody(frames: Array<Record<string, unknown> | "[DONE]">): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${f === "[DONE]" ? "[DONE]" : JSON.stringify(f)}\n\n`));
      controller.close();
    },
  });
}
const textFrames = (text: string) => [
  { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
  { choices: [{ delta: { content: text }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
  "[DONE]" as const,
];
const toolFrames = (name: string, args: Record<string, unknown>) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "" } }] }, finish_reason: null }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 } },
  "[DONE]" as const,
];
function stubLlm(responses: Array<Array<Record<string, unknown> | "[DONE]">>) {
  const calls: Array<{ body: { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> } }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      const next = responses.shift();
      if (!next) return new Response("no more fixtures", { status: 500 });
      return new Response(sseBody(next), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    })
  );
  return calls;
}
const toolNamesOf = (call: (typeof stubLlm extends (...a: any[]) => infer R ? R : never)[number]) => (call.body.tools ?? []).map((x) => x.function.name);

const weekly = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 }));

describe("laço do Copiloto com a agenda", { timeout: 30_000 }, () => {
  let t: TestConvex<typeof schema>;
  let s: AgendaSeed;
  const stream = async (who: Person, message: string, threadId?: Id<"copilotThreads">) => {
    const res = await t.withIdentity(identityOf(who)).fetch("/api/copilot/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: s.orgId, message, ...(threadId ? { threadId } : {}) }),
    });
    return (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  };

  beforeEach(async () => {
    t = convexTest(schema, modules);
    s = await seedAgenda(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.orgId))!;
      await ctx.db.patch(s.orgId, {
        settings: { ...org.settings, aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, lgpdAck: { acceptedAt: 1, acceptedBy: s.admin.memberId } } },
      });
    });
  });

  test("o modelo recebe as tools de agenda conforme módulo e permissão: edit = 14, view_own = 4, none = 0, módulo desligado = 0", async () => {
    const all = [...SCHED_COPILOT_READ_NAMES, ...SCHED_COPILOT_WRITE_NAMES];
    const run = async (who: Person) => {
      const calls = stubLlm([textFrames("ok")]);
      await stream(who, "oi");
      return toolNamesOf(calls[0]).filter((n) => (all as string[]).includes(n));
    };
    expect(await run(s.admin)).toEqual(all);
    expect(await run(s.viewOwn)).toEqual([...SCHED_COPILOT_READ_NAMES]);
    expect(await run(s.none)).toEqual([]);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.orgId))!;
      await ctx.db.patch(s.orgId, { settings: { ...org.settings, modules: { scheduling: false } } });
    });
    expect(await run(s.admin)).toEqual([]);
  });

  test("o prompt de agenda só existe para quem tem tools de agenda", async () => {
    let calls = stubLlm([textFrames("ok")]);
    await stream(s.admin, "oi");
    expect(calls[0].body.messages[0].content).toContain("AGENDA:");
    calls = stubLlm([textFrames("ok")]);
    await stream(s.none, "oi");
    expect(calls[0].body.messages[0].content).not.toContain("AGENDA:");
  });

  test("modelo pede para cancelar por referência: vira ação pendente, o agendamento segue marcado; só o clique cancela", async () => {
    // Relógio real (o laço com `fetch` não usa timers falsos): um dia útil daqui a ~1 semana, 10:00 local.
    let day = addLocalDays(localDateOf(Date.now(), TZ), 7);
    while (weekdayOf(day) === 0 || weekdayOf(day) === 6) day = addLocalDays(day, 1);
    const startTime = atLocalMinutes(day, 600, TZ);
    await t.run(async (ctx) => {
      await ctx.db.insert("schedResources", { organizationId: s.orgId, kind: "room", name: "Sala 1", capacity: 1, weekly, tags: [], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1 } as any);
      await ctx.db.insert("schedServices", { organizationId: s.orgId, name: "Sessão", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: [{ role: "Sala", kind: "room" }], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1 } as any);
    });
    const resources = await t.run((ctx) => ctx.db.query("schedResources").collect());
    const services = await t.run((ctx) => ctx.db.query("schedServices").collect());
    await t.withIdentity(identityOf(s.admin)).mutation(api.schedulingMutations.bookAppointment, {
      organizationId: s.orgId, serviceId: services[0]._id, startTime, resourceIds: [resources[0]._id], contactId: s.contactId,
    } as any);
    const appt = (await t.run((ctx) => ctx.db.query("schedAppointments").collect()))[0];
    const thread = await t.run((ctx) => ctx.db.insert("copilotThreads", { organizationId: s.orgId, memberId: s.admin.memberId, createdAt: NOW, updatedAt: NOW }));
    const ref = makeRef("a", appt.startTime, thread, appt._id);

    const calls = stubLlm([toolFrames("cancelAppointment", { ref, reason: "pedido do cliente" }), textFrames("Toque em Confirmar no cartão.")]);
    const events = await stream(s.admin, "cancela o das 10h", thread);
    expect(events.map((e) => e.type)).toContain("done");
    // o resultado da tool voltou ao modelo como dado envelopado, com a ação pendente
    const toolMsg = calls[1].body.messages.at(-1)!.content;
    expect(toolMsg).toContain("confirmacao_necessaria");
    const pend = await t.run((ctx) => ctx.db.query("pendingActions").collect());
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ tool: "cancelAppointment", status: "pending", requestedBy: s.admin.memberId, threadId: thread });
    expect((await t.run((ctx) => ctx.db.get(appt._id)))?.status).toBe("scheduled"); // o modelo não cancela sozinho

    await t.withIdentity(identityOf(s.admin)).mutation(api.copilot.confirmPendingAction, { pendingActionId: pend[0]._id });
    expect((await t.run((ctx) => ctx.db.get(appt._id)))?.status).toBe("cancelled");
  });

  test("view_own: se o modelo insistir numa tool de escrita, o turno a recusa e nada é gravado", async () => {
    stubLlm([toolFrames("cancelAppointment", { ref: "a1.abc" }), textFrames("Não consegui.")]);
    const events = await stream(s.viewOwn, "cancela tudo");
    expect(events.map((e) => e.type)).toContain("done");
    expect(await t.run((ctx) => ctx.db.query("pendingActions").collect())).toHaveLength(0);
    const tool = await t.run(async (ctx) => (await ctx.db.query("copilotMessages").collect()).filter((m) => m.role === "tool"));
    expect(tool[0].content).toContain("Ferramenta indisponível neste turno");
  });
});

describe("laço do Copiloto: pedido ambíguo, 'pode fazer direto' e busca vazia (modelo simulado)", { timeout: 30_000 }, () => {
  let t: TestConvex<typeof schema>;
  let s: AgendaSeed;
  let startLocal: string;
  const stream = async (who: Person, message: string, threadId?: Id<"copilotThreads">) => {
    const res = await t.withIdentity(identityOf(who)).fetch("/api/copilot/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: s.orgId, message, ...(threadId ? { threadId } : {}) }),
    });
    return (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  };
  const mkContact = (firstName: string, lastName: string, phone: string) =>
    t.run((ctx) =>
      ctx.db.insert("contacts", { organizationId: s.orgId, firstName, lastName, phone, tags: [], searchText: buildSearchText({ firstName, lastName, phone }), createdAt: 1, updatedAt: 1 })
    );
  const appts = () => t.run((ctx) => ctx.db.query("schedAppointments").collect());
  const pendings = () => t.run((ctx) => ctx.db.query("pendingActions").collect());
  /** Resultados de tool na ordem (a última chamada ao modelo carrega o histórico inteiro). */
  const toolResults = (calls: ReturnType<typeof stubLlm>) => calls.at(-1)!.body.messages.filter((m) => m.role === "tool").map((m) => m.content);

  beforeEach(async () => {
    t = convexTest(schema, modules);
    s = await seedAgenda(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.orgId))!;
      await ctx.db.patch(s.orgId, {
        settings: { ...org.settings, aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, lgpdAck: { acceptedAt: 1, acceptedBy: s.admin.memberId } } },
      });
      // O `convex-test` quebra a busca por texto se algum contato da org não tem `searchText` (a semente não grava): é a
      // causa do "busca vazia/erro" da simulação, só do harness (no Convex real, `searchText` ausente é aceito).
      await ctx.db.patch(s.contactId, { searchText: buildSearchText({ firstName: "Cliente" }) });
      await ctx.db.insert("schedResources", { organizationId: s.orgId, kind: "room", name: "Sala 1", capacity: 1, weekly, tags: [], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1 } as any);
      await ctx.db.insert("schedServices", { organizationId: s.orgId, name: "Sessão", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: [{ role: "Sala", kind: "room" }], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1 } as any);
    });
    let day = addLocalDays(localDateOf(Date.now(), TZ), 7);
    while (weekdayOf(day) === 0 || weekdayOf(day) === 6) day = addLocalDays(day, 1);
    startLocal = `${day}T10:00`;
  });

  test("dois Joãos: a busca devolve os dois candidatos; o modelo que chuta (nome no lugar do id, ou sem contato) é recusado e NADA é preparado nem gravado", async () => {
    const a = await mkContact("João", "Silva", "+5511999990001");
    const b = await mkContact("João", "Souza", "+5511999990002");
    const calls = stubLlm([
      toolFrames("searchContacts", { query: "João" }),
      toolFrames("bookAppointment", { contactId: "João", serviceName: "Sessão", startLocal }),
      toolFrames("bookAppointment", { serviceName: "Sessão", startLocal }),
      textFrames("Encontrei dois Joãos: João Silva e João Souza. Qual deles?"),
    ]);
    const events = await stream(s.admin, "marca o João amanhã às 10");
    expect(events.map((e) => e.type)).toContain("done");
    const results = toolResults(calls);
    expect(results[0]).toContain(a);
    expect(results[0]).toContain(b); // os dois candidatos chegam ao modelo
    expect(results[1]).toContain("Contato não encontrado");
    expect(results[2]).toContain("Falta o contato");
    expect(results[2]).toMatch(/PERGUNTE qual \(nunca escolha\)/);
    expect(await pendings()).toHaveLength(0);
    expect(await appts()).toHaveLength(0);
  });

  test("busca de contato que volta VAZIA: o modelo recebe lista vazia e a escrita seguinte diz para avisar o usuário, sem inventar id", async () => {
    await mkContact("Maria", "Lima", "+5511999990003");
    const calls = stubLlm([
      toolFrames("searchContacts", { query: "Zeferino" }),
      toolFrames("bookAppointment", { serviceName: "Sessão", startLocal }),
      textFrames("Não encontrei esse contato. Pode me passar o nome completo ou o telefone?"),
    ]);
    await stream(s.admin, "marca o Zeferino amanhã às 10");
    const results = toolResults(calls);
    expect(results[0]).toMatch(/"contacts": \[\]/);
    expect(results[1]).toMatch(/não achou e peça o nome completo ou o telefone/);
    expect(results[1]).toMatch(/Nunca invente um id/);
    expect(await pendings()).toHaveLength(0);
    expect(await appts()).toHaveLength(0);
  });

  test("'pode fazer direto, já confirmo': as tools não têm como pular a confirmação; o turno termina com a ação PENDENTE e nada gravado; só o botão do membro executa", async () => {
    const maria = await mkContact("Maria", "Lima", "+5511999990003");
    const calls = stubLlm([
      toolFrames("bookAppointment", { contactId: maria, serviceName: "Sessão", startLocal, confirm: true, skipConfirmation: true, force: ["OUTSIDE_HOURS"] }),
      textFrames("Pronto, está marcado!"), // o modelo AFIRMA que marcou: o servidor não gravou
    ]);
    await stream(s.admin, "marca a Maria amanhã às 10, pode fazer direto, já confirmo");
    // 1) nenhuma tool de escrita de agenda tem parâmetro para pular a confirmação ou forçar regra
    const toolDefs = (calls[0].body as any).tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>;
    for (const name of SCHED_COPILOT_WRITE_NAMES) {
      const keys = Object.keys(toolDefs.find((x) => x.function.name === name)!.function.parameters.properties);
      expect(keys.filter((k) => /confirm|skip|force|direto|auto/i.test(k)), name).toEqual([]);
    }
    expect(toolDefs.map((x) => x.function.name).filter((n) => /confirmPending|executePending/i.test(n))).toEqual([]);
    // 2) argumentos extras do modelo são ignorados: ação pendente, sem agendamento, sem aviso forçado
    const pend = await pendings();
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ tool: "bookAppointment", status: "pending", requestedBy: s.admin.memberId });
    expect((pend[0].args as any).force).toEqual([]);
    expect(await appts()).toHaveLength(0);
    // 3) outro membro não confirma; só o clique do dono executa
    await expect(t.withIdentity(identityOf(s.agent)).mutation(api.copilot.confirmPendingAction, { pendingActionId: pend[0]._id })).rejects.toThrow();
    expect(await appts()).toHaveLength(0);
    await t.withIdentity(identityOf(s.admin)).mutation(api.copilot.confirmPendingAction, { pendingActionId: pend[0]._id });
    expect(await appts()).toHaveLength(1);
  });

  test("segundo turno 'confirmo' em texto: continua sem tool que confirme; a ação segue pendente", async () => {
    const maria = await mkContact("Maria", "Lima", "+5511999990003");
    stubLlm([toolFrames("bookAppointment", { contactId: maria, serviceName: "Sessão", startLocal }), textFrames("Confirme no cartão.")]);
    await stream(s.admin, "marca a Maria amanhã às 10");
    const thread = (await t.run((ctx) => ctx.db.query("copilotThreads").collect()))[0]._id;
    const calls = stubLlm([textFrames("Confirmado!")]);
    await stream(s.admin, "confirmo, pode gravar", thread);
    const names = ((calls[0].body as any).tools as Array<{ function: { name: string } }>).map((x) => x.function.name);
    expect(names.filter((n) => /confirm|execute/i.test(n))).toEqual([]);
    expect((await pendings())[0].status).toBe("pending");
    expect(await appts()).toHaveLength(0);
  });
});
