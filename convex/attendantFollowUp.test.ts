/// <reference types="vite/client" />
/**
 * Follow-up que o próprio Atendente IA executa (v0.60).
 *
 * O que estes testes protegem, na ordem em que a revisão adversarial achou os
 * furos:
 *  - a tool v2 agenda de verdade (tarefa + `aiFollowUps` + `runAt`) e devolve a
 *    HORA EFETIVA, empurrando para a próxima abertura da janela;
 *  - o `fire` tem cadeia de guardas completa e é IDEMPOTENTE (duplo armamento
 *    não manda duas mensagens);
 *  - nenhuma saída da fila deixa a tarefa órfã em `queued` — ou ela volta a
 *    `scheduled` ou vira `needs_human` com aviso no sino;
 *  - no turno de follow-up, "não mandar nada" é SUCESSO: texto puro não vira
 *    mensagem, a recuperação não força resposta e não há 4 retries;
 *  - o turno REATIVO sempre vence o proativo (os dois coalescings);
 *  - o vínculo do rascunho sobrevive ao coaching, e aceite conclui a tarefa;
 *  - Meta fora da janela de 24h degrada para RASCUNHO em vez de falhar.
 *
 * Padrão de execução: as mutations rodam sob FAKE timers e o `fire` é chamado
 * explicitamente — nada de `finishAllScheduledFunctions`, que entraria em laço
 * com um job que se re-arma no futuro.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { FOLLOW_UP_REASON_CODES, describeFollowUpReason } from "./lib/followUpOps";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  // Segunda-feira, 21/09/2026, 12:00 em São Paulo (15:00 UTC) — dentro de
  // qualquer janela 8–20h, para o caso feliz não depender do relógio da CI.
  vi.setSystemTime(new Date("2026-09-21T15:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  return convexTest(schema, modules);
}

type FollowUpConfig = {
  mode: "off" | "draft" | "send";
  maxChain?: number;
  quietStartHour?: number;
  quietEndHour?: number;
  dailyCap?: number;
};

async function seedFollowUpOrg(
  t: TestConvex<typeof schema>,
  opts?: {
    mode?: "suggest" | "autopilot";
    followUps?: FollowUpConfig;
    provider?: "meta" | "bridge";
    schedule?: { timezone: string; startHour: number; endHour: number; days?: number[] };
    leadOwner?: "ai" | "human";
  }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Follow-up",
      slug: "org-follow-up",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...org.settings.aiConfig!,
          lgpdAck: { acceptedAt: now, acceptedBy: adminId },
          ...(opts?.provider === "bridge"
            ? { bridgeAiAck: { acceptedAt: now, acceptedBy: adminId } }
            : {}),
        },
      },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Ana (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: {
        kind: "attendant",
        mode: opts?.mode ?? "suggest",
        ...(opts?.schedule ? { schedule: opts.schedule } : {}),
        ...(opts?.followUps ? { followUps: opts.followUps } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: opts?.provider ?? "meta",
      displayName: "Número principal",
      ...(opts?.provider === "bridge"
        ? {
            bridgeBaseUrl: "https://wuzapi.example.com",
            bridgeInstanceId: "inst-1",
            bridgeSessionState: "connected" as const,
          }
        : { phoneNumberId: "555000111" }),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Vendas",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Rejane",
      phone: "5511988887777",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Rejane — Vivência Maré Nova",
      contactId,
      boardId,
      stageId,
      assignedTo: opts?.leadOwner === "human" ? adminId : agentId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
      tags: [],
      customFields: {},
      conversationStatus: "active",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      leadId,
      channel: "whatsapp",
      channelConfigId: configId,
      status: "active",
      lastInboundAt: now,
      messageCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("messages", {
      organizationId,
      conversationId,
      leadId,
      direction: "inbound",
      senderType: "contact",
      content: "já já faço o teu pix",
      contentType: "text",
      isInternal: false,
      createdAt: now,
    });
    return {
      organizationId,
      adminUserId,
      adminId,
      agentId,
      configId,
      boardId,
      stageId,
      contactId,
      leadId,
      conversationId,
    };
  });
}

type Seed = Awaited<ReturnType<typeof seedFollowUpOrg>>;

const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

/** Chama a tool do atendente como o runtime chamaria (mesmo executor gated). */
async function scheduleFollowUp(
  t: TestConvex<typeof schema>,
  seed: Seed,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return await t.mutation(internal.attendant.internalExecuteAttendantTool, {
    name: "scheduleFollowUp",
    argsJson: JSON.stringify(args),
    organizationId: seed.organizationId,
    agentMemberId: seed.agentId,
    conversationId: seed.conversationId,
    leadId: seed.leadId,
  });
}

async function followUpsOf(t: TestConvex<typeof schema>): Promise<Doc<"aiFollowUps">[]> {
  return await t.run(async (ctx) => ctx.db.query("aiFollowUps").collect());
}

async function onlyFollowUp(t: TestConvex<typeof schema>): Promise<Doc<"aiFollowUps">> {
  const rows = await followUpsOf(t);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function tasksOf(t: TestConvex<typeof schema>): Promise<Doc<"tasks">[]> {
  return await t.run(async (ctx) => ctx.db.query("tasks").collect());
}

async function queueItems(t: TestConvex<typeof schema>): Promise<Doc<"aiReplyQueue">[]> {
  return await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect());
}

async function notificationsOf(t: TestConvex<typeof schema>): Promise<Doc<"notifications">[]> {
  return await t.run(async (ctx) => ctx.db.query("notifications").collect());
}

async function scheduledNamed(t: TestConvex<typeof schema>, needle: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (f) => f.name.includes(needle) && f.state.kind === "pending"
    )
  );
}

/**
 * Avança o relógio para o instante em que o job de fato acordaria.
 *
 * O jitter de até 10 min é ALEATÓRIO e `nextFireAt` é o que o guard de disparo
 * antecipado compara — cravar `dueAt` faria o teste falhar em ~90% das
 * execuções, e por motivo certo (o job teria acordado cedo demais).
 */
async function advanceToFireTime(t: TestConvex<typeof schema>, followUp: Doc<"aiFollowUps">) {
  const fresh = await t.run(async (ctx) => ctx.db.get(followUp._id));
  vi.setSystemTime(fresh?.nextFireAt ?? followUp.dueAt);
}

/** Cria o follow-up padrão dos testes: amanhã às 9h locais. */
async function armDefault(
  t: TestConvex<typeof schema>,
  seed: Seed,
  args?: Record<string, unknown>
) {
  const result = await scheduleFollowUp(t, seed, {
    title: "Cobrar comprovante",
    dueAtLocal: "2026-09-22T09:00",
    note: "conferir se o comprovante chegou",
    ...args,
  });
  return result;
}

// ── Mock de LLM ──
// Cada resposta da sequência é consumida por uma chamada de `chat/completions`.

type StubResponse =
  | { kind: "text"; content: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "empty" };

function stubLlmSequence(responses: StubResponse[]) {
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    const message =
      response.kind === "tool"
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${call}`,
                type: "function",
                function: { name: response.name, arguments: JSON.stringify(response.args) },
              },
            ],
          }
        : { role: "assistant", content: response.kind === "text" ? response.content : "" };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message,
            finish_reason: response.kind === "tool" ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function userMessageOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined;
  const body = JSON.parse(init?.body ?? "{}");
  return body.messages?.[1]?.content ?? "";
}

/** Nomes das tools oferecidas ao modelo numa chamada. */
function toolNamesOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): string[] {
  const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined;
  const body = JSON.parse(init?.body ?? "{}");
  return (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
}

function systemPromptOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined;
  const body = JSON.parse(init?.body ?? "{}");
  return body.messages?.[0]?.content ?? "";
}

/**
 * Roda o turno enfileirado pelo `fire`.
 *
 * Fica sob FAKE timers de propósito: o relógio destes testes é 21/09/2026 (para
 * a janela de silêncio não depender da hora da CI), e voltar para o relógio real
 * jogaria o `nextAttemptAt` do item para o futuro — o claim adiaria e nenhuma
 * inferência aconteceria. O mock de fetch resolve na hora, então nada espera
 * timer de verdade.
 */
async function runQueuedTurn(t: TestConvex<typeof schema>, responses: StubResponse[]) {
  const items = await queueItems(t);
  const item = items.find((i) => i.origin === "follow_up" && i.status === "pending");
  expect(item, "o fire precisa ter enfileirado um item follow_up").toBeTruthy();
  const fetchMock = stubLlmSequence(responses);
  await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });
  return { fetchMock, itemId: item!._id };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("tool scheduleFollowUp v2", () => {
  test("cria tarefa + follow-up armado e devolve a hora efetiva em texto", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t);

    const result = await armDefault(t, seed);

    expect(result.status).toBe("agendado");
    expect(result.executor).toBe("ai");
    // "ter 22/09 09:00" — é ESTA hora que a IA repete ao cliente.
    expect(result.quando).toBe("ter 22/09 09:00");

    const followUp = await onlyFollowUp(t);
    expect(followUp).toMatchObject({
      status: "scheduled",
      chainIndex: 0,
      deferrals: 0,
      agentMemberId: seed.agentId,
      conversationId: seed.conversationId,
      note: "conferir se o comprovante chegou",
    });

    const tasks = await tasksOf(t);
    expect(tasks).toHaveLength(1);
    // A tarefa é a VITRINE: mesmo prazo, responsável = o atendente.
    expect(tasks[0].dueDate).toBe(followUp.dueAt);
    expect(tasks[0].assignedTo).toBe(seed.agentId);
    expect(tasks[0].searchText).toContain("Cobrar comprovante");

    // A v1 não gravava nada; agora há audit + webhook task.created.
    const audits = await t.run(async (ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => a.entityType === "task" && a.action === "create")).toBe(true);
    expect(await scheduledNamed(t, "attendantFollowUp")).toHaveLength(1);
  });

  test("fora da janela de silêncio: empurra para a próxima abertura e AVISA", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t);

    // 3h da manhã: a janela default é 8–20h.
    const result = await armDefault(t, seed, { dueAtLocal: "2026-09-22T03:00" });

    expect(result.quando).toBe("ter 22/09 08:00");
    expect(String(result.aviso)).toContain("fora do horário de atendimento");
  });

  test("janela de silêncio vale mesmo com atendente 24h (interseção)", async () => {
    const t = setup();
    // O caso real: o atendente do Eric roda 0–24h. Sem a interseção, o
    // follow-up sairia às 3h da manhã.
    const seed = await seedFollowUpOrg(t, {
      schedule: { timezone: "America/Sao_Paulo", startHour: 0, endHour: 24 },
    });

    const result = await armDefault(t, seed, { dueAtLocal: "2026-09-22T03:00" });
    expect(result.quando).toBe("ter 22/09 08:00");
  });

  test("Meta: prazo além da janela de 24h avisa que vai virar rascunho", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t);
    const result = await armDefault(t, seed, { dueAtLocal: "2026-09-24T09:00" });
    expect(String(result.aviso)).toContain("janela de 24h");
  });

  test("dedupe por propósito: o mesmo título atualiza em vez de duplicar", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t);
    await armDefault(t, seed);
    const again = await armDefault(t, seed, { dueAtLocal: "2026-09-23T10:00" });

    expect(again.status).toBe("atualizado");
    const followUp = await onlyFollowUp(t);
    expect(await tasksOf(t)).toHaveLength(1);
    const task = (await tasksOf(t))[0];
    expect(task.dueDate).toBe(followUp.dueAt);
  });

  test("teto de 3 pendentes por conversa", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t);
    for (const title of ["Um", "Dois", "Três"]) {
      await armDefault(t, seed, { title });
    }
    const quarto = await armDefault(t, seed, { title: "Quatro" });
    expect(String(quarto.error)).toContain("3 follow-ups pendentes");
    expect(await followUpsOf(t)).toHaveLength(3);
  });

  test('executor "team" cria tarefa comum, sem execução automática', async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { leadOwner: "human" });
    const result = await armDefault(t, seed, { executor: "team" });

    expect(result.status).toBe("tarefa_criada");
    expect(result.executor).toBe("team");
    expect(await followUpsOf(t)).toHaveLength(0);
    // Vai para o dono HUMANO do lead — nunca para o membro IA (tarefa zumbi).
    expect((await tasksOf(t))[0].assignedTo).toBe(seed.adminId);
  });

  test('mode "off": comportamento da v1 (tarefa comum), sem aiFollowUps', async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "off" } });
    const result = await armDefault(t, seed);

    expect(result.status).toBe("tarefa_criada");
    expect(await followUpsOf(t)).toHaveLength(0);
    expect(await tasksOf(t)).toHaveLength(1);
  });

  test("prazo no passado e além de 30 dias são recusados", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t);
    const passado = await armDefault(t, seed, { dueAtLocal: "2026-09-20T09:00" });
    expect(String(passado.error)).toContain("já passou");
    const longe = await armDefault(t, seed, { dueAtLocal: "2027-09-20T09:00" });
    expect(String(longe.error)).toContain("30 dias");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("fire — cadeia de guardas", () => {
  async function arm(t: TestConvex<typeof schema>, seed: Seed, args?: Record<string, unknown>) {
    await armDefault(t, seed, args);
    return await onlyFollowUp(t);
  }

  test("caminho feliz: enfileira turno follow_up e marca queued", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" }, mode: "autopilot" });
    const followUp = await arm(t, seed);

    await advanceToFireTime(t, followUp);
    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });
    expect(result.ok).toBe(true);

    const items = await queueItems(t);
    const item = items.find((i) => i.origin === "follow_up")!;
    expect(item).toMatchObject({ status: "pending", followUpId: followUp._id });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("queued");
    expect(updated!.firedAt).toBe(Date.now());
  });

  test("duplo armamento: o segundo fire é no-op (nada de duas mensagens)", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" }, mode: "autopilot" });
    const followUp = await arm(t, seed);
    await advanceToFireTime(t, followUp);

    await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });
    const second = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    expect(second).toEqual({ ok: false, reason: "nao_agendado" });
    expect((await queueItems(t)).filter((i) => i.origin === "follow_up")).toHaveLength(1);
  });

  test("tarefa remarcada enquanto o job dormia: re-arma no prazo novo", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const followUp = await arm(t, seed);
    const novoPrazo = followUp.dueAt + 3 * HOUR_MS;
    // Escrita direta: simula um escritor de `tasks` que esqueceu o sync.
    await t.run(async (ctx) => ctx.db.patch(followUp.taskId, { dueDate: novoPrazo }));

    await advanceToFireTime(t, followUp);
    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    expect(result.reason).toBe("remarcado");
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.dueAt).toBe(novoPrazo);
    expect(updated!.status).toBe("scheduled");
    expect((await queueItems(t)).length).toBe(0);
  });

  test("tarefa adiada pela equipe (snooze): re-arma para o fim do soneca", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const followUp = await arm(t, seed);
    const snoozedUntil = followUp.dueAt + 6 * HOUR_MS;
    await asUser(t, seed.adminUserId).mutation(api.tasks.snoozeTask, {
      taskId: followUp.taskId,
      snoozedUntil,
    });

    await advanceToFireTime(t, followUp);
    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    expect(result.reason).toBe("adiada_pela_equipe");
    expect((await queueItems(t)).length).toBe(0);
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("scheduled");
  });

  test("LEAD arquivado → canceled (arquivar lead não arquiva a conversa)", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const followUp = await arm(t, seed);
    // Só o LEAD é arquivado — a conversa segue ativa, que é o que o
    // `bulkArchiveLeads` faz de verdade.
    await t.run(async (ctx) => ctx.db.patch(seed.leadId, { archivedAt: Date.now() }));

    await advanceToFireTime(t, followUp);
    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    expect(result.reason).toBe("lead_arquivado");
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("canceled");
    expect(updated!.reasonCode).toBe("lead_arquivado");
    expect((await queueItems(t)).length).toBe(0);
  });

  test("arquivar o lead pela tela já cancela os follow-ups ativos", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    await armDefault(t, seed, { title: "Cobrar comprovante" });
    await armDefault(t, seed, { title: "Confirmar endereço" });
    expect(await followUpsOf(t)).toHaveLength(2);

    await asUser(t, seed.adminUserId).mutation(api.leads.bulkArchiveLeads, {
      organizationId: seed.organizationId,
      leadIds: [seed.leadId],
      archived: true,
    });

    const rows = await followUpsOf(t);
    expect(rows.every((f) => f.status === "canceled")).toBe(true);
    expect(rows.every((f) => f.reasonCode === "lead_arquivado")).toBe(true);
  });

  test("conversa arquivada → canceled", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const followUp = await arm(t, seed);
    await t.run(async (ctx) =>
      ctx.db.patch(seed.conversationId, { archivedAt: Date.now() })
    );

    await advanceToFireTime(t, followUp);
    await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("canceled");
    expect(updated!.reason).toContain("arquivada");
  });

  test("opt-out por TELEFONE (SAIR) cancela — o atendente só olhava aiOptOut", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const followUp = await arm(t, seed);
    await t.run(async (ctx) =>
      ctx.db.insert("optOuts", {
        organizationId: seed.organizationId,
        phone: "5511988887777",
        source: "keyword",
        createdAt: Date.now(),
      })
    );

    await advanceToFireTime(t, followUp);
    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    expect(result.reason).toBe("opt_out");
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("canceled");
  });

  test("opt-out de IA do contato também cancela (pela elegibilidade)", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const followUp = await arm(t, seed);
    await t.run(async (ctx) => ctx.db.patch(seed.contactId, { aiOptOut: true }));

    await advanceToFireTime(t, followUp);
    await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("canceled");
  });

  test("bridge caído: adia com backoff e, no teto, vira tarefa de gente", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, {
      provider: "bridge",
      followUps: { mode: "send" },
    });
    const followUp = await arm(t, seed);
    await t.run(async (ctx) =>
      ctx.db.patch(seed.configId, { bridgeSessionState: "disconnected" })
    );
    await advanceToFireTime(t, followUp);

    for (let i = 0; i < 3; i++) {
      const r = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });
      expect(r.reason).toBe("adiado_bridge_offline");
      // Cada adiamento re-arma para daqui a 2/5/15 min: sem andar o relógio, a
      // chamada seguinte seria (com razão) recusada como disparo antecipado.
      vi.setSystemTime(Date.now() + 20 * 60_000);
    }
    const quarta = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });
    expect(quarta.reason).toBe("bridge_offline");

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("needs_human");
    // A tarefa volta para gente e alguém é avisado — nunca silêncio.
    expect((await notificationsOf(t)).some((n) => n.type === "ai_followup_needs_human")).toBe(true);
  });

  test("fora da janela no momento do disparo: re-arma na próxima abertura", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    // Armado para 19:00 locais (dentro da janela 8–20h)…
    const followUp = await arm(t, seed, { dueAtLocal: "2026-09-22T19:00" });

    // …mas o job só acorda às 20:30 locais, já fora dela (o jitter e o pacing
    // atrasam de verdade; é este o caso que a guarda existe para cobrir).
    vi.setSystemTime(new Date("2026-09-22T23:30:00.000Z"));
    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    expect(result.reason).toBe("fora_da_janela");
    expect((await queueItems(t)).length).toBe(0);
    const jobs = await scheduledNamed(t, "attendantFollowUp");
    expect(jobs.length).toBeGreaterThan(0);
  });

  test("fila ocupada (turno reativo em voo): adia sem enfileirar", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const followUp = await arm(t, seed);
    await t.run(async (ctx) =>
      ctx.db.insert("aiReplyQueue", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        triggerMessageId: (
          await ctx.db
            .query("messages")
            .withIndex("by_conversation_and_created", (q) =>
              q.eq("conversationId", seed.conversationId)
            )
            .first()
        )!._id,
        agentMemberId: seed.agentId,
        status: "pending",
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    await advanceToFireTime(t, followUp);
    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    expect(result.reason).toBe("adiado_fila_ocupada");
    expect((await queueItems(t)).filter((i) => i.origin === "follow_up")).toHaveLength(0);
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.deferrals).toBe(1);
  });

  test("anti-insistência: cadeia estourada vira needs_human", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, {
      followUps: { mode: "send", maxChain: 1 },
    });
    const followUp = await arm(t, seed);
    // Um follow-up anterior já disparou e o cliente não falou desde então.
    await t.run(async (ctx) =>
      ctx.db.insert("aiFollowUps", {
        organizationId: seed.organizationId,
        taskId: followUp.taskId,
        conversationId: seed.conversationId,
        leadId: seed.leadId,
        agentMemberId: seed.agentId,
        status: "done",
        dueAt: Date.now(),
        chainIndex: 0,
        deferrals: 0,
        firedAt: Date.now() + HOUR_MS,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    await advanceToFireTime(t, followUp);
    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    expect(result.reason).toBe("cadeia_maxima");
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("needs_human");
  });

  test("teto diário por número: re-arma em vez de enfileirar", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send", dailyCap: 1 } });
    const followUp = await arm(t, seed);
    await advanceToFireTime(t, followUp);
    await t.run(async (ctx) =>
      ctx.db.insert("channelPacing", {
        organizationId: seed.organizationId,
        channelConfigId: seed.configId,
        nextDispatchAt: Date.now(),
        followUpDaily: { day: new Date(Date.now()).toISOString().slice(0, 10), sent: 1 },
      })
    );

    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });
    expect(result.reason).toBe("teto_diario");
    expect((await queueItems(t)).length).toBe(0);
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("scheduled");
  });

  test("job órfão do 'Executar agora' NÃO dispara antes da hora remarcada", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const followUp = await arm(t, seed);
    const jobOriginal = followUp.nextFireAt!;

    // Humano manda executar AGORA (muito antes do prazo) e a IA remarca para
    // depois — era aqui que o `runAt` do prazo original ficava órfão.
    await asUser(t, seed.adminUserId).mutation(api.attendantFollowUp.runNow, {
      followUpId: followUp._id,
    });
    const item = (await queueItems(t)).find((i) => i.origin === "follow_up")!;
    // O turno rodou e a IA remarcou para MAIS TARDE ("me chama na sexta").
    await t.run(async (ctx) => ctx.db.patch(item._id, { status: "done" }));
    await t.mutation(internal.attendant.internalExecuteAttendantTool, {
      name: "resolveFollowUp",
      argsJson: JSON.stringify({ outcome: "reschedule", dueAtLocal: "2026-09-25T09:00" }),
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      followUpId: followUp._id,
    });
    const remarcado = (await t.run(async (ctx) => ctx.db.get(followUp._id)))!;
    expect(remarcado.status).toBe("scheduled");
    expect(remarcado.nextFireAt!).toBeGreaterThan(jobOriginal);

    // O job do prazo ORIGINAL acorda: ele não pode mandar a mensagem dias antes.
    vi.setSystemTime(jobOriginal);
    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    expect(result.reason).toBe("disparo_antecipado");
    expect((await queueItems(t)).filter((i) => i.origin === "follow_up")).toHaveLength(1);
    const depois = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(depois!.status).toBe("scheduled");
  });

  test('mode "off" no vencimento escala para humano (nada vence calado)', async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const followUp = await arm(t, seed);
    await t.run(async (ctx) => {
      const agent = (await ctx.db.get(seed.agentId))!;
      await ctx.db.patch(seed.agentId, {
        agentProfile: { ...agent.agentProfile!, followUps: { mode: "off" } },
      });
    });

    await advanceToFireTime(t, followUp);
    const result = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });

    expect(result.reason).toBe("modo_desligado");
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("needs_human");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("turno de follow-up", () => {
  async function fireReady(
    t: TestConvex<typeof schema>,
    opts?: Parameters<typeof seedFollowUpOrg>[1]
  ) {
    const seed = await seedFollowUpOrg(t, opts);
    await armDefault(t, seed);
    const followUp = await onlyFollowUp(t);
    await advanceToFireTime(t, followUp);
    await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });
    return { seed, followUp };
  }

  test("autopilot + send: envia, marca a mensagem e NÃO conclui a tarefa no commit", async () => {
    const t = setup();
    const { seed, followUp } = await fireReady(t, {
      mode: "autopilot",
      followUps: { mode: "send" },
    });

    const { fetchMock } = await runQueuedTurn(t, [
      { kind: "tool", name: "replyToCustomer", args: { text: "Oi Rejane! Conseguiu fazer o pix?" } },
    ]);

    // O user message é o do turno PROATIVO, não "responda ao cliente agora".
    expect(userMessageOf(fetchMock)).toContain("follow-up que VOCÊ agendou");
    // Título e nota entram DENTRO do envelope não-confiável.
    expect(userMessageOf(fetchMock)).toContain("follow_up_de_agora");
    expect(userMessageOf(fetchMock)).toContain("conferir se o comprovante chegou");
    expect(systemPromptOf(fetchMock)).toContain("10. FOLLOW-UP");
    // `resolveFollowUp` só é oferecida quando existe alvo — aqui existe.
    expect(toolNamesOf(fetchMock)).toContain("resolveFollowUp");

    const sent = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find(
        (m) => m.direction === "outbound" && m.senderType === "ai"
      )
    );
    expect(sent).toBeTruthy();
    expect((sent!.metadata?.followUp as { followUpId?: string })?.followUpId).toBe(followUp._id);

    // Commit ≠ entregue: a tarefa só conclui no gancho de entrega.
    const afterCommit = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(afterCommit!.status).toBe("queued");
    expect((await tasksOf(t))[0].status).toBe("pending");

    // Gancho de entrega (o mesmo ponto onde as campanhas penduram).
    await t.mutation(internal.whatsapp.internalMarkDispatched, {
      messageId: sent!._id,
      wamid: "wamid.TEST",
    });
    const done = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(done!.status).toBe("done");
    expect((await tasksOf(t))[0].status).toBe("completed");
    // Comentário da IA na tarefa, com link da conversa.
    const comments = await t.run(async (ctx) => ctx.db.query("taskComments").collect());
    expect(comments[0].authorType).toBe("ai");
    expect(comments[0].content).toContain("Follow-up executado pela IA");
    void seed;
  });

  test("atendente 9–18h + Executar agora às 19h: o commit NÃO mata o follow-up", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, {
      mode: "autopilot",
      followUps: { mode: "send" },
      schedule: { timezone: "America/Sao_Paulo", startHour: 9, endHour: 18 },
    });
    await armDefault(t, seed, { dueAtLocal: "2026-09-22T10:00" });
    const followUp = await onlyFollowUp(t);

    // 19:00 locais de 21/09 — fora do horário de atendimento do perfil.
    vi.setSystemTime(new Date("2026-09-21T22:00:00.000Z"));
    const fired = await asUser(t, seed.adminUserId).mutation(
      api.attendantFollowUp.runNow,
      { followUpId: followUp._id }
    );
    expect(fired.ok, "o humano mandou executar agora — o horário é decisão dele").toBe(true);

    await runQueuedTurn(t, [
      { kind: "tool", name: "replyToCustomer", args: { text: "Oi! Conseguiu fazer o pix?" } },
    ]);

    const sent = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find(
        (m) => m.direction === "outbound" && m.senderType === "ai"
      )
    );
    expect(sent, "sem a exceção, o commit abortava com fora_do_horario").toBeTruthy();
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("queued"); // esperando a confirmação de entrega
  });

  test("re-run do mesmo item depois do commit não manda uma SEGUNDA mensagem", async () => {
    const t = setup();
    const { followUp } = await fireReady(t, {
      mode: "autopilot",
      followUps: { mode: "send" },
    });
    const { itemId } = await runQueuedTurn(t, [
      { kind: "tool", name: "replyToCustomer", args: { text: "Oi! Conseguiu fazer o pix?" } },
    ]);

    // Um retry do scheduler recoloca o MESMO item para processar.
    await t.run(async (ctx) =>
      ctx.db.patch(itemId, { status: "pending", nextAttemptAt: Date.now() })
    );
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });

    const outbound = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter(
        (m) => m.direction === "outbound" && m.senderType === "ai"
      )
    );
    expect(outbound, "a mensagem deste follow-up já tinha sido comprometida").toHaveLength(1);
    const item = await t.run(async (ctx) => ctx.db.get(itemId));
    expect(item!.error).toBe("follow_up_ja_enviado");
    // Skip PURO: o desfecho do follow-up não foi atropelado.
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("queued");
  });

  test("falha de entrega vira needs_human — nunca tarefa concluída sem mensagem", async () => {
    const t = setup();
    const { followUp } = await fireReady(t, {
      mode: "autopilot",
      followUps: { mode: "send" },
    });
    await runQueuedTurn(t, [
      { kind: "tool", name: "replyToCustomer", args: { text: "Oi! Conseguiu fazer o pix?" } },
    ]);
    const sent = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find(
        (m) => m.direction === "outbound" && m.senderType === "ai"
      )
    );

    await t.mutation(internal.whatsapp.internalMarkDispatchFailed, {
      messageId: sent!._id,
      errorCode: 131026,
      detail: "Fora da janela de 24h",
    });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("needs_human");
    expect((await tasksOf(t))[0].status).toBe("pending");
  });

  test("modo rascunho: vira AiDraft com o vínculo do follow-up", async () => {
    const t = setup();
    const { followUp } = await fireReady(t, { followUps: { mode: "draft" } });

    await runQueuedTurn(t, [
      { kind: "tool", name: "replyToCustomer", args: { text: "Oi! Conseguiu fazer o pix?" } },
    ]);

    const draft = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.isInternal && m.metadata?.aiDraft)
    );
    expect(draft).toBeTruthy();
    expect((draft!.metadata!.aiDraft as { followUpId?: string }).followUpId).toBe(followUp._id);

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("drafted");
    expect(updated!.draftMessageId).toBe(draft!._id);
    // Nada saiu para o cliente.
    const outbound = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.direction === "outbound")
    );
    expect(outbound).toHaveLength(0);
  });

  test("Meta fora da janela de 24h: degrada para RASCUNHO mesmo em autopilot+send", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { mode: "autopilot", followUps: { mode: "send" } });
    await armDefault(t, seed);
    const followUp = await onlyFollowUp(t);
    // Último inbound ficou velho: a janela do Meta fechou.
    await t.run(async (ctx) =>
      ctx.db.patch(seed.conversationId, { lastInboundAt: Date.now() - 2 * DAY_MS })
    );
    await advanceToFireTime(t, followUp);

    const fired = await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });
    expect(fired.ok, "a janela fechada NÃO pode barrar o caminho do rascunho").toBe(true);

    await runQueuedTurn(t, [
      { kind: "tool", name: "replyToCustomer", args: { text: "Oi! Conseguiu fazer o pix?" } },
    ]);

    const draft = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.isInternal && m.metadata?.aiDraft)
    );
    expect(draft, "o texto tem de ficar pronto para quando a janela reabrir").toBeTruthy();
    const outbound = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.direction === "outbound")
    );
    expect(outbound).toHaveLength(0);
  });

  test("resolveFollowUp not_needed: nenhuma mensagem, tarefa concluída", async () => {
    const t = setup();
    const { followUp } = await fireReady(t, {
      mode: "autopilot",
      followUps: { mode: "send" },
    });

    await runQueuedTurn(t, [
      { kind: "tool", name: "resolveFollowUp", args: { outcome: "not_needed", reason: "o comprovante já chegou" } },
      { kind: "empty" },
    ]);

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("not_needed");
    expect((await tasksOf(t))[0].status).toBe("completed");
    const outbound = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.direction === "outbound")
    );
    expect(outbound).toHaveLength(0);
  });

  test("texto puro NÃO vira mensagem: raciocínio da IA nunca chega ao cliente", async () => {
    const t = setup();
    const { followUp } = await fireReady(t, {
      mode: "autopilot",
      followUps: { mode: "send" },
    });

    await runQueuedTurn(t, [
      { kind: "text", content: "O comprovante já chegou, então não preciso mandar nada." },
    ]);

    const outbound = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.direction !== "inbound")
    );
    expect(outbound).toHaveLength(0);
    // Sem decisão por ferramenta, a tarefa vira de gente (e ninguém fica no escuro).
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("needs_human");
  });

  test("modelo não chamou NADA: needs_human terminal, sem retry", async () => {
    const t = setup();
    const { followUp } = await fireReady(t, {
      mode: "autopilot",
      followUps: { mode: "send" },
    });

    const { itemId } = await runQueuedTurn(t, [{ kind: "empty" }]);

    const item = await t.run(async (ctx) => ctx.db.get(itemId));
    expect(item!.status).toBe("skipped");
    expect(item!.attempts).toBe(0); // nada de 4 tentativas
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("needs_human");
    // E nenhum repasse foi aberto (isso silenciaria a IA para o próximo cliente).
    expect(await t.run(async (ctx) => ctx.db.query("handoffs").collect())).toHaveLength(0);
  });

  test("cliente falou durante a geração: aborta e devolve o follow-up a scheduled", async () => {
    const t = setup();
    const { seed, followUp } = await fireReady(t, {
      mode: "autopilot",
      followUps: { mode: "send" },
    });

    stubLlmSequence([
      { kind: "tool", name: "replyToCustomer", args: { text: "Conseguiu fazer o pix?" } },
    ]);
    // O inbound chega ENQUANTO a IA gera (o commit relê a conversa).
    const item = (await queueItems(t)).find((i) => i.origin === "follow_up")!;
    await t.run(async (ctx) => {
      await ctx.db.patch(seed.conversationId, { lastInboundAt: Date.now() + 5_000 });
    });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item._id });

    const outbound = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.direction === "outbound")
    );
    expect(outbound, "duas mensagens fora de ordem é o pior resultado").toHaveLength(0);
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("scheduled");
  });

  test("run de follow-up é `proactive` e fica fora do gate do autopilot", async () => {
    const t = setup();
    const { seed } = await fireReady(t, { followUps: { mode: "draft" } });
    await runQueuedTurn(t, [
      { kind: "tool", name: "replyToCustomer", args: { text: "Oi! Conseguiu fazer o pix?" } },
    ]);

    const runs = await t.run(async (ctx) => ctx.db.query("agentRuns").collect());
    expect(runs[0].proactive).toBe(true);

    const metrics = await asUser(t, seed.adminUserId).query(api.aiSettings.getAttendantMetrics, {
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
    });
    expect(metrics.proactive).toBe(1);
    expect(metrics.pending).toBe(0); // não conta como sugestão à espera de revisão
    expect(metrics.reviewed).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("modo sugestão: a ação proposta já sabe a hora efetiva", () => {
  test("o modelo recebe `quando`/`aviso` e o card mostra a hora reservada", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "draft" } });
    // Inbound novo → turno REATIVO normal em modo sugestão.
    const messageId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        leadId: seed.leadId,
        direction: "inbound",
        senderType: "contact",
        content: "me chama amanhã de madrugada que eu resolvo",
        contentType: "text",
        isInternal: false,
        createdAt: Date.now(),
      })
    );
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    const item = (await queueItems(t))[0];
    vi.setSystemTime(Date.now() + 10_000);

    stubLlmSequence([
      {
        kind: "tool",
        name: "scheduleFollowUp",
        // 03:00 da manhã: a janela de silêncio empurra para as 08:00.
        args: { title: "Cobrar comprovante", dueAtLocal: "2026-09-22T03:00" },
      },
      { kind: "tool", name: "replyToCustomer", args: { text: "Combinado, te chamo!" } },
    ]);
    const fetchMock = vi.mocked(globalThis.fetch);
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item._id });

    // O resultado da tool que volta ao modelo (2ª chamada carrega o histórico).
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as { body?: string })?.body ?? "{}"
    );
    const toolResult = (secondBody.messages ?? []).find(
      (m: { role: string }) => m.role === "tool"
    );
    expect(toolResult?.content).toContain("ter 22/09 08:00");
    expect(toolResult?.content).toContain("fora do horário de atendimento");

    // E o card do rascunho mostra a hora EFETIVA, não a pedida.
    const draft = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.isInternal && m.metadata?.aiDraft)
    );
    const actions = (draft!.metadata!.aiDraft as { proposedActions: { label: string }[] })
      .proposedActions;
    expect(actions[0].label).toContain("ter 22/09 08:00");
    // Nada foi criado ainda: quem cria é a aprovação humana.
    expect(await followUpsOf(t)).toHaveLength(0);
  });

  test("sem follow-up pendente, `resolveFollowUp` nem é oferecida ao modelo", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "draft" } });
    const messageId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        leadId: seed.leadId,
        direction: "inbound",
        senderType: "contact",
        content: "oi, tudo bem?",
        contentType: "text",
        isInternal: false,
        createdAt: Date.now(),
      })
    );
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
    const item = (await queueItems(t))[0];
    vi.setSystemTime(Date.now() + 10_000);

    const fetchMock = stubLlmSequence([
      { kind: "tool", name: "replyToCustomer", args: { text: "Tudo ótimo!" } },
    ]);
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item._id });

    expect(toolNamesOf(fetchMock)).not.toContain("resolveFollowUp");
    expect(toolNamesOf(fetchMock)).toContain("scheduleFollowUp");
  });

  test("aprovar a ação DEPOIS da hora combinada dá erro claro (não agenda no passado)", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "draft" } });
    // A ação proposta pede 22/09 09:00…
    const result = await scheduleFollowUp(t, seed, {
      title: "Cobrar comprovante",
      dueAtLocal: "2026-09-22T09:00",
    });
    expect(result.status).toBe("agendado");

    // …e o humano só aprova três dias depois.
    vi.setSystemTime(new Date("2026-09-25T15:00:00.000Z"));
    const tardio = await scheduleFollowUp(t, seed, {
      title: "Outro assunto",
      dueAtLocal: "2026-09-22T09:00",
    });
    expect(String(tardio.error)).toContain("já passou");
  });
});

describe("coalescing: o turno reativo sempre vence", () => {
  async function queuedFollowUp(t: TestConvex<typeof schema>) {
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" }, mode: "autopilot" });
    await armDefault(t, seed);
    const followUp = await onlyFollowUp(t);
    await advanceToFireTime(t, followUp);
    await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });
    return { seed, followUp };
  }

  test("inbound sequestra o item pendente → vira turno normal e o follow-up re-arma", async () => {
    const t = setup();
    const { seed, followUp } = await queuedFollowUp(t);

    const messageId = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.patch(seed.conversationId, { lastInboundAt: now });
      return await ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        leadId: seed.leadId,
        direction: "inbound",
        senderType: "contact",
        content: "oi, mudei de ideia",
        contentType: "text",
        isInternal: false,
        createdAt: now,
      });
    });
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });

    const items = await queueItems(t);
    expect(items).toHaveLength(1);
    expect(items[0].origin).toBeUndefined();
    expect(items[0].followUpId).toBeUndefined();
    expect(items[0].triggerMessageId).toBe(messageId);

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("scheduled");
    expect(updated!.dueAt).toBeGreaterThan(Date.now());
  });

  test("returnToAi sequestra igual (turno instruído vence)", async () => {
    const t = setup();
    const { seed, followUp } = await queuedFollowUp(t);

    await asUser(t, seed.adminUserId).mutation(api.attendant.returnToAi, {
      conversationId: seed.conversationId,
      instruction: "A chave Pix é 1234 — pode informar",
    });

    const items = await queueItems(t);
    expect(items).toHaveLength(1);
    expect(items[0].origin).toBe("return_to_ai");
    expect(items[0].followUpId).toBeUndefined();

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("scheduled");
  });

  test("getConversationAiState ignora itens de follow-up", async () => {
    const t = setup();
    const { seed } = await queuedFollowUp(t);
    const state = await asUser(t, seed.adminUserId).query(
      api.attendant.getConversationAiState,
      { conversationId: seed.conversationId }
    );
    expect(state, "o chip do inbox fala da última mensagem do cliente").toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("rascunho: coaching, aceite e descarte", () => {
  async function draftedFollowUp(t: TestConvex<typeof schema>) {
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "draft" } });
    await armDefault(t, seed);
    const followUp = await onlyFollowUp(t);
    await advanceToFireTime(t, followUp);
    await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });
    await runQueuedTurn(t, [
      { kind: "tool", name: "replyToCustomer", args: { text: "Oi! Conseguiu fazer o pix?" } },
    ]);
    const draft = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find(
        (m) => m.isInternal && (m.metadata?.aiDraft as { status?: string })?.status === "pending"
      )
    );
    return { seed, followUp, draft: draft! };
  }

  test("aceitar o rascunho conclui a tarefa", async () => {
    const t = setup();
    const { seed, followUp, draft } = await draftedFollowUp(t);

    await asUser(t, seed.adminUserId).mutation(api.attendant.acceptAiDraft, {
      draftMessageId: draft._id,
    });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("done");
    expect((await tasksOf(t))[0].status).toBe("completed");
    const sent = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.direction === "outbound")
    );
    expect((sent!.metadata?.followUp as { followUpId?: string })?.followUpId).toBe(followUp._id);

    // O teto diário conta mensagens que SAEM: em modo rascunho quem manda é o
    // aceite, e sem isto o teto valeria só para orgs em autopilot.
    const pacing = await t.run(async (ctx) =>
      ctx.db
        .query("channelPacing")
        .withIndex("by_channel_config", (q) => q.eq("channelConfigId", seed.configId))
        .first()
    );
    expect(pacing?.followUpDaily?.sent).toBe(1);
  });

  test("descartar cancela o follow-up e a tarefa fica com quem descartou (D7)", async () => {
    const t = setup();
    const { seed, followUp, draft } = await draftedFollowUp(t);

    await asUser(t, seed.adminUserId).mutation(api.attendant.discardAiDraft, {
      draftMessageId: draft._id,
    });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("canceled");
    const task = (await tasksOf(t))[0];
    expect(task.status).toBe("pending");
    expect(task.assignedTo).toBe(seed.adminId);
  });

  test("coaching: o rascunho B herda o vínculo e o aceite conclui a tarefa", async () => {
    const t = setup();
    const { seed, followUp, draft } = await draftedFollowUp(t);

    vi.setSystemTime(Date.now() + 60_000);
    await asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
      instruction: "seja mais direto",
      sourceDraftId: draft._id,
    });
    const coachItem = (await queueItems(t)).find((i) => i.origin === "coach")!;
    // Item de coach NÃO carrega followUpId: o vínculo vem do rascunho de origem.
    expect(coachItem.followUpId).toBeUndefined();
    await t.run(async (ctx) => {
      const pacing = await ctx.db
        .query("aiPacing")
        .withIndex("by_organization", (q) => q.eq("organizationId", seed.organizationId))
        .first();
      if (pacing) await ctx.db.patch(pacing._id, { nextInferenceAt: 0 });
    });

    stubLlmSequence([
      { kind: "tool", name: "replyToCustomer", args: { text: "Rejane, conseguiu o pix?" } },
    ]);
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: coachItem._id });

    const draftB = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find(
        (m) => m.isInternal && (m.metadata?.aiDraft as { status?: string })?.status === "pending"
      )
    );
    expect((draftB!.metadata!.aiDraft as { followUpId?: string }).followUpId).toBe(followUp._id);

    await asUser(t, seed.adminUserId).mutation(api.attendant.acceptAiDraft, {
      draftMessageId: draftB!._id,
    });
    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("done");
    expect((await tasksOf(t))[0].status).toBe("completed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("guardas de estado", () => {
  test("aceitar repasse escala os follow-ups da conversa para quem assumiu", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    await armDefault(t, seed);
    const followUp = await onlyFollowUp(t);

    const handoffId = await t.run(async (ctx) =>
      ctx.db.insert("handoffs", {
        organizationId: seed.organizationId,
        leadId: seed.leadId,
        conversationId: seed.conversationId,
        fromMemberId: seed.agentId,
        reason: "Cliente pediu humano",
        suggestedActions: [],
        status: "pending",
        createdAt: Date.now(),
      })
    );
    await asUser(t, seed.adminUserId).mutation(api.handoffs.acceptHandoff, { handoffId });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("needs_human");
    expect((await tasksOf(t))[0].assignedTo).toBe(seed.adminId);
  });

  test('"Assumir conversa" também escala', async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    await armDefault(t, seed);
    const followUp = await onlyFollowUp(t);

    await asUser(t, seed.adminUserId).mutation(api.conversations.assumeConversation, {
      conversationId: seed.conversationId,
    });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("needs_human");
  });

  test("escalar conversa com VÁRIOS follow-ups: todos viram tarefa de gente, sem auto-aviso", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    await armDefault(t, seed, { title: "Cobrar comprovante" });
    await armDefault(t, seed, { title: "Confirmar endereço" });
    expect(await followUpsOf(t)).toHaveLength(2);

    await asUser(t, seed.adminUserId).mutation(api.conversations.assumeConversation, {
      conversationId: seed.conversationId,
    });

    const rows = await followUpsOf(t);
    expect(rows.every((f) => f.status === "needs_human")).toBe(true);
    expect((await tasksOf(t)).every((task) => task.assignedTo === seed.adminId)).toBe(true);
    // Quem assumiu acabou de agir: nada de aviso sobre a própria ação.
    const avisos = (await notificationsOf(t)).filter(
      (n) => n.type === "ai_followup_needs_human"
    );
    expect(avisos).toHaveLength(0);
  });

  test("cascata de exclusão de lead apaga o follow-up (e mata o agendamento)", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    await armDefault(t, seed);
    expect(await followUpsOf(t)).toHaveLength(1);

    await asUser(t, seed.adminUserId).mutation(api.leads.deleteLead, { leadId: seed.leadId });
    // O job de cascata é chamado direto: `finishAllScheduledFunctions` também
    // acordaria o `fire` armado para amanhã, e um job que se re-arma no futuro
    // nunca deixa a fila vazia (laço no teste).
    await t.mutation(internal.leads.internalCascadeDeleteLeads, {
      organizationId: seed.organizationId,
      leadIds: [seed.leadId],
      contactIds: [],
    });

    expect(await followUpsOf(t)).toHaveLength(0);
    // A TAREFA sobrevive à cascata (perde só o lead) — ela não pode ficar
    // pendente com a IA para sempre.
    const task = (await tasksOf(t))[0];
    expect(task.status).toBe("cancelled");
    const comments = await t.run(async (ctx) => ctx.db.query("taskComments").collect());
    expect(comments.some((c) => /lead foi excluído/i.test(c.content))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("sincronia tarefa → follow-up", () => {
  async function armed(t: TestConvex<typeof schema>) {
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    await armDefault(t, seed);
    return { seed, followUp: await onlyFollowUp(t) };
  }

  test("remarcar a tarefa remarca o follow-up", async () => {
    const t = setup();
    const { seed, followUp } = await armed(t);
    const novo = followUp.dueAt + 5 * HOUR_MS;

    await asUser(t, seed.adminUserId).mutation(api.tasks.updateTask, {
      taskId: followUp.taskId,
      dueDate: novo,
    });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.dueAt).toBe(novo);
    expect(updated!.status).toBe("scheduled");
  });

  test("concluir, cancelar ou excluir a tarefa desarma o follow-up", async () => {
    for (const acao of ["complete", "cancel", "delete"] as const) {
      const t = setup();
      const { seed, followUp } = await armed(t);
      const asAdmin = asUser(t, seed.adminUserId);

      if (acao === "complete") {
        await asAdmin.mutation(api.tasks.completeTask, { taskId: followUp.taskId });
      } else if (acao === "cancel") {
        await asAdmin.mutation(api.tasks.cancelTask, { taskId: followUp.taskId });
      } else {
        await asAdmin.mutation(api.tasks.deleteTask, { taskId: followUp.taskId });
      }

      const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
      expect(updated!.status, `ação ${acao}`).toBe("canceled");
    }
  });

  test("bulkUpdateTasks (cancelar/atribuir/excluir) também desarma o follow-up", async () => {
    for (const acao of ["cancel", "assign", "delete"] as const) {
      const t = setup();
      const { seed, followUp } = await armed(t);

      await asUser(t, seed.adminUserId).mutation(api.tasks.bulkUpdateTasks, {
        taskIds: [followUp.taskId],
        action: acao,
        ...(acao === "assign" ? { assignedTo: seed.adminId } : {}),
      });

      const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
      expect(updated!.status, `bulk ${acao}`).toBe("canceled");
    }
  });

  test("trocar o responsável tira a tarefa da IA", async () => {
    const t = setup();
    const { seed, followUp } = await armed(t);

    await asUser(t, seed.adminUserId).mutation(api.tasks.assignTask, {
      taskId: followUp.taskId,
      assignedTo: seed.adminId,
    });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("canceled");
  });

  test("recorrência é recusada em tarefa com follow-up ativo", async () => {
    const t = setup();
    const { seed, followUp } = await armed(t);

    await expect(
      asUser(t, seed.adminUserId).mutation(api.tasks.updateTask, {
        taskId: followUp.taskId,
        recurrence: { pattern: "weekly" },
      })
    ).rejects.toThrow(/execução automática/i);
  });

  test("GET de tarefa (REST/MCP) devolve o resumo do follow-up", async () => {
    const t = setup();
    const { seed, followUp } = await armed(t);
    const task = await t.query(internal.tasks.internalGetTask, {
      taskId: followUp.taskId,
      organizationId: seed.organizationId,
    });
    expect(task!.aiFollowUp).toMatchObject({
      status: "scheduled",
      dueAt: followUp.dueAt,
      note: "conferir se o comprovante chegou",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("API pública (a tela consome só isto)", () => {
  async function armed(t: TestConvex<typeof schema>) {
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    await armDefault(t, seed);
    return { seed, followUp: await onlyFollowUp(t) };
  }

  test("getForTask e listForConversation", async () => {
    const t = setup();
    const { seed, followUp } = await armed(t);
    const asAdmin = asUser(t, seed.adminUserId);

    const summary = await asAdmin.query(api.attendantFollowUp.getForTask, {
      taskId: followUp.taskId,
    });
    expect(summary).toMatchObject({
      status: "scheduled",
      dueAt: followUp.dueAt,
      note: "conferir se o comprovante chegou",
      agentName: "Ana (IA)",
      effectiveMode: "send",
    });

    const list = await asAdmin.query(api.attendantFollowUp.listForConversation, {
      conversationId: seed.conversationId,
    });
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Cobrar comprovante");
  });

  test("runNow ignora a janela de silêncio mas mantém as outras guardas", async () => {
    const t = setup();
    const { seed, followUp } = await armed(t);
    // 04:00 locais — muito fora da janela 8–20h.
    vi.setSystemTime(new Date("2026-09-22T07:00:00.000Z"));

    const ok = await asUser(t, seed.adminUserId).mutation(api.attendantFollowUp.runNow, {
      followUpId: followUp._id,
    });
    expect(ok.ok).toBe(true);
    expect((await queueItems(t)).filter((i) => i.origin === "follow_up")).toHaveLength(1);
  });

  test("runNow NÃO é atalho: opt-out continua barrando", async () => {
    const t = setup();
    const { seed, followUp } = await armed(t);
    await t.run(async (ctx) =>
      ctx.db.insert("optOuts", {
        organizationId: seed.organizationId,
        phone: "5511988887777",
        source: "keyword",
        createdAt: Date.now(),
      })
    );

    const result = await asUser(t, seed.adminUserId).mutation(api.attendantFollowUp.runNow, {
      followUpId: followUp._id,
    });
    expect(result.ok).toBe(false);
    expect((await queueItems(t)).length).toBe(0);
  });

  test("cancelAuto vira tarefa comum de quem cancelou", async () => {
    const t = setup();
    const { seed, followUp } = await armed(t);

    await asUser(t, seed.adminUserId).mutation(api.attendantFollowUp.cancelAuto, {
      followUpId: followUp._id,
    });

    const updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("canceled");
    const task = (await tasksOf(t))[0];
    expect(task.status).toBe("pending");
    expect(task.assignedTo).toBe(seed.adminId);
  });

  test("adoptTask adota uma tarefa existente do atendente", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const taskId = await t.run(async (ctx) =>
      ctx.db.insert("tasks", {
        organizationId: seed.organizationId,
        title: "Cobrar comprovante — Vivência Maré Nova",
        type: "task",
        status: "pending",
        priority: "medium",
        activityType: "follow_up",
        dueDate: Date.now() + DAY_MS,
        leadId: seed.leadId,
        contactId: seed.contactId,
        assignedTo: seed.agentId,
        createdBy: seed.agentId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const result = await asUser(t, seed.adminUserId).mutation(
      api.attendantFollowUp.adoptTask,
      { taskId }
    );
    expect(result.ok).toBe(true);
    const followUp = await onlyFollowUp(t);
    expect(followUp.taskId).toBe(taskId);
    expect(followUp.conversationId).toBe(seed.conversationId);
    expect(await scheduledNamed(t, "attendantFollowUp")).toHaveLength(1);
  });

  test("adoptTask recusa com mensagem clara: sem lead, sem prazo futuro, já adotada", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" } });
    const asAdmin = asUser(t, seed.adminUserId);

    const semLead = await t.run(async (ctx) =>
      ctx.db.insert("tasks", {
        organizationId: seed.organizationId,
        title: "Sem lead",
        type: "task",
        status: "pending",
        priority: "medium",
        dueDate: Date.now() + DAY_MS,
        assignedTo: seed.agentId,
        createdBy: seed.agentId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    expect(await asAdmin.mutation(api.attendantFollowUp.adoptTask, { taskId: semLead })).toEqual({
      ok: false,
      reason: "A tarefa precisa estar ligada a um lead",
    });

    const vencida = await t.run(async (ctx) =>
      ctx.db.insert("tasks", {
        organizationId: seed.organizationId,
        title: "Vencida",
        type: "task",
        status: "pending",
        priority: "medium",
        dueDate: Date.now() - HOUR_MS,
        leadId: seed.leadId,
        assignedTo: seed.agentId,
        createdBy: seed.agentId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const r = await asAdmin.mutation(api.attendantFollowUp.adoptTask, { taskId: vencida });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("futuro");

    await armDefault(t, seed);
    const existente = await onlyFollowUp(t);
    const jaAdotada = await asAdmin.mutation(api.attendantFollowUp.adoptTask, {
      taskId: existente.taskId,
    });
    expect(jaAdotada).toEqual({ ok: false, reason: "Esta tarefa já é executada pela IA" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("motivos (teste de build)", () => {
  test("todo motivo vira frase humana — nenhum token cru chega ao sino", () => {
    for (const code of FOLLOW_UP_REASON_CODES) {
      const phrase = describeFollowUpReason(code);
      expect(phrase, code).not.toBe(code);
      expect(/[a-z]_[a-z]/.test(phrase), `${code} devolveu um token cru`).toBe(false);
    }
    // Motivo desconhecido não pode virar "undefined" nem vazar o código.
    expect(describeFollowUpReason("algo_novo_do_futuro")).toMatch(/não conseguiu/i);
  });

  test("todos os motivos de elegibilidade do atendente estão mapeados", () => {
    // Se alguém acrescentar uma condição em `evaluateEligibility`, o motivo
    // dela chega até a notificação do follow-up — e precisa ter frase.
    const eligibilityReasons = [
      "conversa_de_grupo", "ia_desativada", "atendente_desativado", "sem_atendente",
      "ia_pausada", "handoff_pendente", "lead_de_humano", "opt_out", "fora_do_horario",
      "teto_conversa", "teto_hora", "bridge_sem_aceite", "janela_24h",
    ];
    for (const reason of eligibilityReasons) {
      expect(FOLLOW_UP_REASON_CODES, reason).toContain(reason);
    }
  });
});

describe("watchdog", () => {
  test("mensagem já comprometida: não escala em 30 min, escala em 6 h, e a entrega tardia ainda conclui", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { mode: "autopilot", followUps: { mode: "send" } });
    await armDefault(t, seed);
    const followUp = await onlyFollowUp(t);
    await advanceToFireTime(t, followUp);
    await t.mutation(internal.attendantFollowUp.fire, { followUpId: followUp._id });
    await runQueuedTurn(t, [
      { kind: "tool", name: "replyToCustomer", args: { text: "Oi! Conseguiu fazer o pix?" } },
    ]);
    const sent = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find(
        (m) => m.direction === "outbound" && m.senderType === "ai"
      )
    );
    const committed = (await t.run(async (ctx) => ctx.db.get(followUp._id)))!;
    expect(committed.resultMessageId).toBe(sent!._id);

    // 45 min depois: o dispatch tem pacing, retry e congelamento de 30 min por
    // qualidade — chamar um humano aqui seria alarme falso.
    vi.setSystemTime(Date.now() + 45 * 60_000);
    await t.mutation(internal.attendantFollowUp.internalWatchdog, {});
    expect((await t.run(async (ctx) => ctx.db.get(followUp._id)))!.status).toBe("queued");

    // 7 h depois: aí sim alguém precisa olhar.
    vi.setSystemTime(Date.now() + 7 * HOUR_MS);
    await t.mutation(internal.attendantFollowUp.internalWatchdog, {});
    const escalado = (await t.run(async (ctx) => ctx.db.get(followUp._id)))!;
    expect(escalado.status).toBe("needs_human");
    expect(escalado.reasonCode).toBe("envio_sem_confirmacao");

    // A confirmação chega atrasada: a mensagem SAIU, então a tarefa conclui.
    await t.mutation(internal.whatsapp.internalMarkDispatched, {
      messageId: sent!._id,
      wamid: "wamid.LATE",
    });
    const final = (await t.run(async (ctx) => ctx.db.get(followUp._id)))!;
    expect(final.status).toBe("done");
    expect((await tasksOf(t))[0].status).toBe("completed");
  });

  test("agendamento perdido é re-disparado; item preso vira needs_human", async () => {
    const t = setup();
    const seed = await seedFollowUpOrg(t, { followUps: { mode: "send" }, mode: "autopilot" });
    await armDefault(t, seed);
    const followUp = await onlyFollowUp(t);

    // Passou muito do prazo e o `runAt` nunca rodou (deploy, restore…).
    vi.setSystemTime(followUp.dueAt + 2 * HOUR_MS);
    await t.mutation(internal.attendantFollowUp.internalWatchdog, {});
    let updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("queued");

    // Agora o turno morreu no caminho: o item ficou preso em `queued`.
    vi.setSystemTime(Date.now() + 2 * HOUR_MS);
    await t.mutation(internal.attendantFollowUp.internalWatchdog, {});
    updated = await t.run(async (ctx) => ctx.db.get(followUp._id));
    expect(updated!.status).toBe("needs_human");
    expect((await notificationsOf(t)).some((n) => n.type === "ai_followup_needs_human")).toBe(true);
  });
});
