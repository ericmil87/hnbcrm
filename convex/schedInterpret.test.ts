/// <reference types="vite/client" />
/**
 * Agenda v2, PR C1: interpretar a confirmação que o HUMANO manda pelo WhatsApp e marcar (ou propor) o agendamento.
 * `lib/schedInterpretOps.ts` + `lib/schedInterpretPure.ts` + `schedulingInterpret.ts` + os dois ganchos.
 *
 * O LLM é SIMULADO por `vi.stubGlobal("fetch")` (padrão de `attendantAgenda.test.ts`): nenhuma chamada real a modelo.
 * Relógio: sexta 12/06/2026 09:00 em São Paulo (a segunda-feira seguinte é 15/06; `at(h)` é a hora local de São Paulo).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { DEFAULT_PERMISSIONS } from "./lib/permissions";
import { bookAppointmentCore } from "./lib/schedBookingOps";
import { dismissOpenInterpretationOfMessage, maybeScheduleConfirmationInterpretation } from "./lib/schedInterpretOps";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { schedInvariantProblems } from "./lib/schedInvariants.test-helper";
import * as SI from "./schedulingInterpret";
import * as sched from "./scheduling";
import { MAIN, OWN100, ROUND1, ROUND2 } from "../src/test/schedConfirmParserTables";
import { parseConfirmation } from "./lib/schedConfirmParser";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const NOW = new Date("2026-06-12T12:00:00Z").getTime(); // sexta, 09:00 em São Paulo
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Instante de `h:m` (São Paulo, UTC-3) do dia `day` de junho/2026 (15 = segunda-feira). */
const at = (h: number, m = 0, day = 15) => Date.UTC(2026, 5, day, h + 3, m);
const CONFIRM = "Ok, confirmado segunda 10h";
const CLIENT_ASKS = "Pode ser segunda às 10h?";

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// LLM simulado
// ---------------------------------------------------------------------------

type Verdict = { ato: string; dia: string; hora: string; servico: string; evidencia: string };
const GOOD: Verdict = { ato: "confirmou", dia: "2026-06-15", hora: "10:00", servico: "nenhum", evidencia: "confirmado segunda 10h" };

function chatResponse(content: string, finish = "stop"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: 120, completion_tokens: 30 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Um modelo que responde `reply(body)` a toda chamada; devolve o mock (as chamadas ficam em `mock.calls`). */
function stubLlm(reply: ((body: { messages: Array<{ role: string; content: string }> }) => Response | Promise<Response>) | Verdict | string) {
  const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) throw new Error(`fetch inesperado: ${url}`);
    const body = JSON.parse((init as { body: string }).body);
    if (typeof reply === "function") return await reply(body);
    return chatResponse(typeof reply === "string" ? reply : JSON.stringify(reply));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const llmCalls = (m: ReturnType<typeof stubLlm>) => m.mock.calls.filter((c) => String(c[0]).includes("/chat/completions"));

/** Texto da mensagem sob análise, como o servidor o mandou ao modelo (dentro do envelope). */
function messageSeenByModel(body: { messages: Array<{ role: string; content: string }> }): string {
  const user = body.messages.find((m) => m.role === "user")!.content;
  const obj = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1));
  return obj.MENSAGEM_DA_EQUIPE as string;
}

// ---------------------------------------------------------------------------
// Semente
// ---------------------------------------------------------------------------

const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 480, endMin: 1080 }));

type SeedOpts = { ai?: boolean; mode?: "auto" | "suggest" | "off"; modules?: boolean; services?: 1 | 2; defaultService?: boolean; relation?: "personal"; now?: number };
type Seed = Awaited<ReturnType<typeof seedOrg>>;
type Person = { userId: Id<"users">; memberId: Id<"teamMembers"> };

async function seedOrg(opts: SeedOpts = {}) {
  return await t.run(async (ctx) => {
    const now = opts.now ?? Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Clínica Teste",
      slug: `org-${Math.random().toString(36).slice(2)}`,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        modules: { scheduling: opts.modules ?? true },
        ...(opts.ai ? { aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 } } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const mkMember = async (orgId: Id<"organizations">, name: string, role: "admin" | "agent", agenda?: "none" | "view_own" | "view_all"): Promise<Person> => {
      const userId = await ctx.db.insert("users", { email: `${name.toLowerCase().replace(/\W+/g, ".")}@teste.dev`, name });
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId: orgId, userId, name, role, type: "human", status: "active",
        ...(agenda ? { permissions: { ...DEFAULT_PERMISSIONS.agent, agenda } } : {}),
        createdAt: now, updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await mkMember(organizationId, "Admin", "admin");
    const editor = await mkMember(organizationId, "Atendente", "agent");
    const viewAll = await mkMember(organizationId, "Leitor Geral", "agent", "view_all");
    const viewOwn = await mkMember(organizationId, "Leitor Proprio", "agent", "view_own");
    const none = await mkMember(organizationId, "Sem Agenda", "agent", "none");
    if (opts.ai) {
      const org = (await ctx.db.get(organizationId))!;
      await ctx.db.patch(organizationId, { settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: admin.memberId } } } });
    }
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra Org", slug: `outra-${Math.random().toString(36).slice(2)}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { scheduling: true } }, createdAt: now, updatedAt: now,
    });
    const outsider = await mkMember(otherOrgId, "Admin Outra", "admin");

    const boardId = await ctx.db.insert("boards", { organizationId, name: "Funil", color: "#3b82f6", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const mkStage = (name: string, order: number) =>
      ctx.db.insert("stages", { organizationId, boardId, name, color: "#6366f1", order, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const stageId = await mkStage("Novo", 0);
    const scheduledStageId = await mkStage("Agendado", 1);
    await ctx.db.insert("schedSettings", {
      organizationId,
      humanConfirm: { ...(opts.mode ? { mode: opts.mode } : {}) },
      funnel: { onScheduledStageId: scheduledStageId },
      updatedAt: now,
    });

    const mkContact = (firstName: string, relation?: "personal") =>
      ctx.db.insert("contacts", { organizationId, firstName, lastName: "Teste", tags: [], ...(relation ? { relation } : {}), createdAt: now, updatedAt: now });
    const contactId = await mkContact("Ana", opts.relation);
    const otherContactId = await mkContact("Bia");
    const mkLead = (title: string, cId: Id<"contacts">) =>
      ctx.db.insert("leads", {
        organizationId, title, contactId: cId, boardId, stageId, value: 0, currency: "BRL", priority: "medium", temperature: "warm", tags: [],
        customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
      });
    const leadId = await mkLead("Lead Ana", contactId);
    const otherLeadId = await mkLead("Lead Bia", otherContactId);
    const mkConv = (lId: Id<"leads">) =>
      ctx.db.insert("conversations", {
        organizationId, leadId: lId, channel: "whatsapp", status: "active", messageCount: 0, createdAt: now, updatedAt: now,
        ...(opts.relation ? { contactRelation: opts.relation } : {}),
      });
    const conversationId = await mkConv(leadId);
    const otherConversationId = await mkConv(otherLeadId);

    const p1 = await ctx.db.insert("schedResources", { organizationId, kind: "person", name: "Profissional Um", capacity: 1, weekly: WEEKDAYS, tags: [], sortOrder: 0, active: true, teamMemberId: admin.memberId, createdAt: now, updatedAt: now });
    const mkService = (name: string) =>
      ctx.db.insert("schedServices", {
        organizationId, name, durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
        requirements: [{ role: "Profissional", kind: "person", resourceIds: [p1] }], sortOrder: 0, active: true, createdAt: now, updatedAt: now,
      });
    const consulta = await mkService("Consulta");
    const retorno = opts.services === 2 ? await mkService("Retorno") : undefined;
    if (opts.defaultService && retorno) {
      const doc = (await ctx.db.query("schedSettings").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).first())!;
      await ctx.db.patch(doc._id, { humanConfirm: { ...(opts.mode ? { mode: opts.mode } : {}), defaultServiceId: consulta } });
    }
    return { organizationId, otherOrgId, admin, editor, viewAll, viewOwn, none, outsider, contactId, otherContactId, leadId, otherLeadId, conversationId, otherConversationId, p1, consulta, retorno, scheduledStageId, stageId };
  });
}

const as = (p: Person) => t.withIdentity({ subject: `${p.userId}|s1` });

let extSeq = 0;
/** Mensagem do CLIENTE já gravada (direto no banco; nada agenda). */
async function clientSays(s: Seed, text: string, atMs: number, conversationId = s.conversationId): Promise<Id<"messages">> {
  return await t.run((ctx) =>
    ctx.db.insert("messages", {
      organizationId: s.organizationId, conversationId, leadId: conversationId === s.conversationId ? s.leadId : s.otherLeadId,
      direction: "inbound", senderType: "contact", content: text, contentType: "text", isInternal: false, createdAt: atMs,
    })
  );
}

/** Mensagem do HUMANO digitada no celular (gancho do ingest do aparelho). */
async function humanOnPhone(s: Seed, text: string, opts: { at?: number; metadata?: Record<string, unknown>; leadId?: Id<"leads"> } = {}): Promise<Id<"messages"> | null> {
  return await t.mutation(internal.conversations.internalReceiveDeviceMessage, {
    organizationId: s.organizationId,
    leadId: opts.leadId ?? s.leadId,
    content: text,
    externalId: `ext-${++extSeq}`,
    sentAt: opts.at ?? Date.now(),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });
}

/** Deixa os jobs de 0 ms (início, segunda leitura) terminarem; a rede de segurança de 3 min NÃO dispara. */
async function drain() {
  for (let i = 0; i < 6; i++) {
    vi.advanceTimersByTime(1);
    const waiting = t.finishInProgressScheduledFunctions();
    let settled = false;
    void waiting.then(() => (settled = true));
    // Se o job dorme num timer falso (recuo do cliente de LLM: 2 s), empurra o relógio de 100 em 100 ms (nunca chega aos 3 min do vigia).
    for (let k = 0; k < 60 && !settled; k++) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
    }
    await waiting;
  }
}

const interpretations = (s: Seed) => t.run((ctx) => ctx.db.query("schedInterpretations").withIndex("by_organization_and_created", (q) => q.eq("organizationId", s.organizationId)).collect());
const appointments = (s: Seed) => t.run(async (ctx) => (await ctx.db.query("schedAppointments").collect()).filter((a) => a.organizationId === s.organizationId));
const conflicts = () => t.run((ctx) => ctx.db.query("schedConflicts").collect());
const notificationsOf = (s: Seed, type: string) => t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.organizationId === s.organizationId && n.type === type));
const scheduledNames = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.name));
const interpretJobs = async () => (await scheduledNames()).filter((n) => n.includes("schedulingInterpret"));

/** Cenário feliz: o cliente propôs segunda 10h, o humano confirma pelo celular, IA ligada e o modelo concorda. */
async function happy(opts: SeedOpts = { ai: true }, reply: Verdict | string | ((b: never) => Response) = GOOD) {
  const s = await seedOrg(opts);
  const llm = stubLlm(reply as never);
  await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
  const messageId = (await humanOnPhone(s, CONFIRM))!;
  await drain();
  return { s, llm, messageId };
}

const onlyRow = async (s: Seed) => {
  const rows = await interpretations(s);
  expect(rows).toHaveLength(1);
  return rows[0];
};

// ---------------------------------------------------------------------------
// Criar sozinho: as quatro condições
// ---------------------------------------------------------------------------

describe("criar sozinho (§8.1)", () => {
  test("com as quatro condições cria como o sistema, `scheduled`, origem human_message, e avisa a equipe", async () => {
    const { s, llm, messageId } = await happy();
    const appts = await appointments(s);
    expect(appts).toHaveLength(1);
    expect(appts[0]).toMatchObject({
      origin: "human_message", status: "scheduled", startTime: at(10), serviceId: s.consulta, contactId: s.contactId, leadId: s.leadId,
      conversationId: s.conversationId, sourceMessageId: messageId, idempotencyKey: `hm:${messageId}`,
    });
    expect(appts[0].createdBy).toBeUndefined();
    expect(llmCalls(llm)).toHaveLength(1);
    // Custo registrado como as outras chamadas (run sem transcrição, tokens e custo).
    const runs = await t.run((ctx) => ctx.db.query("agentRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "sched_interpret", status: "done", conversationId: s.conversationId, triggerMessageId: messageId, promptTokens: 120, completionTokens: 30 });
    expect(JSON.stringify(runs[0])).not.toContain("confirmado");
    const row = await onlyRow(s);
    expect(row).toMatchObject({ act: "confirmou", decision: "created", status: "done", appointmentId: appts[0]._id, parsed: { localDate: "2026-06-15", timeMin: 600, serviceId: s.consulta } });
    expect(row.checks).toMatchObject({ parser: true, proposal: true, service: true, llm: true, agree: true });
    expect(row.reason).toBeUndefined();
    // Etapa do funil pela porta, atividade no lead, auditoria da criação pelo sistema com a mensagem de origem (sem texto).
    expect((await t.run((ctx) => ctx.db.get(s.leadId)))!.stageId).toBe(s.scheduledStageId);
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "schedAppointment" && a.action === "create"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "system", metadata: { via: "human_message", origin: "human_message", messageId } });
    const acts = await t.run(async (ctx) => (await ctx.db.query("activities").collect()).filter((a) => a.type === "appointment_booked"));
    expect(acts).toHaveLength(1);
    // Notificação para a equipe (nunca para o cliente): sem remetente nem responsável = quem tem agenda >= edit.
    const created = await notificationsOf(s, "appointment_created");
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(created.every((n) => n.conversationId === s.conversationId && n.data?.appointmentId === appts[0]._id && n.data?.source === "human_message")).toBe(true);
    expect(created.map((n) => n.title)).toContain("Marquei Ana Teste para seg, 15/06 às 10:00 a partir da sua confirmação");
    const members = new Set(created.map((n) => n.memberId));
    expect(members.has(s.admin.memberId)).toBe(true);
    expect(members.has(s.viewAll.memberId) || members.has(s.viewOwn.memberId) || members.has(s.none.memberId)).toBe(false);
    // Nenhuma mensagem automática ao cliente: só as duas mensagens da conversa.
    const msgs = await t.run((ctx) => ctx.db.query("messages").withIndex("by_conversation_and_created", (q) => q.eq("conversationId", s.conversationId)).collect());
    expect(msgs).toHaveLength(2);
    expect(await schedInvariantProblems(t, s.organizationId, NOW)).toEqual([]);
  });

  test("pelo app (sendMessage) o gancho também cria; o remetente recebe o aviso", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await as(s.admin).mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: CONFIRM });
    await drain();
    const appts = await appointments(s);
    expect(appts).toHaveLength(1);
    expect(appts[0].origin).toBe("human_message");
    // Remetente (admin, com agenda >= edit) recebe; o atendente comum não (só remetente e responsável do lead).
    const to = (await notificationsOf(s, "appointment_created")).map((n) => n.memberId);
    expect(to).toEqual([s.admin.memberId]);
  });

  test("resposta é lida do classificador com texto do cliente dentro do envelope e só com o necessário", async () => {
    const { llm } = await happy();
    const body = JSON.parse((llmCalls(llm)[0][1] as { body: string }).body);
    expect(body.response_format).toEqual({ type: "json_object" });
    const system = body.messages[0].content as string;
    const user = body.messages[1].content as string;
    expect(system).toContain("2026-06-15");
    expect(system).toContain('"Consulta"');
    expect(user).toContain('<crm_data untrusted="true">');
    expect(user).toContain(CLIENT_ASKS);
    expect(user).toContain(CONFIRM);
    expect(body.temperature).toBe(0);
  });

  test("a corrida de duas execuções da mesma mensagem não duplica (idempotente por messageId)", async () => {
    const { s, messageId } = await happy();
    const again = await t.mutation(internal.schedulingInterpret.internalStart, { messageId });
    expect(again).toEqual({ status: "duplicate" });
    await drain();
    expect(await appointments(s)).toHaveLength(1);
    expect(await interpretations(s)).toHaveLength(1);
  });

  test("conflito de horário na criação automática: cria, vai para a fila de conflitos e a ocupação não passa da capacidade", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.organizationId, serviceId: s.consulta, startTime: at(10), contactId: s.otherContactId, idempotencyKey: "pre-1" });
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    const appts = (await appointments(s)).filter((a) => a.origin === "human_message");
    expect(appts).toHaveLength(1);
    expect(appts[0].resources.every((r) => r.allocated === false)).toBe(true);
    const open = await conflicts();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "human_confirm", status: "open", appointmentId: appts[0]._id });
    const row = await onlyRow(s);
    expect(row.decision).toBe("created");
    const created = await notificationsOf(s, "appointment_created");
    expect(created[0].body).toContain("fila de conflitos");
    expect(created[0].data?.inConflict).toBe(true);
    expect(await schedInvariantProblems(t, s.organizationId, NOW)).toEqual([]);
  });

  test("o contato já marcado para esse horário: nada novo (`confirmed_existing`), sem chamar o modelo", async () => {
    const s = await seedOrg({ ai: true });
    const llm = stubLlm(GOOD);
    await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.organizationId, serviceId: s.consulta, startTime: at(10), contactId: s.contactId, idempotencyKey: "pre-2" });
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    expect(await appointments(s)).toHaveLength(1);
    const row = await onlyRow(s);
    expect(row).toMatchObject({ decision: "confirmed_existing", status: "done" });
    expect(llmCalls(llm)).toHaveLength(0);
    expect(await notificationsOf(s, "appointment_created")).toHaveLength(0);
  });

  test("o contato tem UM pendente de aprovação nesse horário: a confirmação do humano o aprova (sem criar outro)", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    // Pendente do contato (como a IA ou o link criariam): inserido pela porta com ator de sistema do link.
    const pend = await t.run((ctx) =>
      bookAppointmentCore(ctx as never, {
        organizationId: s.organizationId, actor: { type: "system", via: "public_link" }, origin: "public", serviceId: s.consulta, startTime: at(10), contactId: s.contactId, leadId: s.leadId, now: NOW + 0,
      } as never)
    );
    expect(pend).toMatchObject({ ok: true, status: "pending_approval" });
    await humanOnPhone(s, CONFIRM);
    await drain();
    const appts = await appointments(s);
    expect(appts).toHaveLength(1);
    expect(appts[0].status).toBe("scheduled");
    expect(appts[0].approvedAt).toBeDefined();
    expect((await onlyRow(s)).decision).toBe("approved_existing");
  });
});

// ---------------------------------------------------------------------------
// Cada condição faltando: proposta de 1 toque com o motivo certo
// ---------------------------------------------------------------------------

describe("faltando uma condição vira proposta com o motivo certo", () => {
  async function expectProposal(s: Seed, reason: string, extra: Record<string, unknown> = {}) {
    expect(await appointments(s)).toHaveLength(0);
    const row = await onlyRow(s);
    expect(row).toMatchObject({ decision: "proposed", status: "open", reason, ...extra });
    const sugg = await notificationsOf(s, "appointment_suggestion");
    expect(sugg.length).toBeGreaterThanOrEqual(1);
    expect(sugg.every((n) => n.conversationId === s.conversationId && n.data?.interpretationId === row._id)).toBe(true);
    expect(await notificationsOf(s, "appointment_created")).toHaveLength(0);
    return row;
  }

  test("sem IA ligada: nunca cria sozinho, só propõe (e não chama modelo)", async () => {
    const s = await seedOrg({ ai: false });
    const llm = stubLlm(GOOD);
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    const row = await expectProposal(s, "sem_ia", { parsed: { localDate: "2026-06-15", timeMin: 600, serviceId: s.consulta } });
    expect(row.checks).toMatchObject({ parser: true, proposal: true, service: true });
    expect(row.checks.llm).toBeUndefined();
    expect(llmCalls(llm)).toHaveLength(0);
    expect((await notificationsOf(s, "appointment_suggestion"))[0].title).toBe("Parece uma confirmação de horário");
  });

  test("modo `Só sugerir`: propõe sem chamar o modelo", async () => {
    const s = await seedOrg({ ai: true, mode: "suggest" });
    const llm = stubLlm(GOOD);
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    await expectProposal(s, "modo_sugerir");
    expect(llmCalls(llm)).toHaveLength(0);
  });

  test("sem proposta aberta (o cliente não citou o horário): propõe com `sem_proposta`", async () => {
    const s = await seedOrg({ ai: true });
    const llm = stubLlm(GOOD);
    await humanOnPhone(s, CONFIRM);
    await drain();
    await expectProposal(s, "sem_proposta");
    expect(llmCalls(llm)).toHaveLength(0);
  });

  test("a proposta aberta é de OUTRO dia/hora: propõe com `sem_proposta_coincidente`", async () => {
    const s = await seedOrg({ ai: true });
    const llm = stubLlm(GOOD);
    await clientSays(s, "Pode ser terça às 14h?", NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    await expectProposal(s, "sem_proposta_coincidente");
    expect(llmCalls(llm)).toHaveLength(0);
  });

  test("a proposta do cliente tem mais de 48 h: não vale", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    await clientSays(s, CLIENT_ASKS, NOW - 49 * HOUR);
    await humanOnPhone(s, CONFIRM);
    await drain();
    await expectProposal(s, "sem_proposta");
  });

  test("proposta da IA gravada em `schedConversationState` vale como proposta aberta", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    await t.run((ctx) =>
      ctx.db.insert("schedConversationState", {
        organizationId: s.organizationId, conversationId: s.conversationId, offerSeq: 1, updatedAt: NOW,
        offers: [{ code: "h1", batch: 1, serviceId: s.consulta, startTime: at(10), resourceIds: [s.p1], issuedAt: NOW - HOUR, expiresAt: NOW + HOUR }],
      })
    );
    await humanOnPhone(s, CONFIRM);
    await drain();
    const appts = await appointments(s);
    expect(appts).toHaveLength(1);
    expect(appts[0].serviceId).toBe(s.consulta);
  });

  test("mensagem anterior do próprio humano com o mesmo dia e hora também vale como proposta", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound", senderType: "human",
        content: "Consigo te atender segunda às 10h", contentType: "text", isInternal: false, createdAt: NOW - 20 * MIN,
      })
    );
    await humanOnPhone(s, CONFIRM);
    await drain();
    expect(await appointments(s)).toHaveLength(1);
  });

  test("serviço ambíguo (dois serviços, nenhum citado, sem padrão): propõe sem criar", async () => {
    const s = await seedOrg({ ai: true, services: 2 });
    const llm = stubLlm(GOOD);
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    const row = await expectProposal(s, "servico_nao_definido");
    expect(row.parsed.serviceId).toBeUndefined();
    expect(llmCalls(llm)).toHaveLength(0);
  });

  test("dois serviços citados na conversa: ambíguo, mesmo com serviço padrão configurado", async () => {
    const s = await seedOrg({ ai: true, services: 2, defaultService: true });
    stubLlm(GOOD);
    await clientSays(s, "Quero Consulta ou Retorno, pode ser segunda às 10h?", NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    await expectProposal(s, "servico_ambiguo");
  });

  test("serviço citado na conversa desempata (dois serviços ativos)", async () => {
    const s = await seedOrg({ ai: true, services: 2 });
    stubLlm({ ...GOOD, servico: "Retorno" });
    await clientSays(s, "Queria marcar o Retorno, pode ser segunda às 10h?", NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    const appts = await appointments(s);
    expect(appts).toHaveLength(1);
    expect(appts[0].serviceId).toBe(s.retorno);
  });

  test("serviço padrão configurado resolve a ambiguidade; se o modelo cita OUTRO serviço, diverge e propõe", async () => {
    const s = await seedOrg({ ai: true, services: 2, defaultService: true });
    stubLlm({ ...GOOD, servico: "Retorno" });
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    await expectProposal(s, "ia_divergente");
    const s2 = await seedOrg({ ai: true, services: 2, defaultService: true });
    stubLlm(GOOD);
    await clientSays(s2, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s2, CONFIRM);
    await drain();
    expect((await appointments(s2))[0].serviceId).toBe(s2.consulta);
  });

  test("dia/hora que o modelo leu diferem do parser: `ia_divergente`", async () => {
    for (const verdict of [{ ...GOOD, dia: "2026-06-16" }, { ...GOOD, hora: "11:00" }, { ...GOOD, dia: "nenhum" }, { ...GOOD, hora: "nenhuma" }, { ...GOOD, ato: "propos" }]) {
      t = convexTest(schema, modules);
      const { s } = await happy({ ai: true }, verdict);
      await expectProposal(s, "ia_divergente");
    }
  });

  test("evidência que NÃO é substring da mensagem: `ia_evidencia_invalida`", async () => {
    const { s } = await happy({ ai: true }, { ...GOOD, evidencia: "frase que não está na mensagem" });
    await expectProposal(s, "ia_evidencia_invalida");
  });

  test("resposta fora do schema (dia fora do enum, hora malformada, serviço inexistente, JSON ruim): `ia_resposta_invalida`", async () => {
    for (const reply of [{ ...GOOD, dia: "2026-07-30" }, { ...GOOD, hora: "10h" }, { ...GOOD, servico: "Massagem" }, { ...GOOD, ato: "talvez" }, "isto não é JSON", '{"ato":"confirmou"}']) {
      t = convexTest(schema, modules);
      const { s } = await happy({ ai: true }, reply);
      await expectProposal(s, "ia_resposta_invalida");
    }
  });

  test("modelo fora do ar (500) ou tempo esgotado: `ia_indisponivel` (vira proposta, sem criar)", async () => {
    for (const reply of [() => new Response("boom", { status: 500 }), () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }]) {
      t = convexTest(schema, modules);
      const { s } = await happy({ ai: true }, reply as never);
      await expectProposal(s, "ia_indisponivel");
      const runs = await t.run((ctx) => ctx.db.query("agentRuns").collect());
      expect(runs.every((r) => r.kind === "sched_interpret")).toBe(true);
    }
  });

  test("a rede de segurança: sem resposta do modelo a mensagem vira proposta (nunca fica pendente)", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    const messageId = (await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound", senderType: "human", content: CONFIRM, contentType: "text", isInternal: false, createdAt: NOW,
      })
    ))!;
    // Início direto (sem drenar o job da segunda leitura): a linha fica `pending` e NÃO aparece na fila da equipe.
    expect(await t.mutation(internal.schedulingInterpret.internalStart, { messageId })).toEqual({ status: "pending" });
    expect((await onlyRow(s)).status).toBe("pending");
    const pending = await as(s.admin).query(api.scheduling.listPending, { organizationId: s.organizationId, now: NOW });
    expect(pending.suggestions).toEqual([]);
    const res = await t.mutation(internal.schedulingInterpret.internalDecide, { messageId, llm: { status: "unavailable" } });
    expect(res).toMatchObject({ decision: "proposed", reason: "ia_indisponivel" });
    // A segunda chamada (o vigia dos 3 min depois do modelo, ou o inverso) não faz nada.
    expect(await t.mutation(internal.schedulingInterpret.internalDecide, { messageId, llm: { status: "ok", ato: "confirmou", dia: "2026-06-15", hora: "10:00", servicoId: null } })).toEqual({ decision: "noop" });
    expect(await appointments(s)).toHaveLength(0);
  });

  test("data além de 30 dias ou além da janela do modelo (14 dias): propõe", async () => {
    const s = await seedOrg({ ai: true });
    const llm = stubLlm(GOOD);
    await clientSays(s, "Pode ser dia 20 de julho às 10h?", NOW - 30 * MIN);
    await humanOnPhone(s, "Ok, confirmado dia 20/07 10h");
    await drain();
    const row = await onlyRow(s);
    expect(row.decision).toBe("proposed");
    expect(["data_distante", "sem_proposta", "sem_proposta_coincidente", "leitura_incompleta"]).toContain(row.reason);
    expect(llmCalls(llm)).toHaveLength(0);
    expect(await appointments(s)).toHaveLength(0);
  });

  test("OUTSIDE_HOURS (fora do expediente) ou recurso fechado: o modelo concorda, a porta recusa e vira proposta com o código da regra", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm({ ...GOOD, hora: "19:00", evidencia: "confirmado segunda 19h" });
    await clientSays(s, "Pode ser segunda às 19h?", NOW - 30 * MIN);
    await humanOnPhone(s, "Ok, confirmado segunda 19h");
    await drain();
    await expectProposal(s, "regra:OUTSIDE_HOURS", { parsed: { localDate: "2026-06-15", timeMin: 1140, serviceId: s.consulta } });
    expect(await schedInvariantProblems(t, s.organizationId, NOW)).toEqual([]);
  });

  test("forma incompleta: sem hora, fora da forma fechada ou resposta curta nunca criam (resposta curta pré-preenche com a proposta do CLIENTE)", async () => {
    const cases: Array<[string, string]> = [
      ["Ok, confirmado segunda 10h, leva o documento", "leitura_incompleta"],
      ["fechado", "resposta_curta"],
      ["confirmado segunda", "resposta_curta"],
    ];
    for (const [text, reason] of cases) {
      t = convexTest(schema, modules);
      const s = await seedOrg({ ai: true });
      const llm = stubLlm(GOOD);
      await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
      await humanOnPhone(s, text);
      await drain();
      const row = await expectProposal(s, reason);
      expect(llmCalls(llm)).toHaveLength(0);
      if (reason === "resposta_curta") expect(row.parsed).toMatchObject({ localDate: "2026-06-15", timeMin: 600 });
    }
  });

  test("resposta curta com proposta do PRÓPRIO humano (e não do cliente) não confirma nada", async () => {
    const s = await seedOrg({ ai: true });
    const llm = stubLlm(GOOD);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound", senderType: "human",
        content: "Consigo te atender segunda às 10h", contentType: "text", isInternal: false, createdAt: NOW - 20 * MIN,
      })
    );
    await humanOnPhone(s, "fechado");
    await drain();
    expect(await appointments(s)).toHaveLength(0);
    expect(await notificationsOf(s, "appointment_suggestion")).toHaveLength(0);
    expect((await onlyRow(s)).decision).toBe("ignored");
    expect(llmCalls(llm)).toHaveLength(0);
  });

  test("a resposta curta só conta com a ÚLTIMA mensagem do cliente: se ela não cita o horário, não pré-preenche", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await clientSays(s, "Obrigada!", NOW - 10 * MIN);
    await humanOnPhone(s, "fechado");
    await drain();
    expect(await appointments(s)).toHaveLength(0);
    expect((await onlyRow(s)).decision).toBe("ignored");
  });

  test("remarcou e cancelou NUNCA agem sozinhos: proposta de 1 toque apontando o agendamento do contato", async () => {
    const s = await seedOrg({ ai: true });
    const llm = stubLlm(GOOD);
    const { appointmentIds } = await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.organizationId, serviceId: s.consulta, startTime: at(14), contactId: s.contactId, idempotencyKey: "pre-3" });
    await humanOnPhone(s, "Remarcado para terça 14h");
    await humanOnPhone(s, "Cancelei sua consulta de segunda");
    await drain();
    const rows = await interpretations(s);
    expect(rows.map((r) => r.act).sort()).toEqual(["cancelou", "remarcou"]);
    expect(rows.every((r) => r.decision === "proposed" && r.status === "open" && r.reason === "ato_nao_automatico" && r.appointmentId === appointmentIds[0])).toBe(true);
    expect((await appointments(s))[0].status).toBe("scheduled");
    expect(llmCalls(llm)).toHaveLength(0);
    const titles = (await notificationsOf(s, "appointment_suggestion")).map((n) => n.title);
    expect(titles).toContain("Parece que você remarcou Ana Teste");
    expect(titles).toContain("Parece que você cancelou Ana Teste");
  });

  test("remarcou/cancelou sem agendamento do contato: ignora (nada a aplicar)", async () => {
    const s = await seedOrg({ ai: true });
    await humanOnPhone(s, "Cancelei sua consulta de segunda");
    await drain();
    expect(await onlyRow(s)).toMatchObject({ decision: "ignored", reason: "sem_agendamento" });
    expect(await notificationsOf(s, "appointment_suggestion")).toHaveLength(0);
  });

  test("propos grava a proposta do humano na conversa (48 h) e a resposta do cliente vira confirmação reavaliada", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    const first = await humanOnPhone(s, "Agendado pra segunda 10h?"); // pergunta: não passa do pré-filtro, só vira menção
    await drain();
    expect(first).not.toBeNull();
    // Contraproposta no meio da frase vira `propos` e é gravada.
    await humanOnPhone(s, "Fechado! Mas só consigo segunda 10h");
    await drain();
    const rows = await interpretations(s);
    expect(rows.some((r) => r.decision === "proposal_saved" && r.act === "propos")).toBe(true);
    const state = await t.run((ctx) => ctx.db.query("schedConversationState").withIndex("by_conversation", (q) => q.eq("conversationId", s.conversationId)).first());
    expect(state?.proposal).toMatchObject({ localDate: "2026-06-15", timeMin: 600 });
    expect(state!.proposal!.expiresAt - state!.proposal!.at).toBe(48 * HOUR);
    expect(await appointments(s)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gancho: custo zero e o que é ignorado
// ---------------------------------------------------------------------------

describe("gancho", () => {
  test("pré-filtro negativo e mensagens que não são do caminho: nada é agendado, nenhuma linha", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    const before = (await scheduledNames()).length;
    await humanOnPhone(s, "Atendemos de segunda a sexta das 8h às 18h");
    await humanOnPhone(s, "Vou ter que ver");
    await humanOnPhone(s, "Quinta não consigo");
    await humanOnPhone(s, "ok");
    await humanOnPhone(s, "Oi, tudo bem?");
    await humanOnPhone(s, "x".repeat(601));
    await humanOnPhone(s, "  ");
    expect(await interpretJobs()).toEqual([]);
    expect((await scheduledNames()).filter((n) => n.includes("Interpret"))).toEqual([]);
    expect(await interpretations(s)).toEqual([]);
    void before;
  });

  test("mensagem com mais de 10 minutos (histórico importado usa o mesmo ingest) é ignorada", async () => {
    const s = await seedOrg({ ai: true });
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM, { at: NOW - 11 * MIN });
    await humanOnPhone(s, CONFIRM, { at: NOW - 3 * 24 * HOUR });
    await humanOnPhone(s, CONFIRM, { metadata: { importedFromHistory: true } });
    expect(await interpretJobs()).toEqual([]);
    // Dentro dos 10 minutos passa.
    await humanOnPhone(s, CONFIRM, { at: NOW - 9 * MIN });
    expect((await interpretJobs()).length).toBe(1);
  });

  test("mesmo se o job rodar tarde, mensagem velha não é interpretada", async () => {
    const s = await seedOrg({ ai: true });
    const messageId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound", senderType: "human", content: CONFIRM, contentType: "text", isInternal: false, createdAt: NOW - 20 * MIN,
      })
    );
    expect(await t.mutation(internal.schedulingInterpret.internalStart, { messageId })).toEqual({ status: "skipped", reason: "mensagem_antiga" });
    expect(await interpretations(s)).toEqual([]);
  });

  test("IA, sistema, campanha, nota interna, grupo e cliente nunca são interpretados", async () => {
    const s = await seedOrg({ ai: true });
    const insert = (extra: Partial<Doc<"messages">>) =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound", senderType: "human", content: CONFIRM,
          contentType: "text", isInternal: false, createdAt: NOW, ...extra,
        } as never)
      );
    const start = async (id: Id<"messages">) => (await t.mutation(internal.schedulingInterpret.internalStart, { messageId: id })).reason;
    expect(await start(await insert({ senderType: "ai" }))).toBe("nao_e_do_humano");
    expect(await start(await insert({ direction: "inbound", senderType: "contact" }))).toBe("nao_e_do_humano");
    expect(await start(await insert({ isInternal: true, direction: "internal" }))).toBe("nao_e_do_humano");
    expect(await start(await insert({ metadata: { via: "telegram_auto" } }))).toBe("nao_e_do_humano");
    expect(await start(await insert({ metadata: { via: "copilot" } }))).toBe("nao_e_do_humano");
    expect(await start(await insert({ metadata: { importedFromHistory: true } }))).toBe("nao_e_do_humano");
    expect(await start(await insert({ metadata: { revoked: true } }))).toBe("nao_e_do_humano");
    expect(await interpretations(s)).toEqual([]);
    // Pelo gancho: IA no app, campanha/agendada (nunca passam pelo gancho), nota interna e grupo.
    const hookMessageId = await insert({});
    const hook = (extra: Record<string, unknown>) =>
      t.run((ctx) =>
        maybeScheduleConfirmationInterpretation(ctx as never, {
          organizationId: s.organizationId, conversationId: s.conversationId, messageId: hookMessageId, content: CONFIRM, sentAt: NOW, now: NOW, ...extra,
        })
      );
    expect(await hook({ senderIsAi: true })).toBe(false);
    expect(await hook({ isInternal: true })).toBe(false);
    expect(await hook({ isGroup: true })).toBe(false);
    expect(await hook({ contentType: "audio" })).toBe(false);
    expect(await hook({ contactRelation: "personal" })).toBe(false);
    expect(await hook({})).toBe(true);
  });

  test("contato 'não é cliente' (fora do comercial) é ignorado, no gancho e no início", async () => {
    const s = await seedOrg({ ai: true, relation: "personal" });
    stubLlm(GOOD);
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    expect(await interpretJobs()).toEqual([]);
    expect(await interpretations(s)).toEqual([]);
    expect(await appointments(s)).toHaveLength(0);
    // Mesmo se alguém agendar por fora: o início confere o contato.
    const messageId = await t.run((ctx) =>
      ctx.db.insert("messages", { organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound", senderType: "human", content: CONFIRM, contentType: "text", isInternal: false, createdAt: NOW })
    );
    await t.run((ctx) => ctx.db.patch(s.conversationId, { contactRelation: undefined }));
    expect((await t.mutation(internal.schedulingInterpret.internalStart, { messageId })).reason).toBe("fora_do_comercial");
  });

  test("módulo desligado, interpretação desligada e conta em modo leitura: custo zero (nada agendado)", async () => {
    for (const opts of [{ ai: true, modules: false }, { ai: true, mode: "off" as const }]) {
      t = convexTest(schema, modules);
      const s = await seedOrg(opts);
      await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
      await humanOnPhone(s, CONFIRM);
      await drain();
      expect(await interpretJobs()).toEqual([]);
      expect(await interpretations(s)).toEqual([]);
    }
    const s = await seedOrg({ ai: true });
    await t.run((ctx) => ctx.db.patch(s.organizationId, { billing: { plan: "profissional", status: "read_only", updatedAt: 1 } }));
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    expect(await interpretJobs()).toEqual([]);
    // Fora do modo leitura o mesmo texto agenda (controle).
    await t.run((ctx) => ctx.db.patch(s.organizationId, { billing: { plan: "profissional", status: "active", updatedAt: 1 } }));
    await humanOnPhone(s, CONFIRM);
    expect(await interpretJobs()).toHaveLength(1);
  });

  test("pré-filtro positivo agenda UM job (`internalStart`) e mais nada", async () => {
    const s = await seedOrg({ ai: true });
    await humanOnPhone(s, CONFIRM);
    const names = await interpretJobs();
    expect(names).toHaveLength(1);
    expect(names[0]).toContain("internalStart");
    void s;
  });

  test("mensagem editada ou apagada no aparelho só descarta a proposta aberta; o agendamento criado não é tocado", async () => {
    const s = await seedOrg({ ai: false });
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    const messageId = (await humanOnPhone(s, CONFIRM, {}))!;
    await drain();
    expect((await onlyRow(s)).status).toBe("open");
    await t.run(async (ctx) => {
      await dismissOpenInterpretationOfMessage(ctx as never, (await ctx.db.get(messageId))!);
    });
    expect(await onlyRow(s)).toMatchObject({ status: "dismissed", outcome: "dismissed", reason: "mensagem_alterada" });
    // Criado: não mexe.
    t = convexTest(schema, modules);
    const h = await happy();
    await t.run(async (ctx) => {
      expect(await dismissOpenInterpretationOfMessage(ctx as never, (await ctx.db.get(h.messageId))!)).toBe(false);
    });
    expect((await appointments(h.s))[0].status).toBe("scheduled");
  });
});

// ---------------------------------------------------------------------------
// Equipe: aceitar, recusar, desfazer
// ---------------------------------------------------------------------------

describe("sugestão de 1 toque", () => {
  async function suggestion(opts: SeedOpts = { ai: false }) {
    const s = await seedOrg(opts);
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    const messageId = (await humanOnPhone(s, CONFIRM))!;
    await drain();
    const row = await onlyRow(s);
    expect(row.status).toBe("open");
    return { s, row, messageId };
  }

  test("aceitar marca pela porta (staff, avisos normais) e fecha a sugestão com `accepted`", async () => {
    const { s, row } = await suggestion();
    const out = await as(s.editor).mutation(api.schedulingInterpret.answerSuggestion, { organizationId: s.organizationId, interpretationId: row._id, accept: true });
    assertMatchesReturns(out, SI.answerSuggestion);
    const appts = await appointments(s);
    expect(appts).toHaveLength(1);
    expect(appts[0]).toMatchObject({ origin: "staff", status: "scheduled", startTime: at(10), serviceId: s.consulta, sourceMessageId: row.messageId, createdBy: s.editor.memberId });
    expect(out.appointmentId).toBe(appts[0]._id);
    const after = (await t.run((ctx) => ctx.db.get(row._id)))!;
    expect(after).toMatchObject({ status: "accepted", outcome: "accepted", appointmentId: appts[0]._id, answeredBy: s.editor.memberId });
    // O aviso do sino da sugestão foi resolvido.
    const n = await notificationsOf(s, "appointment_suggestion");
    expect(n.every((x) => x.readAt !== undefined)).toBe(true);
    // Auditoria sem texto de mensagem.
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "schedInterpretation"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain("confirmado segunda");
    // Responder duas vezes: recusado.
    await expect(as(s.editor).mutation(api.schedulingInterpret.answerSuggestion, { organizationId: s.organizationId, interpretationId: row._id, accept: true })).rejects.toThrow(/já foi respondida/);
    expect(await appointments(s)).toHaveLength(1);
  });

  test("aceitar com edições (outro horário e serviço) marca o editado e registra `edited`", async () => {
    const { s, row } = await suggestion({ ai: false, services: 2 });
    await as(s.admin).mutation(api.schedulingInterpret.answerSuggestion, {
      organizationId: s.organizationId, interpretationId: row._id, accept: true, edits: { timeMin: 11 * 60, serviceId: s.retorno },
    });
    const appts = await appointments(s);
    expect(appts[0]).toMatchObject({ startTime: at(11), serviceId: s.retorno });
    expect((await t.run((ctx) => ctx.db.get(row._id)))!.outcome).toBe("edited");
  });

  test("aceitar sem serviço definido pede o serviço; fora do expediente devolve as regras e aceita com `force`", async () => {
    const { s, row } = await suggestion({ ai: false, services: 2 });
    await expect(as(s.admin).mutation(api.schedulingInterpret.answerSuggestion, { organizationId: s.organizationId, interpretationId: row._id, accept: true })).rejects.toThrow(/Informe o dia, a hora e o serviço/);
    const bad = as(s.admin).mutation(api.schedulingInterpret.answerSuggestion, {
      organizationId: s.organizationId, interpretationId: row._id, accept: true, edits: { serviceId: s.consulta, timeMin: 19 * 60 },
    });
    await expect(bad).rejects.toThrow();
    expect(await appointments(s)).toHaveLength(0);
    const ok = await as(s.admin).mutation(api.schedulingInterpret.answerSuggestion, {
      organizationId: s.organizationId, interpretationId: row._id, accept: true, edits: { serviceId: s.consulta, timeMin: 19 * 60 }, force: ["OUTSIDE_HOURS"],
    });
    expect(ok.appointmentId).toBeDefined();
    expect((await appointments(s))[0].forcedRules).toContain("OUTSIDE_HOURS");
  });

  test("recusar fecha a sugestão, não cria nada e resolve o aviso", async () => {
    const { s, row } = await suggestion();
    const out = await as(s.editor).mutation(api.schedulingInterpret.answerSuggestion, { organizationId: s.organizationId, interpretationId: row._id, accept: false });
    assertMatchesReturns(out, SI.answerSuggestion);
    expect(out).toEqual({});
    expect(await appointments(s)).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.get(row._id))).toMatchObject({ status: "dismissed", outcome: "dismissed", answeredBy: s.editor.memberId });
    expect((await notificationsOf(s, "appointment_suggestion")).every((x) => x.readAt !== undefined)).toBe(true);
  });

  test("sugestão com mais de 48 h: aceitar é recusado e some das listas", async () => {
    const { s, row } = await suggestion();
    vi.setSystemTime(NOW + 49 * HOUR);
    await expect(as(s.editor).mutation(api.schedulingInterpret.answerSuggestion, { organizationId: s.organizationId, interpretationId: row._id, accept: true })).rejects.toThrow(/venceu/);
    const pending = await as(s.admin).query(api.scheduling.listPending, { organizationId: s.organizationId, now: NOW + 49 * HOUR });
    expect(pending.suggestions).toEqual([]);
    const list = await as(s.admin).query(api.schedulingInterpret.listOpenForConversation, { organizationId: s.organizationId, conversationId: s.conversationId, now: NOW + 49 * HOUR });
    expect(list).toEqual([]);
  });

  test("remarcou: aceitar remarca o agendamento do contato; cancelou: aceitar cancela", async () => {
    const s = await seedOrg({ ai: false });
    const { appointmentIds } = await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.organizationId, serviceId: s.consulta, startTime: at(14), contactId: s.contactId, idempotencyKey: "pre-4" });
    await humanOnPhone(s, "Remarcado para terça 14h");
    await drain();
    const row = await onlyRow(s);
    const out = await as(s.admin).mutation(api.schedulingInterpret.answerSuggestion, { organizationId: s.organizationId, interpretationId: row._id, accept: true });
    const appts = await appointments(s);
    expect(appts.find((a) => a._id === appointmentIds[0])!.status).toBe("rescheduled");
    expect(appts.find((a) => a._id === out.appointmentId)).toMatchObject({ startTime: at(14, 0, 16), status: "scheduled" });
    // Cancelar o novo.
    await humanOnPhone(s, "Cancelei sua consulta de terça");
    await drain();
    const rows = (await interpretations(s)).filter((r) => r.act === "cancelou");
    expect(rows).toHaveLength(1);
    await as(s.admin).mutation(api.schedulingInterpret.answerSuggestion, { organizationId: s.organizationId, interpretationId: rows[0]._id, accept: true });
    expect((await appointments(s)).find((a) => a._id === out.appointmentId)!.status).toBe("cancelled");
    expect(await schedInvariantProblems(t, s.organizationId, NOW)).toEqual([]);
  });

  test("remarcou: não aplica a agendamento de OUTRO cliente", async () => {
    const s = await seedOrg({ ai: false });
    const { appointmentIds } = await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.organizationId, serviceId: s.consulta, startTime: at(14), contactId: s.otherContactId, idempotencyKey: "pre-5" });
    const mine = await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.organizationId, serviceId: s.consulta, startTime: at(15), contactId: s.contactId, idempotencyKey: "pre-6" });
    void mine;
    await humanOnPhone(s, "Cancelei sua consulta de segunda");
    await drain();
    const row = await onlyRow(s);
    await expect(
      as(s.admin).mutation(api.schedulingInterpret.answerSuggestion, { organizationId: s.organizationId, interpretationId: row._id, accept: true, edits: { appointmentId: appointmentIds[0] } })
    ).rejects.toThrow(/não é deste cliente/);
  });

  test("há um pendente de aprovação do contato nesse horário: aceitar aprova o pendente (não cria outro)", async () => {
    const { s, row } = await suggestion();
    const pend = await t.run((ctx) =>
      bookAppointmentCore(ctx as never, {
        organizationId: s.organizationId, actor: { type: "system", via: "public_link" }, origin: "public", serviceId: s.consulta, startTime: at(10), contactId: s.contactId, leadId: s.leadId, now: NOW,
      } as never)
    );
    const out = await as(s.admin).mutation(api.schedulingInterpret.answerSuggestion, { organizationId: s.organizationId, interpretationId: row._id, accept: true });
    expect(await appointments(s)).toHaveLength(1);
    expect(out.appointmentId).toBe((pend as { appointmentId: Id<"schedAppointments"> }).appointmentId);
    expect((await appointments(s))[0].status).toBe("scheduled");
  });

  test("RBAC: só `agenda: edit`+ responde; módulo desligado recusa; outra org não enxerga", async () => {
    const { s, row } = await suggestion();
    const args = { organizationId: s.organizationId, interpretationId: row._id, accept: false };
    for (const p of [s.viewAll, s.viewOwn, s.none]) await expect(as(p).mutation(api.schedulingInterpret.answerSuggestion, args)).rejects.toThrow();
    await expect(as(s.outsider).mutation(api.schedulingInterpret.answerSuggestion, args)).rejects.toThrow();
    // Membro de outra org com o id da sugestão da primeira org e a SUA org: "não encontrada", igual a inexistente.
    await expect(as(s.outsider).mutation(api.schedulingInterpret.answerSuggestion, { ...args, organizationId: s.otherOrgId })).rejects.toThrow(/Sugestão não encontrada/);
    expect((await t.run((ctx) => ctx.db.get(row._id)))!.status).toBe("open");
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, { settings: { ...org.settings, modules: { scheduling: false } } });
    });
    await expect(as(s.admin).mutation(api.schedulingInterpret.answerSuggestion, args)).rejects.toThrow(/Módulo não habilitado/);
  });

  test("leituras: a lista geral (listPending) e a da conversa mostram a sugestão aberta, com motivo; isolamento e níveis", async () => {
    const { s, row } = await suggestion();
    const pending = await as(s.viewAll).query(api.scheduling.listPending, { organizationId: s.organizationId, now: NOW });
    assertMatchesReturns(pending, sched.listPending);
    expect(pending.suggestions).toHaveLength(1);
    expect(pending.suggestions[0]).toMatchObject({ _id: row._id, conversationId: s.conversationId, reason: "sem_ia", parsed: { localDate: "2026-06-15", timeMin: 600 } });
    const list = await as(s.viewAll).query(api.schedulingInterpret.listOpenForConversation, { organizationId: s.organizationId, conversationId: s.conversationId, now: NOW });
    assertMatchesReturns(list, SI.listOpenForConversation);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ _id: row._id, reason: "sem_ia", serviceName: "Consulta" });
    expect(await as(s.viewOwn).query(api.schedulingInterpret.listOpenForConversation, { organizationId: s.organizationId, conversationId: s.conversationId, now: NOW })).toEqual([]);
    expect(await as(s.outsider).query(api.schedulingInterpret.listOpenForConversation, { organizationId: s.organizationId, conversationId: s.conversationId, now: NOW })).toEqual([]);
    expect(await as(s.admin).query(api.schedulingInterpret.listOpenForConversation, { organizationId: s.organizationId, conversationId: s.otherConversationId, now: NOW })).toEqual([]);
    // Depois de recusada some das duas.
    await as(s.admin).mutation(api.schedulingInterpret.answerSuggestion, { organizationId: s.organizationId, interpretationId: row._id, accept: false });
    expect((await as(s.admin).query(api.scheduling.listPending, { organizationId: s.organizationId, now: NOW })).suggestions).toEqual([]);
  });

  test("uma sugestão nova do mesmo ato na conversa envelhece a anterior", async () => {
    const s = await seedOrg({ ai: false });
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    await humanOnPhone(s, "Ok, confirmado segunda 10h mesmo");
    await drain();
    const rows = await interpretations(s);
    expect(rows.filter((r) => r.status === "open")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "expired")).toHaveLength(1);
  });
});

describe("desfazer a criação automática", () => {
  test("libera a vaga, cancela como sistema (sem cancelamento tardio, sem `appointment.cancelled`) e marca a interpretação `undone`", async () => {
    const { s } = await happy();
    await t.run((ctx) => ctx.db.insert("webhooks", { organizationId: s.organizationId, name: "h", url: "https://example.test/h", events: ["*"], secret: "segredo-de-teste", isActive: true, createdAt: NOW }));
    const appt = (await appointments(s))[0];
    vi.setSystemTime(NOW + 6 * HOUR);
    const out = await as(s.editor).mutation(api.schedulingInterpret.undoHumanConfirmBooking, { organizationId: s.organizationId, appointmentId: appt._id });
    assertMatchesReturns(out, SI.undoHumanConfirmBooking);
    const after = (await appointments(s))[0];
    expect(after).toMatchObject({ status: "cancelled", cancelledByClass: "system" });
    expect(after.lateCancel).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("schedAllocations").collect())).toEqual([]);
    expect((await onlyRow(s)).outcome).toBe("undone");
    // Auditoria com outcome undone; evento undone e nenhum cancelled.
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "schedAppointment" && a.metadata?.outcome === "undone"));
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ undo: true, byClass: "system", lateCancel: false });
    const events = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((j) => JSON.stringify(j.args)));
    expect(events.some((e) => e.includes("appointment.undone"))).toBe(true);
    expect(events.some((e) => e.includes("appointment.cancelled"))).toBe(false);
    // A vaga voltou: a mesma hora pode ser marcada de novo; o "Desfazer" genérico não reinstala.
    await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.organizationId, serviceId: s.consulta, startTime: at(10), contactId: s.otherContactId, idempotencyKey: "pos-undo" });
    await expect(as(s.admin).mutation(api.schedulingMutations.undoAppointmentStatus, { organizationId: s.organizationId, appointmentId: appt._id })).rejects.toThrow();
    // Aviso "Marquei…" resolvido.
    expect((await notificationsOf(s, "appointment_created")).every((n) => n.readAt !== undefined)).toBe(true);
    expect(await schedInvariantProblems(t, s.organizationId, NOW)).toEqual([]);
  });

  test("a criação que foi para a fila de conflitos: desfazer fecha a linha do conflito", async () => {
    const s = await seedOrg({ ai: true });
    stubLlm(GOOD);
    await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.organizationId, serviceId: s.consulta, startTime: at(10), contactId: s.otherContactId, idempotencyKey: "pre-7" });
    await clientSays(s, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s, CONFIRM);
    await drain();
    const appt = (await appointments(s)).find((a) => a.origin === "human_message")!;
    await as(s.admin).mutation(api.schedulingInterpret.undoHumanConfirmBooking, { organizationId: s.organizationId, appointmentId: appt._id });
    expect((await conflicts())[0].status).toBe("resolved");
    expect(await schedInvariantProblems(t, s.organizationId, NOW)).toEqual([]);
  });

  test("janela de 24 h, só origem human_message, só `agenda: edit`, só a mesma org", async () => {
    const { s } = await happy();
    const appt = (await appointments(s))[0];
    const args = { organizationId: s.organizationId, appointmentId: appt._id };
    for (const p of [s.viewAll, s.viewOwn, s.none]) await expect(as(p).mutation(api.schedulingInterpret.undoHumanConfirmBooking, args)).rejects.toThrow();
    await expect(as(s.outsider).mutation(api.schedulingInterpret.undoHumanConfirmBooking, args)).rejects.toThrow();
    // Agendamento da EQUIPE não se desfaz por esta via.
    const staff = await as(s.admin).mutation(api.schedulingMutations.bookAppointment, { organizationId: s.organizationId, serviceId: s.consulta, startTime: at(15), contactId: s.otherContactId, idempotencyKey: "staff-1" });
    await expect(as(s.admin).mutation(api.schedulingInterpret.undoHumanConfirmBooking, { organizationId: s.organizationId, appointmentId: staff.appointmentIds[0] })).rejects.toThrow(/sua confirmação/);
    // Mudou de situação (confirmado): fora.
    await as(s.admin).mutation(api.schedulingMutations.setAppointmentStatus, { ...args, to: "confirmed" });
    await expect(as(s.admin).mutation(api.schedulingInterpret.undoHumanConfirmBooking, args)).rejects.toThrow(/mudou de situação/);
    // 24 h depois.
    const h2 = await happy();
    vi.setSystemTime(NOW + 25 * HOUR);
    await expect(as(h2.s.admin).mutation(api.schedulingInterpret.undoHumanConfirmBooking, { organizationId: h2.s.organizationId, appointmentId: (await appointments(h2.s))[0]._id })).rejects.toThrow(/24 horas/);
  });

  test("taxa de desfeito por org (internalUndoRate)", async () => {
    const { s } = await happy();
    const empty = await t.query(internal.schedulingInterpret.internalUndoRate, { organizationId: s.otherOrgId });
    expect(empty).toEqual({ created: 0, undone: 0, rate: null, suggested: 0, accepted: 0, dismissed: 0, sample: 0 });
    const before = await t.query(internal.schedulingInterpret.internalUndoRate, { organizationId: s.organizationId });
    assertMatchesReturns(before, SI.internalUndoRate);
    expect(before).toMatchObject({ created: 1, undone: 0, rate: 0, sample: 1 });
    await as(s.admin).mutation(api.schedulingInterpret.undoHumanConfirmBooking, { organizationId: s.organizationId, appointmentId: (await appointments(s))[0]._id });
    expect(await t.query(internal.schedulingInterpret.internalUndoRate, { organizationId: s.organizationId })).toMatchObject({ created: 1, undone: 1, rate: 1 });
  });
});

// ---------------------------------------------------------------------------
// Privacidade e contratos
// ---------------------------------------------------------------------------

describe("LGPD e contratos", () => {
  test("nenhuma linha gravada contém o texto das mensagens (interpretação, auditoria, atividade, aviso, estado, run, jobs)", async () => {
    const { s } = await happy();
    await humanOnPhone(s, "Fechado! Mas só consigo terça 15h30 com o doutor Fulano");
    await drain();
    const dump = await t.run(async (ctx) => {
      const tables = ["schedInterpretations", "auditLogs", "activities", "notifications", "schedConversationState", "agentRuns", "schedAppointments", "schedConflicts"] as const;
      const out: string[] = [];
      for (const name of tables) out.push(JSON.stringify(await ctx.db.query(name).collect()));
      out.push(JSON.stringify((await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.args)));
      return out.join("\n");
    });
    for (const text of ["confirmado segunda", CLIENT_ASKS, CONFIRM, "doutor Fulano", "Pode ser segunda"]) expect(dump).not.toContain(text);
  });

  test("validators de retorno das funções novas conferem com o que sai", async () => {
    const { s, messageId } = await happy();
    assertMatchesReturns(await t.mutation(internal.schedulingInterpret.internalStart, { messageId }), SI.internalStart);
    assertMatchesReturns(await t.mutation(internal.schedulingInterpret.internalDecide, { messageId }), SI.internalDecide);
    assertMatchesReturns(await t.query(internal.schedulingInterpret.internalUndoRate, { organizationId: s.organizationId }), SI.internalUndoRate);
    const ctxOut = await t.query(internal.schedulingInterpret.internalClassifierContext, { messageId, now: NOW });
    assertMatchesReturns(ctxOut, SI.internalClassifierContext);
    // Remetente de uma sugestão e propostas: formatos do `listPending.suggestions` também conferem (ver teste de leituras).
    const s2 = await seedOrg({ ai: false });
    await clientSays(s2, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(s2, CONFIRM);
    await drain();
    const row = await onlyRow(s2);
    assertMatchesReturns(await as(s2.admin).query(api.scheduling.listPending, { organizationId: s2.organizationId, now: NOW }), sched.listPending);
    expect(row.decision).toBe("proposed");
  });

  test("isolamento entre orgs: uma sugestão/aviso nunca vai para membro de outra org", async () => {
    const a = await seedOrg({ ai: false });
    await clientSays(a, CLIENT_ASKS, NOW - 30 * MIN);
    await humanOnPhone(a, CONFIRM);
    await drain();
    const all = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((n) => n.organizationId === a.organizationId && n.memberId !== a.outsider.memberId)).toBe(true);
    expect((await as(a.outsider).query(api.scheduling.listPending, { organizationId: a.organizationId, now: NOW })).suggestions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fumaça: nenhuma frase NEGATIVA das tabelas do parser cria agendamento
// ---------------------------------------------------------------------------

describe("fumaça com as tabelas do parser", () => {
  const SAT = Date.parse("2026-11-21T10:00:00-03:00"); // relógio padrão das tabelas
  const negatives: string[] = [
    ...MAIN.NEGATIVAS.filter((r) => r.now === undefined && r.tz === undefined).map((r) => r.t),
    ...ROUND1.filter((c) => c.exp === "NC" && c.now === undefined && c.tz === undefined).map((c) => c.t),
    ...OWN100.filter((r) => r.exp === "NC").map((r) => r.t),
  ].filter((txt) => txt.length <= 600);

  test(`${negatives.length} frases negativas: nenhuma resulta em agendamento, com ou sem proposta coincidente e com um modelo que concorda com tudo`, async () => {
    expect(negatives.length).toBeGreaterThanOrEqual(150);
    for (const withProposal of [false, true]) {
      t = convexTest(schema, modules);
      vi.setSystemTime(SAT);
      const s = await seedOrg({ ai: true, now: SAT });
      // O adversário: um modelo que concorda em tudo com o que o parser leu (pior caso do classificador).
      stubLlm((body) => {
        const text = messageSeenByModel(body);
        const p = parseConfirmation(text, { now: SAT, tz: "America/Sao_Paulo" });
        const hh = (m?: number) => (m === undefined ? "nenhuma" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
        return chatResponse(JSON.stringify({ ato: "confirmou", dia: p.localDate ?? "2026-11-26", hora: hh(p.timeMin ?? 600), servico: "nenhum", evidencia: text }));
      });
      if (withProposal) await clientSays(s, "Pode ser quinta 26/11 às 10h?", SAT - HOUR);
      let n = 0;
      for (const text of negatives) {
        await humanOnPhone(s, text, { at: SAT });
        if (++n % 20 === 0) {
          await drain();
          const created = (await appointments(s)).length;
          expect(created, `frase negativa criou agendamento (com proposta: ${withProposal}) antes de: ${text}`).toBe(0);
        }
      }
      await drain();
      expect(await appointments(s), `alguma frase negativa criou agendamento (com proposta: ${withProposal})`).toHaveLength(0);
    }
  }, 120_000);

  test("frases que o parser vê como confirmação verdadeira mas são de outro assunto (cls ctx): sem proposta coincidente nunca criam, mesmo com um modelo que concorda com tudo", async () => {
    const ctxPhrases = ROUND2.CASES.filter((c) => c.cls === "ctx" && c.now === undefined && c.tz === undefined).map((c) => c.t);
    expect(ctxPhrases.length).toBeGreaterThanOrEqual(30);
    vi.setSystemTime(SAT);
    const s = await seedOrg({ ai: true, now: SAT });
    const llm = stubLlm((body) => {
      const text = messageSeenByModel(body);
      const p = parseConfirmation(text, { now: SAT, tz: "America/Sao_Paulo" });
      const hh = (m?: number) => (m === undefined ? "nenhuma" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
      return chatResponse(JSON.stringify({ ato: "confirmou", dia: p.localDate ?? "nenhum", hora: hh(p.timeMin), servico: "nenhum", evidencia: text }));
    });
    // Uma proposta do cliente para OUTRO horário (sexta 14h): não coincide com nenhuma frase.
    await clientSays(s, "Pode ser sexta 27/11 às 14h?", SAT - HOUR);
    for (const text of ctxPhrases) await humanOnPhone(s, text, { at: SAT });
    await drain();
    const rows = await interpretations(s);
    expect(rows.length).toBeGreaterThan(10); // o parser as leu como confirmação: viraram proposta, não agendamento
    expect(await appointments(s)).toHaveLength(0);
    expect(llmCalls(llm)).toHaveLength(0); // nem o modelo é consultado: a condição 3 barra antes
    expect(rows.every((r) => r.decision === "proposed" || r.decision === "ignored" || r.decision === "proposal_saved")).toBe(true);
  }, 60_000);

  test("controle positivo da fumaça: a mesma estrutura, com uma confirmação verdadeira, CRIA", async () => {
    vi.setSystemTime(SAT);
    const s = await seedOrg({ ai: true, now: SAT });
    stubLlm((body) =>
      chatResponse(JSON.stringify({ ato: "confirmou", dia: "2026-11-26", hora: "10:00", servico: "nenhum", evidencia: messageSeenByModel(body).slice(0, 12) }))
    );
    await clientSays(s, "Pode ser quinta 26/11 às 10h?", SAT - HOUR);
    await humanOnPhone(s, "Ok, confirmado quinta 10h", { at: SAT });
    await drain();
    expect(await appointments(s)).toHaveLength(1);
  });
});
