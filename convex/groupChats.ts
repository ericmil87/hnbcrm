/**
 * Grupos de WhatsApp — cadastro, sincronização e política por grupo (v0.57).
 *
 * Três princípios que explicam quase todas as decisões deste arquivo:
 *
 *  1. **Acompanhar é opt-in POR GRUPO** (D4). O CRM LISTA todos os grupos do
 *     número, mas só ingere mensagem dos marcados. O número do cliente está em
 *     grupo de família e de escola; ingerir tudo seria vazamento, não recurso.
 *  2. **Membro não vira contato nem lead** (D3). Fica em `participants[]`, com
 *     `contactId` apenas quando o telefone JÁ é um contato da org.
 *  3. **Nada de segredo sai daqui.** As queries devolvem o doc de `groupChats`,
 *     nunca o de `channelConfigs` (que carrega o token cifrado do gateway).
 *
 * Ligar grupos num número exige o aceite de risco `bridgeGroupsAck` (D12): a
 * API é não-oficial e grupos aumentam a exposição a banimento. Avisar e exigir
 * aceite auditado, não bloquear — é decisão do operador.
 */
import { v, type ObjectType } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { authorizeGroups, groupsActorHas, type InternalActorArgs } from "./lib/groupAuth";
import { buildAuditDescription } from "./lib/auditDescription";
import { configProvider } from "./channelConfigs";
import { decryptSecret } from "./lib/secretCrypto";
import {
  ParsedGroupInfo,
  buildGroupInfoRequest,
  buildGroupInviteInfoRequest,
  buildGroupJoinRequest,
  buildGroupLeaveRequest,
  buildGroupListRequest,
  buildUserLidRequest,
  findSelfParticipant,
  inviteCodeFromLink,
  jidToPhoneDigits,
  parseGroupAckResponse,
  parseGroupInfoResponse,
  parseGroupListResponse,
  parseUserLidResponse,
} from "./lib/bridgeGroups";
import {
  appendTimeline,
  groupFieldsFromGateway,
  membersWithPermission,
  mergeParticipant,
  mergeParticipantsFromGateway,
  participantsForStorage,
  GROUP_PARTICIPANTS_CAP,
  GROUP_SUBJECT_CAP,
  GROUP_TOPIC_CAP,
} from "./lib/groupChatCore";
import { createNotification } from "./lib/notify";
import { deleteConversationCascade, newBudget } from "./lib/leadCascade";
import { createLeadFromGroupMemberCore } from "./lib/groupMemberLead";

// ─────────────────────────────────────────────────────────────────────────────
// Leitura (app)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Teto da listagem. O WhatsApp permite estar em ~1000 grupos e cada doc pode
 * carregar até 1024 participantes — sem teto, uma query reativa da tela de
 * Canais traria megabytes a cada re-execução.
 */
const GROUP_LIST_CAP = 200;

/**
 * Quantos membros a sala tem.
 *
 * A lista guardada é a fonte preferida (o `/group/list` do wuzapi devolve
 * `ParticipantCount: 0`), mas um grupo NÃO acompanhado não guarda lista nenhuma
 * — só a contagem (review de segurança nº 1). Lista vazia significa "não sei
 * quem", não "zero pessoas".
 */
function countParticipants(
  participants: Doc<"groupChats">["participants"],
  stored: number | undefined
): number {
  if (participants && participants.length > 0) {
    return participants.filter((p) => p.leftAt === undefined).length;
  }
  return stored ?? 0;
}

/**
 * Grupos conhecidos por um canal (ou por toda a org). Gate `inbox:view_own` —
 * ler grupo é ler conversa (D11). Nunca devolve o doc do canal.
 */
export const listGroupsArgs = {
  organizationId: v.id("organizations"),
  channelConfigId: v.optional(v.id("channelConfigs")),
  includeRemoved: v.optional(v.boolean()),
};
export type ListGroupsArgs = ObjectType<typeof listGroupsArgs> & InternalActorArgs;
export async function listGroupsHandler(ctx: QueryCtx, args: ListGroupsArgs) {
    await authorizeGroups(ctx, args.organizationId, "inbox", "view_own", args.actorMemberId);

    let groups: Doc<"groupChats">[];
    if (args.channelConfigId) {
      const config = await ctx.db.get(args.channelConfigId);
      if (!config || config.organizationId !== args.organizationId) return [];
      groups = await ctx.db
        .query("groupChats")
        .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId!))
        .take(GROUP_LIST_CAP);
    } else {
      groups = await ctx.db
        .query("groupChats")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .take(GROUP_LIST_CAP);
    }

    return groups
      .filter((g) => (args.includeRemoved ? true : g.removedAt === undefined))
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))
      .map(({ participants, timeline, ...g }) => ({
        ...g,
        // A lista de participantes NÃO vai na listagem: um grupo pode ter 1024
        // membros, e 200 grupos assim são megabytes numa query reativa que a
        // tela inteira re-executa. Quem precisa dos membros abre `getGroup`.
        // A contagem sai do tamanho da lista quando ela existe (o `/group/list`
        // do wuzapi devolve `ParticipantCount: 0`) e do campo guardado quando
        // não — grupo NÃO acompanhado não guarda a lista, só a contagem
        // (review de segurança nº 1).
        participantsCount: countParticipants(participants, g.participantsCount),
      }));
  }
export const listGroups = query({
  args: listGroupsArgs,
  returns: v.any(),
  handler: listGroupsHandler,
});

/** Um grupo pelo id, com a lista completa de participantes. */
export const getGroupArgs = { groupChatId: v.id("groupChats") };
export type GetGroupArgs = ObjectType<typeof getGroupArgs> & InternalActorArgs;
export async function getGroupHandler(ctx: QueryCtx, args: GetGroupArgs) {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) return null;
    await authorizeGroups(ctx, group.organizationId, "inbox", "view_own", args.actorMemberId);
    // A UI precisa marcar "você" na lista de membros. Antes devolvíamos a CHAVE
    // crua do nosso número (`bridgeLid ?? bridgePhone`) — o mesmo campo que
    // `channelConfigs.getChannelConfigs` mascara, entregue aqui sob o gate mais
    // baixo do produto (review de segurança nº 9). Agora quem compara é o
    // servidor e sai só um booleano por participante.
    // O LID vem antes do telefone pelo mesmo motivo do `findSelfParticipant`:
    // num canal reprovisionado o `bridgePhone` gravado pode estar defasado.
    const config = await ctx.db.get(group.channelConfigId);
    const selfKey = config?.bridgeLid ?? config?.bridgePhone ?? null;
    const selfLidUser = config?.bridgeLid ? config.bridgeLid.split("@")[0] : null;
    const isSelfParticipant = (p: { lid?: string; phone?: string }): boolean => {
      if (config?.bridgeLid && (p.lid === config.bridgeLid || p.lid?.split("@")[0] === selfLidUser)) {
        return true;
      }
      return !!config?.bridgePhone && p.phone === config.bridgePhone;
    };
    return {
      ...group,
      participants: (group.participants ?? []).map((p) => ({ ...p, isSelf: isSelfParticipant(p) })),
      // `selfKey` continua saindo APENAS para quem administra o número, que já
      // enxerga a configuração do canal inteira.
      selfKey: (await groupsActorHas(
        ctx,
        group.organizationId,
        "settings",
        "manage",
        args.actorMemberId
      ))
        ? selfKey
        : null,
      // Nosso número é conhecido? A UI usa isto para avisar que o gatilho por
      // menção não funciona em gateway self-hosted (review de correção nº 22).
      selfKnown: selfKey !== null,
      participantsCount: countParticipants(group.participants, group.participantsCount),
    };
  }
export const getGroup = query({
  args: getGroupArgs,
  returns: v.any(),
  handler: getGroupHandler,
});

// ─────────────────────────────────────────────────────────────────────────────
// Configuração (app)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Passa a acompanhar (ou para de acompanhar) um grupo.
 *
 * Ligar cria a conversa `kind:"group"` na primeira vez — é ela que faz o grupo
 * aparecer no inbox. Desligar ARQUIVA a conversa em vez de apagá-la: o
 * histórico já ingerido não some porque alguém desmarcou um interruptor.
 */
export const setMonitoredArgs = {
  groupChatId: v.id("groupChats"),
  monitored: v.boolean(),
};
export type SetMonitoredArgs = ObjectType<typeof setMonitoredArgs> & InternalActorArgs;
export async function setMonitoredHandler(ctx: MutationCtx, args: SetMonitoredArgs) {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) throw new Error("Grupo não encontrado");
    const member = await authorizeGroups(
      ctx,
      group.organizationId,
      "settings",
      "manage",
      args.actorMemberId
    );

    const config = await ctx.db.get(group.channelConfigId);
    if (args.monitored) {
      if (!config || config.status !== "active") {
        throw new Error("O número deste grupo não está ativo");
      }
      if (config.bridgeGroupsEnabled !== true) {
        throw new Error("Ative os grupos neste número antes de acompanhar uma conversa");
      }
      if (group.leftAt !== undefined || group.removedAt !== undefined) {
        throw new Error("Este número não faz mais parte do grupo");
      }
    }

    const now = Date.now();
    let conversationId = group.conversationId;

    if (args.monitored) {
      const existing = conversationId ? await ctx.db.get(conversationId) : null;
      if (existing) {
        await ctx.db.patch(existing._id, { archivedAt: undefined, updatedAt: now });
      } else {
        conversationId = await ctx.db.insert("conversations", {
          organizationId: group.organizationId,
          kind: "group",
          externalChatId: group.jid,
          groupChatId: group._id,
          channel: "whatsapp",
          channelConfigId: group.channelConfigId,
          status: "active",
          messageCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
    } else if (conversationId) {
      const existing = await ctx.db.get(conversationId);
      if (existing && !existing.archivedAt) {
        await ctx.db.patch(conversationId, { archivedAt: now, updatedAt: now });
      }
    }

    await ctx.db.patch(group._id, {
      monitored: args.monitored,
      ...(conversationId ? { conversationId } : {}),
      ...(args.monitored ? { monitoredSince: now, monitoredBy: member._id } : {}),
      // Parar de acompanhar APAGA a lista de membros (review de segurança nº 1):
      // o telefone e o nome de terceiros só podem ficar no banco enquanto a sala
      // está de fato sendo acompanhada. A contagem permanece — é o que a lista
      // de grupos mostra. Voltar a acompanhar repopula pelo `/group/info`
      // agendado logo abaixo.
      ...(args.monitored ? {} : { participants: [] }),
      timeline: appendTimeline(group.timeline, {
        at: now,
        type: args.monitored ? "monitored_on" : "monitored_off",
        data: member.name,
      }),
      updatedAt: now,
    });

    // Passou a acompanhar: busca a lista de membros agora (a sincronização não
    // a guarda mais para sala não acompanhada). Best-effort — a action devolve
    // `false` em canal self-hosted sem token e o painel segue com a contagem.
    if (args.monitored) {
      await ctx.scheduler.runAfter(0, internal.groupChats.internalRefreshGroup, {
        groupChatId: group._id,
      });
    }

    await ctx.db.insert("auditLogs", {
      organizationId: group.organizationId,
      entityType: "groupChat",
      entityId: group._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      changes: {
        before: { monitored: group.monitored },
        after: { monitored: args.monitored },
      },
      metadata: { name: group.subject, jid: group.jid },
      description: args.monitored
        ? `Passou a acompanhar o grupo '${group.subject}'`
        : `Parou de acompanhar o grupo '${group.subject}'`,
      severity: "medium",
      createdAt: now,
    });

    return group._id;
  }
export const setMonitored = mutation({
  args: setMonitoredArgs,
  returns: v.id("groupChats"),
  handler: setMonitoredHandler,
});

/**
 * Política da IA neste grupo (D6). A F1 só GRAVA — quem lê é o agente de grupo
 * da F4. Gravar antes é de propósito: a tela de canais já configura tudo, e
 * ligar a IA depois não exige reconfigurar grupo a grupo.
 */
export const setAiPolicy = mutation({
  args: {
    groupChatId: v.id("groupChats"),
    mode: v.union(v.literal("off"), v.literal("mention")),
    replyMode: v.union(v.literal("inherit"), v.literal("suggest"), v.literal("autopilot")),
    maxPerHour: v.optional(v.number()),
    maxPerDay: v.optional(v.number()),
    extraInstructions: v.optional(v.string()),
    // F4 — gatilho extra, alerta sem LLM, radar e digest.
    keywords: v.optional(v.array(v.string())),
    alertKeywords: v.optional(v.array(v.string())),
    opportunityRadar: v.optional(v.boolean()),
    dailyDigestAt: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) throw new Error("Grupo não encontrado");
    const member = await requirePermission(ctx, group.organizationId, "settings", "manage");

    if (args.extraInstructions && args.extraInstructions.length > 2000) {
      throw new Error("Instruções muito longas (máx. 2000 caracteres)");
    }

    // Autopilot NA SALA exige aceite próprio (review de segurança nº 5). O
    // `autopilotEarlyAck` do atendente 1 a 1 não vale aqui: foi assinado para a
    // IA responder sozinha a UMA pessoa, não para publicar sem revisão a
    // dezenas de terceiros. Dispensado quando o atendente já está de fato em
    // `autopilot` — aí a org já convive com o risco maior.
    if (args.replyMode === "autopilot") {
      const org = await ctx.db.get(group.organizationId);
      const hasOwnAck = org?.settings.aiConfig?.groupAutopilotAck !== undefined;
      if (!hasOwnAck) {
        const aiMembers = await ctx.db
          .query("teamMembers")
          .withIndex("by_organization_and_type", (q) =>
            q.eq("organizationId", group.organizationId).eq("type", "ai")
          )
          .collect();
        const attendantOnAutopilot = aiMembers.some(
          (m) =>
            m.status === "active" &&
            m.agentProfile?.kind === "attendant" &&
            m.agentProfile.mode === "autopilot"
        );
        if (!attendantOnAutopilot) {
          throw new Error(
            "Para a IA publicar sozinha num grupo, aceite o risco em Configurações → IA (a IA responde sem revisão para todos os participantes da sala)"
          );
        }
      }
    }
    const clamp = (n: number | undefined, max: number) =>
      n === undefined ? undefined : Math.max(0, Math.min(Math.round(n), max));
    // Palavras-chave: no máximo 20, até 40 caracteres, sem vazias. O gatilho
    // roda em TODA mensagem do grupo — uma lista enorme é custo por mensagem.
    const cleanWords = (list: string[] | undefined) =>
      list === undefined
        ? undefined
        : list
            .map((w) => w.trim().slice(0, 40))
            .filter((w) => w.length > 0)
            .slice(0, 20);
    const keywords = cleanWords(args.keywords);
    const alertKeywords = cleanWords(args.alertKeywords);
    // "HH:MM" ou nada — um horário inválido viraria um digest que nunca sai.
    const digestAt = args.dailyDigestAt?.trim();
    if (digestAt && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(digestAt)) {
      throw new Error('Horário do resumo diário inválido — use "HH:MM"');
    }

    const now = Date.now();
    await ctx.db.patch(group._id, {
      ai: {
        // `lastDigestAt` é ESTADO, não configuração: perdê-lo ao salvar a
        // política faria o cron horário repetir o digest do dia.
        ...(group.ai?.lastDigestAt !== undefined
          ? { lastDigestAt: group.ai.lastDigestAt }
          : {}),
        mode: args.mode,
        replyMode: args.replyMode,
        ...(clamp(args.maxPerHour, 500) !== undefined
          ? { maxPerHour: clamp(args.maxPerHour, 500) }
          : {}),
        ...(clamp(args.maxPerDay, 2000) !== undefined
          ? { maxPerDay: clamp(args.maxPerDay, 2000) }
          : {}),
        ...(args.extraInstructions ? { extraInstructions: args.extraInstructions } : {}),
        ...(keywords && keywords.length > 0 ? { keywords } : {}),
        ...(alertKeywords && alertKeywords.length > 0 ? { alertKeywords } : {}),
        ...(args.opportunityRadar !== undefined
          ? { opportunityRadar: args.opportunityRadar }
          : {}),
        ...(digestAt ? { dailyDigestAt: digestAt } : {}),
      },
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: group.organizationId,
      entityType: "groupChat",
      entityId: group._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      changes: {
        before: {
          aiMode: group.ai?.mode ?? "off",
          opportunityRadar: group.ai?.opportunityRadar === true,
        },
        after: {
          aiMode: args.mode,
          replyMode: args.replyMode,
          opportunityRadar: args.opportunityRadar === true,
          dailyDigestAt: digestAt ?? null,
        },
      },
      metadata: { name: group.subject, jid: group.jid },
      description: `Política de IA do grupo '${group.subject}' alterada`,
      severity: "medium",
      createdAt: now,
    });
    return null;
  },
});

/**
 * Aceite de risco para usar grupos neste número (D12). Auditado como `high`:
 * é o registro de que alguém foi avisado de que a API é não-oficial, que
 * grupos aumentam a exposição e que a conta pode ser banida.
 */
export const acceptGroupsAck = mutation({
  args: { channelConfigId: v.id("channelConfigs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config) throw new Error("Canal não encontrado");
    const member = await requirePermission(ctx, config.organizationId, "settings", "manage");
    if (configProvider(config) !== "bridge") {
      throw new Error("Grupos só estão disponíveis no canal bridge");
    }

    const now = Date.now();
    await ctx.db.patch(config._id, {
      bridgeGroupsAck: { acceptedAt: now, acceptedBy: member._id },
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: config.organizationId,
      entityType: "channelConfig",
      entityId: config._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      changes: { before: { bridgeGroupsAck: false }, after: { bridgeGroupsAck: true } },
      metadata: { name: config.displayName, risk: "grupos em API não-oficial" },
      description: `Aceitou o risco de usar grupos de WhatsApp no número '${config.displayName}'`,
      severity: "high",
      createdAt: now,
    });
    return null;
  },
});

/** Liga/desliga grupos neste número. Ligar exige o aceite acima. */
export const setGroupsEnabled = mutation({
  args: { channelConfigId: v.id("channelConfigs"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config) throw new Error("Canal não encontrado");
    const member = await requirePermission(ctx, config.organizationId, "settings", "manage");
    if (configProvider(config) !== "bridge") {
      throw new Error("Grupos só estão disponíveis no canal bridge");
    }
    if (args.enabled && !config.bridgeGroupsAck) {
      throw new Error("Aceite o aviso de risco antes de ligar os grupos neste número");
    }

    const now = Date.now();
    await ctx.db.patch(config._id, { bridgeGroupsEnabled: args.enabled, updatedAt: now });

    // Desligar no número não apaga nada: só para de ingerir. Os grupos ficam
    // desmarcados para que religar não volte a ingerir sem alguém decidir.
    if (!args.enabled) {
      const groups = await ctx.db
        .query("groupChats")
        .withIndex("by_channel_config", (q) => q.eq("channelConfigId", config._id))
        .collect();
      for (const group of groups) {
        if (!group.monitored) continue;
        await ctx.db.patch(group._id, { monitored: false, updatedAt: now });
        if (group.conversationId) {
          const conversation = await ctx.db.get(group.conversationId);
          if (conversation && !conversation.archivedAt) {
            await ctx.db.patch(group.conversationId, { archivedAt: now, updatedAt: now });
          }
        }
      }
    }

    await ctx.db.insert("auditLogs", {
      organizationId: config.organizationId,
      entityType: "channelConfig",
      entityId: config._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      changes: {
        before: { bridgeGroupsEnabled: config.bridgeGroupsEnabled === true },
        after: { bridgeGroupsEnabled: args.enabled },
      },
      metadata: { name: config.displayName },
      description: args.enabled
        ? `Ligou grupos de WhatsApp no número '${config.displayName}'`
        : `Desligou grupos de WhatsApp no número '${config.displayName}'`,
      severity: "high",
      createdAt: now,
    });
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internals de leitura/escrita usados pelas actions e pelo ingest
// ─────────────────────────────────────────────────────────────────────────────

/** Grupo por canal + JID — a consulta do ingest (idempotente e barata). */
export const internalGetGroupByJid = internalQuery({
  args: { channelConfigId: v.id("channelConfigs"), jid: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("groupChats")
      .withIndex("by_channel_config_and_jid", (q) =>
        q.eq("channelConfigId", args.channelConfigId).eq("jid", args.jid)
      )
      .first();
  },
});

/** Tudo o que uma action de grupo precisa, numa consulta só (inclui credenciais). */
export const internalGetChannelGroupContext = internalQuery({
  args: { channelConfigId: v.id("channelConfigs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config) return null;
    return {
      organizationId: config.organizationId,
      provider: configProvider(config),
      status: config.status,
      displayName: config.displayName,
      baseUrl: config.bridgeBaseUrl ?? null,
      tokenEncrypted: config.bridgeTokenEncrypted ?? null,
      groupsEnabled: config.bridgeGroupsEnabled === true,
      hasAck: config.bridgeGroupsAck !== undefined,
      bridgeLid: config.bridgeLid ?? null,
      bridgePhone: config.bridgePhone ?? null,
    };
  },
});

/** Contexto de um grupo específico (org + credenciais do canal dele). */
export const internalGetGroupActionContext = internalQuery({
  args: { groupChatId: v.id("groupChats") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) return null;
    const config = await ctx.db.get(group.channelConfigId);
    if (!config) return null;
    return {
      organizationId: group.organizationId,
      jid: group.jid,
      subject: group.subject,
      channelConfigId: group.channelConfigId,
      provider: configProvider(config),
      status: config.status,
      baseUrl: config.bridgeBaseUrl ?? null,
      tokenEncrypted: config.bridgeTokenEncrypted ?? null,
    };
  },
});

/** Grava o NOSSO LID no canal (resolvido por `/user/lid/{telefone}`). */
export const internalSetBridgeLid = internalMutation({
  args: { channelConfigId: v.id("channelConfigs"), bridgeLid: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config) return null;
    await ctx.db.patch(args.channelConfigId, {
      bridgeLid: args.bridgeLid,
      updatedAt: Date.now(),
    });
    return null;
  },
});

const gatewayGroupValidator = v.object({
  jid: v.string(),
  subject: v.string(),
  topic: v.optional(v.string()),
  ownerJid: v.optional(v.string()),
  createdAtWa: v.optional(v.number()),
  isAnnounce: v.boolean(),
  isLocked: v.boolean(),
  isEphemeral: v.boolean(),
  disappearingTimer: v.optional(v.number()),
  isCommunityParent: v.boolean(),
  linkedParentJid: v.optional(v.string()),
  addressingMode: v.optional(v.union(v.literal("lid"), v.literal("pn"))),
  participants: v.array(
    v.object({
      lid: v.optional(v.string()),
      phone: v.optional(v.string()),
      name: v.optional(v.string()),
      isAdmin: v.boolean(),
      isSuperAdmin: v.boolean(),
    })
  ),
  participantsCount: v.number(),
});

/**
 * Aplica o resultado de `/group/list`: upsert dos que vieram e `removedAt` nos
 * que sumiram. NUNCA toca em `monitored`, `conversationId` ou `ai` — essas são
 * decisões do operador, e uma sincronização não pode desfazê-las.
 */
export const internalUpsertGroupsFromSync = internalMutation({
  args: {
    channelConfigId: v.id("channelConfigs"),
    groups: v.array(gatewayGroupValidator),
    // `full: false` (upsert pontual, ex. após entrar por link) não marca
    // ausentes como removidos — a lista recebida não é a verdade completa.
    full: v.boolean(),
  },
  returns: v.object({ upserted: v.number(), removed: v.number() }),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config) throw new Error("Canal não encontrado");
    const ourLid = config.bridgeLid ?? undefined;
    const ourPhone = config.bridgePhone ?? undefined;
    const now = Date.now();

    const existing = await ctx.db
      .query("groupChats")
      .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
      .collect();
    const byJid = new Map(existing.map((g) => [g.jid, g]));

    let upserted = 0;
    for (const raw of args.groups) {
      const group = raw as ParsedGroupInfo;
      const fields = groupFieldsFromGateway(group, ourLid, ourPhone, now);
      const prev = byJid.get(group.jid);
      if (prev) {
        const merged = mergeParticipantsFromGateway(prev.participants, group.participants, now);
        // Sala NÃO acompanhada guarda só a contagem — nome e telefone de
        // terceiros ficam fora do banco (review de segurança nº 1).
        const stored = participantsForStorage(prev.monitored, merged);
        await ctx.db.patch(prev._id, {
          ...fields,
          participants: stored.participants,
          participantsCount: stored.participantsCount,
          ...(prev.subject !== group.subject
            ? {
                timeline: appendTimeline(prev.timeline, {
                  at: now,
                  type: "renamed",
                  data: group.subject,
                }),
              }
            : {}),
          // Voltou a aparecer na listagem: não estamos mais fora dele.
          leftAt: undefined,
        });
      } else {
        const merged = mergeParticipantsFromGateway(undefined, group.participants, now);
        await ctx.db.insert("groupChats", {
          organizationId: config.organizationId,
          channelConfigId: args.channelConfigId,
          jid: group.jid,
          subject: group.subject,
          ...fields,
          // Grupo novo nasce NÃO acompanhado, logo sem lista de membros. Ela é
          // populada por `internalRefreshGroup` quando alguém marca
          // "Acompanhar".
          participants: [],
          participantsCount: merged.length,
          // D4: grupo novo NASCE sem acompanhamento.
          monitored: false,
          timeline: [{ at: now, type: "discovered" }],
          createdAt: now,
          updatedAt: now,
        } as Doc<"groupChats">);
      }
      upserted++;
    }

    let removed = 0;
    if (args.full) {
      const seen = new Set(args.groups.map((g) => g.jid));
      for (const prev of existing) {
        if (seen.has(prev.jid) || prev.removedAt !== undefined) continue;
        await ctx.db.patch(prev._id, {
          removedAt: now,
          monitored: false,
          timeline: appendTimeline(prev.timeline, { at: now, type: "removed" }),
          updatedAt: now,
        });
        if (prev.conversationId) {
          const conversation = await ctx.db.get(prev.conversationId);
          if (conversation && !conversation.archivedAt) {
            await ctx.db.patch(prev.conversationId, { archivedAt: now, updatedAt: now });
          }
        }
        removed++;
      }
    }

    await ctx.db.patch(args.channelConfigId, {
      bridgeGroupsLastSyncAt: now,
      updatedAt: now,
    });
    return { upserted, removed };
  },
});

/**
 * Evento `GroupInfo` do whatsmeow: nome/tópico/config mudaram, ou alguém
 * entrou/saiu/foi promovido. Grupo desconhecido é no-op (não cadastramos por
 * evento de mudança — quem cadastra é a sincronização ou o `JoinedGroup`).
 *
 * Se NÓS saímos (nosso LID/telefone em `leave`), o grupo é desmarcado e a
 * conversa arquivada: continuar "acompanhando" uma sala de onde saímos só
 * produziria uma conversa muda para sempre.
 */
export const internalApplyGroupInfoEvent = internalMutation({
  args: {
    channelConfigId: v.id("channelConfigs"),
    jid: v.string(),
    actorJid: v.optional(v.string()),
    at: v.number(),
    name: v.optional(v.string()),
    topic: v.optional(v.string()),
    isLocked: v.optional(v.boolean()),
    isAnnounce: v.optional(v.boolean()),
    join: v.array(v.string()),
    leave: v.array(v.string()),
    promote: v.array(v.string()),
    demote: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await ctx.db
      .query("groupChats")
      .withIndex("by_channel_config_and_jid", (q) =>
        q.eq("channelConfigId", args.channelConfigId).eq("jid", args.jid)
      )
      .first();
    if (!group) return null;

    const config = await ctx.db.get(args.channelConfigId);
    const ourLid = config?.bridgeLid ?? undefined;
    const ourPhone = config?.bridgePhone ?? undefined;
    const isUs = (jid: string) => {
      if (ourLid && jid === ourLid) return true;
      const user = jid.split("@")[0].split(":")[0].split(".")[0];
      if (ourLid && user === ourLid.split("@")[0]) return true;
      return !!ourPhone && user.replace(/\D/g, "") === ourPhone;
    };
    const asParticipant = (jid: string) => {
      const lid = jid.endsWith("@lid") ? jid : undefined;
      const phone = jidToPhoneDigits(jid);
      return { ...(lid ? { lid } : {}), ...(phone ? { phone } : {}) };
    };

    let participants = group.participants;
    let timeline = group.timeline;

    // Defesa em profundidade: o parser já corta em `GROUP_EVENT_JID_CAP`, mas
    // esta mutation é `internal` e pode ser chamada de outro caminho amanhã.
    // Cada item custa um merge LINEAR + uma linha de timeline dentro de UMA
    // transação (review de segurança nº 7).
    const cap = <T,>(list: T[]): T[] => list.slice(0, GROUP_PARTICIPANTS_CAP);

    for (const jid of cap(args.join)) {
      participants = mergeParticipant(participants, {
        ...asParticipant(jid),
        joinedAt: args.at,
        leftAt: undefined,
      });
      timeline = appendTimeline(timeline, { at: args.at, type: "join", actorJid: jid });
    }
    for (const jid of cap(args.leave)) {
      participants = mergeParticipant(participants, { ...asParticipant(jid), leftAt: args.at });
      timeline = appendTimeline(timeline, { at: args.at, type: "leave", actorJid: jid });
    }
    for (const jid of cap(args.promote)) {
      participants = mergeParticipant(participants, { ...asParticipant(jid), isAdmin: true });
      timeline = appendTimeline(timeline, { at: args.at, type: "promote", actorJid: jid });
    }
    for (const jid of cap(args.demote)) {
      participants = mergeParticipant(participants, {
        ...asParticipant(jid),
        isAdmin: false,
        isSuperAdmin: false,
      });
      timeline = appendTimeline(timeline, { at: args.at, type: "demote", actorJid: jid });
    }
    if (args.name !== undefined && args.name !== group.subject) {
      timeline = appendTimeline(timeline, {
        at: args.at,
        type: "renamed",
        ...(args.actorJid ? { actorJid: args.actorJid } : {}),
        data: args.name.slice(0, 200),
      });
    }
    if (args.topic !== undefined && args.topic !== (group.topic ?? "")) {
      timeline = appendTimeline(timeline, {
        at: args.at,
        type: "topic",
        ...(args.actorJid ? { actorJid: args.actorJid } : {}),
        data: args.topic.slice(0, 200),
      });
    }

    const weLeft = args.leave.some(isUs);
    const meNow = findSelfParticipant(participants ?? [], ourLid, ourPhone);
    // Sala não acompanhada: a contagem é atualizada, a lista não é guardada.
    const stored = participants
      ? participantsForStorage(weLeft ? false : group.monitored, participants)
      : null;

    await ctx.db.patch(group._id, {
      // Nome e tópico são escolhidos por um ADMIN DO GRUPO, que é um terceiro,
      // e viajam daqui para o prompt, a notificação, o card e o webhook. O teto
      // é o mesmo já usado na linha do tempo (review de segurança nº 8).
      ...(args.name !== undefined ? { subject: args.name.slice(0, GROUP_SUBJECT_CAP) } : {}),
      ...(args.topic !== undefined ? { topic: args.topic.slice(0, GROUP_TOPIC_CAP) } : {}),
      ...(args.isLocked !== undefined ? { isLocked: args.isLocked } : {}),
      ...(args.isAnnounce !== undefined ? { isAnnounce: args.isAnnounce } : {}),
      ...(stored
        ? {
            participants: stored.participants,
            participantsCount: stored.participantsCount,
          }
        : {}),
      ...(meNow
        ? {
            weAreAdmin: meNow.isAdmin === true || meNow.isSuperAdmin === true,
            weAreSuperAdmin: meNow.isSuperAdmin === true,
          }
        : {}),
      ...(weLeft ? { leftAt: args.at, monitored: false } : {}),
      timeline,
      updatedAt: args.at,
    });

    if (weLeft && group.conversationId) {
      const conversation = await ctx.db.get(group.conversationId);
      if (conversation && !conversation.archivedAt) {
        await ctx.db.patch(group.conversationId, { archivedAt: args.at, updatedAt: args.at });
      }
    }

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: group.organizationId,
      event: weLeft ? "group.left" : "group.updated",
      payload: {
        groupChatId: group._id,
        jid: group.jid,
        subject: (args.name ?? group.subject).slice(0, GROUP_SUBJECT_CAP),
        channelConfigId: args.channelConfigId,
        join: args.join,
        leave: args.leave,
        promote: args.promote,
        demote: args.demote,
      },
    });
    return null;
  },
});

/**
 * Evento `JoinedGroup`: entramos num grupo (ou fomos adicionados). CADASTRA a
 * sala com `monitored: false` (D4) e avisa quem administra o canal — a decisão
 * de acompanhar é de uma pessoa, não do evento.
 */
export const internalApplyJoinedGroup = internalMutation({
  args: {
    channelConfigId: v.id("channelConfigs"),
    group: gatewayGroupValidator,
    reason: v.optional(v.string()),
    at: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config) return null;
    // Grupos desligados no número: nem cadastrar. Ligar depois faz a
    // sincronização trazer tudo de uma vez.
    if (config.bridgeGroupsEnabled !== true) return null;

    const parsed = args.group as ParsedGroupInfo;
    const fields = groupFieldsFromGateway(
      parsed,
      config.bridgeLid ?? undefined,
      config.bridgePhone ?? undefined,
      args.at
    );
    const existing = await ctx.db
      .query("groupChats")
      .withIndex("by_channel_config_and_jid", (q) =>
        q.eq("channelConfigId", args.channelConfigId).eq("jid", parsed.jid)
      )
      .first();

    let groupChatId: Id<"groupChats">;
    if (existing) {
      const participants = mergeParticipantsFromGateway(
        existing.participants,
        parsed.participants,
        args.at
      );
      groupChatId = existing._id;
      await ctx.db.patch(existing._id, {
        ...fields,
        participants,
        participantsCount: participants.filter((p) => p.leftAt === undefined).length,
        leftAt: undefined,
        timeline: appendTimeline(existing.timeline, {
          at: args.at,
          type: "joined",
          ...(args.reason ? { data: args.reason } : {}),
        }),
      });
    } else {
      const participants = mergeParticipantsFromGateway(undefined, parsed.participants, args.at);
      groupChatId = await ctx.db.insert("groupChats", {
        organizationId: config.organizationId,
        channelConfigId: args.channelConfigId,
        jid: parsed.jid,
        subject: parsed.subject,
        ...fields,
        participants,
        participantsCount: participants.length,
        monitored: false,
        timeline: [
          { at: args.at, type: "joined", ...(args.reason ? { data: args.reason } : {}) },
        ],
        createdAt: args.at,
        updatedAt: args.at,
      } as Doc<"groupChats">);
    }

    await ctx.db.insert("auditLogs", {
      organizationId: config.organizationId,
      entityType: "groupChat",
      entityId: groupChatId,
      action: "create",
      actorType: "system",
      metadata: { name: parsed.subject, jid: parsed.jid, reason: args.reason },
      description: `O número '${config.displayName}' entrou no grupo '${parsed.subject}'`,
      severity: "medium",
      createdAt: args.at,
    });

    // Notifica quem pode decidir acompanhar (mesma permissão de `setMonitored`).
    const members = await membersWithPermission(
      ctx,
      config.organizationId,
      "settings",
      "manage"
    );
    for (const m of members) {
      await createNotification(ctx, {
        organizationId: config.organizationId,
        memberId: m._id,
        type: "group_joined",
        title: `Entrou no grupo "${parsed.subject}"`,
        body: "Marque «Acompanhar» para as mensagens deste grupo aparecerem no inbox.",
      });
    }

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: config.organizationId,
      event: "group.joined",
      payload: {
        groupChatId,
        jid: parsed.jid,
        subject: parsed.subject,
        channelConfigId: args.channelConfigId,
        participantsCount: parsed.participantsCount,
        reason: args.reason,
      },
    });
    return null;
  },
});

/** Carimba que saímos do grupo (usado pela ação "Sair do grupo"). */
export const internalMarkGroupLeft = internalMutation({
  args: { groupChatId: v.id("groupChats"), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) return null;
    await ctx.db.patch(group._id, {
      leftAt: args.at,
      monitored: false,
      timeline: appendTimeline(group.timeline, { at: args.at, type: "left" }),
      updatedAt: args.at,
    });
    if (group.conversationId) {
      const conversation = await ctx.db.get(group.conversationId);
      if (conversation && !conversation.archivedAt) {
        await ctx.db.patch(group.conversationId, { archivedAt: args.at, updatedAt: args.at });
      }
    }
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: group.organizationId,
      event: "group.left",
      payload: { groupChatId: group._id, jid: group.jid, subject: group.subject },
    });
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Actions que falam com o gateway
// ─────────────────────────────────────────────────────────────────────────────

type GroupContext = {
  organizationId: Id<"organizations">;
  provider: "meta" | "bridge";
  status: string;
  baseUrl: string | null;
  tokenEncrypted: string | null;
  groupsEnabled: boolean;
  hasAck: boolean;
  bridgeLid: string | null;
  bridgePhone: string | null;
};

function assertBridgeGroupsUsable(context: GroupContext | null): asserts context is GroupContext {
  if (!context) throw new Error("Canal não encontrado");
  if (context.provider !== "bridge") {
    throw new Error("Grupos só estão disponíveis no canal bridge");
  }
  if (!context.groupsEnabled) {
    throw new Error("Ative os grupos neste número em Configurações → Canais");
  }
  if (!context.baseUrl || !context.tokenEncrypted) {
    throw new Error("Configuração bridge incompleta — gateway ou token ausente");
  }
}

/**
 * Sincroniza a lista de grupos do número com o gateway (`GET /group/list`).
 *
 * Também resolve o NOSSO LID quando ainda não é conhecido: `/session/status`
 * devolve `jid: ""` mesmo logado, e sem o LID não dá para saber se somos admin
 * nem detectar menção a nós. Em gateway self-hosted o telefone pode não estar
 * gravado — aí o LID fica vazio e `weAreAdmin` simplesmente não é calculado.
 */
export const syncGroupsArgs = { channelConfigId: v.id("channelConfigs") };
export type SyncGroupsArgs = ObjectType<typeof syncGroupsArgs> & InternalActorArgs;
export async function syncGroupsHandler(
    ctx: ActionCtx,
    args: SyncGroupsArgs
  ): Promise<{ upserted: number; removed: number; detail: string }> {
    const context: GroupContext | null = await ctx.runQuery(
      internal.groupChats.internalGetChannelGroupContext,
      { channelConfigId: args.channelConfigId }
    );
    if (!context) throw new Error("Canal não encontrado");
    // Permissão ANTES de qualquer chamada ao gateway. Pela REST não há sessão,
    // então o ator chega explícito e é revalidado dentro da query.
    await ctx.runQuery(internal.groupChats.internalAuthorizeGroupAccess, {
      organizationId: context.organizationId,
      category: "settings",
      level: "manage",
      ...(args.actorMemberId ? { actorMemberId: args.actorMemberId } : {}),
    });
    assertBridgeGroupsUsable(context);

    const token = await decryptSecret(context.tokenEncrypted!);

    // 1) NOSSO LID (uma vez por número; barato e best-effort).
    if (!context.bridgeLid && context.bridgePhone) {
      const req = buildUserLidRequest({
        baseUrl: context.baseUrl!,
        token,
        phone: context.bridgePhone,
      });
      const res = await fetch(req.url, { method: "GET", headers: req.headers }).catch(() => null);
      if (res) {
        const body = await res.json().catch(() => ({}));
        const parsed = parseUserLidResponse(res.ok, res.status, body);
        if (parsed.ok) {
          await ctx.runMutation(internal.groupChats.internalSetBridgeLid, {
            channelConfigId: args.channelConfigId,
            bridgeLid: parsed.lid,
          });
        }
      }
    }

    // 2) A lista.
    const listReq = buildGroupListRequest({ baseUrl: context.baseUrl!, token });
    const listRes = await fetch(listReq.url, {
      method: "GET",
      headers: listReq.headers,
    }).catch(() => null);
    if (!listRes) throw new Error("Gateway inacessível");
    const listBody = await listRes.json().catch(() => ({}));
    const parsed = parseGroupListResponse(listRes.ok, listRes.status, listBody);
    if (!parsed.ok) throw new Error(parsed.error);

    const result: { upserted: number; removed: number } = await ctx.runMutation(
      internal.groupChats.internalUpsertGroupsFromSync,
      { channelConfigId: args.channelConfigId, groups: parsed.groups, full: true }
    );
    return {
      ...result,
      detail:
        parsed.groups.length === 0
          ? "Este número não está em nenhum grupo"
          : `${result.upserted} grupo(s) sincronizado(s)${result.removed > 0 ? `, ${result.removed} fora da lista` : ""}`,
    };
  }
export const syncGroups = action({
  args: syncGroupsArgs,
  returns: v.object({
    upserted: v.number(),
    removed: v.number(),
    detail: v.string(),
  }),
  handler: syncGroupsHandler,
});

/**
 * Gate de RBAC avaliado dentro de uma query — é o que permite às ACTIONS
 * (`syncGroups`) e às rotas REST checarem permissão sem uma sessão.
 * Sem `actorMemberId` cai no caminho de sessão (`requirePermission`).
 */
export const internalAuthorizeGroupAccess = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    category: v.union(v.literal("inbox"), v.literal("settings"), v.literal("campaigns")),
    level: v.string(),
    actorMemberId: v.optional(v.id("teamMembers")),
  },
  returns: v.id("teamMembers"),
  handler: async (ctx, args) => {
    const member = await authorizeGroups(
      ctx,
      args.organizationId,
      args.category,
      args.level,
      args.actorMemberId
    );
    return member._id;
  },
});

/**
 * Sai de um grupo. Auditado como `high`: é irreversível pelo CRM (voltar exige
 * um convite novo) e alcança gente de fora da empresa.
 */
export const leaveGroup = action({
  args: { groupChatId: v.id("groupChats") },
  returns: v.object({ ok: v.boolean(), detail: v.string() }),
  handler: async (ctx, args): Promise<{ ok: boolean; detail: string }> => {
    const context = await ctx.runQuery(internal.groupChats.internalGetGroupActionContext, {
      groupChatId: args.groupChatId,
    });
    if (!context) throw new Error("Grupo não encontrado");
    await ctx.runQuery(internal.channelConfigs.internalRequireSettingsManage, {
      organizationId: context.organizationId,
    });
    if (context.provider !== "bridge") {
      throw new Error("Grupos só estão disponíveis no canal bridge");
    }
    if (!context.baseUrl || !context.tokenEncrypted) {
      throw new Error("Configuração bridge incompleta — gateway ou token ausente");
    }

    const token = await decryptSecret(context.tokenEncrypted);
    const req = buildGroupLeaveRequest({
      baseUrl: context.baseUrl,
      token,
      groupJid: context.jid,
    });
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
    }).catch(() => null);
    if (!res) throw new Error("Gateway inacessível");
    const body = await res.json().catch(() => ({}));
    const parsed = parseGroupAckResponse(res.ok, res.status, body);
    if (!parsed.ok) throw new Error(parsed.error);

    await ctx.runMutation(internal.groupChats.internalMarkGroupLeft, {
      groupChatId: args.groupChatId,
      at: Date.now(),
    });
    await ctx.runMutation(internal.groupChats.internalAuditGroupAction, {
      groupChatId: args.groupChatId,
      action: "leave",
      description: `Saiu do grupo '${context.subject}'`,
    });
    return { ok: true, detail: `Saiu do grupo '${context.subject}'` };
  },
});

/** Audit `high` das ações de grupo que falam com o gateway (sair/entrar). */
export const internalAuditGroupAction = internalMutation({
  args: {
    groupChatId: v.id("groupChats"),
    action: v.union(v.literal("leave"), v.literal("join")),
    description: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) return null;
    const member = await requirePermission(ctx, group.organizationId, "settings", "manage");
    await ctx.db.insert("auditLogs", {
      organizationId: group.organizationId,
      entityType: "groupChat",
      entityId: group._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      metadata: { name: group.subject, jid: group.jid, groupAction: args.action },
      description: args.description,
      severity: "high",
      createdAt: Date.now(),
    });
    return null;
  },
});

/**
 * Entra num grupo por link de convite. Duas etapas de propósito: `inviteinfo`
 * mostra em que sala estamos prestes a entrar ANTES de entrar (a UI confirma),
 * e só então `join`. Auditado como `high`.
 */
export const joinByInviteLink = action({
  args: {
    channelConfigId: v.id("channelConfigs"),
    link: v.string(),
    // false = só pré-visualizar o grupo do convite (não entra).
    confirm: v.optional(v.boolean()),
  },
  returns: v.object({
    joined: v.boolean(),
    jid: v.string(),
    subject: v.string(),
    participantsCount: v.number(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ joined: boolean; jid: string; subject: string; participantsCount: number }> => {
    const context: GroupContext | null = await ctx.runQuery(
      internal.groupChats.internalGetChannelGroupContext,
      { channelConfigId: args.channelConfigId }
    );
    if (!context) throw new Error("Canal não encontrado");
    await ctx.runQuery(internal.channelConfigs.internalRequireSettingsManage, {
      organizationId: context.organizationId,
    });
    assertBridgeGroupsUsable(context);

    const code = inviteCodeFromLink(args.link);
    if (!code) throw new Error("Link de convite inválido");

    const token = await decryptSecret(context.tokenEncrypted!);

    const infoReq = buildGroupInviteInfoRequest({ baseUrl: context.baseUrl!, token, code });
    const infoRes = await fetch(infoReq.url, {
      method: "POST",
      headers: infoReq.headers,
      body: infoReq.body,
    }).catch(() => null);
    if (!infoRes) throw new Error("Gateway inacessível");
    const infoBody = await infoRes.json().catch(() => ({}));
    const info = parseGroupInfoResponse(infoRes.ok, infoRes.status, infoBody);
    if (!info.ok) throw new Error(info.error);

    if (args.confirm !== true) {
      return {
        joined: false,
        jid: info.group.jid,
        subject: info.group.subject,
        participantsCount: info.group.participantsCount,
      };
    }

    const joinReq = buildGroupJoinRequest({ baseUrl: context.baseUrl!, token, code });
    const joinRes = await fetch(joinReq.url, {
      method: "POST",
      headers: joinReq.headers,
      body: joinReq.body,
    }).catch(() => null);
    if (!joinRes) throw new Error("Gateway inacessível");
    const joinBody = await joinRes.json().catch(() => ({}));
    const ack = parseGroupAckResponse(joinRes.ok, joinRes.status, joinBody);
    if (!ack.ok) throw new Error(ack.error);

    // Cadastra já (o evento `JoinedGroup` pode chegar depois, e é idempotente).
    await ctx.runMutation(internal.groupChats.internalUpsertGroupsFromSync, {
      channelConfigId: args.channelConfigId,
      groups: [info.group],
      full: false,
    });
    const created = await ctx.runQuery(internal.groupChats.internalGetGroupByJid, {
      channelConfigId: args.channelConfigId,
      jid: info.group.jid,
    });
    if (created) {
      await ctx.runMutation(internal.groupChats.internalAuditGroupAction, {
        groupChatId: created._id,
        action: "join",
        description: `Entrou no grupo '${info.group.subject}' por link de convite`,
      });
    }

    return {
      joined: true,
      jid: info.group.jid,
      subject: info.group.subject,
      participantsCount: info.group.participantsCount,
    };
  },
});

/**
 * Atualiza UM grupo a partir do gateway (`GET /group/info`). Útil quando um
 * `GroupInfo` chega e queremos a lista de participantes inteira de volta.
 */
export const internalRefreshGroup = internalAction({
  args: { groupChatId: v.id("groupChats") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const context = await ctx.runQuery(internal.groupChats.internalGetGroupActionContext, {
      groupChatId: args.groupChatId,
    });
    if (!context || context.provider !== "bridge") return false;
    if (!context.baseUrl || !context.tokenEncrypted) return false;
    const token = await decryptSecret(context.tokenEncrypted);
    const req = buildGroupInfoRequest({
      baseUrl: context.baseUrl,
      token,
      groupJid: context.jid,
    });
    const res = await fetch(req.url, { method: "GET", headers: req.headers }).catch(() => null);
    if (!res) return false;
    const body = await res.json().catch(() => ({}));
    const parsed = parseGroupInfoResponse(res.ok, res.status, body);
    if (!parsed.ok) return false;
    await ctx.runMutation(internal.groupChats.internalUpsertGroupsFromSync, {
      channelConfigId: context.channelConfigId,
      groups: [parsed.group],
      full: false,
    });
    return true;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Cascata de exclusão do canal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apaga os grupos de um canal excluído — e, com eles, as conversas de grupo,
 * as mensagens e os blobs de mídia. Batched e auto-reagendado, como a cascata
 * de lead: um job sequencial, nunca N jobs.
 *
 * Só grupo: as conversas 1:1 do canal pertencem a LEADS e sobrevivem à
 * exclusão do número (o histórico do cliente não é do canal).
 */
export const internalCascadeDeleteChannelGroups = internalMutation({
  args: { channelConfigId: v.id("channelConfigs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const budget = newBudget();

    while (budget.left > 0) {
      const group = await ctx.db
        .query("groupChats")
        .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
        .first();
      if (!group) return null;

      if (group.conversationId) {
        const conversation = await ctx.db.get(group.conversationId);
        if (conversation) {
          if (!(await deleteConversationCascade(ctx, conversation._id, budget))) break;
        }
      }
      await ctx.db.delete(group._id);
      budget.left -= 1;
    }

    // Orçamento esgotado com grupo ainda em pé: continua na próxima execução.
    const remaining = await ctx.db
      .query("groupChats")
      .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
      .first();
    if (remaining) {
      await ctx.scheduler.runAfter(
        0,
        internal.groupChats.internalCascadeDeleteChannelGroups,
        { channelConfigId: args.channelConfigId }
      );
    }
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 (UI): estado dos grupos por número, membro → lead, grupos de um contato
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estado do interruptor de grupos de cada número bridge da org.
 *
 * Existe porque `channelConfigs.getChannelConfigs` mascara o documento e não
 * carrega os três campos de grupo — e o painel de Canais precisa deles ao lado
 * do card do número. Devolve só booleanos e carimbos: nada do token, nada da
 * URL do gateway.
 *
 * O gate continua em `inbox:view_own` DE PROPÓSITO (review de segurança nº 10
 * pedia `settings:manage`): além de Configurações → Canais, hoje consomem esta
 * query o filtro de canal de `/app/grupos` e o wizard de publicações, telas que
 * um `agent` legitimamente abre. O que mudou é o RECORTE — `bridgeSessionState`
 * e `groupsAckAt` são estado de infraestrutura e só saem para quem tem
 * `settings:manage`; quem não tem recebe o que precisa para escolher um número
 * (nome, se os grupos estão ligados, última sincronização).
 */
export const listChannelGroupSettings = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(
    v.object({
      channelConfigId: v.id("channelConfigs"),
      displayName: v.string(),
      status: v.union(v.literal("active"), v.literal("disabled"), v.literal("error")),
      bridgeSessionState: v.union(v.string(), v.null()),
      groupsEnabled: v.boolean(),
      groupsAckAt: v.union(v.number(), v.null()),
      lastSyncAt: v.union(v.number(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "inbox", "view_own");
    const manages = await groupsActorHas(ctx, args.organizationId, "settings", "manage");
    const configs = await ctx.db
      .query("channelConfigs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    return configs
      .filter((c) => configProvider(c) === "bridge")
      .map((c) => ({
        channelConfigId: c._id,
        displayName: c.displayName,
        status: c.status,
        bridgeSessionState: manages ? c.bridgeSessionState ?? null : null,
        groupsEnabled: c.bridgeGroupsEnabled === true,
        groupsAckAt: manages ? c.bridgeGroupsAck?.acceptedAt ?? null : null,
        lastSyncAt: c.bridgeGroupsLastSyncAt ?? null,
      }));
  },
});

/**
 * Promove um MEMBRO do grupo a contato + lead (D3, ação humana explícita).
 *
 * D3 diz que membro não vira contato sozinho — 300 membros seriam 300 contatos
 * fantasma e um problema de LGPD. Esta mutation é o "sozinho" virando
 * "alguém clicou": mesmo find-or-create do ingest 1:1 (`lib/inboundRouting`),
 * então um membro que já é contato não duplica nada e um lead existente é
 * reaproveitado.
 *
 * A conversa 1:1 nasce vazia de propósito: é o lugar onde a equipe vai puxar a
 * pessoa para o privado. O grupo continua sendo o grupo.
 */
export const createLeadFromMember = mutation({
  args: {
    groupChatId: v.id("groupChats"),
    // `lid ?? phone` do participante, como `getGroup` devolve.
    participantKey: v.string(),
  },
  returns: v.object({
    contactId: v.id("contacts"),
    leadId: v.id("leads"),
    conversationId: v.id("conversations"),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) throw new Error("Grupo não encontrado");
    // Criar lead a partir de um membro cria contato E lead — as duas permissões.
    const member = await requirePermission(ctx, group.organizationId, "leads", "edit_own");
    await requirePermission(ctx, group.organizationId, "contacts", "edit");

    // O NÚCLEO é compartilhado com a tool do copiloto (`lib/groupMemberLead.ts`):
    // gates diferentes, mesma escrita — senão um dia uma das superfícies cria a
    // conversa 1:1 e a outra não.
    const result = await createLeadFromGroupMemberCore(ctx, {
      group,
      participantKey: args.participantKey,
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
    });
    return {
      contactId: result.contactId,
      leadId: result.leadId,
      conversationId: result.conversationId,
      created: result.created,
    };
  },
});

/**
 * Grupos MONITORADOS em que este contato é participante (aba "Grupos" do
 * contato). Sem índice novo: varre os grupos da org (teto de 200, o mesmo da
 * listagem) e casa por `participants[].contactId`, que o ingest preenche
 * quando o telefone do membro já era um contato.
 */
export const listGroupsForContact = query({
  args: {
    organizationId: v.id("organizations"),
    contactId: v.id("contacts"),
  },
  returns: v.array(
    v.object({
      _id: v.id("groupChats"),
      subject: v.string(),
      jid: v.string(),
      channelConfigId: v.id("channelConfigs"),
      conversationId: v.union(v.id("conversations"), v.null()),
      participantsCount: v.number(),
      lastMessageAt: v.union(v.number(), v.null()),
      isAdmin: v.boolean(),
      joinedAt: v.union(v.number(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "inbox", "view_own");
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.organizationId !== args.organizationId) return [];

    const groups = await ctx.db
      .query("groupChats")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(GROUP_LIST_CAP);

    const rows = [];
    for (const group of groups) {
      if (!group.monitored || group.removedAt !== undefined || group.leftAt !== undefined) continue;
      const participant = (group.participants ?? []).find(
        (p) => p.contactId === args.contactId && p.leftAt === undefined
      );
      if (!participant) continue;
      rows.push({
        _id: group._id,
        subject: group.subject,
        jid: group.jid,
        channelConfigId: group.channelConfigId,
        conversationId: group.conversationId ?? null,
        participantsCount:
          group.participants?.filter((p) => p.leftAt === undefined).length ??
          group.participantsCount ??
          0,
        lastMessageAt: group.lastMessageAt ?? null,
        isAdmin: participant.isAdmin === true || participant.isSuperAdmin === true,
        joinedAt: participant.joinedAt ?? null,
      });
    }
    return rows.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Resumo por IA (F4, §9.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Um resumo com menos de 1 h não paga outra inferência — mesmo valor da tool do
 * copiloto (`lib/groupCopilotTools.ts`), que já fazia isto certo.
 */
const SUMMARY_FRESH_MS = 60 * 60 * 1000;
/**
 * Teto de resumos GERADOS por org por hora. O gate do resumo é `inbox:view_own`
 * (ler a sala), o mais baixo do produto, e cada chamada é uma inferência paga na
 * chave da plataforma ou na BYO da org. 20/h cobre uso humano de sobra e mata o
 * laço (review de segurança nº 3).
 */
const SUMMARY_MAX_PER_ORG_HOUR = 20;

/**
 * Gate do resumo, separado da geração: a action não tem `ctx.db`, e o `runQuery`
 * de dentro dela carrega a identidade de quem chamou (mesmo padrão de
 * `groupPosts.internalAssertCanSendNow`).
 *
 * Ler o resumo de uma sala é ler a conversa — `inbox:view_own`, como
 * `listGroups`. Gastar uma inferência não é: o interruptor do agente de grupo
 * precisa estar ligado, senão qualquer atendente dispara custo de LLM numa org
 * que decidiu não usar IA em grupos.
 */
export const internalAssertCanSummarize = internalQuery({
  args: { groupChatId: v.id("groupChats"), now: v.number(), hours: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) throw new Error("Grupo não encontrado");
    await requirePermission(ctx, group.organizationId, "inbox", "view_own");
    const org = await ctx.db.get(group.organizationId);
    if (org?.settings.aiConfig?.groupAgentEnabled !== true) {
      throw new Error("Ative a IA em grupos (Configurações → IA) para usar o resumo");
    }

    // Resumo recente do MESMO período: devolve o que está guardado em vez de
    // pagar outra inferência. É exatamente o que a tool do copiloto já fazia
    // (`SUMMARY_FRESH_MS`); a action pública não tinha frescor nenhum, e um
    // papel `agent` em laço virava conta de LLM (review de segurança nº 3).
    const cached =
      group.summary &&
      group.summary.at > args.now - SUMMARY_FRESH_MS &&
      (group.summary.hours ?? 24) === args.hours
        ? { text: group.summary.text, at: group.summary.at }
        : null;

    // Teto por ORG e por hora: sem cache (grupos diferentes, períodos
    // diferentes) o laço continuaria caro. Conta as runs de resumo da última
    // hora pelo índice de `agentRuns`.
    let recentRuns = 0;
    if (!cached) {
      const runs = await ctx.db
        .query("agentRuns")
        .withIndex("by_organization_and_kind_and_started", (q) =>
          q
            .eq("organizationId", group.organizationId)
            .eq("kind", "group_summary")
            .gte("startedAt", args.now - 60 * 60 * 1000)
        )
        .take(SUMMARY_MAX_PER_ORG_HOUR + 1);
      recentRuns = runs.length;
    }

    return {
      organizationId: group.organizationId,
      subject: group.subject,
      monitored: group.monitored === true && group.conversationId !== undefined,
      cached,
      overQuota: recentRuns >= SUMMARY_MAX_PER_ORG_HOUR,
    };
  },
});

/**
 * "Resumo por IA" do menu do grupo: o que rolou nas últimas 24 h (ou 7 dias) em
 * cinco linhas, gravado em `groupChats.summary` para quem abrir depois ver o
 * mesmo texto sem pagar outra inferência.
 */
export const summarizeGroup = action({
  args: {
    groupChatId: v.id("groupChats"),
    hours: v.optional(v.union(v.literal(24), v.literal(168))),
  },
  returns: v.object({
    text: v.union(v.string(), v.null()),
    at: v.union(v.number(), v.null()),
    hours: v.number(),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ text: string | null; at: number | null; hours: number; error: string | null }> => {
    const hours = args.hours ?? 24;
    const gate = await ctx.runQuery(internal.groupChats.internalAssertCanSummarize, {
      groupChatId: args.groupChatId,
      now: Date.now(),
      hours,
    });
    if (!gate.monitored) {
      return {
        text: null,
        at: null,
        hours,
        error: "Acompanhe o grupo para o CRM ter mensagens a resumir",
      };
    }
    // Resumo fresco do mesmo período: devolve o guardado, sem inferência.
    if (gate.cached) {
      return { text: gate.cached.text, at: gate.cached.at, hours, error: null };
    }
    if (gate.overQuota) {
      return {
        text: null,
        at: null,
        hours,
        error: `Limite de ${SUMMARY_MAX_PER_ORG_HOUR} resumos por hora atingido nesta organização — tente de novo mais tarde`,
      };
    }
    return await ctx.runAction(internal.groupAgent.internalGenerateSummary, {
      groupChatId: args.groupChatId,
      hours,
    });
  },
});
