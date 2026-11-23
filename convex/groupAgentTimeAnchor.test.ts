/// <reference types="vite/client" />
/**
 * Âncora de tempo no turno de grupo (PR-3, depois do PR-2 do atendente 1:1).
 *
 * Lab de grupo (141 respostas, mesmo modelo e caminho de LLM): erros de tempo ("amanhã" dito sobre um evento
 * que já passou, "neste sábado" para um sábado passado) 5/33 sem âncora, 0/35 com ela. A âncora é calculada no
 * claim a partir do histórico já lido (sem query nova), vai no FIM da mensagem do usuário, antes de "Responda
 * AGORA…", e some com `includeCurrentDateTime:false`. O resumo não ganha âncora.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { buildTimeAnchor } from "./lib/promptTimeAnchor";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const OUR_LID = "92965187932215@lid";
const OUR_PHONE = "558192985729";
const MEMBER_LID = "180002129735765@lid";
const MEMBER_PHONE = "558181392929";
const GROUP_JID = "120363431849092219@g.us";

/** Segunda 23/11/2026 12:25 em São Paulo (15:25 UTC). */
const NOW = Date.UTC(2026, 10, 23, 15, 25);
/** Dom 22/11 22:29 em São Paulo = 21:29 em Manaus (01:29 UTC de segunda). */
const DOM_2229_SP = Date.UTC(2026, 10, 23, 1, 29);
/** Dom 22/11 22:31 em São Paulo. */
const DOM_2231_SP = Date.UTC(2026, 10, 23, 1, 31);

const FINAL = "Responda AGORA ao que foi perguntado a você no grupo";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type SeedOpts = {
  agentTimezone?: string;
  includeCurrentDateTime?: boolean;
};

async function seedGroupOrg(t: TestConvex<typeof schema>, opts: SeedOpts = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Grupos",
      slug: "org-grupos",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(organizationId, {
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
          lgpdAck: { acceptedAt: now, acceptedBy: adminId },
          groupAgentEnabled: true,
          bridgeAiAck: { acceptedAt: now, acceptedBy: adminId },
        },
      },
    });
    await ctx.db.insert("teamMembers", {
      organizationId, name: "Guia (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: {
        kind: "attendant",
        mode: "suggest",
        systemPrompt: "Você é o Guia, atendente da loja.",
        knowledge: "Entregamos às terças.",
        ...(opts.agentTimezone
          ? { schedule: { timezone: opts.agentTimezone, startHour: 0, endHour: 24 } }
          : {}),
        ...(opts.includeCurrentDateTime !== undefined
          ? { includeCurrentDateTime: opts.includeCurrentDateTime }
          : {}),
      },
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge",
      displayName: "Número bridge", status: "active",
      bridgeBaseUrl: "https://wuzapi.example.com",
      bridgeInstanceId: "inst_1",
      bridgeLid: OUR_LID,
      bridgePhone: OUR_PHONE,
      bridgeGroupsEnabled: true,
      bridgeGroupsAck: { acceptedAt: now, acceptedBy: adminId },
      createdAt: now, updatedAt: now,
    });
    const groupChatId = await ctx.db.insert("groupChats", {
      organizationId,
      channelConfigId: configId,
      jid: GROUP_JID,
      subject: "Grupo-Teste",
      monitored: true,
      participantsCount: 2,
      participants: [
        { lid: OUR_LID, phone: OUR_PHONE, name: "Cláudio", isAdmin: false, isSuperAdmin: false },
        { lid: MEMBER_LID, phone: MEMBER_PHONE, name: "Eric", isAdmin: true, isSuperAdmin: true },
      ],
      ai: { mode: "mention", replyMode: "suggest" },
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      kind: "group",
      externalChatId: GROUP_JID,
      groupChatId,
      channel: "whatsapp",
      channelConfigId: configId,
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(groupChatId, { conversationId });
    return { organizationId, groupChatId, conversationId };
  });
}

type Seed = Awaited<ReturnType<typeof seedGroupOrg>>;

async function memberMessage(
  t: TestConvex<typeof schema>,
  seed: Seed,
  content: string,
  createdAt: number,
  extra: { mentions?: string[]; isInternal?: boolean } = {}
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      direction: "inbound",
      senderType: "contact",
      senderLid: MEMBER_LID,
      senderPhone: MEMBER_PHONE,
      senderName: "Eric",
      content,
      contentType: "text",
      isInternal: extra.isInternal ?? false,
      ...(extra.mentions ? { mentions: extra.mentions } : {}),
      createdAt,
    })
  );
}

/** Mensagem NOSSA na sala: da IA ou da equipe humana. */
async function ourMessage(
  t: TestConvex<typeof schema>,
  seed: Seed,
  content: string,
  createdAt: number,
  senderType: "ai" | "human",
  isInternal = false
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      direction: "outbound",
      senderType,
      content,
      contentType: "text",
      isInternal,
      createdAt,
    })
  );
}

function stubLlm(content: string) {
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}");
}

/** Turno real do agente de grupo: "amanhã às 10h" dito domingo à noite, menção às 12:25 de segunda. */
async function runGroupTurn(
  t: TestConvex<typeof schema>,
  seed: Seed,
  before?: (t: TestConvex<typeof schema>, seed: Seed) => Promise<void>,
  /** Depois de enfileirar a menção e antes de o turno rodar (o claim lê o que chegou nesse meio-tempo). */
  afterEnqueue?: (t: TestConvex<typeof schema>, seed: Seed) => Promise<void>
) {
  await memberMessage(t, seed, "amanhã às 10h tem a roda de conversa", DOM_2229_SP);
  if (before) await before(t, seed);
  const messageId = await memberMessage(t, seed, "@Cláudio já começou?", NOW, { mentions: [OUR_LID] });
  await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
  const item = (await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect()))[0];
  await t.run(async (ctx) => {
    await ctx.db.patch(item._id, { nextAttemptAt: 0 });
  });
  if (afterEnqueue) await afterEnqueue(t, seed);
  const fetchMock = stubLlm("ok");
  await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });
  const body = bodyOf(fetchMock);
  return { system: body.messages[0].content as string, user: body.messages[1].content as string };
}

function anchorOf(user: string): string | undefined {
  return user.split("\n\n").find((p) => p.startsWith("AGORA:"));
}

/** Só o campo `historico` do envelope (os membros levam telefone/LID de propósito). */
function historyOf(user: string): string {
  const start = user.indexOf('"historico"');
  const end = user.indexOf('"membros"');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return user.slice(start, end);
}

describe("agente de grupo: âncora de tempo", () => {
  test("presente por padrão, depois do envelope e ANTES de 'Responda AGORA', com os fatos do servidor", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t);

    const { user } = await runGroupTurn(t, seed, async (tt, s) => {
      await ourMessage(tt, s, "Combinado, pessoal!", DOM_2231_SP, "ai");
    });
    const anchor = anchorOf(user)!;
    expect(anchor).toContain("AGORA: segunda-feira, 23/11/2026, 12:25.");
    expect(anchor).toContain("Última mensagem do grupo: seg 23/11 12:25.");
    expect(anchor).toContain("Última mensagem nossa: dom 22/11 22:31 (ontem, há 14 h).");
    expect(anchor).not.toContain("do cliente");
    expect(anchor).toContain("compare com AGORA");
    expect(user.indexOf(anchor)).toBeGreaterThan(user.indexOf("</crm_data>"));
    expect(user.endsWith(`${anchor}\n\n${FINAL} (última mensagem do histórico). Se nada ali for para você, não chame nenhuma ferramenta.`)).toBe(true);
  });

  test("includeCurrentDateTime:false: sem âncora e a mensagem do usuário volta a ser o envelope + a instrução", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t, { includeCurrentDateTime: false });

    const { user } = await runGroupTurn(t, seed);
    expect(user).not.toContain("AGORA:");
    expect(user).not.toContain("Última mensagem do grupo");
    expect(user).toContain(`</crm_data>\n\n${FINAL}`);
  });

  test("nenhum epoch: nem no histórico nem na âncora", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t);

    const { user } = await runGroupTurn(t, seed, async (tt, s) => {
      await ourMessage(tt, s, "Combinado!", DOM_2231_SP, "ai");
    });
    expect(historyOf(user)).not.toMatch(/\d{12,}/);
    expect(anchorOf(user)).not.toMatch(/\d{12,}/);
  });

  test("'nossa' inclui a EQUIPE (human), e a mais recente vence a da IA", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t);

    const { user } = await runGroupTurn(t, seed, async (tt, s) => {
      await ourMessage(tt, s, "Combinado!", DOM_2231_SP, "ai");
      // Equipe humana falou depois (seg 23/11 09:00 em São Paulo).
      await ourMessage(tt, s, "Confirmado pela equipe: hoje às 10h", Date.UTC(2026, 10, 23, 12, 0), "human");
    });
    expect(anchorOf(user)).toContain("Última mensagem nossa: seg 23/11 09:00 (hoje, há 3 h 25).");
  });

  test("mensagens internas (notas) não contam como 'nossa' nem como do grupo", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t);

    const { user } = await runGroupTurn(t, seed, async (tt, s) => {
      await ourMessage(tt, s, "Combinado!", DOM_2231_SP, "ai");
      await ourMessage(tt, s, "nota interna da equipe", Date.UTC(2026, 10, 23, 12, 0), "human", true);
      await memberMessage(tt, s, "recado interno", Date.UTC(2026, 10, 23, 12, 5), { isInternal: true });
    });
    const anchor = anchorOf(user)!;
    expect(anchor).toContain("Última mensagem nossa: dom 22/11 22:31 (ontem, há 14 h).");
    expect(anchor).toContain("Última mensagem do grupo: seg 23/11 12:25.");
  });

  test("membro que escreve DEPOIS da menção: 'última do grupo' é a dele, não a da menção", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t);

    const { user } = await runGroupTurn(t, seed, undefined, async (tt, s) => {
      // 12:27 em São Paulo; o turno roda às 12:28.
      await memberMessage(tt, s, "esquece, já achei", Date.UTC(2026, 10, 23, 15, 27));
      vi.setSystemTime(Date.UTC(2026, 10, 23, 15, 28));
    });
    const anchor = anchorOf(user)!;
    expect(anchor).toContain("AGORA: segunda-feira, 23/11/2026, 12:28.");
    expect(anchor).toContain("Última mensagem do grupo: seg 23/11 12:27.");
    expect(anchor).not.toContain("seg 23/11 12:25");
  });

  test("mensagem do aparelho (outbound human, metadata.via 'device') conta como NOSSA", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t);

    const { user } = await runGroupTurn(t, seed, async (tt, s) => {
      await ourMessage(tt, s, "Combinado!", DOM_2231_SP, "ai");
      await tt.run(async (ctx) =>
        ctx.db.insert("messages", {
          organizationId: s.organizationId,
          conversationId: s.conversationId,
          direction: "outbound",
          senderType: "human",
          content: "Pessoal, hoje é às 10h, viu?",
          contentType: "text",
          isInternal: false,
          metadata: { via: "device" },
          createdAt: Date.UTC(2026, 10, 23, 12, 0), // seg 23/11 09:00 em São Paulo
        })
      );
    });
    expect(anchorOf(user)).toContain("Última mensagem nossa: seg 23/11 09:00 (hoje, há 3 h 25).");
  });

  test("rascunho interno da IA (modo sugestão) NÃO conta como nossa", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t);

    const { user } = await runGroupTurn(t, seed, async (tt, s) => {
      await ourMessage(tt, s, "Combinado!", DOM_2231_SP, "ai");
      // O rascunho que `internalCommitGroupReply` guarda em modo sugestão: direction "internal", isInternal.
      await tt.run(async (ctx) =>
        ctx.db.insert("messages", {
          organizationId: s.organizationId,
          conversationId: s.conversationId,
          direction: "internal",
          senderType: "ai",
          content: "Rascunho: a roda é hoje às 10h.",
          contentType: "text",
          isInternal: true,
          metadata: { aiDraft: { status: "pending", proposedActions: [] }, groupAgent: true },
          createdAt: Date.UTC(2026, 10, 23, 12, 0),
        })
      );
    });
    const anchor = anchorOf(user)!;
    expect(anchor).toContain("Última mensagem nossa: dom 22/11 22:31 (ontem, há 14 h).");
    expect(anchor).not.toContain("seg 23/11 09:00");
  });

  test("sala sem mensagem nossa: a parte 'nossa' é omitida (nada é inventado)", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t);

    const { user } = await runGroupTurn(t, seed);
    const anchor = anchorOf(user)!;
    expect(anchor).toContain("AGORA: segunda-feira, 23/11/2026, 12:25. Última mensagem do grupo: seg 23/11 12:25. ");
    expect(anchor).not.toContain("Última mensagem nossa");
    expect(anchor).toContain("compare com AGORA");
  });

  test("o fuso do agente (Manaus) vence o da org: AGORA e as horas da âncora saem em Manaus", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t, { agentTimezone: "America/Manaus" });

    const { user } = await runGroupTurn(t, seed, async (tt, s) => {
      await ourMessage(tt, s, "Combinado!", DOM_2231_SP, "ai");
    });
    const anchor = anchorOf(user)!;
    expect(anchor).toContain("AGORA: segunda-feira, 23/11/2026, 11:25.");
    expect(anchor).toContain("Última mensagem do grupo: seg 23/11 11:25.");
    expect(anchor).toContain("Última mensagem nossa: dom 22/11 21:31 (ontem, há 14 h).");
    expect(anchor).not.toContain("12:25");
    expect(anchor).not.toContain("22:31");
  });
});

describe("resumo de grupo: sem âncora", () => {
  test("o corpo do resumo não leva a âncora (nem a regra dela)", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t);
    await memberMessage(t, seed, "amanhã às 10h tem a roda de conversa", DOM_2229_SP);
    await ourMessage(t, seed, "Combinado!", DOM_2231_SP, "ai");
    await memberMessage(t, seed, "combinado, eu levo o café", NOW - 60_000);
    const fetchMock = stubLlm("Assuntos: roda de conversa em dom 22/11.");
    const result = await t.action(internal.groupAgent.internalGenerateSummary, {
      groupChatId: seed.groupChatId,
      hours: 24,
    });
    expect(result.error).toBeNull();
    const body = bodyOf(fetchMock);
    const all = JSON.stringify(body.messages);
    expect(all).not.toContain("AGORA:");
    expect(all).not.toContain("Última mensagem do grupo");
    expect(all).not.toContain("Última mensagem nossa");
    expect(all).not.toContain("compare com AGORA");
  });
});

describe("buildTimeAnchor: o 1:1 não muda", () => {
  const input = {
    now: NOW,
    timezone: "America/Sao_Paulo",
    lastInboundAt: NOW,
    lastOutboundAt: DOM_2229_SP,
  };
  // Texto do PR-2 (atendente 1:1), byte a byte.
  const ONE_TO_ONE =
    'AGORA: segunda-feira, 23/11/2026, 12:25. Última mensagem do cliente: seg 23/11 12:25. Última mensagem nossa: dom 22/11 22:29 (ontem, há 14 h). "Hoje", "amanhã" e dias da semana escritos numa mensagem valem para o dia em que ela foi escrita: antes de citar um dia ou horário combinado, compare com AGORA. O que já passou é passado: não diga "te espero", "até lá" nem "amanhã" para ele.';

  test("sem `audience` e com audience:'cliente' a saída é a do 1:1, idêntica", () => {
    expect(buildTimeAnchor(input)).toBe(ONE_TO_ONE);
    expect(buildTimeAnchor({ ...input, audience: "cliente" })).toBe(ONE_TO_ONE);
  });

  test("audience:'grupo' só troca a palavra do rótulo da última mensagem recebida", () => {
    const group = buildTimeAnchor({ ...input, audience: "grupo" });
    expect(group).toBe(ONE_TO_ONE.replace("Última mensagem do cliente", "Última mensagem do grupo"));
  });
});
