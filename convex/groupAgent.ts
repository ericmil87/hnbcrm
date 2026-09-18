/**
 * Agente de IA DENTRO de grupos de WhatsApp (F4, §9 do plano).
 *
 * Quatro coisas vivem aqui, e todas são produto PRÓPRIO — não o atendente 1:1
 * com um `if` a mais:
 *
 *  1. **Turno por menção** (§9.1): alguém chama a IA no grupo, ela responde uma
 *     vez. O gatilho é determinístico (menção/citação/nosso número/palavra-
 *     chave), a elegibilidade é própria (`evaluateGroupEligibility`), os tetos
 *     são do GRUPO (10/h, 30/dia) e as tools são três — nenhuma toca lead.
 *  2. **Resumo e digest** (§9.2): "o que rolou nas últimas 24 h" em 5 linhas.
 *  3. **Radar de oportunidade** (§9.3): classificação barata em lote de 15 min;
 *     acha intenção de compra e NOTIFICA uma pessoa. A IA nunca manda DM.
 *  4. **Os commits transacionais** que re-checam tudo (TOCTOU), porque entre a
 *     decisão e o envio a org pode ter desligado a IA, o humano pode ter
 *     respondido e o teto pode ter estourado.
 *
 * O que reaproveitamos do atendente, de propósito: a FILA (`aiReplyQueue` com
 * debounce/coalescing/backoff), o cursor de pacing por org, o lock OCC por
 * conversa, `historyTextOf` (áudio/imagem/arquivo formatados igual) e a
 * PERSONA/CONHECIMENTO do atendente da org. O resto é deste arquivo.
 *
 * O que NÃO existe aqui, também de propósito: tool de lead/contato (D6), DM
 * automática (D3), criação de contato por membro (D3) e qualquer retorno que
 * carregue o doc de `channelConfigs` (onde mora o token do gateway).
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { assertAgentCan, assertGroupRecordScope, orgAiActive } from "./lib/agentSecurity";
import { applyOutboundMessageSideEffects } from "./lib/outboundSideEffects";
import { configProvider } from "./channelConfigs";
import { GROUP_AGENT_TOOLS, toChatTools } from "./lib/agentTools";
import { wrapUntrustedJson } from "./lib/promptEnvelope";
import { ChatMessage } from "./lib/llm/types";
import { chatWithFallback } from "./lib/llm";
import { resolveOrgRoutes } from "./lib/agentRoutes";
import { DEFAULT_MODELS } from "./lib/llm/registry";
import { sanitizeLlmError } from "./lib/llm/sanitize";
import { createHandoffCore } from "./handoffs";
import { createNotification } from "./lib/notify";
import { visionEnabledForOrg } from "./lib/mediaEnrichment";
import { appendTimeline, membersWithPermission } from "./lib/groupChatCore";
import { historyTextOf, isWithinSchedule, hasMediaAwaitingEnrichment } from "./attendant";
import {
  DEFAULT_GROUP_MAX_PER_DAY,
  DEFAULT_GROUP_MAX_PER_HOUR,
  GROUP_HISTORY_FOR_LLM,
  RADAR_BATCH_MS,
  RADAR_BATCH_SIZE,
  RADAR_MIN_CHARS,
  SUMMARY_MAX_MESSAGES,
  buildGroupSummarySystemPrompt,
  buildGroupSystemPrompt,
  buildRadarSystemPrompt,
  digestDueNow,
  evaluateGroupEligibility,
  groupSpeakerLabel,
  maskGroupPhone,
  opportunityLabel,
  parseRadarVerdicts,
  resolveMentionJids,
  sanitizeGroupReply,
  shouldTriggerGroupAgent,
  suggestedDmFor,
} from "./lib/groupAgentCore";
import {
  buildCurrentDateTimeBlock,
  resolveAgentTimezone,
  shouldIncludeCurrentDateTime,
} from "./lib/promptDateTime";

// ── Constantes de runtime (espelham as do atendente onde o contrato é o mesmo) ──
const DEFAULT_DEBOUNCE_SECONDS = 5;
const PACING_INTERVAL_MS = 1_000;
const LEASE_MS = 3 * 60 * 1000;
const MEDIA_RECHECK_MS = 8_000;
const MEDIA_MAX_WAIT_MS = 60_000;
const MAX_TOOL_ROUNDS = 3;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Participantes que entram no contexto do turno (a sala pode ter 1024). */
const PARTICIPANTS_IN_CONTEXT = 60;
/** Cap de grupos varridos pelo cron do digest. */
const DIGEST_GROUP_CAP = 200;

// Custo: mesmos preços do flash usados pelo atendente (estimativa, não fatura).
const FLASH_PROMPT_USD_PER_M = 0.14;
const FLASH_COMPLETION_USD_PER_M = 0.28;
function estimateCostUsd(usage: { promptTokens: number; completionTokens: number }): number {
  return (
    (usage.promptTokens / 1_000_000) * FLASH_PROMPT_USD_PER_M +
    (usage.completionTokens / 1_000_000) * FLASH_COMPLETION_USD_PER_M
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Contexto compartilhado: carrega grupo + conversa + canal + org + atendente e
// devolve a elegibilidade já avaliada. Usado no enqueue, no claim e nos dois
// commits — divergirem seria exatamente o bug de TOCTOU que o commit existe
// para impedir.
// ─────────────────────────────────────────────────────────────────────────────

type GroupTurnContext = {
  group: Doc<"groupChats">;
  conversation: Doc<"conversations">;
  org: Doc<"organizations">;
  config: Doc<"channelConfigs">;
  agent: Doc<"teamMembers">;
  eligibility: { ok: true } | { ok: false; reason: string };
  counts: { hour: number; day: number };
};

/** Respostas da IA nesta sala na última hora / nas últimas 24 h. */
async function countGroupAiReplies(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  now: number
): Promise<{ hour: number; day: number }> {
  // `.order("desc")` é o que faz o teto valer (review de correção nº 5): em
  // ordem ascendente o `.take(300)` pegava as 300 mensagens MAIS ANTIGAS das
  // últimas 24 h, então numa sala com mais de 300 mensagens/dia — qualquer
  // grupo movimentado — as respostas recentes da IA ficavam fora da janela lida
  // e os tetos de 10/h e 30/dia nunca disparavam. É o mesmo que o atendente 1 a
  // 1 sempre fez (`countAiReplies`, `.order("desc").take(200)`).
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) =>
      q.eq("conversationId", conversationId).gte("createdAt", now - DAY_MS)
    )
    .order("desc")
    .take(300);
  const ai = recent.filter(
    (m) => m.direction === "outbound" && m.senderType === "ai" && !m.isInternal
  );
  return {
    hour: ai.filter((m) => m.createdAt > now - HOUR_MS).length,
    day: ai.length,
  };
}

/** O atendente IA da org — dono da persona, do conhecimento e do horário. */
async function findGroupAttendant(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  channelConfigId: Id<"channelConfigs">
): Promise<Doc<"teamMembers"> | null> {
  const aiMembers = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", organizationId).eq("type", "ai")
    )
    .collect();
  for (const member of aiMembers) {
    const profile = member.agentProfile;
    if (member.status !== "active" || profile?.kind !== "attendant") continue;
    if (
      profile.channelConfigIds &&
      profile.channelConfigIds.length > 0 &&
      !profile.channelConfigIds.includes(channelConfigId)
    ) {
      continue;
    }
    return member;
  }
  return null;
}

async function loadGroupTurnContext(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  now: number
): Promise<GroupTurnContext | { error: string }> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.kind !== "group" || !conversation.groupChatId) {
    return { error: "conversa_nao_e_grupo" };
  }
  const group = await ctx.db.get(conversation.groupChatId);
  if (!group || group.organizationId !== conversation.organizationId) {
    return { error: "grupo_removido" };
  }
  const org = await ctx.db.get(conversation.organizationId);
  if (!org) return { error: "org_removida" };
  const config = await ctx.db.get(group.channelConfigId);
  if (!config || config.organizationId !== org._id) return { error: "canal_removido" };
  const agent = await findGroupAttendant(ctx, org._id, config._id);
  if (!agent) return { error: "sem_atendente" };

  const counts = await countGroupAiReplies(ctx, conversation._id, now);
  // Consulta DIRETA pelo índice `by_conversation_and_status` (review de
  // segurança nº 6). Antes era um `.take(100)` no índice por org, em ordem
  // ascendente: numa org com mais de 100 repasses pendentes — o estado normal
  // depois de alguns meses — o repasse desta sala ficava fora da varredura, a
  // elegibilidade deixava de segurar a IA e ela voltava a responder numa sala
  // já escalada para um humano. Também custava 100 leituras por turno.
  const pendingHandoff =
    (await ctx.db
      .query("handoffs")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversation._id).eq("status", "pending")
      )
      .first()) !== null;

  const eligibility = evaluateGroupEligibility({
    orgAiActive: orgAiActive(org),
    groupAgentEnabled: org.settings.aiConfig?.groupAgentEnabled === true,
    bridgeAiAck: org.settings.aiConfig?.bridgeAiAck !== undefined,
    bridgeGroupsAck: config.bridgeGroupsAck !== undefined,
    bridgeGroupsEnabled: config.bridgeGroupsEnabled === true,
    channelProvider: configProvider(config),
    channelActive: config.status === "active",
    attendantActive: agent.status === "active",
    withinSchedule: isWithinSchedule(agent.agentProfile?.schedule, now),
    groupMode: group.ai?.mode,
    groupMonitored: group.monitored === true && group.conversationId !== undefined,
    groupGone: group.leftAt !== undefined || group.removedAt !== undefined,
    conversationPausedUntil: conversation.aiPausedUntil,
    hasPendingHandoff: pendingHandoff,
    repliesLastHour: counts.hour,
    repliesLastDay: counts.day,
    maxPerHour: group.ai?.maxPerHour,
    maxPerDay: group.ai?.maxPerDay,
    now,
  });

  return { group, conversation, org, config, agent, eligibility, counts };
}

/**
 * Modo de resposta efetivo. `inherit` segue o atendente; `autopilot` só vale se
 * a org de fato venceu o gate — pedir autopilot na política do grupo não é um
 * atalho para publicar sem revisão.
 *
 * Review de segurança nº 5: o `autopilotEarlyAck` do atendente NÃO serve mais
 * como passe para a sala. Ele foi assinado para outro risco — a IA responder
 * sozinha a UMA pessoa que escreveu para a empresa. Publicar sozinha numa sala
 * com dezenas de terceiros é risco maior, e passava apoiado num aceite dado
 * para o menor. Agora o autopilot no grupo exige UMA das duas coisas:
 *
 *  - o atendente 1 a 1 estar DE FATO em `autopilot` (a org já convive com a IA
 *    enviando sem revisão), ou
 *  - o aceite próprio `aiConfig.groupAutopilotAck` (Configurações → IA, audit
 *    `high`).
 *
 * Sem nenhum dos dois, a sala cai para `suggest`. Avisar, não travar: o
 * operador decide, com o aviso na frente e o rastro no audit.
 */
function effectiveReplyMode(
  group: Doc<"groupChats">,
  agent: Doc<"teamMembers">,
  org: Doc<"organizations">
): "suggest" | "autopilot" {
  const profile = agent.agentProfile;
  const wanted = group.ai?.replyMode ?? "inherit";
  const attendantMode = profile?.mode === "autopilot" ? "autopilot" : "suggest";
  if (wanted === "suggest") return "suggest";
  if (wanted === "inherit") return attendantMode;
  const gatePassed =
    attendantMode === "autopilot" ||
    org.settings.aiConfig?.groupAutopilotAck !== undefined;
  return gatePassed ? "autopilot" : "suggest";
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Gatilho e fila
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chamada pelo ingest (`conversations.internalReceiveGroupMessage`) para TODA
 * mensagem de membro. Decide se a IA foi chamada e, só então, enfileira.
 *
 * Deliberadamente NÃO é `attendant.internalEnqueueFromInbound`: aquele
 * responderia a toda mensagem de todo membro e usaria tools de lead numa
 * conversa sem lead.
 */
export const internalEnqueueFromGroup = internalMutation({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.direction !== "inbound" || message.senderType !== "contact") {
      return null;
    }
    const now = Date.now();

    // ── Gate BARATO primeiro ──
    // Esta mutation roda para TODA mensagem de membro de TODO grupo
    // monitorado. A conta pesada (contar respostas da IA, varrer repasses
    // pendentes) só pode acontecer depois de sabermos que a IA foi chamada —
    // senão uma org que nem usa IA paga por cada "bom dia" de cada sala.
    const conversationPre = await ctx.db.get(message.conversationId);
    if (!conversationPre || conversationPre.kind !== "group" || !conversationPre.groupChatId) {
      return null;
    }
    const orgPre = await ctx.db.get(conversationPre.organizationId);
    if (!orgAiActive(orgPre)) return null;
    if (orgPre!.settings.aiConfig?.groupAgentEnabled !== true) return null;
    const groupPre = await ctx.db.get(conversationPre.groupChatId);
    if (!groupPre || groupPre.ai?.mode !== "mention") return null;
    const configPre = await ctx.db.get(groupPre.channelConfigId);

    const trigger = shouldTriggerGroupAgent({
      mode: groupPre.ai?.mode,
      keywords: groupPre.ai?.keywords,
      content: message.content,
      mentions: message.mentions,
      quotedParticipantJid: message.quotedParticipantJid,
      ourLid: configPre?.bridgeLid,
      ourPhone: configPre?.bridgePhone,
    });
    if (!trigger.trigger) return null;

    // Chamaram a IA: agora vale carregar o contexto inteiro.
    const loaded = await loadGroupTurnContext(ctx, message.conversationId, now);
    if ("error" in loaded) return null;
    const { conversation, org, agent } = loaded;

    if (!loaded.eligibility.ok) {
      // Chamaram a IA e ela não pode responder: deixa RASTRO (o inbox mostra
      // "IA em espera: <motivo>"). Silêncio aqui parece bug.
      await ctx.db.insert("aiReplyQueue", {
        organizationId: org._id,
        conversationId: conversation._id,
        triggerMessageId: args.messageId,
        agentMemberId: agent._id,
        status: "skipped",
        error: loaded.eligibility.reason,
        attempts: 0,
        nextAttemptAt: now,
        origin: "group_mention",
        createdAt: now,
        updatedAt: now,
      });
      return null;
    }

    const debounceMs =
      (agent.agentProfile?.messageDebounceSeconds ?? DEFAULT_DEBOUNCE_SECONDS) * 1_000;

    // Coalescing: duas menções seguidas viram UM turno.
    const pending = await ctx.db
      .query("aiReplyQueue")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversation._id).eq("status", "pending")
      )
      .first();
    if (pending) {
      await ctx.db.patch(pending._id, {
        triggerMessageId: args.messageId,
        nextAttemptAt: now + debounceMs,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(debounceMs, internal.groupAgent.internalProcessGroupTurn, {
        queueItemId: pending._id,
      });
      return null;
    }
    const processing = await ctx.db
      .query("aiReplyQueue")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversation._id).eq("status", "processing")
      )
      .first();
    if (processing) return null;

    const queueItemId = await ctx.db.insert("aiReplyQueue", {
      organizationId: org._id,
      conversationId: conversation._id,
      triggerMessageId: args.messageId,
      agentMemberId: agent._id,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now + debounceMs,
      origin: "group_mention",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(debounceMs, internal.groupAgent.internalProcessGroupTurn, {
      queueItemId,
    });
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Claim transacional (debounce + mídia + pacing + lock + snapshot)
// ─────────────────────────────────────────────────────────────────────────────

const claimResultValidator = v.union(
  v.object({ kind: v.literal("skip"), reason: v.string() }),
  v.object({ kind: v.literal("defer"), delayMs: v.number() }),
  v.object({ kind: v.literal("requeued"), reason: v.string() }),
  v.object({ kind: v.literal("run"), context: v.any() })
);

export const internalClaimGroupTurn = internalMutation({
  args: { queueItemId: v.id("aiReplyQueue"), runId: v.string() },
  returns: claimResultValidator,
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.queueItemId);
    if (!item || item.status !== "pending") {
      return { kind: "skip" as const, reason: "nao_pendente" };
    }
    const now = Date.now();
    if (item.nextAttemptAt > now + 250) {
      return { kind: "defer" as const, delayMs: item.nextAttemptAt - now };
    }

    const loaded = await loadGroupTurnContext(ctx, item.conversationId, now);
    if ("error" in loaded) {
      await ctx.db.patch(item._id, { status: "skipped", error: loaded.error, updatedAt: now });
      return { kind: "skip" as const, reason: loaded.error };
    }
    const { group, conversation, org, config, agent, eligibility } = loaded;
    if (!eligibility.ok) {
      await ctx.db.patch(item._id, {
        status: "skipped",
        error: eligibility.reason,
        updatedAt: now,
      });
      return { kind: "skip" as const, reason: eligibility.reason };
    }

    // Espera pelo enriquecimento da mídia — mesma regra do 1:1: sem isto a IA
    // responde ao "[imagem]" cru quando alguém manda um print e a menciona.
    const visionEnabled = visionEnabledForOrg(org);
    if (process.env.WHISPER_SERVICE_URL || visionEnabled) {
      const waitUntil = item.mediaWaitUntil ?? item.createdAt + MEDIA_MAX_WAIT_MS;
      if (
        now < waitUntil &&
        (await hasMediaAwaitingEnrichment(ctx, conversation._id, item.createdAt - MEDIA_MAX_WAIT_MS, {
          visionEnabled,
        }))
      ) {
        await ctx.db.patch(item._id, {
          nextAttemptAt: now + MEDIA_RECHECK_MS,
          ...(item.mediaWaitUntil === undefined ? { mediaWaitUntil: waitUntil } : {}),
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(
          MEDIA_RECHECK_MS,
          internal.groupAgent.internalProcessGroupTurn,
          { queueItemId: item._id }
        );
        return { kind: "requeued" as const, reason: "aguardando_midia" };
      }
    }

    // Pacing por-org: o mesmo cursor do atendente. Grupo e 1:1 competem pelo
    // mesmo orçamento de inferências por segundo — é a mesma conta de LLM.
    const pacing = await ctx.db
      .query("aiPacing")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .first();
    const slot = Math.max(now, pacing?.nextInferenceAt ?? 0);
    if (slot > now + 250) {
      await ctx.db.patch(item._id, { nextAttemptAt: slot, updatedAt: now });
      return { kind: "defer" as const, delayMs: slot - now };
    }
    if (pacing) {
      await ctx.db.patch(pacing._id, { nextInferenceAt: slot + PACING_INTERVAL_MS });
    } else {
      await ctx.db.insert("aiPacing", {
        organizationId: org._id,
        nextInferenceAt: slot + PACING_INTERVAL_MS,
      });
    }

    const lock = conversation.aiTurnLock;
    if (lock && lock.leaseUntil > now) {
      const delayMs = Math.max(lock.leaseUntil - now, 1_000);
      await ctx.db.patch(item._id, { nextAttemptAt: now + delayMs, updatedAt: now });
      return { kind: "defer" as const, delayMs };
    }
    await ctx.db.patch(conversation._id, {
      aiTurnLock: { runId: args.runId, leaseUntil: now + LEASE_MS },
    });
    await ctx.db.patch(item._id, { status: "processing", updatedAt: now });

    const profile = agent.agentProfile!;
    const providerConfig = org.settings.aiConfig?.providerConfig;
    const model =
      providerConfig?.products?.groupAgent?.model ??
      profile.model ??
      providerConfig?.models.attendant ??
      DEFAULT_MODELS.attendant;

    const agentRunId = await ctx.db.insert("agentRuns", {
      organizationId: org._id,
      memberId: agent._id,
      kind: "group_reply",
      status: "running",
      conversationId: conversation._id,
      triggerMessageId: item.triggerMessageId,
      model,
      requestCount: 0,
      startedAt: now,
    });

    // Snapshot por INJEÇÃO (o agente não "busca" nada): histórico da sala com
    // quem falou, participantes para resolver menção, e a política do grupo.
    const rawHistory = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(GROUP_HISTORY_FOR_LLM * 2);
    const history = rawHistory
      .filter((m) => !m.isInternal)
      .slice(0, GROUP_HISTORY_FOR_LLM)
      .reverse()
      .map((m) => ({
        de: groupSpeakerLabel(m),
        texto: historyTextOf(m, { visionEnabled }),
        em: m.createdAt,
      }));

    const participants = (group.participants ?? [])
      .filter((p) => p.leftAt === undefined)
      .slice(0, PARTICIPANTS_IN_CONTEXT)
      .map((p) => ({
        chave: p.lid ?? p.phone ?? "",
        nome: p.name ?? null,
        admin: p.isAdmin === true || p.isSuperAdmin === true,
      }))
      .filter((p) => p.chave.length > 0);

    const trigger = item.triggerMessageId ? await ctx.db.get(item.triggerMessageId) : null;

    return {
      kind: "run" as const,
      context: {
        agentRunId,
        runStartedAt: now,
        organizationId: org._id,
        groupChatId: group._id,
        conversationId: conversation._id,
        agentMemberId: agent._id,
        replyMode: effectiveReplyMode(group, agent, org),
        model,
        providerConfig: providerConfig ?? null,
        temperature: profile.temperature ?? 0.3,
        prompt: {
          agentName: agent.name,
          orgName: org.name,
          language: profile.language ?? "pt-BR",
          persona: profile.systemPrompt ?? null,
          knowledge: profile.knowledge ?? null,
          groupSubject: group.subject,
          participantsCount: participants.length,
          extraInstructions: group.ai?.extraInstructions ?? null,
          teamNotes: (conversation.aiTeamNotes ?? []).map((n) => ({ text: n.text, at: n.at })),
          isEphemeral: group.isEphemeral === true,
          opportunityRadar: group.ai?.opportunityRadar === true,
          // Mesma flag (e mesmo fuso) do perfil do atendente da org: quem
          // desliga o carimbo desliga em todo lugar onde essa persona fala.
          dateTimeBlock: shouldIncludeCurrentDateTime(profile)
            ? buildCurrentDateTimeBlock(
                now,
                resolveAgentTimezone(profile.schedule?.timezone, org.settings.timezone)
              )
            : null,
        },
        envelope: {
          grupo: group.subject,
          membros: participants,
          historico: history,
          mencionaram_voce_em: trigger
            ? { de: groupSpeakerLabel(trigger), texto: trigger.content.slice(0, 1000) }
            : null,
        },
        participants: (group.participants ?? []).map((p) => ({
          lid: p.lid,
          phone: p.phone,
          leftAt: p.leftAt,
        })),
      },
    };
  },
});

export const internalReleaseGroupLock = internalMutation({
  args: { conversationId: v.id("conversations"), runId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (conversation?.aiTurnLock?.runId === args.runId) {
      await ctx.db.patch(args.conversationId, { aiTurnLock: undefined });
    }
    return null;
  },
});

/**
 * Pós-commit: chegou mensagem NOVA durante a geração que também chamava a IA?
 * Re-enfileira (review de correção nº 15).
 *
 * Espelha `attendant.internalCheckMissedInbound`, com uma diferença que é a
 * razão de existir um gêmeo em vez de reuso: num grupo nem toda mensagem de
 * membro é para a IA. Quem decide é `internalEnqueueFromGroup`, que reavalia o
 * gatilho (menção, quote, nosso número digitado, palavra-chave) — então basta
 * reapresentar a mensagem mais recente e deixar o gatilho decidir. Uma mensagem
 * que não chama a IA volta a ser no-op, como sempre foi.
 */
export const internalCheckMissedMention = internalMutation({
  args: { conversationId: v.id("conversations"), sinceTs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) =>
        q.eq("conversationId", args.conversationId).gt("createdAt", args.sinceTs)
      )
      .order("desc")
      .take(10);
    // A MAIS RECENTE das que vieram de um membro: o coalescing do enqueue já
    // trata "duas menções seguidas viram um turno".
    const missed = recent.find(
      (m) => m.direction === "inbound" && m.senderType === "contact"
    );
    if (missed) {
      await ctx.scheduler.runAfter(0, internal.groupAgent.internalEnqueueFromGroup, {
        messageId: missed._id,
      });
    }
    return null;
  },
});

export const internalMarkGroupItemSkipped = internalMutation({
  args: {
    queueItemId: v.id("aiReplyQueue"),
    conversationId: v.id("conversations"),
    runId: v.string(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.queueItemId);
    if (item && item.status === "processing") {
      await ctx.db.patch(args.queueItemId, {
        status: "skipped",
        error: args.reason,
        updatedAt: Date.now(),
      });
    }
    const conversation = await ctx.db.get(args.conversationId);
    if (conversation?.aiTurnLock?.runId === args.runId) {
      await ctx.db.patch(args.conversationId, { aiTurnLock: undefined });
    }
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Commits transacionais
// ─────────────────────────────────────────────────────────────────────────────

const commitResultValidator = v.union(
  v.object({ committed: v.literal(true), messageId: v.id("messages") }),
  v.object({ committed: v.literal(false), reason: v.string() })
);

/**
 * Envia de verdade no grupo (autopilot). RE-CHECA a elegibilidade inteira: a
 * checagem da action não conta (entre ela e aqui a org pode ter desligado a IA,
 * alguém pode ter parado de acompanhar a sala e o teto pode ter estourado).
 *
 * O read do histórico entra no read-set do OCC: um `sendMessage` humano
 * concorrente força a re-execução, que relê e aborta em "humano_respondeu".
 */
export const internalCommitGroupAiReply = internalMutation({
  args: {
    queueItemId: v.id("aiReplyQueue"),
    conversationId: v.id("conversations"),
    groupChatId: v.id("groupChats"),
    agentMemberId: v.id("teamMembers"),
    runId: v.string(),
    agentRunId: v.id("agentRuns"),
    runStartedAt: v.number(),
    text: v.string(),
    mentions: v.optional(v.array(v.string())),
    allowPendingHandoff: v.boolean(),
  },
  returns: commitResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return { committed: false as const, reason: "conversa_removida" };
    if (conversation.aiTurnLock?.runId !== args.runId) {
      return { committed: false as const, reason: "lock_perdido" };
    }
    const loaded = await loadGroupTurnContext(ctx, args.conversationId, now);
    if ("error" in loaded) return { committed: false as const, reason: loaded.error };
    if (loaded.group._id !== args.groupChatId || loaded.agent._id !== args.agentMemberId) {
      return { committed: false as const, reason: "escopo_divergente" };
    }
    if (
      !loaded.eligibility.ok &&
      !(args.allowPendingHandoff && loaded.eligibility.reason === "handoff_pendente")
    ) {
      return { committed: false as const, reason: loaded.eligibility.reason };
    }

    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(20);
    // Humano do time respondeu no grupo durante a geração? A IA não pisa nele.
    if (
      recent.some(
        (m) =>
          m.direction === "outbound" &&
          m.senderType === "human" &&
          m.createdAt >= args.runStartedAt
      )
    ) {
      return { committed: false as const, reason: "humano_respondeu" };
    }

    const messageId = await ctx.db.insert("messages", {
      organizationId: conversation.organizationId,
      conversationId: conversation._id,
      direction: "outbound",
      senderId: args.agentMemberId,
      senderType: "ai",
      content: args.text,
      contentType: "text",
      isInternal: false,
      ...(args.mentions && args.mentions.length > 0 ? { mentions: args.mentions } : {}),
      metadata: { agentRunId: args.agentRunId, groupAgent: true },
      createdAt: now,
    });
    await applyOutboundMessageSideEffects(ctx, {
      conversation,
      member: loaded.agent,
      messageId,
      now,
      activityContent: "Resposta do agente de IA no grupo",
    });
    await ctx.db.patch(loaded.group._id, {
      timeline: appendTimeline(loaded.group.timeline, {
        at: now,
        type: "ai_reply",
        data: args.text.slice(0, 200),
      }),
      updatedAt: now,
    });

    await ctx.db.patch(args.queueItemId, { status: "done", updatedAt: now });
    await ctx.db.patch(conversation._id, { aiTurnLock: undefined });
    return { committed: true as const, messageId };
  },
});

/**
 * Modo sugestão (default): o texto vira RASCUNHO interno na conversa do grupo —
 * o mesmo `AiDraftCard` do inbox. As menções ficam gravadas na linha do
 * rascunho para o envio aprovado sair com elas (`acceptAiDraft` as copia).
 */
export const internalCommitGroupAiSuggestion = internalMutation({
  args: {
    queueItemId: v.id("aiReplyQueue"),
    conversationId: v.id("conversations"),
    groupChatId: v.id("groupChats"),
    agentMemberId: v.id("teamMembers"),
    runId: v.string(),
    agentRunId: v.id("agentRuns"),
    text: v.string(),
    mentions: v.optional(v.array(v.string())),
  },
  returns: commitResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return { committed: false as const, reason: "conversa_removida" };
    if (conversation.aiTurnLock?.runId !== args.runId) {
      return { committed: false as const, reason: "lock_perdido" };
    }
    if (conversation.aiPausedUntil !== undefined && conversation.aiPausedUntil > now) {
      await ctx.db.patch(args.queueItemId, {
        status: "skipped",
        error: "ia_pausada",
        updatedAt: now,
      });
      await ctx.db.patch(conversation._id, { aiTurnLock: undefined });
      return { committed: false as const, reason: "ia_pausada" };
    }

    const agent = await ctx.db.get(args.agentMemberId);
    const messageId = await ctx.db.insert("messages", {
      organizationId: conversation.organizationId,
      conversationId: conversation._id,
      direction: "internal",
      senderId: agent?._id,
      senderType: "ai",
      content: args.text,
      contentType: "text",
      isInternal: true,
      ...(args.mentions && args.mentions.length > 0 ? { mentions: args.mentions } : {}),
      metadata: {
        aiDraft: { status: "pending", agentRunId: args.agentRunId, proposedActions: [] },
        groupAgent: true,
      },
      createdAt: now,
    });

    await ctx.db.patch(conversation._id, {
      lastMessageAt: now,
      messageCount: conversation.messageCount + 1,
      updatedAt: now,
      aiTurnLock: undefined,
    });
    await ctx.db.patch(args.queueItemId, { status: "done", updatedAt: now });

    // Sino: numa sala não há "dono do lead", então o aviso vai para quem pode
    // responder no inbox. Dedupe por conversa — rajada de menções não empilha.
    const group = await ctx.db.get(args.groupChatId);
    for (const replier of await membersWithPermission(
      ctx,
      conversation.organizationId,
      "inbox",
      "reply"
    )) {
      const unread = await ctx.db
        .query("notifications")
        .withIndex("by_member_and_read", (q) =>
          q.eq("memberId", replier._id).eq("readAt", undefined)
        )
        .order("desc")
        .take(50);
      if (
        unread.some(
          (n) => n.type === "ai_draft_pending" && n.conversationId === conversation._id
        )
      ) {
        continue;
      }
      await createNotification(ctx, {
        organizationId: conversation.organizationId,
        memberId: replier._id,
        type: "ai_draft_pending",
        title: "Rascunho da IA aguardando revisão",
        body: group ? `Grupo "${group.subject}"` : undefined,
        conversationId: conversation._id,
        groupChatId: args.groupChatId,
        actorId: args.agentMemberId,
      });
    }
    return { committed: true as const, messageId };
  },
});

/** Tool `requestGroupHandoff`: repasse SEM lead, amarrado à conversa da sala. */
export const internalCreateGroupHandoff = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    groupChatId: v.id("groupChats"),
    conversationId: v.id("conversations"),
    agentMemberId: v.id("teamMembers"),
    reason: v.string(),
    summary: v.optional(v.string()),
  },
  returns: v.union(v.id("handoffs"), v.null()),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group || group.organizationId !== args.organizationId) return null;
    // Camada 1 (RBAC + org) e camada 2 (escopo por registro): os ids vêm da
    // action, e a action os recebeu do CLAIM — nunca do modelo. A checagem
    // existe para um caller futuro não virar escrita fora da sala do turno.
    await assertAgentCan(ctx, args.agentMemberId, "inbox", "reply", group);
    assertGroupRecordScope(
      {
        organizationId: args.organizationId,
        groupChatId: group._id,
        conversationId: group.conversationId!,
      },
      { kind: "conversation", id: args.conversationId }
    );
    return await createHandoffCore(ctx, {
      organizationId: args.organizationId,
      subjectLabel: `Grupo: ${group.subject}`,
      conversationId: args.conversationId,
      fromMemberId: args.agentMemberId,
      reason: args.reason.slice(0, 200),
      summary: args.summary?.slice(0, 1000),
      suggestedActions: ["Abrir a conversa do grupo e responder"],
      origin: "ai_tool",
      onDuplicate: "skip",
    });
  },
});

/**
 * Tool `flagOpportunity` (e o radar §9.3): notifica o time. NÃO cria lead e NÃO
 * manda DM — as duas coisas são decisão de uma pessoa (D3), e a segunda é
 * caminho direto para banimento.
 */
export const internalFlagOpportunity = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    groupChatId: v.id("groupChats"),
    conversationId: v.id("conversations"),
    agentMemberId: v.id("teamMembers"),
    participantKey: v.string(),
    summary: v.string(),
    tipo: v.optional(v.string()),
  },
  returns: v.union(v.literal("notificado"), v.literal("ignorado")),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group || group.organizationId !== args.organizationId) return "ignorado";
    await assertAgentCan(ctx, args.agentMemberId, "leads", "view_own", group);
    assertGroupRecordScope(
      {
        organizationId: args.organizationId,
        groupChatId: group._id,
        conversationId: group.conversationId!,
      },
      { kind: "conversation", id: args.conversationId }
    );

    const participant = (group.participants ?? []).find(
      (p) => (p.lid ?? p.phone) === args.participantKey
    );
    if (!participant) return "ignorado";
    const agent = await ctx.db.get(args.agentMemberId);
    const org = await ctx.db.get(args.organizationId);
    const summary = args.summary.slice(0, 140);

    for (const replier of await membersWithPermission(
      ctx,
      args.organizationId,
      "inbox",
      "reply"
    )) {
      await createNotification(ctx, {
        organizationId: args.organizationId,
        memberId: replier._id,
        type: "group_opportunity",
        title: `${opportunityLabel(args.tipo ?? "")} em "${group.subject}"`,
        // Telefone de TERCEIRO mascarado, como no resto do produto
        // (`maskMemberPhone` das campanhas, `maskPhone` das tools do copiloto).
        // A notificação fica persistida em `notifications`; o número inteiro
        // está a um clique em "Ver membros", sob `inbox:view_all`
        // (review de segurança nº 12).
        body: `${participant.name ?? maskGroupPhone(participant.phone) ?? "Um membro"}: ${summary}`,
        conversationId: args.conversationId,
        groupChatId: args.groupChatId,
        data: {
          participantKey: args.participantKey,
          memberName: participant.name ?? null,
          hasPhone: participant.phone !== undefined,
          // Rascunho da primeira DM — quem manda é o humano que clicar.
          suggestedDm: suggestedDmFor({
            agentName: agent?.name ?? "a equipe",
            orgName: org?.name ?? "",
            memberName: participant.name,
            groupSubject: group.subject,
            summary,
          }),
        },
        actorId: args.agentMemberId,
      });
    }
    return "notificado";
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Runtime do turno
// ─────────────────────────────────────────────────────────────────────────────

type GroupRunContext = {
  agentRunId: Id<"agentRuns">;
  runStartedAt: number;
  organizationId: Id<"organizations">;
  groupChatId: Id<"groupChats">;
  conversationId: Id<"conversations">;
  agentMemberId: Id<"teamMembers">;
  replyMode: "suggest" | "autopilot";
  model: string;
  providerConfig: Parameters<typeof resolveOrgRoutes>[2];
  temperature: number;
  prompt: Parameters<typeof buildGroupSystemPrompt>[0];
  envelope: Record<string, unknown>;
  participants: { lid?: string; phone?: string; leftAt?: number }[];
};

export const internalProcessGroupTurn = internalAction({
  args: { queueItemId: v.id("aiReplyQueue") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const runId = crypto.randomUUID();
    const claim = await ctx.runMutation(internal.groupAgent.internalClaimGroupTurn, {
      queueItemId: args.queueItemId,
      runId,
    });
    if (claim.kind === "skip" || claim.kind === "requeued") return null;
    if (claim.kind === "defer") {
      await ctx.scheduler.runAfter(
        claim.delayMs,
        internal.groupAgent.internalProcessGroupTurn,
        { queueItemId: args.queueItemId }
      );
      return null;
    }

    const context = claim.context as GroupRunContext;
    try {
      const routes = await resolveOrgRoutes(
        ctx,
        context.organizationId,
        context.providerConfig,
        context.model,
        "groupAgent"
      );
      if (routes.length === 0) throw new Error("Nenhum provider de IA disponível");

      // Sem radar ligado a tool `flagOpportunity` nem existe — subtração do
      // registry estático, nunca adição.
      const tools = toChatTools(
        context.prompt.opportunityRadar
          ? GROUP_AGENT_TOOLS
          : GROUP_AGENT_TOOLS.filter((t) => t.name !== "flagOpportunity")
      );

      const messages: ChatMessage[] = [
        { role: "system", content: buildGroupSystemPrompt(context.prompt) },
        {
          role: "user",
          content: `${wrapUntrustedJson("conversa do grupo", context.envelope)}\n\nResponda AGORA ao que foi perguntado a você no grupo (última mensagem do histórico). Se nada ali for para você, não chame nenhuma ferramenta.`,
        },
      ];

      let replyText: string | null = null;
      let mentionKeys: unknown = null;
      const toolCallNames: string[] = [];
      let requestCount = 0;
      const usage = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
      let usedProvider: string | undefined;
      let handoffRequestedThisRun = false;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const resp = await chatWithFallback(routes, {
          messages,
          tools,
          toolChoice: "auto",
          temperature: context.temperature,
          maxTokens: 1000,
        });
        requestCount += 1;
        usedProvider = resp.usedRoute.providerId;
        if (resp.usage) {
          usage.promptTokens += resp.usage.promptTokens;
          usage.completionTokens += resp.usage.completionTokens;
          usage.cachedPromptTokens += resp.usage.cachedPromptTokens ?? 0;
        }
        if (resp.finishReason === "content_filter") {
          throw new Error("content_filter: resposta bloqueada pelo provider");
        }
        messages.push(resp.message);
        const toolCalls = resp.message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          // Texto puro sem tool: no grupo isso NÃO vira mensagem publicada. A
          // regra 1 manda usar `replyToGroup`, e publicar o que o modelo
          // "pensou em voz alta" numa sala com clientes é risco sem ganho.
          break;
        }
        for (const tc of toolCalls) {
          const name = tc.function.name;
          toolCallNames.push(name);
          let result: Record<string, unknown>;
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(tc.function.arguments || "{}");
          } catch {
            parsed = {};
          }

          if (name === "replyToGroup") {
            replyText = sanitizeGroupReply(
              typeof parsed.text === "string" ? parsed.text : null
            );
            mentionKeys = parsed.mentionKeys ?? null;
            result = replyText
              ? { status: context.replyMode === "suggest" ? "rascunho_registrado" : "publicada" }
              : { error: "text é obrigatório" };
          } else if (name === "requestGroupHandoff") {
            const handoffId = await ctx.runMutation(
              internal.groupAgent.internalCreateGroupHandoff,
              {
                organizationId: context.organizationId,
                groupChatId: context.groupChatId,
                conversationId: context.conversationId,
                agentMemberId: context.agentMemberId,
                reason: typeof parsed.reason === "string" ? parsed.reason : "Escalado pela IA",
                summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
              }
            );
            handoffRequestedThisRun = true;
            result = handoffId
              ? { status: "repasse_criado" }
              : { status: "ja_existe_repasse_pendente" };
          } else if (name === "flagOpportunity" && context.prompt.opportunityRadar) {
            const flagged = await ctx.runMutation(internal.groupAgent.internalFlagOpportunity, {
              organizationId: context.organizationId,
              groupChatId: context.groupChatId,
              conversationId: context.conversationId,
              agentMemberId: context.agentMemberId,
              participantKey:
                typeof parsed.participantKey === "string" ? parsed.participantKey : "",
              summary: typeof parsed.summary === "string" ? parsed.summary : "",
              tipo: "compra",
            });
            result = { status: flagged };
          } else {
            // Nome fora do registry do grupo (inclusive uma tool de lead que o
            // modelo tenha "lembrado" de outro contexto): recusa explícita.
            result = { error: `Ferramenta indisponível neste grupo: ${name}` };
          }
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }
        if (replyText !== null) break;
      }

      let commit: { committed: boolean; messageId?: Id<"messages">; reason?: string } = {
        committed: false,
        reason: "sem_resposta",
      };
      if (replyText) {
        const mentions = resolveMentionJids(context.participants, mentionKeys);
        commit =
          context.replyMode === "suggest"
            ? await ctx.runMutation(internal.groupAgent.internalCommitGroupAiSuggestion, {
                queueItemId: args.queueItemId,
                conversationId: context.conversationId,
                groupChatId: context.groupChatId,
                agentMemberId: context.agentMemberId,
                runId,
                agentRunId: context.agentRunId,
                text: replyText,
                ...(mentions.length > 0 ? { mentions } : {}),
              })
            : await ctx.runMutation(internal.groupAgent.internalCommitGroupAiReply, {
                queueItemId: args.queueItemId,
                conversationId: context.conversationId,
                groupChatId: context.groupChatId,
                agentMemberId: context.agentMemberId,
                runId,
                agentRunId: context.agentRunId,
                runStartedAt: context.runStartedAt,
                text: replyText,
                ...(mentions.length > 0 ? { mentions } : {}),
                allowPendingHandoff: handoffRequestedThisRun,
              });
      }

      await ctx.runMutation(internal.agentRuns.internalFinishRun, {
        runId: context.agentRunId,
        status: "done",
        provider: usedProvider,
        model: context.model,
        requestCount,
        toolCallNames,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedPromptTokens: usage.cachedPromptTokens,
        costUsdEstimate: estimateCostUsd(usage),
        ...(commit.committed && commit.messageId ? { resultMessageId: commit.messageId } : {}),
      });

      if (!commit.committed) {
        // Inclui o caso "a IA decidiu não responder" — legítimo num grupo, e
        // é por isso que isto NÃO é tratado como falha (sem retry, sem repasse).
        await ctx.runMutation(internal.groupAgent.internalMarkGroupItemSkipped, {
          queueItemId: args.queueItemId,
          conversationId: context.conversationId,
          runId,
          reason: commit.reason ?? "sem_resposta",
        });
      }

      // Mencionaram a IA DURANTE a geração? Re-enfileira (review de correção
      // nº 15). O guard `if (processing) return null` de
      // `internalEnqueueFromGroup` foi copiado do atendente 1 a 1, mas a
      // compensação dele não: lá o pós-commit chama
      // `internalCheckMissedInbound`. Sem este passo, "@Guardião e o prazo?"
      // chegando 3 s depois de "@Guardião qual o preço?" nunca era respondido,
      // e nem rastro `skipped` ficava.
      await ctx.runMutation(internal.groupAgent.internalCheckMissedMention, {
        conversationId: context.conversationId,
        sinceTs: context.runStartedAt,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Erro inesperado no agente de grupo";
      const retry = await ctx.runMutation(internal.attendant.internalRecordQueueFailure, {
        queueItemId: args.queueItemId,
        conversationId: context.conversationId,
        runId,
        agentRunId: context.agentRunId,
        error: message,
      });
      if (retry) {
        await ctx.scheduler.runAfter(
          retry.retryInMs,
          internal.groupAgent.internalProcessGroupTurn,
          { queueItemId: args.queueItemId }
        );
      }
    }
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Resumo por IA (§9.2) — sob demanda e no digest diário
// ─────────────────────────────────────────────────────────────────────────────

/** Contexto do resumo. `null` = gate fechado (a action devolve erro amigável). */
export const internalGetSummaryContext = internalQuery({
  args: { groupChatId: v.id("groupChats"), hours: v.number(), now: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) return null;
    const org = await ctx.db.get(group.organizationId);
    if (!orgAiActive(org)) return { error: "ia_desativada" };
    if (org!.settings.aiConfig?.groupAgentEnabled !== true) {
      return { error: "agente_de_grupo_desativado" };
    }
    if (!group.conversationId) return { error: "grupo_nao_monitorado" };

    const since = args.now - args.hours * HOUR_MS;
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) =>
        q.eq("conversationId", group.conversationId!).gte("createdAt", since)
      )
      .order("desc")
      .take(SUMMARY_MAX_MESSAGES);
    const visionEnabled = visionEnabledForOrg(org);
    const history = rows
      .filter((m) => !m.isInternal)
      .reverse()
      .map((m) => ({
        de: groupSpeakerLabel(m),
        texto: historyTextOf(m, { visionEnabled }).slice(0, 500),
        em: m.createdAt,
      }));

    const aiMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) =>
        q.eq("organizationId", group.organizationId).eq("type", "ai")
      )
      .collect();
    const attendant = aiMembers.find(
      (m) => m.status === "active" && m.agentProfile?.kind === "attendant"
    );
    const providerConfig = org!.settings.aiConfig?.providerConfig;

    return {
      organizationId: group.organizationId,
      orgName: org!.name,
      subject: group.subject,
      language: attendant?.agentProfile?.language ?? "pt-BR",
      memberId: attendant?._id ?? null,
      model:
        providerConfig?.products?.groupAgent?.model ??
        providerConfig?.models.classify ??
        DEFAULT_MODELS.classify,
      providerConfig: providerConfig ?? null,
      history,
    };
  },
});

export const internalStoreSummary = internalMutation({
  args: {
    groupChatId: v.id("groupChats"),
    text: v.string(),
    hours: v.number(),
    model: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) return null;
    await ctx.db.patch(args.groupChatId, {
      summary: { text: args.text, at: Date.now(), hours: args.hours, model: args.model },
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** O que `internalGetSummaryContext` devolve quando os gates passam. */
type SummarySetup = {
  organizationId: Id<"organizations">;
  orgName: string;
  subject: string;
  language: string;
  memberId: Id<"teamMembers"> | null;
  model: string;
  providerConfig: Parameters<typeof resolveOrgRoutes>[2];
  history: { de: string; texto: string; em: number }[];
};

const summaryResultValidator = v.object({
  text: v.union(v.string(), v.null()),
  at: v.union(v.number(), v.null()),
  hours: v.number(),
  error: v.union(v.string(), v.null()),
});

/**
 * Gera (e grava) o resumo da sala. Sem gate de permissão aqui de propósito:
 * quem chama é ou a action pública `groupChats.summarizeGroup` (que já exigiu
 * `inbox:view_own`), ou o cron do digest, ou o copiloto (que já passou pelo
 * RBAC do usuário no executor de tools).
 */
export const internalGenerateSummary = internalAction({
  args: { groupChatId: v.id("groupChats"), hours: v.number() },
  returns: summaryResultValidator,
  handler: async (ctx, args): Promise<{
    text: string | null;
    at: number | null;
    hours: number;
    error: string | null;
  }> => {
    const hours = args.hours === 168 ? 168 : 24;
    // `internalGetSummaryContext` devolve `v.any()` (null | {error} | contexto):
    // o cast declara qual dos três estamos tratando em cada ramo.
    const setup = (await ctx.runQuery(internal.groupAgent.internalGetSummaryContext, {
      groupChatId: args.groupChatId,
      hours,
      now: Date.now(),
    })) as SummarySetup | { error: string } | null;
    if (!setup) return { text: null, at: null, hours, error: "grupo_nao_encontrado" };
    if ("error" in setup) return { text: null, at: null, hours, error: setup.error };
    if (setup.history.length === 0) {
      return { text: null, at: null, hours, error: "sem_mensagens_no_periodo" };
    }

    let runId: Id<"agentRuns"> | null = null;
    try {
      const routes = await resolveOrgRoutes(
        ctx,
        setup.organizationId,
        setup.providerConfig,
        setup.model,
        "groupAgent"
      );
      if (routes.length === 0) throw new Error("Nenhum provider de IA disponível");
      if (setup.memberId) {
        runId = await ctx.runMutation(internal.agentRuns.internalStartRun, {
          organizationId: setup.organizationId,
          memberId: setup.memberId,
          kind: "group_summary",
          model: setup.model,
        });
      }

      const resp = await chatWithFallback(routes, {
        messages: [
          {
            role: "system",
            content: buildGroupSummarySystemPrompt({
              orgName: setup.orgName,
              language: setup.language,
              groupSubject: setup.subject,
              hours,
              messageCount: setup.history.length,
            }),
          },
          {
            role: "user",
            content: `${wrapUntrustedJson("mensagens do grupo", {
              grupo: setup.subject,
              mensagens: setup.history,
            })}\n\nEscreva o resumo agora.`,
          },
        ],
        temperature: 0.2,
        maxTokens: 900,
      });
      const text = resp.message.content?.trim();
      if (!text) throw new Error("O modelo não produziu o resumo");

      await ctx.runMutation(internal.groupAgent.internalStoreSummary, {
        groupChatId: args.groupChatId,
        text,
        hours,
        model: setup.model,
      });
      if (runId) {
        await ctx.runMutation(internal.agentRuns.internalFinishRun, {
          runId,
          status: "done",
          provider: resp.usedRoute.providerId,
          model: setup.model,
          requestCount: 1,
          promptTokens: resp.usage?.promptTokens ?? 0,
          completionTokens: resp.usage?.completionTokens ?? 0,
          costUsdEstimate: estimateCostUsd({
            promptTokens: resp.usage?.promptTokens ?? 0,
            completionTokens: resp.usage?.completionTokens ?? 0,
          }),
        });
      }
      return { text, at: Date.now(), hours, error: null };
    } catch (e) {
      const error = sanitizeLlmError(e instanceof Error ? e.message : "Falha ao resumir");
      if (runId) {
        await ctx.runMutation(internal.agentRuns.internalFinishRun, {
          runId,
          status: "error",
          error,
        });
      }
      return { text: null, at: null, hours, error };
    }
  },
});

// ── Digest diário (§9.2) ────────────────────────────────────────────────────

export const internalListDigestDue = internalQuery({
  args: { now: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const groups = await ctx.db.query("groupChats").take(DIGEST_GROUP_CAP);
    const due: { groupChatId: Id<"groupChats">; organizationId: Id<"organizations"> }[] = [];
    for (const group of groups) {
      if (!group.monitored || !group.conversationId) continue;
      if (group.leftAt !== undefined || group.removedAt !== undefined) continue;
      if (!group.ai?.dailyDigestAt) continue;
      const org = await ctx.db.get(group.organizationId);
      if (!orgAiActive(org)) continue;
      if (org!.settings.aiConfig?.groupAgentEnabled !== true) continue;
      if (!digestDueNow(group.ai.dailyDigestAt, org!.settings.timezone, args.now)) continue;
      // Idempotência do cron horário: um DIGEST por dia por grupo. O campo é
      // próprio (`ai.lastDigestAt`) e não `summary.at`: aquele é escrito também
      // pelo "Resumo por IA" manual, então um resumo pedido à tarde cancelava o
      // digest do dia em silêncio.
      if ((group.ai.lastDigestAt ?? 0) > args.now - 20 * HOUR_MS) continue;
      due.push({ groupChatId: group._id, organizationId: group.organizationId });
    }
    return due;
  },
});

export const internalNotifyDigest = internalMutation({
  args: { groupChatId: v.id("groupChats"), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) return null;
    // Carimba o digest do dia ANTES de notificar: é o que impede o cron
    // horário de repetir, e independe de o resumo manual ter rodado.
    if (group.ai) {
      await ctx.db.patch(group._id, {
        ai: { ...group.ai, lastDigestAt: Date.now() },
        updatedAt: Date.now(),
      });
    }
    for (const member of await membersWithPermission(
      ctx,
      group.organizationId,
      "inbox",
      "reply"
    )) {
      await createNotification(ctx, {
        organizationId: group.organizationId,
        memberId: member._id,
        type: "group_digest",
        title: `Resumo do dia: ${group.subject}`,
        body: args.text.slice(0, 280),
        conversationId: group.conversationId,
        groupChatId: group._id,
        data: { hours: 24 },
      });
    }
    return null;
  },
});

/** Cron horário: gera o resumo dos grupos cujo horário de digest é AGORA. */
export const internalRunGroupDigests = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const due = (await ctx.runQuery(internal.groupAgent.internalListDigestDue, {
      now: Date.now(),
    })) as { groupChatId: Id<"groupChats"> }[];
    for (const row of due) {
      const result = await ctx.runAction(internal.groupAgent.internalGenerateSummary, {
        groupChatId: row.groupChatId,
        hours: 24,
      });
      if (result.text) {
        await ctx.runMutation(internal.groupAgent.internalNotifyDigest, {
          groupChatId: row.groupChatId,
          text: result.text,
        });
      }
    }
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Radar de oportunidade (§9.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agenda o lote do radar. COALESCING por grupo: com um lote já marcado, a
 * mensagem nova não agenda outro. É a diferença entre 1 chamada por 15 min e
 * 1 chamada por mensagem num grupo movimentado.
 */
export const internalScheduleRadar = internalMutation({
  args: { groupChatId: v.id("groupChats") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group || group.ai?.opportunityRadar !== true) return null;
    const org = await ctx.db.get(group.organizationId);
    if (!orgAiActive(org) || org!.settings.aiConfig?.groupAgentEnabled !== true) return null;

    const now = Date.now();
    if (group.radar?.scheduledFor !== undefined && group.radar.scheduledFor > now) return null;
    const at = now + RADAR_BATCH_MS;
    await ctx.db.patch(group._id, {
      radar: { ...(group.radar ?? {}), scheduledFor: at },
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(RADAR_BATCH_MS, internal.groupAgent.internalRadar, {
      groupChatId: args.groupChatId,
    });
    return null;
  },
});

export const internalGetRadarBatch = internalQuery({
  args: { groupChatId: v.id("groupChats"), now: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group || group.ai?.opportunityRadar !== true || !group.conversationId) return null;
    const org = await ctx.db.get(group.organizationId);
    if (!orgAiActive(org) || org!.settings.aiConfig?.groupAgentEnabled !== true) return null;

    const since = group.radar?.lastRunAt ?? args.now - 2 * RADAR_BATCH_MS;
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) =>
        q.eq("conversationId", group.conversationId!).gte("createdAt", since)
      )
      .order("desc")
      .take(RADAR_BATCH_SIZE * 3);
    const candidates = rows
      .filter(
        (m) =>
          m.direction === "inbound" &&
          m.senderType === "contact" &&
          !m.isInternal &&
          m.content.trim().length >= RADAR_MIN_CHARS
      )
      .slice(0, RADAR_BATCH_SIZE)
      .reverse()
      .map((m) => ({
        id: m._id as string,
        de: groupSpeakerLabel(m),
        chave: m.senderLid ?? m.senderPhone ?? null,
        texto: m.content.slice(0, 500),
      }))
      .filter((m) => m.chave !== null);

    const aiMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) =>
        q.eq("organizationId", group.organizationId).eq("type", "ai")
      )
      .collect();
    const attendant = aiMembers.find(
      (m) => m.status === "active" && m.agentProfile?.kind === "attendant"
    );
    if (!attendant) return null;
    const providerConfig = org!.settings.aiConfig?.providerConfig;

    return {
      organizationId: group.organizationId,
      conversationId: group.conversationId,
      orgName: org!.name,
      subject: group.subject,
      language: attendant.agentProfile?.language ?? "pt-BR",
      memberId: attendant._id,
      model: providerConfig?.models.classify ?? DEFAULT_MODELS.classify,
      providerConfig: providerConfig ?? null,
      candidates,
    };
  },
});

export const internalFinishRadar = internalMutation({
  args: {
    groupChatId: v.id("groupChats"),
    // Slot que ESTA run estava servindo. Sem ele, um lote agendado DURANTE a
    // action (a mensagem que chegou enquanto o LLM rodava) era apagado ao
    // terminar — e o agendamento ficava órfão, gerando outro lote e notificação
    // repetida (achado menor do review de correção).
    ranFor: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) return null;
    const now = Date.now();
    const pending = group.radar?.scheduledFor;
    // Só limpa o coalescing quando o slot marcado é o que acabou de rodar (ou
    // quando ele já venceu). Um slot FUTURO foi criado depois e continua valendo.
    const keepPending =
      pending !== undefined &&
      pending > now &&
      (args.ranFor === undefined || pending !== args.ranFor);
    await ctx.db.patch(group._id, {
      radar: { lastRunAt: now, ...(keepPending ? { scheduledFor: pending } : {}) },
      updatedAt: now,
    });
    return null;
  },
});

/** Slot de coalescing atualmente marcado na sala (`radar.scheduledFor`). */
export const internalGetRadarSlot = internalQuery({
  args: { groupChatId: v.id("groupChats") },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    return group?.radar?.scheduledFor ?? null;
  },
});

/** O que `internalGetRadarBatch` devolve quando o radar está ligado. */
type RadarSetup = {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  orgName: string;
  subject: string;
  language: string;
  memberId: Id<"teamMembers">;
  model: string;
  providerConfig: Parameters<typeof resolveOrgRoutes>[2];
  candidates: { id: string; de: string; chave: string; texto: string }[];
};

/** Lote do radar: UMA chamada barata, JSON, sem tools. */
export const internalRadar = internalAction({
  args: { groupChatId: v.id("groupChats") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    // O slot que esta run serve, lido ANTES de qualquer trabalho: é ele que
    // `internalFinishRadar` compara para não apagar um agendamento criado
    // durante a action.
    const ranFor = (await ctx.runQuery(internal.groupAgent.internalGetRadarSlot, {
      groupChatId: args.groupChatId,
    })) as number | null;
    const setup = (await ctx.runQuery(internal.groupAgent.internalGetRadarBatch, {
      groupChatId: args.groupChatId,
      now: Date.now(),
    })) as RadarSetup | null;
    if (!setup || setup.candidates.length === 0) {
      await ctx.runMutation(internal.groupAgent.internalFinishRadar, {
        groupChatId: args.groupChatId,
        ...(ranFor !== null ? { ranFor } : {}),
      });
      return null;
    }

    let runId: Id<"agentRuns"> | null = null;
    try {
      const routes = await resolveOrgRoutes(
        ctx,
        setup.organizationId,
        setup.providerConfig,
        setup.model,
        "groupAgent"
      );
      if (routes.length === 0) throw new Error("Nenhum provider de IA disponível");
      runId = await ctx.runMutation(internal.agentRuns.internalStartRun, {
        organizationId: setup.organizationId,
        memberId: setup.memberId,
        kind: "group_radar",
        conversationId: setup.conversationId,
        model: setup.model,
      });

      const resp = await chatWithFallback(routes, {
        messages: [
          { role: "system", content: buildRadarSystemPrompt(setup.orgName, setup.language) },
          {
            role: "user",
            content: `${wrapUntrustedJson("mensagens a classificar", {
              grupo: setup.subject,
              mensagens: setup.candidates,
            })}\n\nDevolva o JSON agora.`,
          },
        ],
        temperature: 0,
        maxTokens: 300,
      });

      const verdicts = parseRadarVerdicts(resp.message.content);
      const byId = new Map(setup.candidates.map((c) => [c.id, c]));
      for (const verdict of verdicts) {
        if (!verdict.oportunidade) continue;
        const candidate = byId.get(verdict.id);
        if (!candidate) continue;
        await ctx.runMutation(internal.groupAgent.internalFlagOpportunity, {
          organizationId: setup.organizationId,
          groupChatId: args.groupChatId,
          conversationId: setup.conversationId,
          agentMemberId: setup.memberId,
          participantKey: candidate.chave,
          summary: verdict.resumo,
          tipo: verdict.tipo,
        });
      }

      await ctx.runMutation(internal.agentRuns.internalFinishRun, {
        runId,
        status: "done",
        provider: resp.usedRoute.providerId,
        model: setup.model,
        requestCount: 1,
        promptTokens: resp.usage?.promptTokens ?? 0,
        completionTokens: resp.usage?.completionTokens ?? 0,
        costUsdEstimate: estimateCostUsd({
          promptTokens: resp.usage?.promptTokens ?? 0,
          completionTokens: resp.usage?.completionTokens ?? 0,
        }),
      });
    } catch (e) {
      if (runId) {
        await ctx.runMutation(internal.agentRuns.internalFinishRun, {
          runId,
          status: "error",
          error: sanitizeLlmError(e instanceof Error ? e.message : "Falha no radar"),
        });
      }
    }
    // Sempre libera o coalescing: um erro não pode congelar o radar do grupo.
    await ctx.runMutation(internal.groupAgent.internalFinishRadar, {
      groupChatId: args.groupChatId,
      ...(ranFor !== null ? { ranFor } : {}),
    });
    return null;
  },
});
