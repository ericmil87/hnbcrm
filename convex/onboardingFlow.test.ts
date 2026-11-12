/// <reference types="vite/client" />
/**
 * Roteiro determinístico da conversa de configuração: o ESTADO decide o próximo
 * passo e os cartões; o modelo só escreve frases. Eventos estruturados (sem LLM),
 * link antes da confirmação do e-mail, procedência, envio automático do código e
 * o fechamento do ciclo (ativar, testar, conectar).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { setSafeFetchDepsForTests } from "./lib/safeFetchNode";
import type { SafeFetchDeps } from "./lib/safeFetch";
import { parseTurnBody } from "./onboardingHttp";
import { buildBlock } from "./lib/onboardingBlocks";
import { scanDraft } from "./lib/onboardingDraftFilter";
import { mergeDraftPatch, mergeReaderProposal, templateStartDraft } from "./lib/onboardingInterviewer";
import { normalizeDraft } from "./lib/onboardingDraft";
import { sectionSignature, stepMessage } from "./lib/onboardingRoadmap";

const sentEmails: Array<{ to: string; html: string }> = [];
vi.mock("./email", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./email")>();
  return {
    ...orig,
    sendTransactionalEmail: vi.fn(async (_ctx: unknown, args: { to: string; html: string }) => {
      sentEmails.push({ to: args.to, html: args.html });
      return true;
    }),
  };
});

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-FAKE-test-key");
  vi.stubEnv("LLM_PLATFORM_ORDER", "openrouter-only");
  vi.stubEnv("JWT_PRIVATE_KEY", "fake-jwt-key-for-tests");
  sentEmails.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setSafeFetchDepsForTests(null);
});

type T = TestConvex<typeof schema>;
const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function seed(t: T, opts: { verified?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Passeios do Bruno",
      slug: "passeios-do-bruno",
      settings: { timezone: "America/Recife", currency: "BRL", aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 } },
      onboardingMeta: { industry: "outro" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {
      email: "bugueiroteste@milfont.net",
      ...(opts.verified ? { emailVerificationTime: now } : {}),
    });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Bruno", email: "bugueiroteste@milfont.net", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    return { organizationId, userId, memberId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

// ── LLM falso ───────────────────────────────────────────────────────────────

type Call = { role: string; body: { messages: Array<{ role: string; content: unknown }>; tools?: unknown } };

function completion(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 600, completion_tokens: 80 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
function roleOf(body: Call["body"]): string {
  const sys = String(body.messages?.[0]?.content ?? "");
  if (sys.includes("LEITOR em quarentena")) return "reader";
  if (sys.includes("configuração inicial por conversa")) return "interviewer";
  return "other";
}
function stubLlm(responder: (role: string, n: number, body: Call["body"]) => Response | string): Call[] {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const role = roleOf(body);
      counts[role] = (counts[role] ?? 0) + 1;
      calls.push({ role, body });
      const r = responder(role, counts[role], body);
      return typeof r === "string" ? completion(r) : r;
    }),
  );
  return calls;
}
const interviewer = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ reply: "Que legal! Me conta de onde você sai com os passeios?", chips: ["Saio da praia"], ...extra });

const DESCRIBE = { draftPatch: { business: { description: "Passeios de buggy em Porto de Galinhas" } } };

async function turn(t: T, s: Seed, input: { text?: string; attachment?: { kind: "url"; url: string } }) {
  return await as(t, s.userId).action(internal.onboardingChat.internalSendTurn, { organizationId: s.organizationId, ...input });
}
async function event(t: T, s: Seed, ev: Parameters<typeof parseTurnBody>[0] extends never ? never : NonNullable<ReturnType<typeof parseTurnBody>>["event"]) {
  return await as(t, s.userId).action(internal.onboardingChat.internalSendTurn, { organizationId: s.organizationId, event: ev });
}
async function state(t: T, s: Seed) {
  return await t.run(async (ctx) => {
    const session = await ctx.db.query("onboardingSessions").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).first();
    const messages = session
      ? await ctx.db.query("onboardingMessages").withIndex("by_session", (q) => q.eq("sessionId", session._id)).collect()
      : [];
    const limits = await ctx.db.query("onboardingRateLimits").collect();
    const runs = await ctx.db.query("agentRuns").collect();
    return { session, messages, limits, runs };
  });
}
const kinds = (r: { ok: boolean; blocks?: Array<{ kind: string }> }) => (r.blocks ?? []).map((b) => b.kind);

/** Liga a IA da org e marca o rascunho atual como aplicado (o que `applyOnboardingDraft` faz, sem o resto). */
async function markApplied(t: T, s: Seed) {
  await t.run(async (ctx) => {
    const org = (await ctx.db.get(s.organizationId))!;
    await ctx.db.patch(s.organizationId, {
      settings: { ...org.settings, aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, lgpdAck: { acceptedAt: Date.now(), acceptedBy: s.memberId } } },
    });
    const session = (await ctx.db.query("onboardingSessions").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).first())!;
    await ctx.db.patch(session._id, { appliedDraftHash: session.draftHash, appliedAt: Date.now() });
  });
}

describe("turno normal: cartões pelo estado", () => {
  test("o funil não aparece 3 vezes em 3 turnos; o negócio contado leva o cartão do passo uma vez", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm((_r, n) => interviewer(n === 1 ? { ...DESCRIBE, blocks: [{ kind: "funilPreview" }] } : { blocks: [{ kind: "funilPreview" }] }));
    const r1 = await turn(t, s, { text: "Sou bugueiro em Porto de Galinhas" });
    const r2 = await turn(t, s, { text: "Saio da praia" });
    const r3 = await turn(t, s, { text: "Levo até 4 pessoas" });
    const funnels = [r1, r2, r3].map((r) => (r.ok ? r.blocks.filter((b) => b.kind === "funilPreview").length : -1));
    expect(funnels).toEqual([1, 0, 0]);
    const { session } = await state(t, s);
    expect(session?.shownCards?.funilPreview).toBeTruthy();
  });

  test("1º turno sem negócio contado não força o funil", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm(() => interviewer());
    const r = await turn(t, s, { text: "oi" });
    expect(r.ok && kinds(r)).toEqual([]);
  });

  test("passo de ativar: o cartão de ação vem do estado, mesmo sem o modelo pedir; pedido de ação é ignorado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm((_r, n) => interviewer(n === 1 ? DESCRIBE : { blocks: [{ kind: "operacaoPronta" }, { kind: "cartaoAceite" }] }));
    await turn(t, s, { text: "Sou bugueiro" });
    // Aprovações gravadas direto (sem evento): o cartão de ação ainda nunca foi mostrado.
    await t.run(async (ctx) => {
      const session = (await ctx.db.query("onboardingSessions").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).first())!;
      await ctx.db.patch(session._id, {
        approvals: {
          funnel: sectionSignature(session.draft!, "funnel"),
          persona: sectionSignature(session.draft!, "persona"),
          knowledge: sectionSignature(session.draft!, "knowledge"),
        },
      });
    });
    const r = await turn(t, s, { text: "tudo certo, e agora?" });
    expect(r.ok && kinds(r)).toEqual(["ativarIa"]);
  });

  test("resposta que diz 'cartão abaixo' sai com o cartão do passo, mesmo já mostrado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm((_r, n) =>
      n === 1
        ? interviewer(DESCRIBE)
        : n === 2
          ? interviewer({ reply: "Dá uma olhada no cartão abaixo e me diz se está bom." })
          : interviewer(),
    );
    const r1 = await turn(t, s, { text: "Sou bugueiro" });
    expect(r1.ok && kinds(r1)).toEqual(["funilPreview"]);
    const r2 = await turn(t, s, { text: "ok" });
    expect(r2.ok && kinds(r2)).toEqual(["funilPreview"]);
    const r3 = await turn(t, s, { text: "legal" });
    expect(r3.ok && kinds(r3)).toEqual([]);
  });

  test("chips: nada de segmento depois do negócio contado; etapa vem da tarefa e nunca de 'materials'", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm((_r, n) =>
      interviewer({ ...(n === 1 ? DESCRIBE : {}), chips: ["Clínica ou consultório", "Tenho uma loja"], nextStage: "materials" }),
    );
    const r = await turn(t, s, { text: "Sou bugueiro" });
    expect(r.ok && r.chips).toEqual(["Quero mudar as etapas", "O que é um funil?"]);
    const { session } = await state(t, s);
    expect(session?.stage).toBe("draft");
    expect(session?.reachedStep).toBe(1);
  });

  test("falha do modelo devolve o próximo passo (fala fixa, cartão do passo e chips da tarefa)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm((_r, n) => (n === 1 ? interviewer(DESCRIBE) : "isto não é JSON"));
    await turn(t, s, { text: "Sou bugueiro" });
    const r = await turn(t, s, { text: "oi?" });
    expect(r.ok && r.reply).toBe(stepMessage("next", "approve_funnel"));
    expect(r.ok && kinds(r)).toEqual(["funilPreview"]);
    expect(r.ok && r.chips.length).toBeGreaterThan(0);
    expect(r.ok && r.reply).not.toContain("Tive um problema");
  });

  test("horário: o rascunho nasce 24h, com recursos ligados e a regra de pedido de humano", async () => {
    const d = templateStartDraft("outro", "Passeios do Bruno");
    expect(d.businessHours).toBeUndefined();
    expect(Object.values(d.features).every((x) => x === true)).toBe(true);
    expect(d.handoffRules.map((r) => r.kind)).toContain("pedido_humano");
  });
});

describe("procedência no cartão do conhecimento", () => {
  const fact = (draft: ReturnType<typeof templateStartDraft>) => {
    const checked = normalizeDraft(draft);
    if (!checked.ok) throw new Error("rascunho inválido");
    const block = buildBlock({ kind: "conhecimentoLista" }, { draft: checked.draft, draftHash: "h", draftVersion: 1, appliedDraftHash: null, emailVerified: true, aiActive: false });
    if (!block || block.kind !== "conhecimentoLista") throw new Error("sem bloco");
    return block.items[0];
  };
  const viaAi = (patched: ReturnType<typeof templateStartDraft>, previous = templateStartDraft("outro", "X")) =>
    scanDraft(patched, { mode: "ai", previous, now: 1 }).draft;

  test("digitado: 'Você contou' (nunca 'Do site')", () => {
    const d = viaAi(mergeDraftPatch(templateStartDraft("outro", "X"), { knowledge: ["Saímos às 8h da praia"] }));
    expect(fact(d)).toMatchObject({ originKind: "usuario", originLabel: "Você contou" });
  });

  test("áudio transcrito: 'Do áudio'", () => {
    const d = viaAi(mergeDraftPatch(templateStartDraft("outro", "X"), { knowledge: ["Saímos às 8h da praia"] }, { fromAudio: true }));
    expect(fact(d)).toMatchObject({ originKind: "audio", originLabel: "Do áudio" });
  });

  test("material lido continua 'Do site: host' e 'Do PDF: nome'", () => {
    const base = templateStartDraft("outro", "X");
    const site = mergeReaderProposal(base, { knowledge: ["Passeio R$ 120"], quickReplies: [] }, { kind: "site", reference: "bugueiro.example" }).draft;
    expect(fact(viaAi(site))).toMatchObject({ originKind: "site", originLabel: "Do site: bugueiro.example" });
    const pdf = mergeReaderProposal(base, { knowledge: ["Passeio R$ 120"], quickReplies: [] }, { kind: "pdf", reference: "tabela.pdf" }).draft;
    expect(fact(viaAi(pdf))).toMatchObject({ originKind: "pdf", originLabel: "Do PDF: tabela.pdf" });
  });

  test("ponta a ponta: fato digitado num turno aparece 'Você contou'", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm(() => interviewer({ ...DESCRIBE, draftPatch: { ...DESCRIBE.draftPatch, knowledge: ["Passeio de 4h custa R$ 300"] }, blocks: [{ kind: "conhecimentoLista" }] }));
    await turn(t, s, { text: "O passeio de 4h custa R$ 300" });
    // O cartão do conhecimento entra quando vira o passo atual (depois do funil e do jeito de atender).
    await event(t, s, { kind: "approve", section: "funnel" });
    const r = await event(t, s, { kind: "approve", section: "persona" });
    const list = r.ok ? r.blocks.find((b) => b.kind === "conhecimentoLista") : undefined;
    expect(list && list.kind === "conhecimentoLista" && list.items[0].originLabel).toBe("Você contou");
  });
});

describe("eventos estruturados (sem LLM)", () => {
  test("approve avança, anexa o cartão seguinte, não grava mensagem de usuário e não chama o modelo nem gasta limite", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    const calls = stubLlm((_r, n) => interviewer(n === 1 ? DESCRIBE : {}));
    await turn(t, s, { text: "Sou bugueiro" });
    const before = await state(t, s);
    const llmBefore = calls.length;

    const r = await event(t, s, { kind: "approve", section: "funnel" });
    expect(r.ok).toBe(true);
    expect(r.ok && kinds(r)).toEqual(["personaCard"]);
    expect(r.ok && r.reply).toContain("Combinado.");
    expect(r.ok && r.reply).toContain("24h");
    expect(calls.length).toBe(llmBefore);

    const after = await state(t, s);
    expect(after.messages.length).toBe(before.messages.length + 1);
    expect(after.messages.at(-1)?.role).toBe("assistant");
    expect(after.messages.at(-1)?.event).toMatch(/^approve:funnel:approve_persona/);
    expect(after.limits).toEqual(before.limits);
    expect(after.runs.length).toBe(before.runs.length);
    expect(after.session?.approvals?.funnel).toBeTruthy();
    expect(after.session?.reachedStep).toBe(2);
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    const approvals = audit.filter((a) => (a.metadata as { action?: string })?.action === "onboarding_section_approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].severity).toBe("low");
    expect(JSON.stringify(approvals[0].metadata)).toBe(JSON.stringify({ action: "onboarding_section_approved", section: "funnel" }));
  });

  test("evento repetido não duplica a mensagem", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm((_r, n) => interviewer(n === 1 ? DESCRIBE : {}));
    await turn(t, s, { text: "Sou bugueiro" });
    await event(t, s, { kind: "approve", section: "funnel" });
    const n1 = (await state(t, s)).messages.length;
    const again = await event(t, s, { kind: "approve", section: "funnel" });
    expect(again.ok).toBe(true);
    expect((await state(t, s)).messages.length).toBe(n1);
    await event(t, s, { kind: "next" });
    const n2 = (await state(t, s)).messages.length;
    await event(t, s, { kind: "next" });
    expect((await state(t, s)).messages.length).toBe(n2);
  });

  test("approve com assinatura velha não aprova: avisa que o cartão mudou e reanexa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm((_r, n) => interviewer(n === 1 ? DESCRIBE : {}));
    await turn(t, s, { text: "Sou bugueiro" });
    const r = await event(t, s, { kind: "approve", section: "funnel", sig: "00000000" });
    expect(r.ok && r.reply).toContain("mudou");
    expect(r.ok && kinds(r)).toEqual(["funilPreview"]);
    expect((await state(t, s)).session?.approvals?.funnel).toBeUndefined();
  });

  test("fato falso não é reconhecido: responde com o passo atual, sem erro e sem gravar nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t); // e-mail NÃO confirmado
    stubLlm((_r, n) => interviewer(n === 1 ? DESCRIBE : {}));
    await turn(t, s, { text: "Sou bugueiro" });
    for (const what of ["email_verified", "activated", "tested", "connected", "skip_connect"] as const) {
      const r = await event(t, s, { kind: "notify", what });
      expect(r.ok).toBe(true);
      expect(r.ok && r.reply).toBe(stepMessage("next", "approve_funnel"));
    }
    const { session } = await state(t, s);
    expect(session?.testedAt).toBeUndefined();
    expect(session?.channelStepAt).toBeUndefined();
  });

  test("ciclo completo: e-mail, ativar, testar, pular a conexão e operação pronta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubLlm((_r, n) => interviewer(n === 1 ? DESCRIBE : {}));
    await turn(t, s, { text: "Sou bugueiro" });
    await event(t, s, { kind: "approve", section: "funnel" });
    await event(t, s, { kind: "approve", section: "persona" });
    const act = await event(t, s, { kind: "approve", section: "knowledge" });
    expect(act.ok && kinds(act)).toEqual(["ativarIa"]);

    // E-mail confirmado: reconhece e segue para o passo atual (nunca fica mudo).
    await t.run(async (ctx) => ctx.db.patch(s.userId, { emailVerificationTime: Date.now() }));
    const mail = await event(t, s, { kind: "notify", what: "email_verified" });
    expect(mail.ok && mail.reply).toContain("E-mail confirmado.");
    expect(mail.ok && kinds(mail)).toEqual(["ativarIa"]);

    // Ativou + montou (o clique do cartão): vai para o teste.
    await markApplied(t, s);
    const on = await event(t, s, { kind: "notify", what: "activated" });
    expect(on.ok && on.reply).toContain("a sua IA está ligada");
    expect(on.ok && kinds(on)).toEqual(["operacaoPronta"]);

    const tested = await event(t, s, { kind: "notify", what: "tested" });
    expect(tested.ok && tested.reply).toContain("WhatsApp");
    const connectStep = tested.ok ? tested.blocks.find((b) => b.kind === "operacaoPronta") : undefined;
    expect(connectStep && connectStep.kind === "operacaoPronta" && connectStep.tested).toBe(true);

    const done = await event(t, s, { kind: "notify", what: "skip_connect" });
    const final = done.ok ? done.blocks.find((b) => b.kind === "operacaoPronta") : undefined;
    expect(final && final.kind === "operacaoPronta" && [final.tested, final.connected]).toEqual([true, true]);
    expect(done.ok && done.reply).toContain("CRM");

    const { session, messages } = await state(t, s);
    expect(session?.channelStepKind).toBe("skipped");
    expect(session?.reachedStep).toBe(5);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(calls.length).toBe(1);

    const chat = await as(t, s.userId).query(api.onboardingChat.getChatState, { organizationId: s.organizationId });
    expect(chat).toMatchObject({ emailVerified: true, applied: true, tested: true, connected: true, reachedStep: 5, pendingMaterials: 0, maskedEmail: "bu…te@milfont.net" });
    expect(chat?.approvals.funnel).toBeTruthy();
    expect(chat?.lastChips).toEqual([]);
  });

  test("connected só com canal de WhatsApp conectado de verdade", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm((_r, n) => interviewer(n === 1 ? DESCRIBE : {}));
    await turn(t, s, { text: "Sou bugueiro" });
    await markApplied(t, s);
    await event(t, s, { kind: "notify", what: "tested" });
    const no = await event(t, s, { kind: "notify", what: "connected" });
    expect(no.ok && no.reply).toBe(stepMessage("next", "connect"));
    expect((await state(t, s)).session?.channelStepAt).toBeUndefined();
    await t.run(async (ctx) => {
      await ctx.db.insert("channelConfigs", {
        organizationId: s.organizationId, channel: "whatsapp", provider: "meta", displayName: "Principal", phoneNumberId: "555000111", status: "active", createdAt: 1, updatedAt: 1,
      });
    });
    const yes = await event(t, s, { kind: "notify", what: "connected" });
    expect(yes.ok && yes.reply).toContain("WhatsApp conectado.");
    expect((await state(t, s)).session?.channelStepKind).toBe("connected");
  });

  test("evento exige conta e permissão; texto ou anexo junto do evento é recusado; corpo HTTP valida", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm(() => interviewer());
    const anon = await t.action(internal.onboardingChat.internalSendTurn, { organizationId: s.organizationId, event: { kind: "next" } });
    expect(anon).toMatchObject({ ok: false, code: "forbidden" });
    const both = await as(t, s.userId).action(internal.onboardingChat.internalSendTurn, { organizationId: s.organizationId, text: "oi", event: { kind: "next" } });
    expect(both).toMatchObject({ ok: false, code: "invalid_input" });

    const org = s.organizationId;
    expect(parseTurnBody({ organizationId: org, event: { kind: "approve", section: "funnel", sig: "abc" } })?.event).toEqual({ kind: "approve", section: "funnel", sig: "abc" });
    expect(parseTurnBody({ organizationId: org, event: { kind: "notify", what: "tested" } })?.event).toEqual({ kind: "notify", what: "tested" });
    expect(parseTurnBody({ organizationId: org, event: { kind: "process_pending" } })?.event).toEqual({ kind: "process_pending" });
    expect(parseTurnBody({ organizationId: org, event: { kind: "approve", section: "outra" } })).toBeNull();
    expect(parseTurnBody({ organizationId: org, event: { kind: "notify", what: "hack" } })).toBeNull();
    expect(parseTurnBody({ organizationId: org, event: { kind: "next" }, text: "oi" })).toBeNull();
    expect(parseTurnBody({ organizationId: org, event: "next" })).toBeNull();
  });

  test("sessão de outra org não é tocada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    const other = await t.run(async (ctx) => {
      const now = Date.now();
      const orgId = await ctx.db.insert("organizations", { name: "Outra", slug: "outra", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now });
      const userId = await ctx.db.insert("users", { email: "o@milfont.net" });
      const memberId = await ctx.db.insert("teamMembers", { organizationId: orgId, userId, name: "O", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now });
      const sessionId = await ctx.db.insert("onboardingSessions", { organizationId: orgId, createdBy: memberId, stage: "interview", draftVersion: 0, messageCount: 0, spentUsdMicros: 0, createdAt: now, updatedAt: now });
      return { sessionId };
    });
    const r = await as(t, s.userId).action(internal.onboardingChat.internalSendTurn, {
      organizationId: s.organizationId,
      sessionId: other.sessionId,
      event: { kind: "approve", section: "funnel" },
    });
    expect(r).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("link antes da confirmação do e-mail", () => {
  const URL_ = "https://bugueiro.example/";
  const PAGE = "<html><head><title>Bugueiro</title></head><body><p>Passeio de 4h por R$ 300. Saímos da praia às 8h.</p></body></html>";
  function fakeNet() {
    const connects: string[] = [];
    const deps: SafeFetchDeps = {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: async (req) => {
        connects.push(req.url.toString());
        const bytes = new TextEncoder().encode(PAGE);
        return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: (async function* () { yield bytes; })(), cancel: () => {} };
      },
    };
    setSafeFetchDepsForTests(deps);
    return connects;
  }

  test("fica pendente (sem rede, sem LLM, sem orçamento); process_pending depois de confirmar e dar ciência lê pelo turno normal", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const connects = fakeNet();
    const calls = stubLlm((role) =>
      role === "reader"
        ? JSON.stringify({ knowledge: ["Passeio de 4h por R$ 300", "Saída da praia às 8h"], business: { description: "Passeios de buggy" } })
        : interviewer(),
    );

    const r = await turn(t, s, { attachment: { kind: "url", url: URL_ } });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(connects).toHaveLength(0);
    const conta = r.ok ? r.blocks.find((b) => b.kind === "cartaoConta") : undefined;
    expect(conta).toMatchObject({ kind: "cartaoConta", emailVerified: false, maskedEmail: "bu…te@milfont.net", pendingCount: 1 });
    expect(r.ok && kinds(r)).toContain("avisoMateriais");
    expect(r.ok && r.reply).toContain("bu…te@milfont.net");
    let st = await state(t, s);
    expect(st.session?.pendingMaterials).toHaveLength(1);
    expect(st.session?.pendingMaterials?.[0]).toMatchObject({ kind: "url", url: URL_, label: "bugueiro.example" });
    expect(st.messages[0]).toMatchObject({ role: "user", attachment: { kind: "site" } });
    expect(st.runs.filter((x) => x.kind === "onboarding")).toHaveLength(0);

    // Mesmo link de novo não duplica; o 4º diferente é recusado pelo teto de 3.
    await turn(t, s, { attachment: { kind: "url", url: URL_ } });
    await turn(t, s, { attachment: { kind: "url", url: "https://a.example/" } });
    await turn(t, s, { attachment: { kind: "url", url: "https://b.example/" } });
    const full = await turn(t, s, { attachment: { kind: "url", url: "https://c.example/" } });
    expect(full.ok && full.reply).toContain("demais");
    st = await state(t, s);
    expect(st.session?.pendingMaterials?.map((m) => m.label)).toEqual(["bugueiro.example", "a.example", "b.example"]);
    expect(connects).toHaveLength(0);
    expect(calls).toHaveLength(0);

    // Sem confirmação, process_pending só repete o pedido (nada é lido).
    const early = await event(t, s, { kind: "process_pending" });
    expect(early.ok && kinds(early)).toEqual(["cartaoConta"]);
    expect(connects).toHaveLength(0);

    // Confirma o e-mail: reconhece e avisa que vai ler; falta a ciência do aviso.
    await t.run(async (ctx) => ctx.db.patch(s.userId, { emailVerificationTime: Date.now() }));
    const mail = await event(t, s, { kind: "notify", what: "email_verified" });
    expect(mail.ok && mail.reply).toContain("Já vou ler");
    expect(mail.ok && kinds(mail)).toContain("avisoMateriais");
    const noAck = await event(t, s, { kind: "process_pending" });
    expect(noAck.ok && kinds(noAck)).toEqual(["avisoMateriais"]);
    expect(connects).toHaveLength(0);

    // Ciência dada: lê o PRIMEIRO, pelo turno normal (leitor + entrevistador, página contada).
    await as(t, s.userId).mutation(api.onboardingChat.ackMaterialsNotice, { organizationId: s.organizationId, sessionId: st.session!._id });
    const read = await event(t, s, { kind: "process_pending" });
    expect(read.ok).toBe(true);
    expect(connects).toEqual([URL_]);
    expect(calls.map((c) => c.role)).toEqual(["reader", "interviewer"]);
    const progress = read.ok ? read.blocks.find((b) => b.kind === "uploadProgresso") : undefined;
    expect(progress).toMatchObject({ kind: "uploadProgresso", status: "lido", sourceKind: "site" });
    st = await state(t, s);
    expect(st.session?.pendingMaterials?.map((m) => m.label)).toEqual(["a.example", "b.example"]);
    expect(st.session?.draft?.knowledge.some((k) => k.text.includes("R$ 300"))).toBe(true);
  });

  test("link com a leitura recusada (limite) volta para a frente da fila", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const connects = fakeNet();
    stubLlm(() => interviewer());
    await turn(t, s, { attachment: { kind: "url", url: URL_ } });
    await t.run(async (ctx) => ctx.db.patch(s.userId, { emailVerificationTime: Date.now() }));
    const st = await state(t, s);
    await as(t, s.userId).mutation(api.onboardingChat.ackMaterialsNotice, { organizationId: s.organizationId, sessionId: st.session!._id });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("onboardingRateLimits").collect()) await ctx.db.patch(row._id, { count: 10_000 });
    });
    const r = await event(t, s, { kind: "process_pending" });
    expect(r).toMatchObject({ ok: false, code: "rate_limited" });
    expect((await state(t, s)).session?.pendingMaterials).toHaveLength(1);
    expect(connects).toHaveLength(0);
  });

  test("sem pendência, process_pending é no-op", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm(() => interviewer());
    const r = await event(t, s, { kind: "process_pending" });
    expect(r).toMatchObject({ ok: true, reply: "", blocks: [] });
    expect((await state(t, s)).messages).toHaveLength(0);
  });

  test("ARQUIVO antes da confirmação continua recusado (email_unverified), sem blob novo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const calls = stubLlm(() => interviewer());
    const storageId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }));
      await ctx.db.insert("files", { organizationId: s.organizationId, storageId: id, name: "tabela.pdf", mimeType: "application/pdf", size: 3, fileType: "other", createdAt: Date.now() });
      return id;
    });
    const r = await as(t, s.userId).action(internal.onboardingChat.internalSendTurn, { organizationId: s.organizationId, attachment: { kind: "pdf", storageId } });
    expect(r).toMatchObject({ ok: false, code: "email_unverified" });
    expect(calls).toHaveLength(0);
    expect((await state(t, s)).session?.pendingMaterials).toBeUndefined();
  });

  test("endereço inválido continua recusado mesmo antes da confirmação", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    stubLlm(() => interviewer());
    const r = await turn(t, s, { attachment: { kind: "url", url: "http://inseguro.example/" } });
    expect(r).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("envio automático do código de e-mail", () => {
  async function session(t: T, s: Seed) {
    return (await as(t, s.userId).mutation(api.onboardingSessions.getOrCreateSession, { organizationId: s.organizationId }))._id;
  }

  test("envia UMA vez por sessão; a segunda chamada não envia", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const sessionId = await session(t, s);
    const first = await as(t, s.userId).mutation(api.onboardingChat.ensureEmailCodeSent, { organizationId: s.organizationId, sessionId });
    expect(first).toMatchObject({ sent: true, maskedEmail: "bu…te@milfont.net" });
    expect((first as { canResendAt?: number }).canResendAt).toBeGreaterThan(Date.now());
    expect(sentEmails).toHaveLength(1);
    const second = await as(t, s.userId).mutation(api.onboardingChat.ensureEmailCodeSent, { organizationId: s.organizationId, sessionId });
    expect(second).toMatchObject({ sent: false, reason: "already_requested" });
    expect(sentEmails).toHaveLength(1);
    const status = await as(t, s.userId).query(api.emailVerification.getEmailVerificationStatus, {});
    expect(status).toMatchObject({ verified: false, maskedEmail: "bu…te@milfont.net" });
  });

  test("conta já confirmada: no-op", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    const sessionId = await session(t, s);
    const r = await as(t, s.userId).mutation(api.onboardingChat.ensureEmailCodeSent, { organizationId: s.organizationId, sessionId });
    expect(r).toMatchObject({ sent: false, reason: "already_verified" });
    expect(sentEmails).toHaveLength(0);
  });

  test("respeita os limites e grava a tentativa mesmo recusada; nunca lança por falta de segredo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const sessionId = await session(t, s);
    vi.stubEnv("JWT_PRIVATE_KEY", "");
    vi.stubEnv("EMAIL_CODE_PEPPER", "");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await as(t, s.userId).mutation(api.onboardingChat.ensureEmailCodeSent, { organizationId: s.organizationId, sessionId });
      expect(r).toMatchObject({ sent: false, reason: "unavailable" });
    } finally {
      err.mockRestore();
    }
    expect(sentEmails).toHaveLength(0);
    expect((await state(t, s)).session?.emailCodeAutoSentAt).toBeDefined();
    const again = await as(t, s.userId).mutation(api.onboardingChat.ensureEmailCodeSent, { organizationId: s.organizationId, sessionId });
    expect(again.reason).toBe("already_requested");
    vi.stubEnv("JWT_PRIVATE_KEY", "fake-jwt-key-for-tests");

    // Cooldown: um código recém-pedido pelo botão bloqueia o automático (sem lançar).
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2);
    const sid2 = await session(t2, s2);
    await as(t2, s2.userId).mutation(api.emailVerification.requestEmailVerificationCode, {});
    const cool = await as(t2, s2.userId).mutation(api.onboardingChat.ensureEmailCodeSent, { organizationId: s2.organizationId, sessionId: sid2 });
    expect(cool).toMatchObject({ sent: false, reason: "cooldown" });
    expect((cool as { canResendAt?: number }).canResendAt).toBeGreaterThan(Date.now());
    expect(sentEmails).toHaveLength(1);
  });

  test("não-membro e sessão de outra org são recusados", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const sessionId = await session(t, s);
    await expect(t.mutation(api.onboardingChat.ensureEmailCodeSent, { organizationId: s.organizationId, sessionId })).rejects.toThrow();
    const o = await seed(t);
    await expect(as(t, o.userId).mutation(api.onboardingChat.ensureEmailCodeSent, { organizationId: o.organizationId, sessionId })).rejects.toThrow(/não encontrada/);
  });
});

describe("leituras para a tela", () => {
  test("getSession traz approvals, reachedStep, tested, connected e pendingMaterialsCount", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const view = await as(t, s.userId).mutation(api.onboardingSessions.getOrCreateSession, { organizationId: s.organizationId });
    expect(view).toMatchObject({ approvals: {}, reachedStep: 0, tested: false, connected: false, pendingMaterialsCount: 0 });
    stubLlm((_r, n) => interviewer(n === 1 ? DESCRIBE : {}));
    await turn(t, s, { attachment: { kind: "url", url: "https://bugueiro.example/" } });
    const got = await as(t, s.userId).query(api.onboardingSessions.getSession, { organizationId: s.organizationId });
    expect(got?.pendingMaterialsCount).toBe(1);
  });

  test("getChatState filtra as últimas sugestões pelo estado vivo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { verified: true });
    stubLlm((_r, n) => interviewer({ ...(n === 1 ? DESCRIBE : {}), chips: ["Confirmar e-mail", "Ok"] }));
    await turn(t, s, { text: "Sou bugueiro" });
    const chat = await as(t, s.userId).query(api.onboardingChat.getChatState, { organizationId: s.organizationId });
    expect(chat?.lastChips).not.toContain("Confirmar e-mail");
    expect(chat?.lastChips).toContain("Ok");
    expect(chat?.emailVerified).toBe(true);
    expect(chat?.reachedStep).toBe(1);
  });
});

describe("modo do atendente: só pelo clique da pessoa", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function seedApply(t: T) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const orgId = await ctx.db.insert("organizations", {
        name: "Org A", slug: "org-a",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL", aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 } },
        createdAt: now, updatedAt: now,
      });
      const boardId = await ctx.db.insert("boards", { organizationId: orgId, name: "Funil de Vendas", color: "#3B82F6", isDefault: true, order: 0, createdAt: now, updatedAt: now });
      for (const [i, name] of ["Novo lead", "Qualificado", "Proposta"].entries()) {
        await ctx.db.insert("stages", { organizationId: orgId, boardId, name, color: "#111111", order: i, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
      }
      const userId = await ctx.db.insert("users", { email: "admin@teste.com" });
      const memberId = await ctx.db.insert("teamMembers", { organizationId: orgId, userId, name: "Admin", email: "admin@teste.com", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now });
      const org = (await ctx.db.get(orgId))!;
      await ctx.db.patch(orgId, { settings: { ...org.settings, aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, lgpdAck: { acceptedAt: now, acceptedBy: memberId } } } });
      return { orgId, userId };
    });
  }

  test("aplicar o rascunho nunca deixa o atendente em autopilot; updateAgentProfile exige o aceite de risco e o grava auditado", async () => {
    const t = convexTest(schema, modules);
    const s = await seedApply(t);
    const asAdmin = as(t, s.userId);
    const session = await asAdmin.mutation(api.onboardingSessions.getOrCreateSession, { organizationId: s.orgId });
    const draft = templateStartDraft("outro", "Passeios do Bruno");
    draft.business.description = "Passeios de buggy";
    await asAdmin.mutation(api.onboardingSessions.saveDraft, { organizationId: s.orgId, sessionId: session._id, draft, expectedVersion: session.draftVersion });
    const view = await asAdmin.query(api.onboardingSessions.getSession, { organizationId: s.orgId });
    const applied = await asAdmin.mutation(api.onboardingSessions.applyOnboardingDraft, {
      organizationId: s.orgId, sessionId: session._id, expectedDraftHash: view!.draftHash!,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(applied.attendantId).not.toBeNull();
    const agentId = applied.attendantId!;
    const agent = await t.run((ctx) => ctx.db.get(agentId));
    expect(agent?.agentProfile?.mode).toBe("suggest");

    // Sem o aceite de risco: recusa.
    await expect(
      asAdmin.mutation(api.aiSettings.updateAgentProfile, { agentMemberId: agentId, patch: { mode: "autopilot" } }),
    ).rejects.toThrow();
    expect((await t.run((ctx) => ctx.db.get(agentId)))?.agentProfile?.mode).toBe("suggest");

    // Com o aceite (o clique do cartão "Ativar a sua IA"): liga e grava o aceite auditado.
    await asAdmin.mutation(api.aiSettings.updateAgentProfile, { agentMemberId: agentId, patch: { mode: "autopilot" }, autopilotRiskAck: true });
    const after = await t.run((ctx) => ctx.db.get(agentId));
    expect(after?.agentProfile?.mode).toBe("autopilot");
    expect(after?.agentProfile?.autopilotEarlyAck).toBeDefined();
    const logs = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.orgId)).collect());
    expect(logs.some((l) => l.severity === "high" && l.metadata?.autopilotEarly === true)).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});
