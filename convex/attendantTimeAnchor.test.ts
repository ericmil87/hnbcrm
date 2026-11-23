/// <reference types="vite/client" />
/**
 * ÂNCORA DE TEMPO no fim da mensagem do usuário (atendente 1:1).
 *
 * Incidente (Kenji, 23/11/2026): a IA escreveu "Te espero amanhã às 10h" às 12h25, sobre uma sessão que era às
 * 10h do próprio dia. O bloco DATA E HORA e o carimbo legível por mensagem (#207) não bastaram. Laboratório
 * (414 respostas reais pelo caminho de PROD): sem nada 38/100 erros nos cenários difíceis; só uma frase de regra
 * 17/100; âncora calculada no servidor, no FIM da mensagem do usuário, 1/100; controles 0.
 *
 * Prova que:
 *  - a âncora entra por DEFAULT, depois do envelope e ANTES da instrução final (e do follow-up);
 *  - `includeCurrentDateTime:false` a remove (junto com o bloco de data);
 *  - runtime e simulador geram o MESMO texto de instrução para o mesmo contexto (instrução final única);
 *  - o simulador sem `at` leva só o AGORA (nada inventado);
 *  - virada de dia, fuso do agente diferente do da org, nada de epoch no envelope;
 *  - notas da equipe do 1:1 levam a data em que foram escritas.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildAttendantFinalInstruction, buildTimeAnchor } from "./lib/promptTimeAnchor";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

/** São Paulo = UTC-3 (sem horário de verão). `day` de novembro de 2026. */
const sp = (day: number, hh: number, mm: number, ss = 0) => Date.UTC(2026, 10, day, hh + 3, mm, ss);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Sai dos timers falsos mas CONGELA o relógio (mesmo padrão de `attendantDateTime.test.ts`). */
function freezeClock(now: number) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
}

function stubLlm(reply: { tool?: boolean } = {}) {
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: reply.tool
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      { id: "call_1", type: "function", function: { name: "replyToCustomer", arguments: JSON.stringify({ text: "ok" }) } },
                    ],
                  }
                : { role: "assistant", content: "ok" },
              finish_reason: reply.tool ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const bodyOf = (m: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(((m.mock.calls[call]?.[1] as { body?: string } | undefined)?.body ?? "{}"));
const systemOf = (m: ReturnType<typeof vi.fn>) => bodyOf(m).messages?.[0]?.content ?? "";
const userOf = (m: ReturnType<typeof vi.fn>) => bodyOf(m).messages?.[1]?.content ?? "";
/** O que vem DEPOIS do envelope: âncora (se houver) + instrução final. */
const tailOf = (user: string) => user.slice(user.indexOf("</crm_data>") + "</crm_data>\n\n".length);

type ProfilePatch = {
  includeCurrentDateTime?: boolean;
  schedule?: { timezone: string; startHour: number; endHour: number };
  followUps?: { mode: "send"; quietStartHour: number; quietEndHour: number };
};
type Msg = {
  at: number;
  senderType: "contact" | "ai" | "human";
  text: string;
  /** Nota interna / rascunho: nunca conta como "nossa" nem entra no histórico. */
  isInternal?: boolean;
  direction?: "inbound" | "outbound" | "internal";
  metadata?: Record<string, unknown>;
};

/** Org + atendente + conversa; as mensagens de `msgs` entram com `createdAt` REAL (a última do cliente dispara o turno). */
async function seed(t: TestConvex<typeof schema>, msgs: Msg[], profile?: ProfilePatch, orgTz = "America/Sao_Paulo") {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Âncora",
      slug: "org-ancora",
      settings: { timezone: orgTz, currency: "BRL", aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 } },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } } },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest", ...profile },
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Número principal",
      phoneNumberId: "555000111", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Ana", phone: "5511988887777", tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Ana", contactId, boardId, stageId, assignedTo: agentId, value: 0, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const lastInbound = [...msgs].reverse().find((m) => m.senderType === "contact")!;
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active",
      lastInboundAt: lastInbound.at, messageCount: msgs.length, createdAt: msgs[0].at, updatedAt: now,
    });
    for (const m of msgs) {
      await ctx.db.insert("messages", {
        organizationId, conversationId, leadId,
        direction: m.direction ?? (m.senderType === "contact" ? "inbound" : "outbound"),
        senderType: m.senderType, content: m.text, contentType: "text", isInternal: m.isInternal ?? false,
        ...(m.metadata ? { metadata: m.metadata } : {}),
        createdAt: m.at,
      });
    }
    return { organizationId, adminUserId, adminId, agentId, leadId, conversationId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

/** O caso real: combinou dom 22:29 "amanhã às 10h"; o cliente agradece seg 12:25. */
const CASO_REAL: Msg[] = [
  { at: sp(22, 22, 29, 40), senderType: "ai", text: "O Kenji liberou sim: amanhã, segunda 23/11, às 10h. Te espero amanhã então. Até lá!" },
  { at: sp(23, 12, 25, 12), senderType: "contact", text: "Muito obrigada" },
];
const NOW_REAL = sp(23, 12, 25, 24);

async function setup(now: number, msgs: Msg[], profile?: ProfilePatch, orgTz?: string) {
  vi.setSystemTime(now);
  const t = convexTest(schema, modules);
  return { t, seed: await seed(t, msgs, profile, orgTz) };
}

/** Um turno real (`requestAiDraft` → `internalProcessQueueItem`); devolve o fetch gravado. */
async function runTurn(t: TestConvex<typeof schema>, s: Seed, now: number) {
  await asUser(t, s.adminUserId).mutation(api.attendant.requestAiDraft, { conversationId: s.conversationId });
  const item = await t.run(async (ctx) => (await ctx.db.query("aiReplyQueue").collect())[0]);
  freezeClock(now);
  const fetchMock = stubLlm();
  await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });
  return fetchMock;
}

const FINAL = "Responda ao cliente agora (última mensagem do histórico acima).";

describe("âncora de tempo — runtime", () => {
  test("entra por DEFAULT, depois do envelope e ANTES da instrução final; o system prompt não muda", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL);
    const fetchMock = await runTurn(t, s, NOW_REAL);

    const user = userOf(fetchMock);
    const anchor =
      'AGORA: segunda-feira, 23/11/2026, 12:25. Última mensagem do cliente: seg 23/11 12:25. Última mensagem nossa: dom 22/11 22:29 (ontem, há 14 h). "Hoje", "amanhã" e dias da semana escritos numa mensagem valem para o dia em que ela foi escrita: antes de citar um dia ou horário combinado, compare com AGORA. O que já passou é passado: não diga "te espero", "até lá" nem "amanhã" para ele.';
    expect(user.endsWith(`</crm_data>\n\n${anchor}\n\n${FINAL}`)).toBe(true);
    // Fim do system prompt continua sendo o bloco de data: a âncora NÃO foi para o prefixo cacheável.
    expect(systemOf(fetchMock)).not.toContain("AGORA:");
    expect(systemOf(fetchMock).trimEnd().endsWith("Nunca chute a data nem invente o dia da semana.")).toBe(true);
  });

  test("includeCurrentDateTime:false remove a âncora (os carimbos absolutos por mensagem ficam, como no #207)", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL, { includeCurrentDateTime: false });
    const fetchMock = await runTurn(t, s, NOW_REAL);

    const user = userOf(fetchMock);
    expect(user).not.toContain("AGORA:");
    expect(systemOf(fetchMock)).not.toContain("Próximos dias:");
    expect(tailOf(user)).toBe(FINAL);
    expect(user).toContain("dom 22/11 22:29");
  });

  test("virada de dia: combinou às 23:58, o cliente fala às 00:05 → 'ontem, há 7 min'", async () => {
    const msgs: Msg[] = [
      { at: sp(22, 23, 58, 20), senderType: "ai", text: "O Kenji liberou: amanhã, segunda 23/11, às 10h." },
      { at: sp(23, 0, 5, 9), senderType: "contact", text: "obrigada, até amanhã" },
    ];
    const now = sp(23, 0, 5, 21);
    const { t, seed: s } = await setup(now, msgs);
    const fetchMock = await runTurn(t, s, now);

    const user = userOf(fetchMock);
    expect(user).toContain("AGORA: segunda-feira, 23/11/2026, 00:05.");
    expect(user).toContain("Última mensagem do cliente: seg 23/11 00:05.");
    expect(user).toContain("Última mensagem nossa: dom 22/11 23:58 (ontem, há 7 min).");
  });

  test("fuso do horário de atendimento (≠ org) vale para o AGORA e para os carimbos da âncora", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL, { schedule: { timezone: "Europe/Lisbon", startHour: 0, endHour: 24 } });
    const fetchMock = await runTurn(t, s, NOW_REAL);

    const user = userOf(fetchMock);
    // 12:25 em São Paulo = 15:25 em Lisboa; 22:29 de domingo em SP = 01:29 de segunda em Lisboa.
    expect(user).toContain("AGORA: segunda-feira, 23/11/2026, 15:25.");
    expect(user).toContain("Última mensagem do cliente: seg 23/11 15:25.");
    expect(user).toContain("Última mensagem nossa: seg 23/11 01:29 (hoje, há 14 h).");
  });

  test("'nossa' = IA + equipe: a última mensagem humana conta (a confirmação foi da equipe)", async () => {
    const msgs: Msg[] = [
      { at: sp(22, 22, 29, 40), senderType: "human", text: "Confirmado, amanhã 10h" },
      { at: sp(23, 12, 25, 12), senderType: "contact", text: "obrigada!" },
    ];
    const { t, seed: s } = await setup(NOW_REAL, msgs);
    const fetchMock = await runTurn(t, s, NOW_REAL);
    expect(userOf(fetchMock)).toContain("Última mensagem nossa: dom 22/11 22:29 (ontem, há 14 h).");
  });

  test("nota interna (outbound isInternal e direction \"internal\") mais nova que a última resposta NÃO vira 'Última mensagem nossa'", async () => {
    const msgs: Msg[] = [
      { at: sp(22, 22, 29, 40), senderType: "ai", text: "O Kenji liberou sim: amanhã, segunda 23/11, às 10h." },
      // Nota interna da equipe (outbound) e rascunho (direction "internal"), ambas DEPOIS da resposta e antes do cliente.
      { at: sp(23, 9, 0, 0), senderType: "human", text: "nota: cliente é da casa", isInternal: true },
      { at: sp(23, 9, 30, 0), senderType: "ai", text: "rascunho que ninguém enviou", isInternal: true, direction: "internal" },
      { at: sp(23, 12, 25, 12), senderType: "contact", text: "Muito obrigada" },
    ];
    const { t, seed: s } = await setup(NOW_REAL, msgs);
    const fetchMock = await runTurn(t, s, NOW_REAL);

    const user = userOf(fetchMock);
    expect(user).toContain("Última mensagem nossa: dom 22/11 22:29 (ontem, há 14 h).");
    expect(user).not.toContain("seg 23/11 09:00");
    expect(user).not.toContain("seg 23/11 09:30");
  });

  test("mensagem do aparelho (human sem senderId, metadata.via \"device\") conta como nossa", async () => {
    const msgs: Msg[] = [
      { at: sp(22, 22, 29, 40), senderType: "ai", text: "O Kenji liberou sim: amanhã, segunda 23/11, às 10h." },
      { at: sp(23, 10, 5, 0), senderType: "human", text: "Foi um prazer!", metadata: { via: "device" } },
      { at: sp(23, 12, 25, 12), senderType: "contact", text: "Muito obrigada" },
    ];
    const { t, seed: s } = await setup(NOW_REAL, msgs);
    const fetchMock = await runTurn(t, s, NOW_REAL);
    expect(userOf(fetchMock)).toContain("Última mensagem nossa: seg 23/11 10:05 (hoje, há 2 h 20).");
  });

  test("conversa só com mensagens do cliente: a âncora sai sem 'Última mensagem nossa'", async () => {
    const msgs: Msg[] = [{ at: sp(23, 12, 25, 12), senderType: "contact", text: "Oi, tudo bem?" }];
    const { t, seed: s } = await setup(NOW_REAL, msgs);
    const fetchMock = await runTurn(t, s, NOW_REAL);

    const tail = tailOf(userOf(fetchMock));
    expect(tail.startsWith("AGORA: segunda-feira, 23/11/2026, 12:25. Última mensagem do cliente: seg 23/11 12:25. \"Hoje\"")).toBe(true);
    expect(tail).not.toContain("Última mensagem nossa");
    expect(tail.endsWith(FINAL)).toBe(true);
  });

  test("nada de epoch no envelope nem na âncora", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL);
    const fetchMock = await runTurn(t, s, NOW_REAL);
    expect(userOf(fetchMock)).not.toMatch(/\d{12,}/);
  });

  test("notas da equipe do 1:1 levam a data em que foram escritas (fuso do agente)", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.conversationId, {
        aiTeamNotes: [{ text: "O Kenji confirmou amanhã às 10h.", at: sp(22, 22, 29, 40), byMemberId: s.adminId }],
      });
    });
    const fetchMock = await runTurn(t, s, NOW_REAL);
    expect(systemOf(fetchMock)).toContain("- [dom 22/11 22:29] O Kenji confirmou amanhã às 10h.");
  });
});

describe("âncora de tempo — follow-up", () => {
  test("turno de follow-up: a âncora vem ANTES da instrução de follow-up", async () => {
    const profile: ProfilePatch = { followUps: { mode: "send", quietStartHour: 8, quietEndHour: 20 } };
    const msgs: Msg[] = [
      { at: sp(22, 22, 29, 40), senderType: "ai", text: "O Kenji liberou: amanhã, segunda 23/11, às 10h." },
      { at: sp(23, 12, 25, 12), senderType: "contact", text: "Muito obrigada" },
      { at: sp(23, 12, 26, 0), senderType: "ai", text: "Imagina! Amanhã de manhã eu passo aqui pra saber como foi." },
    ];
    const { t, seed: s } = await setup(sp(23, 12, 26, 40), msgs, profile);
    await t.mutation(internal.attendant.internalExecuteAttendantTool, {
      name: "scheduleFollowUp",
      argsJson: JSON.stringify({ title: "Ver como foi a sessão", dueAtLocal: "2026-11-24T10:00", note: "perguntar como ela está" }),
      organizationId: s.organizationId,
      agentMemberId: s.agentId,
      conversationId: s.conversationId,
      leadId: s.leadId,
    });
    const fu = (await t.run(async (ctx) => ctx.db.query("aiFollowUps").collect()))[0];
    expect(fu).toBeTruthy();
    await t.run(async (ctx) => ctx.db.patch(fu._id, { nextFireAt: fu.dueAt }));
    const now = sp(24, 10, 0, 30);
    vi.setSystemTime(now);
    const fired = await t.mutation(internal.attendantFollowUp.fire, { followUpId: fu._id });
    expect(fired.ok).toBe(true);
    const item = (await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect())).find((i) => i.origin === "follow_up")!;
    await t.run(async (ctx) => ctx.db.patch(item._id, { nextAttemptAt: 0 }));
    freezeClock(now);
    const fetchMock = stubLlm({ tool: true });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item._id });

    const user = userOf(fetchMock);
    const tail = tailOf(user);
    expect(tail.startsWith("AGORA: terça-feira, 24/11/2026, 10:00.")).toBe(true);
    expect(tail).toContain("Última mensagem do cliente: seg 23/11 12:25.");
    expect(tail).toContain("Última mensagem nossa: seg 23/11 12:26 (ontem, há 22 h).");
    expect(tail.indexOf("AGORA:")).toBeLessThan(tail.indexOf("Chegou a hora de um follow-up"));
    expect(user).not.toContain(FINAL);
  });
});

describe("instrução final única (runtime = simulador)", () => {
  test("mesmo contexto → mesmo texto de âncora + instrução, no turno de resposta", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL);
    const runtimeFetch = await runTurn(t, s, NOW_REAL);
    const runtimeTail = tailOf(userOf(runtimeFetch));

    freezeClock(NOW_REAL);
    const simFetch = stubLlm();
    const result = await asUser(t, s.adminUserId).action(api.attendant.simulateAttendant, {
      organizationId: s.organizationId,
      agentMemberId: s.agentId,
      transcript: [
        { role: "agent" as const, content: CASO_REAL[0].text, at: CASO_REAL[0].at },
        { role: "customer" as const, content: "Muito obrigada", at: CASO_REAL[1].at },
      ],
      simulatedNow: NOW_REAL,
    });
    expect(result.error).toBeNull();
    const simTail = tailOf(userOf(simFetch));
    expect(simTail).toBe(runtimeTail);
    expect(simTail).toContain("AGORA:");
  });

  test("mesmo contexto → mesmo texto no turno de follow-up (a divergência antiga do texto acabou)", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL);
    freezeClock(NOW_REAL);
    const simFetch = stubLlm();
    await asUser(t, s.adminUserId).action(api.attendant.simulateAttendant, {
      organizationId: s.organizationId,
      agentMemberId: s.agentId,
      transcript: [
        { role: "agent" as const, content: CASO_REAL[0].text, at: CASO_REAL[0].at },
        { role: "customer" as const, content: "Muito obrigada", at: CASO_REAL[1].at },
      ],
      simulatedNow: NOW_REAL,
      followUp: { title: "Ver como foi", note: "perguntar como ela está" },
    });
    const tail = tailOf(userOf(simFetch));
    const anchor = buildTimeAnchor({
      now: NOW_REAL,
      timezone: "America/Sao_Paulo",
      lastInboundAt: CASO_REAL[1].at,
      lastOutboundAt: CASO_REAL[0].at,
    });
    expect(tail).toBe(buildAttendantFinalInstruction({ followUp: true, anchor }));
    // A frase do runtime (que o simulador antes resumia): "já respondeu" e "sem cobrar".
    expect(tail).toContain("(o cliente mandou o comprovante, já comprou, já respondeu)");
    expect(tail).toContain("que retome o assunto sem cobrar");
  });

  test("simulador SEM `at` (botão Testar): a âncora leva só o AGORA, nada inventado", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL);
    freezeClock(NOW_REAL);
    const simFetch = stubLlm();
    await asUser(t, s.adminUserId).action(api.attendant.simulateAttendant, {
      organizationId: s.organizationId,
      agentMemberId: s.agentId,
      transcript: [{ role: "customer" as const, content: "Oi" }],
      simulatedNow: NOW_REAL,
    });
    const tail = tailOf(userOf(simFetch));
    expect(tail.startsWith("AGORA: segunda-feira, 23/11/2026, 12:25. \"Hoje\", \"amanhã\"")).toBe(true);
    expect(tail).not.toContain("Última mensagem");
    expect(tail).not.toContain("1970");
    expect(tail.endsWith(FINAL)).toBe(true);
  });

  test("simulador com `group`: leva a âncora do grupo, antes de 'Responda AGORA', como o runtime de grupo", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL);
    freezeClock(NOW_REAL);
    const simFetch = stubLlm();
    await asUser(t, s.adminUserId).action(api.attendant.simulateAttendant, {
      organizationId: s.organizationId,
      agentMemberId: s.agentId,
      transcript: [
        { role: "agent" as const, content: "Combinado, pessoal!", at: CASO_REAL[0].at },
        { role: "customer" as const, content: "@IA que horas é a roda?", at: CASO_REAL[1].at },
      ],
      simulatedNow: NOW_REAL,
      group: { subject: "Grupo da turma" },
    });
    const user = userOf(simFetch);
    const anchor = user.split("\n\n").find((p: string) => p.startsWith("AGORA:"))!;
    expect(anchor).toContain("AGORA: segunda-feira, 23/11/2026, 12:25.");
    expect(anchor).toContain("Última mensagem do grupo: seg 23/11 12:25.");
    expect(anchor).not.toContain("do cliente");
    expect(anchor).toContain("Última mensagem nossa:");
    expect(user.indexOf(anchor)).toBeGreaterThan(user.indexOf("</crm_data>"));
    expect(user.endsWith(`${anchor}\n\nResponda AGORA ao que foi perguntado a você no grupo (última mensagem do histórico). Se nada ali for para você, não chame nenhuma ferramenta.`)).toBe(true);
  });

  test("simulador com `group` e includeCurrentDateTime:false: sem âncora", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL, { includeCurrentDateTime: false });
    freezeClock(NOW_REAL);
    const simFetch = stubLlm();
    await asUser(t, s.adminUserId).action(api.attendant.simulateAttendant, {
      organizationId: s.organizationId,
      agentMemberId: s.agentId,
      transcript: [{ role: "customer" as const, content: "@IA que horas é a roda?", at: CASO_REAL[1].at }],
      simulatedNow: NOW_REAL,
      group: { subject: "Grupo da turma" },
    });
    expect(userOf(simFetch)).not.toContain("AGORA:");
    expect(userOf(simFetch)).not.toContain("Última mensagem");
  });

  test("simulador com includeCurrentDateTime:false: sem âncora, instrução crua", async () => {
    const { t, seed: s } = await setup(NOW_REAL, CASO_REAL, { includeCurrentDateTime: false });
    freezeClock(NOW_REAL);
    const simFetch = stubLlm();
    await asUser(t, s.adminUserId).action(api.attendant.simulateAttendant, {
      organizationId: s.organizationId,
      agentMemberId: s.agentId,
      transcript: [{ role: "customer" as const, content: "Oi", at: CASO_REAL[1].at }],
      simulatedNow: NOW_REAL,
    });
    expect(tailOf(userOf(simFetch))).toBe(FINAL);
  });
});

describe("buildTimeAnchor / buildAttendantFinalInstruction (puros)", () => {
  const now = sp(23, 12, 25, 24);

  test("omite as partes que não existem e nunca lança com instantes impossíveis", () => {
    const so = buildTimeAnchor({ now, timezone: "America/Sao_Paulo" })!;
    expect(so.startsWith("AGORA: segunda-feira, 23/11/2026, 12:25. ")).toBe(true);
    expect(so).not.toContain("Última mensagem");
    const lixo = buildTimeAnchor({ now, timezone: "America/Sao_Paulo", lastInboundAt: Number.NaN, lastOutboundAt: 1e20 })!;
    expect(lixo).toBe(so);
    expect(buildTimeAnchor({ now: Number.NaN, timezone: "America/Sao_Paulo" })).toBeNull();
    // fuso inválido cai no default em vez de lançar
    expect(buildTimeAnchor({ now, timezone: "America/Sao_Pualo" })).toContain("12:25");
  });

  test("rótulos relativos: hoje, ontem e dias", () => {
    const hoje = buildTimeAnchor({ now, timezone: "America/Sao_Paulo", lastOutboundAt: sp(23, 10, 0) })!;
    expect(hoje).toContain("Última mensagem nossa: seg 23/11 10:00 (hoje, há 2 h 25).");
    const tres = buildTimeAnchor({ now: sp(26, 10, 0, 9), timezone: "America/Sao_Paulo", lastOutboundAt: sp(23, 12, 26) })!;
    expect(tres).toContain("Última mensagem nossa: seg 23/11 12:26 (há 2 dias).");
  });

  test("instrução final: sem âncora é só a instrução; com âncora ela vem antes", () => {
    expect(buildAttendantFinalInstruction({ followUp: false, anchor: null })).toBe(FINAL);
    expect(buildAttendantFinalInstruction({ followUp: false, anchor: "AGORA: x." })).toBe(`AGORA: x.\n\n${FINAL}`);
    expect(buildAttendantFinalInstruction({ followUp: true, anchor: null }).startsWith("Chegou a hora de um follow-up")).toBe(true);
  });
});
