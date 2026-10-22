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
import { paginationOptsValidator } from "convex/server";
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
  GROUP_TIMELINE_CAP,
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
import { groupMediaModeValidator, groupMediaOverrideModeValidator } from "./schema";
import {
  GROUP_MEDIA_KINDS,
  fillGroupMediaOverride,
  resolveEffectiveGroupMedia,
  resolveNumberGroupMedia,
  type GroupMediaOverride,
} from "./lib/groupMediaPolicy";
import { fetchAndStoreBridgeMedia } from "./lib/bridgeMediaDownload";
import {
  DEFERRED_FETCH_TIMEOUT_MS,
  DEFERRED_TOO_BIG_REASON,
  DEFERRED_UNAVAILABLE_REASON,
} from "./groupMedia";
import {
  channelProviderPatch,
  groupSummaryFieldsOf,
  syncGroupSummaryToConversation,
} from "./lib/conversationListFields";
import {
  memberMatchesSearch,
  normalizeSearchText,
  participantSearchName,
  phonePrefixVariants,
  phoneSearchDigits,
} from "./lib/groupMemberSearch";
import {
  replaceTimelineRows,
  dedupeParticipants,
  deleteGroupSideTables,
  deleteParticipantRows,
  diffParticipantsTable,
  findParticipant,
  isGroupMigrated,
  STORE_PARTICIPANTS_CAP,
  loadParticipantRows,
  loadTimelineRows,
  participantsForWrite,
  participantsOf,
  recordTimeline,
  syncParticipantsTable,
  timelineOf,
  timelineRowToEntry,
  timelineSignature,
  writeParticipants,
} from "./lib/groupParticipantsStore";
import { scheduleWebhookEvent } from "./lib/webhookDispatch";

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

    // Política de mídia (v0.62): o efetivo depende do padrão do NÚMERO. Um
    // `get` por canal distinto (a org tem poucos números), nunca por grupo.
    const numberMedia = new Map<string, Doc<"channelConfigs">["bridgeGroupMedia"] | null>();
    for (const g of groups) {
      if (numberMedia.has(g.channelConfigId)) continue;
      const config = await ctx.db.get(g.channelConfigId);
      numberMedia.set(g.channelConfigId, config?.bridgeGroupMedia ?? null);
    }

    return groups
      .filter((g) => (args.includeRemoved ? true : g.removedAt === undefined))
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))
      .map(({ participants, timeline: _timeline, participantsMigratedAt: _migratedAt, ...g }) => ({
        ...g,
        mediaPolicy: fillGroupMediaOverride(g.mediaPolicy),
        effectiveMedia: resolveEffectiveGroupMedia(numberMedia.get(g.channelConfigId), g.mediaPolicy),
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

/**
 * "Somos nós?" por participante, decidido no SERVIDOR a partir do canal.
 *
 * A UI precisa marcar "você" na lista de membros. Antes devolvíamos a CHAVE
 * crua do nosso número (`bridgeLid ?? bridgePhone`) — o mesmo campo que
 * `channelConfigs.getChannelConfigs` mascara, entregue sob o gate mais baixo do
 * produto (review de segurança nº 9). Agora sai só um booleano.
 * O LID vem antes do telefone pelo mesmo motivo do `findSelfParticipant`: num
 * canal reprovisionado o `bridgePhone` gravado pode estar defasado.
 */
function selfMatcher(
  config: Pick<Doc<"channelConfigs">, "bridgeLid" | "bridgePhone"> | null
): (p: { lid?: string; phone?: string }) => boolean {
  const selfLidUser = config?.bridgeLid ? config.bridgeLid.split("@")[0] : null;
  return (p) => {
    if (config?.bridgeLid && (p.lid === config.bridgeLid || p.lid?.split("@")[0] === selfLidUser)) {
      return true;
    }
    return !!config?.bridgePhone && p.phone === config.bridgePhone;
  };
}

/**
 * Um grupo pelo id.
 *
 * `includeParticipants` (perf I/O onda 2): a lista inteira (até 1.024 linhas,
 * ~250 KB numa sala grande) só vem quando pedida. O HANDLER mantém o contrato
 * antigo por padrão (ausente = inclui) porque é ele que a REST
 * `GET /api/v1/groups/get` e o MCP `crm_get_group` usam via `groupsInternal`;
 * a query PÚBLICA `getGroup` (o app) inverte o padrão — o front lê os membros
 * paginados por `listGroupMembers` e os nomes das menções por
 * `resolveGroupMemberNames`.
 */
export const getGroupArgs = { groupChatId: v.id("groupChats") };
export type GetGroupArgs = ObjectType<typeof getGroupArgs> &
  InternalActorArgs & { includeParticipants?: boolean };
export async function getGroupHandler(ctx: QueryCtx, args: GetGroupArgs) {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) return null;
    await authorizeGroups(ctx, group.organizationId, "inbox", "view_own", args.actorMemberId);
    const config = await ctx.db.get(group.channelConfigId);
    const selfKey = config?.bridgeLid ?? config?.bridgePhone ?? null;
    const isSelfParticipant = selfMatcher(config);
    const includeParticipants = args.includeParticipants !== false;
    // Fase 4d: membros e linha do tempo vêm das tabelas próprias quando a sala
    // já migrou (o shape devolvido — e o contrato da REST/MCP — não muda).
    const participants = includeParticipants ? await participantsOf(ctx, group) : null;
    const timeline = await timelineOf(ctx, group);
    const {
      participantsMigratedAt: _migratedAt,
      participants: legacyParticipants,
      timeline: _legacyTimeline,
      ...groupFields
    } = group;
    return {
      ...groupFields,
      ...(participants
        ? { participants: participants.map((p) => ({ ...p, isSelf: isSelfParticipant(p) })) }
        : {}),
      timeline,
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
      // Sem a lista, a contagem é a mesma de sempre: sala migrada usa o campo
      // mantido por todo escritor; a legada conta o array do próprio doc.
      participantsCount: participants
        ? countParticipants(participants, group.participantsCount)
        : isGroupMigrated(group)
          ? (group.participantsCount ?? 0)
          : countParticipants(legacyParticipants, group.participantsCount),
      mediaPolicy: fillGroupMediaOverride(group.mediaPolicy),
      effectiveMedia: resolveEffectiveGroupMedia(config?.bridgeGroupMedia, group.mediaPolicy),
    };
  }
export const getGroup = query({
  args: { ...getGroupArgs, includeParticipants: v.optional(v.boolean()) },
  returns: v.any(),
  handler: (ctx, args) =>
    getGroupHandler(ctx, { ...args, includeParticipants: args.includeParticipants === true }),
});

/**
 * Os membros da sala podem ser mostrados? Só com a sala ACOMPANHADA e ativa
 * (LGPD — `participantsForStorage`): parar de acompanhar, remover a sala ou
 * sairmos dela agenda a purga das linhas, que é assíncrona; até ela terminar
 * nada pode sair por `listGroupMembers`/`resolveGroupMemberNames`.
 */
function groupMembersVisible(
  group: Pick<Doc<"groupChats">, "monitored" | "removedAt" | "leftAt">
): boolean {
  return group.monitored === true && group.removedAt === undefined && group.leftAt === undefined;
}

/** Página do painel de membros (e teto da busca do "@"). */
export const GROUP_MEMBERS_PAGE_MAX = 50;
/** Teto do termo de busca (nome/telefone). */
const GROUP_MEMBERS_SEARCH_MAX = 60;

const groupMemberValidator = v.object({
  key: v.string(),
  lid: v.optional(v.string()),
  phone: v.optional(v.string()),
  name: v.optional(v.string()),
  isAdmin: v.boolean(),
  isSuperAdmin: v.boolean(),
  contactId: v.optional(v.id("contacts")),
  joinedAt: v.optional(v.number()),
  isSelf: v.boolean(),
});

const groupMembersPageValidator = v.object({
  page: v.array(groupMemberValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())
  ),
});

type GroupMember = {
  key: string;
  lid?: string;
  phone?: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  contactId?: Id<"contacts">;
  joinedAt?: number;
  isSelf: boolean;
};

const EMPTY_MEMBERS_PAGE = { page: [] as GroupMember[], isDone: true, continueCursor: "" };

function toGroupMember(
  p: {
    lid?: string;
    phone?: string;
    name?: string;
    isAdmin: boolean;
    isSuperAdmin: boolean;
    contactId?: Id<"contacts">;
    joinedAt?: number;
  },
  isSelf: (p: { lid?: string; phone?: string }) => boolean
): GroupMember | null {
  const key = p.lid ?? p.phone;
  if (!key) return null;
  return {
    key,
    ...(p.lid !== undefined ? { lid: p.lid } : {}),
    ...(p.phone !== undefined ? { phone: p.phone } : {}),
    ...(p.name !== undefined ? { name: p.name } : {}),
    isAdmin: p.isAdmin === true,
    isSuperAdmin: p.isSuperAdmin === true,
    ...(p.contactId !== undefined ? { contactId: p.contactId } : {}),
    ...(p.joinedAt !== undefined ? { joinedAt: p.joinedAt } : {}),
    isSelf: isSelf(p),
  };
}

/**
 * Membros ATIVOS de uma sala, paginados (perf Convex I/O, onda 2).
 *
 * Substitui o `participants[]` que o front recebia inteiro de `getGroup` (até
 * 1.024 linhas, ~250 KB, reexecutado a cada mudança da sala): agora vem uma
 * página de até 50 (~12 KB).
 *
 * Lê o doc da sala UMA vez — é o mínimo para autorizar (org) e achar o canal
 * (`isSelf`); desde a fase 4d ele é pequeno, então a reexecução quando a sala
 * muda custa uma página, não a lista. O canal é lido uma vez por chamada.
 *
 * `search`: termo com cara de telefone vai por PREFIXO no `by_group_and_phone`
 * (variantes de `phonePrefixVariants`: com o DDI 55 na frente, para "85 9…"
 * achar "5585 9…", e com/sem o 9º dígito BR, 12 ↔ 13 dígitos). Busca pelo FIM
 * do número (os 4 dígitos visíveis, ••••5729) não existe — o índice só serve
 * prefixo. O resto vai pelo search index de `searchName` (nome normalizado sem
 * acento/caixa — o termo é normalizado igual, então "joao" acha "João"; prefixo
 * por palavra, como toda busca do Convex). Linha antiga sem `searchName` não
 * aparece na busca por nome até o backfill
 * `internalBackfillParticipantSearchName`.
 * Busca devolve UMA página (`isDone: true`), até `numItems` (≤ 50) — é
 * autocomplete/filtro, não listagem.
 *
 * Não-membro (ou sala inexistente) recebe página vazia, sem erro: a query é
 * reativa e um throw derrubaria a tela. Sala não acompanhada, removida ou de
 * onde saímos também recebe vazio (LGPD, defesa em profundidade): a purga das
 * linhas é assíncrona e, até terminar, os membros ainda estariam na tabela.
 * Sala ainda NÃO migrada (fase 4d): a lista vem do array legado do doc, numa
 * página só — transitório até o backfill.
 */
export const listGroupMembers = query({
  args: {
    groupChatId: v.id("groupChats"),
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  returns: groupMembersPageValidator,
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group || !groupMembersVisible(group)) return EMPTY_MEMBERS_PAGE;
    try {
      await authorizeGroups(ctx, group.organizationId, "inbox", "view_own");
    } catch {
      return EMPTY_MEMBERS_PAGE;
    }
    const config = await ctx.db.get(group.channelConfigId);
    const isSelf = selfMatcher(config);
    const numItems = Math.max(1, Math.min(args.paginationOpts.numItems, GROUP_MEMBERS_PAGE_MAX));
    const term = (args.search ?? "").trim().slice(0, GROUP_MEMBERS_SEARCH_MAX);
    const digits = term ? phoneSearchDigits(term) : null;

    if (!isGroupMigrated(group)) {
      const page = (group.participants ?? [])
        .filter((p) => p.leftAt === undefined)
        .filter((p) => memberMatchesSearch(p, term))
        .slice(0, term ? numItems : STORE_PARTICIPANTS_CAP)
        .map((p) => toGroupMember(p, isSelf))
        .filter((p): p is GroupMember => p !== null);
      return { page, isDone: true, continueCursor: "" };
    }

    if (!term) {
      const result = await ctx.db
        .query("groupParticipants")
        .withIndex("by_group_and_left", (q) =>
          q.eq("groupChatId", args.groupChatId).eq("leftAt", undefined)
        )
        .paginate({ ...args.paginationOpts, numItems });
      return {
        ...result,
        page: result.page
          .map((row) => toGroupMember(row, isSelf))
          .filter((p): p is GroupMember => p !== null),
      };
    }

    const rows: Doc<"groupParticipants">[] = [];
    const seen = new Set<string>();
    const push = (list: Doc<"groupParticipants">[]) => {
      for (const row of list) {
        if (rows.length >= numItems) return;
        if (row.leftAt !== undefined || seen.has(row._id)) continue;
        seen.add(row._id);
        rows.push(row);
      }
    };
    if (digits) {
      for (const prefix of phonePrefixVariants(digits)) {
        // `~` vem depois de todo dígito: [prefixo, prefixo~) = "começa com".
        push(
          await ctx.db
            .query("groupParticipants")
            .withIndex("by_group_and_phone", (q) =>
              q.eq("groupChatId", args.groupChatId).gte("phone", prefix).lt("phone", `${prefix}~`)
            )
            .take(numItems * 2)
        );
      }
    } else {
      const needle = normalizeSearchText(term);
      if (needle) {
        push(
          await ctx.db
            .query("groupParticipants")
            .withSearchIndex("search_name", (q) =>
              q.search("searchName", needle).eq("groupChatId", args.groupChatId)
            )
            .take(numItems * 2)
        );
      }
    }
    return {
      page: rows
        .map((row) => toGroupMember(row, isSelf))
        .filter((p): p is GroupMember => p !== null),
      isDone: true,
      continueCursor: "",
    };
  },
});

/** Teto de JIDs resolvidos por chamada (as menções das mensagens carregadas). */
const GROUP_MEMBER_NAMES_MAX = 100;

/**
 * Nome dos membros mencionados nas mensagens da tela (o negrito do "@Fulano"
 * recebido). Antes o front montava o mapa com a lista inteira de `getGroup`;
 * agora pede só os JIDs que aparecem — um lookup por índice cada, sem ler a
 * lista. Não-membro recebe lista vazia.
 */
export const resolveGroupMemberNames = query({
  args: { groupChatId: v.id("groupChats"), jids: v.array(v.string()) },
  returns: v.array(v.object({ jid: v.string(), name: v.string() })),
  handler: async (ctx, args) => {
    if (args.jids.length === 0) return [];
    const group = await ctx.db.get(args.groupChatId);
    // LGPD: sala não acompanhada/removida/abandonada não expõe nome de membro.
    if (!group || !groupMembersVisible(group)) return [];
    try {
      await authorizeGroups(ctx, group.organizationId, "inbox", "view_own");
    } catch {
      return [];
    }
    const out: { jid: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const jid of args.jids.slice(0, GROUP_MEMBER_NAMES_MAX)) {
      if (typeof jid !== "string" || !jid || seen.has(jid)) continue;
      seen.add(jid);
      const user = jid.split("@")[0].split(":")[0];
      const who = jid.endsWith("@lid") ? { lid: jid } : /^\d+$/.test(user) ? { phone: user } : null;
      if (!who) continue;
      const p = await findParticipant(ctx, group, who);
      const name = p?.name?.trim();
      if (name) out.push({ jid, name });
    }
    return out;
  },
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
          ...channelProviderPatch(config),
          ...groupSummaryFieldsOf(group),
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

    // Parar de acompanhar APAGA a lista de membros (review de segurança nº 1):
    // o telefone e o nome de terceiros só podem ficar no banco enquanto a sala
    // está de fato sendo acompanhada. A contagem permanece — é o que a lista
    // de grupos mostra. Voltar a acompanhar repopula pelo `/group/info`
    // agendado logo abaixo. Fase 4d: apaga as linhas de `groupParticipants`.
    const participantsPatch = args.monitored ? {} : await writeParticipants(ctx, group, [], now);
    const timelinePatch = await recordTimeline(ctx, group, [
      {
        at: now,
        type: args.monitored ? "monitored_on" : "monitored_off",
        data: member.name,
      },
    ]);
    await ctx.db.patch(group._id, {
      monitored: args.monitored,
      ...(conversationId ? { conversationId } : {}),
      ...(args.monitored ? { monitoredSince: now, monitoredBy: member._id } : {}),
      ...participantsPatch,
      ...timelinePatch,
      updatedAt: now,
    });
    // Lista do inbox (fase 4c): nome/contagem espelhados na conversa.
    await syncGroupSummaryToConversation(ctx, {
      ...group,
      conversationId,
      ...(args.monitored ? {} : { participants: isGroupMigrated(group) ? undefined : [] }),
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
// Política de download de mídia (v0.62)
// ─────────────────────────────────────────────────────────────────────────────

const groupMediaPolicyValidator = v.object({
  image: groupMediaModeValidator,
  audio: groupMediaModeValidator,
  video: groupMediaModeValidator,
  document: groupMediaModeValidator,
});
const groupMediaOverrideValidator = v.object({
  image: groupMediaOverrideModeValidator,
  audio: groupMediaOverrideModeValidator,
  video: groupMediaOverrideModeValidator,
  document: groupMediaOverrideModeValidator,
});

/**
 * Padrão do NÚMERO: o que baixar de cada tipo de mídia nos grupos
 * acompanhados. "mentions" (default) = só o que é com a gente; o resto fica
 * disponível sob demanda por 14 dias.
 */
export const setGroupMediaDefaults = mutation({
  args: {
    organizationId: v.id("organizations"),
    channelConfigId: v.id("channelConfigs"),
    policy: groupMediaPolicyValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const config = await ctx.db.get(args.channelConfigId);
    if (!config || config.organizationId !== args.organizationId) {
      throw new Error("Canal não encontrado");
    }
    if (configProvider(config) !== "bridge") {
      throw new Error("Grupos só estão disponíveis no canal bridge");
    }

    const before = resolveNumberGroupMedia(config.bridgeGroupMedia);
    const after = { ...args.policy };
    const now = Date.now();
    await ctx.db.patch(config._id, { bridgeGroupMedia: after, updatedAt: now });
    await ctx.db.insert("auditLogs", {
      organizationId: config.organizationId,
      entityType: "channelConfig",
      entityId: config._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      changes: { before: { groupMedia: before }, after: { groupMedia: after } },
      metadata: { name: config.displayName },
      description: `Política de mídia dos grupos do número '${config.displayName}' alterada`,
      severity: "medium",
      createdAt: now,
    });
    return null;
  },
});

/** Override POR GRUPO — `"inherit"` volta a seguir o padrão do número. */
export const setGroupMediaPolicy = mutation({
  args: {
    organizationId: v.id("organizations"),
    groupChatId: v.id("groupChats"),
    policy: groupMediaOverrideValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const group = await ctx.db.get(args.groupChatId);
    if (!group || group.organizationId !== args.organizationId) {
      throw new Error("Grupo não encontrado");
    }

    // Só o que difere de "inherit" é gravado; tudo "inherit" apaga o campo.
    const stored: GroupMediaOverride = {};
    for (const kind of GROUP_MEDIA_KINDS) {
      const mode = args.policy[kind];
      if (mode !== "inherit") stored[kind] = mode;
    }
    const hasOverride = Object.keys(stored).length > 0;
    const now = Date.now();
    await ctx.db.patch(group._id, {
      mediaPolicy: hasOverride ? stored : undefined,
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
        before: { mediaPolicy: fillGroupMediaOverride(group.mediaPolicy) },
        after: { mediaPolicy: fillGroupMediaOverride(stored) },
      },
      metadata: { name: group.subject, jid: group.jid },
      description: `Política de mídia do grupo '${group.subject}' alterada`,
      severity: "medium",
      createdAt: now,
    });
    return null;
  },
});

/**
 * O whatsmeow disse que o blob sumiu da CDN do WhatsApp? Só o erro DELE conta
 * (`ErrMediaDownloadFailedWith404/410`: "download failed with status code
 * 404"). Um 404/410 do próprio gateway — proxy em manutenção, base URL
 * errada — é falha transitória: tratá-lo como expirado apagaria o descriptor
 * para sempre por causa de um problema de infraestrutura nosso.
 */
export function looksLikeGoneFromCdn(reason: string): boolean {
  return /download failed with status code (404|410)\b/i.test(reason);
}

/**
 * Baixa sob demanda uma mídia de grupo que a política não baixou. Mesmo
 * caminho do ingest (`fetchAndStoreBridgeMedia`: teto de 25 MB, allowlist,
 * quota) e, no fim, o mesmo enriquecimento (transcrição/visão). Idempotente:
 * a segunda chamada com a mídia já baixada devolve `ok`.
 */
export const downloadDeferredMedia = action({
  args: { organizationId: v.id("organizations"), messageId: v.id("messages") },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), reason: v.string() })
  ),
  handler: async (ctx, args): Promise<{ ok: true } | { ok: false; reason: string }> => {
    await ctx.runQuery(internal.groupChats.internalAuthorizeGroupAccess, {
      organizationId: args.organizationId,
      category: "inbox",
      level: "reply",
    });

    const claim = await ctx.runMutation(internal.groupMedia.internalClaimDeferredMedia, {
      organizationId: args.organizationId,
      messageId: args.messageId,
    });
    if (claim.state === "done") return { ok: true };
    if (claim.state === "unavailable") return { ok: false, reason: claim.reason };
    if (claim.state === "busy") {
      return { ok: false, reason: "Esta mídia já está sendo baixada — aguarde alguns segundos" };
    }

    type Final =
      | { kind: "expired" }
      | { kind: "tooBig" }
      | { kind: "rejected"; reason: string };
    const release = async (final?: Final) => {
      await ctx.runMutation(internal.groupMedia.internalReleaseDeferredClaim, {
        rowId: claim.rowId,
        claimToken: claim.claimToken,
        ...(final ? { final } : {}),
      });
    };

    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
      configId: claim.channelConfigId,
    });
    if (
      !config ||
      config.organizationId !== args.organizationId ||
      config.status !== "active" ||
      configProvider(config) !== "bridge"
    ) {
      await release();
      return { ok: false, reason: "O número deste grupo não está ativo — não dá para baixar agora" };
    }

    let descriptor: Record<string, any>;
    try {
      descriptor = JSON.parse(await decryptSecret(claim.descriptorEncrypted));
    } catch {
      await release({ kind: "expired" });
      return { ok: false, reason: DEFERRED_UNAVAILABLE_REASON };
    }

    const result = await fetchAndStoreBridgeMedia(ctx, {
      config,
      media: {
        kind: claim.kind,
        mimeType: claim.mimeType,
        filename: claim.filename,
        descriptor,
      },
      externalId: claim.externalId,
      timeoutMs: DEFERRED_FETCH_TIMEOUT_MS,
    });
    if (!result.ok) {
      if (result.failure === "too_big") {
        await release({ kind: "tooBig" });
        return { ok: false, reason: DEFERRED_TOO_BIG_REASON };
      }
      if (result.failure === "rejected") {
        // Quota estourada é transitória (alguém libera espaço); mimetype fora
        // da allowlist não muda nunca — vira estado final, sem botão.
        if (result.rejectedBy === "mime") {
          await release({ kind: "rejected", reason: result.reason });
        } else {
          await release();
        }
        return { ok: false, reason: `Não foi possível guardar a mídia: ${result.reason}` };
      }
      if (looksLikeGoneFromCdn(result.reason)) {
        await release({ kind: "expired" });
        return { ok: false, reason: DEFERRED_UNAVAILABLE_REASON };
      }
      await release();
      return {
        ok: false,
        reason: `Não foi possível baixar a mídia agora (${result.reason}). Tente de novo em instantes.`,
      };
    }

    const outcome = await ctx.runMutation(internal.groupMedia.internalCompleteDeferredMedia, {
      rowId: claim.rowId,
      claimToken: claim.claimToken,
      messageId: args.messageId,
      fileId: result.fileId,
    });
    if (outcome === "attached" || outcome === "duplicate") return { ok: true };
    return outcome === "gone"
      ? { ok: false, reason: "A mensagem foi removida enquanto a mídia era baixada" }
      : { ok: false, reason: "Outro pedido assumiu este download — tente de novo em instantes" };
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

const gatewayParticipantsValidator = v.array(
  v.object({
    lid: v.optional(v.string()),
    phone: v.optional(v.string()),
    name: v.optional(v.string()),
    isAdmin: v.boolean(),
    isSuperAdmin: v.boolean(),
  })
);

/**
 * Escritas de "apagar membros" que o sync faz INLINE por execução (sala que
 * sumiu da listagem). O resto vai para `internalPurgeGroupParticipants`, que
 * se reagenda — 16 salas de 1.024 apagadas numa transação só estourariam.
 */
const SYNC_INLINE_DELETE_BUDGET = 2000;

/** Campos do doc da sala que o sync compara antes de regravar. */
function syncPatchChanges(
  prev: Doc<"groupChats">,
  patch: Partial<Doc<"groupChats">>
): boolean {
  for (const [key, value] of Object.entries(patch)) {
    // Carimbos não contam como "mudou": senão todo sync regravaria toda sala
    // (e reexecutaria toda query que lê o doc), com nada de novo. Consequência:
    // `groupChats.lastSyncAt` da SALA passou a significar "última mudança vinda
    // do sync", não "último sync" (o do número inteiro é
    // `channelConfigs.bridgeGroupsLastSyncAt`). A REST/MCP devolvem o doc cru,
    // então quem integra vê esse significado novo.
    if (key === "lastSyncAt" || key === "updatedAt") continue;
    const before = (prev as Record<string, unknown>)[key];
    if (JSON.stringify(before ?? null) !== JSON.stringify(value ?? null)) return true;
  }
  return false;
}

/**
 * Aplica o resultado de `/group/list`: upsert dos que vieram e `removedAt` nos
 * que sumiram. NUNCA toca em `monitored`, `conversationId` ou `ai` — essas são
 * decisões do operador, e uma sincronização não pode desfazê-las.
 *
 * Perf (Convex I/O, onda 2): esta mutation grava só os METADADOS das salas
 * (barato) e devolve em `participantJobs` as salas cujos membros precisam do
 * diff; quem chama (`applyGatewayGroupList`, numa action) roda
 * `internalApplyGatewayParticipants` UMA vez por sala, em série — cada uma na
 * sua transação. Antes o diff de todas as salas acompanhadas corria aqui
 * dentro (até 1.024 leituras/escritas por sala; 16 salas grandes ≈ 16 mil
 * escritas numa transação só). Sala sem nada novo não é regravada.
 */
export const internalUpsertGroupsFromSync = internalMutation({
  args: {
    channelConfigId: v.id("channelConfigs"),
    groups: v.array(gatewayGroupValidator),
    // `full: false` (upsert pontual, ex. após entrar por link) não marca
    // ausentes como removidos — a lista recebida não é a verdade completa.
    full: v.boolean(),
  },
  returns: v.object({
    upserted: v.number(),
    removed: v.number(),
    syncedAt: v.number(),
    participantJobs: v.array(v.object({ groupChatId: v.id("groupChats"), jid: v.string() })),
  }),
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

    const participantJobs: { groupChatId: Id<"groupChats">; jid: string }[] = [];
    let upserted = 0;
    for (const raw of args.groups) {
      const group = raw as ParsedGroupInfo;
      const fields = groupFieldsFromGateway(group, ourLid, ourPhone, now);
      // Membros ativos da sala segundo o gateway — o MESMO número que o diff
      // chega (o merge mantém 1 linha ativa por participante recebido, e quem
      // sumiu ganha `leftAt`), então dá para gravar a contagem já aqui.
      const activeCount = mergeParticipantsFromGateway(undefined, group.participants, now).length;
      const prev = byJid.get(group.jid);
      if (prev) {
        const migrated = isGroupMigrated(prev);
        // Diff de membros: sala acompanhada; e a legada (não migrada) sempre,
        // porque o array dela mora no doc e o diff é quem o mantém (inclusive
        // esvaziando o de sala NÃO acompanhada — LGPD).
        if (prev.monitored === true || !migrated) {
          participantJobs.push({ groupChatId: prev._id, jid: group.jid });
        }
        const timelinePatch =
          prev.subject !== group.subject
            ? await recordTimeline(ctx, prev, [{ at: now, type: "renamed", data: group.subject }])
            : {};
        const patch: Partial<Doc<"groupChats">> = {
          ...fields,
          participantsCount: activeCount,
          ...timelinePatch,
          // Voltou a aparecer na listagem: não estamos mais fora dele.
          leftAt: undefined,
        };
        if (syncPatchChanges(prev, patch)) {
          await ctx.db.patch(prev._id, patch);
        }
        // Sala legada: o espelho da conversa conta o array, que só o diff
        // atualiza — ele sincroniza no fim.
        if (migrated) {
          await syncGroupSummaryToConversation(ctx, {
            ...prev,
            subject: fields.subject ?? prev.subject,
            participants: undefined,
            participantsCount: activeCount,
          });
        }
      } else {
        const groupChatId = await ctx.db.insert("groupChats", {
          organizationId: config.organizationId,
          channelConfigId: args.channelConfigId,
          jid: group.jid,
          subject: group.subject,
          ...fields,
          // Grupo novo nasce NÃO acompanhado, logo sem lista de membros. Ela é
          // populada por `internalRefreshGroup` quando alguém marca
          // "Acompanhar". Fase 4d: já nasce migrado (membros e linha do tempo
          // só nas tabelas próprias).
          participantsCount: activeCount,
          participantsMigratedAt: now,
          // D4: grupo novo NASCE sem acompanhamento.
          monitored: false,
          createdAt: now,
          updatedAt: now,
        } as Doc<"groupChats">);
        await recordTimeline(
          ctx,
          { _id: groupChatId, organizationId: config.organizationId, participantsMigratedAt: now },
          [{ at: now, type: "discovered" }]
        );
      }
      upserted++;
    }

    let removed = 0;
    if (args.full) {
      const seen = new Set(args.groups.map((g) => g.jid));
      const budget = { left: SYNC_INLINE_DELETE_BUDGET };
      for (const prev of existing) {
        if (seen.has(prev.jid) || prev.removedAt !== undefined) continue;
        const timelinePatch = await recordTimeline(ctx, prev, [{ at: now, type: "removed" }]);
        // LGPD: deixou de ser acompanhada → membros (nome/telefone de
        // terceiros) saem do banco; a contagem fica. Dentro de um orçamento:
        // o que não couber vai para a limpeza auto-reagendada.
        const cleared = await deleteParticipantRows(ctx, prev._id, budget);
        if (!cleared) {
          await ctx.scheduler.runAfter(0, internal.groupChats.internalPurgeGroupParticipants, {
            groupChatId: prev._id,
          });
        }
        await ctx.db.patch(prev._id, {
          removedAt: now,
          monitored: false,
          ...(isGroupMigrated(prev) ? {} : { participants: [] }),
          ...timelinePatch,
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
    return { upserted, removed, syncedAt: now, participantJobs };
  },
});

/**
 * Diff dos membros de UMA sala contra o que o gateway devolveu (o passo 2 do
 * sync — ver `internalUpsertGroupsFromSync`). Semântica idêntica à de antes:
 * novos entram, mudados atualizam, quem sumiu ganha `leftAt`; sala NÃO
 * acompanhada fica sem linhas (LGPD). Atualiza `participantsCount` e o espelho
 * `groupParticipantsCount` da conversa (fase 4c) só se mudaram.
 *
 * Relê a sala: se ela deixou de ser acompanhada (ou foi removida) entre o
 * passo 1 e este, o diff vira "apagar todos", como faria o sync antigo.
 */
export const internalApplyGatewayParticipants = internalMutation({
  args: {
    groupChatId: v.id("groupChats"),
    participants: gatewayParticipantsValidator,
    syncedAt: v.number(),
  },
  returns: v.object({ inserted: v.number(), updated: v.number(), deleted: v.number() }),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group) return { inserted: 0, updated: 0, deleted: 0 };
    const current = await participantsForWrite(ctx, group);
    const merged = mergeParticipantsFromGateway(current.list, args.participants, args.syncedAt);
    const stored = participantsForStorage(
      group.monitored === true && group.removedAt === undefined,
      merged
    );
    const counts = await syncParticipantsTable(
      ctx,
      group,
      stored.participants,
      args.syncedAt,
      current.rows
    );
    const migrated = isGroupMigrated(group);
    const patch: Partial<Doc<"groupChats">> = {};
    if (
      !migrated &&
      JSON.stringify(group.participants ?? []) !== JSON.stringify(stored.participants)
    ) {
      patch.participants = stored.participants;
    }
    if (group.participantsCount !== stored.participantsCount) {
      patch.participantsCount = stored.participantsCount;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(group._id, { ...patch, updatedAt: Date.now() });
    }
    await syncGroupSummaryToConversation(ctx, {
      ...group,
      participants: migrated ? undefined : stored.participants,
      participantsCount: stored.participantsCount,
    });
    return counts;
  },
});

/** Lote da limpeza auto-reagendada de membros de uma sala fora de uso. */
const PURGE_PARTICIPANTS_BATCH = 500;

/**
 * Apaga as linhas de membros de uma sala que deixou de ser acompanhada (ou
 * sumiu da listagem) quando o sync não conseguiu fazer tudo inline. Para se a
 * sala voltou a ser acompanhada nesse meio-tempo — aí quem manda é o diff.
 */
export const internalPurgeGroupParticipants = internalMutation({
  args: { groupChatId: v.id("groupChats") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (group && group.monitored === true && group.removedAt === undefined) return null;
    const done = await deleteParticipantRows(ctx, args.groupChatId, {
      left: PURGE_PARTICIPANTS_BATCH,
    });
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.groupChats.internalPurgeGroupParticipants, {
        groupChatId: args.groupChatId,
      });
    }
    return null;
  },
});

/** Linhas por página do backfill de `searchName`. */
const BACKFILL_SEARCH_NAME_PAGE = 200;

/**
 * Backfill de `groupParticipants.searchName` (perf I/O onda 2, busca sem
 * acento). Linhas gravadas antes do campo existir ficam fora da busca por NOME
 * até passar por aqui (a listagem e a busca por telefone não dependem dele).
 * Varre a tabela inteira pelo cursor, 200 linhas por página; `dryRun` (padrão)
 * só conta uma página. O real se reagenda até o fim. Idempotente.
 *
 * `npx convex run --prod groupChats:internalBackfillParticipantSearchName '{"dryRun":false}'`
 */
export const internalBackfillParticipantSearchName = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({
    scanned: v.number(),
    patched: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const result = await ctx.db
      .query("groupParticipants")
      .paginate({ numItems: BACKFILL_SEARCH_NAME_PAGE, cursor: args.cursor ?? null });
    let patched = 0;
    for (const row of result.page) {
      const searchName = participantSearchName(row.name);
      if (row.searchName === searchName) continue;
      patched++;
      if (!dryRun) await ctx.db.patch(row._id, { searchName });
    }
    if (!dryRun && !result.isDone) {
      await ctx.scheduler.runAfter(0, internal.groupChats.internalBackfillParticipantSearchName, {
        dryRun: false,
        cursor: result.continueCursor,
      });
    }
    return {
      scanned: result.page.length,
      patched,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Sincroniza uma lista do gateway em DOIS passos (perf I/O, onda 2): os
 * metadados de todas as salas numa mutation e, depois, o diff de membros de
 * cada sala acompanhada na sua própria mutation, em série. Se a action cair no
 * meio, as salas que faltaram ficam com a lista anterior até o próximo sync —
 * e a CONTAGEM (`participantsCount`, gravada no 1º passo a partir do gateway)
 * pode divergir da lista de membros da tabela até lá. Nenhuma das duas se
 * corrompe; o próximo sync reconcilia.
 */
async function applyGatewayGroupList(
  ctx: ActionCtx,
  args: { channelConfigId: Id<"channelConfigs">; groups: ParsedGroupInfo[]; full: boolean }
): Promise<{ upserted: number; removed: number }> {
  const result = await ctx.runMutation(internal.groupChats.internalUpsertGroupsFromSync, {
    channelConfigId: args.channelConfigId,
    groups: args.groups,
    full: args.full,
  });
  const byJid = new Map(args.groups.map((g) => [g.jid, g]));
  for (const job of result.participantJobs) {
    const group = byJid.get(job.jid);
    if (!group) continue;
    await ctx.runMutation(internal.groupChats.internalApplyGatewayParticipants, {
      groupChatId: job.groupChatId,
      participants: group.participants,
      syncedAt: result.syncedAt,
    });
  }
  return { upserted: result.upserted, removed: result.removed };
}

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

    // Fase 4d: a lista atual vem da tabela (sala migrada) ou do array legado.
    const current = await participantsForWrite(ctx, group);
    let participants: Doc<"groupChats">["participants"] = current.list;
    const timelineEntries: { at: number; type: string; actorJid?: string; data?: string }[] = [];
    const pushTimeline = (entry: { at: number; type: string; actorJid?: string; data?: string }) => {
      timelineEntries.push(entry);
    };

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
      pushTimeline({ at: args.at, type: "join", actorJid: jid });
    }
    for (const jid of cap(args.leave)) {
      participants = mergeParticipant(participants, { ...asParticipant(jid), leftAt: args.at });
      pushTimeline({ at: args.at, type: "leave", actorJid: jid });
    }
    for (const jid of cap(args.promote)) {
      participants = mergeParticipant(participants, { ...asParticipant(jid), isAdmin: true });
      pushTimeline({ at: args.at, type: "promote", actorJid: jid });
    }
    for (const jid of cap(args.demote)) {
      participants = mergeParticipant(participants, {
        ...asParticipant(jid),
        isAdmin: false,
        isSuperAdmin: false,
      });
      pushTimeline({ at: args.at, type: "demote", actorJid: jid });
    }
    if (args.name !== undefined && args.name !== group.subject) {
      pushTimeline({
        at: args.at,
        type: "renamed",
        ...(args.actorJid ? { actorJid: args.actorJid } : {}),
        data: args.name.slice(0, 200),
      });
    }
    if (args.topic !== undefined && args.topic !== (group.topic ?? "")) {
      pushTimeline({
        at: args.at,
        type: "topic",
        ...(args.actorJid ? { actorJid: args.actorJid } : {}),
        data: args.topic.slice(0, 200),
      });
    }

    const weLeft = args.leave.some(isUs);
    const meNow = findSelfParticipant(participants ?? [], ourLid, ourPhone);
    // Sala não acompanhada: a contagem é atualizada, a lista não é guardada.
    // Só recalcula quando o evento mexe em membros OU a sala é acompanhada:
    // sala não acompanhada não tem linhas, e um evento só de rename/tópico
    // recalcularia a contagem a partir de uma lista vazia (zeraria o número).
    const membershipChanged =
      args.join.length > 0 ||
      args.leave.length > 0 ||
      args.promote.length > 0 ||
      args.demote.length > 0;
    const stored = participants && (membershipChanged || group.monitored === true)
      ? participantsForStorage(weLeft ? false : group.monitored, participants)
      : null;
    const participantsPatch = stored
      ? await writeParticipants(ctx, group, stored.participants, args.at, current.rows)
      : {};
    const timelinePatch = await recordTimeline(ctx, group, timelineEntries);

    await ctx.db.patch(group._id, {
      // Nome e tópico são escolhidos por um ADMIN DO GRUPO, que é um terceiro,
      // e viajam daqui para o prompt, a notificação, o card e o webhook. O teto
      // é o mesmo já usado na linha do tempo (review de segurança nº 8).
      ...(args.name !== undefined ? { subject: args.name.slice(0, GROUP_SUBJECT_CAP) } : {}),
      ...(args.topic !== undefined ? { topic: args.topic.slice(0, GROUP_TOPIC_CAP) } : {}),
      ...(args.isLocked !== undefined ? { isLocked: args.isLocked } : {}),
      ...(args.isAnnounce !== undefined ? { isAnnounce: args.isAnnounce } : {}),
      ...participantsPatch,
      ...(stored ? { participantsCount: stored.participantsCount } : {}),
      ...(meNow
        ? {
            weAreAdmin: meNow.isAdmin === true || meNow.isSuperAdmin === true,
            weAreSuperAdmin: meNow.isSuperAdmin === true,
          }
        : {}),
      ...(weLeft ? { leftAt: args.at, monitored: false } : {}),
      ...timelinePatch,
      updatedAt: args.at,
    });
    await syncGroupSummaryToConversation(ctx, {
      ...group,
      ...(args.name !== undefined ? { subject: args.name.slice(0, GROUP_SUBJECT_CAP) } : {}),
      ...(stored
        ? {
            participants: isGroupMigrated(group) ? undefined : stored.participants,
            participantsCount: stored.participantsCount,
          }
        : {}),
    });

    if (weLeft && group.conversationId) {
      const conversation = await ctx.db.get(group.conversationId);
      if (conversation && !conversation.archivedAt) {
        await ctx.db.patch(group.conversationId, { archivedAt: args.at, updatedAt: args.at });
      }
    }

    await scheduleWebhookEvent(ctx, {
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
    const joinedEntry = {
      at: args.at,
      type: "joined",
      ...(args.reason ? { data: args.reason } : {}),
    };
    if (existing) {
      const current = await participantsForWrite(ctx, existing);
      const participants = mergeParticipantsFromGateway(current.list, parsed.participants, args.at);
      const participantsCount = participants.filter((p) => p.leftAt === undefined).length;
      // A tabela segue a regra de LGPD (só sala acompanhada guarda membros);
      // o array legado da sala ainda não migrada mantém o comportamento antigo
      // e some no `internalFinishGroupParticipantsMigration`.
      await syncParticipantsTable(
        ctx,
        existing,
        participantsForStorage(existing.monitored, participants).participants,
        args.at,
        current.rows
      );
      const participantsPatch = isGroupMigrated(existing) ? {} : { participants };
      groupChatId = existing._id;
      const timelinePatch = await recordTimeline(ctx, existing, [joinedEntry]);
      await ctx.db.patch(existing._id, {
        ...fields,
        ...participantsPatch,
        participantsCount,
        leftAt: undefined,
        ...timelinePatch,
      });
      await syncGroupSummaryToConversation(ctx, {
        ...existing,
        ...fields,
        subject: fields.subject ?? existing.subject,
        participants: isGroupMigrated(existing) ? undefined : participants,
        participantsCount,
      });
    } else {
      const participants = mergeParticipantsFromGateway(undefined, parsed.participants, args.at);
      // Sala nova nasce migrada e NÃO acompanhada (D4): a lista de membros não
      // é guardada (LGPD) — só a contagem; `internalRefreshGroup` popula ao
      // marcar "Acompanhar".
      groupChatId = await ctx.db.insert("groupChats", {
        organizationId: config.organizationId,
        channelConfigId: args.channelConfigId,
        jid: parsed.jid,
        subject: parsed.subject,
        ...fields,
        participantsCount: participants.length,
        participantsMigratedAt: args.at,
        monitored: false,
        createdAt: args.at,
        updatedAt: args.at,
      } as Doc<"groupChats">);
      await recordTimeline(
        ctx,
        { _id: groupChatId, organizationId: config.organizationId, participantsMigratedAt: args.at },
        [joinedEntry]
      );
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

    await scheduleWebhookEvent(ctx, {
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
    const timelinePatch = await recordTimeline(ctx, group, [{ at: args.at, type: "left" }]);
    // LGPD: saímos da sala e ela deixa de ser acompanhada → membros saem do
    // banco (a contagem fica).
    const participantsPatch = await writeParticipants(ctx, group, [], args.at);
    await ctx.db.patch(group._id, {
      leftAt: args.at,
      monitored: false,
      ...participantsPatch,
      ...timelinePatch,
      updatedAt: args.at,
    });
    if (group.conversationId) {
      const conversation = await ctx.db.get(group.conversationId);
      if (conversation && !conversation.archivedAt) {
        await ctx.db.patch(group.conversationId, { archivedAt: args.at, updatedAt: args.at });
      }
    }
    await scheduleWebhookEvent(ctx, {
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

    const result = await applyGatewayGroupList(ctx, {
      channelConfigId: args.channelConfigId,
      groups: parsed.groups,
      full: true,
    });
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
    await applyGatewayGroupList(ctx, {
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
    await applyGatewayGroupList(ctx, {
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
  args: {
    channelConfigId: v.id("channelConfigs"),
    // Só para teste: orçamento de escritas por execução (default
    // `CASCADE_WRITE_BUDGET`). Propagado no reagendamento.
    budget: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const budget = newBudget(
      args.budget !== undefined ? Math.max(1, Math.floor(args.budget)) : undefined
    );

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
      // Fase 4d: membros e linha do tempo moram em tabelas próprias. Cada
      // linha apagada conta no orçamento; a sala só sai quando as duas
      // tabelas dela estão vazias (senão para e continua na próxima execução).
      if (!(await deleteGroupSideTables(ctx, group._id, budget))) break;
      if (budget.left <= 0) break;
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
        {
          channelConfigId: args.channelConfigId,
          ...(args.budget !== undefined ? { budget: args.budget } : {}),
        }
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
      // Padrão de mídia do número, já resolvido (v0.62).
      groupMedia: groupMediaPolicyValidator,
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
        groupMedia: resolveNumberGroupMedia(c.bridgeGroupMedia),
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
 * contato). Varre os grupos da org (teto de 200, o mesmo da listagem) e casa
 * por `contactId` do participante, que o ingest preenche quando o telefone do
 * membro já era um contato. Fase 4d: em sala migrada o participante vem de
 * `groupParticipants.by_organization_and_contact` (uma consulta só, não um
 * array de 1.024 por sala); em sala ainda não migrada, do array legado.
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

    const tableRows = await ctx.db
      .query("groupParticipants")
      .withIndex("by_organization_and_contact", (q) =>
        q.eq("organizationId", args.organizationId).eq("contactId", args.contactId)
      )
      .take(GROUP_LIST_CAP);
    const rowByGroup = new Map<string, Doc<"groupParticipants">>();
    for (const row of tableRows) {
      if (row.leftAt === undefined && !rowByGroup.has(row.groupChatId)) {
        rowByGroup.set(row.groupChatId, row);
      }
    }

    const rows = [];
    for (const group of groups) {
      if (!group.monitored || group.removedAt !== undefined || group.leftAt !== undefined) continue;
      const participant = isGroupMigrated(group)
        ? rowByGroup.get(group._id)
        : (group.participants ?? []).find(
            (p) => p.contactId === args.contactId && p.leftAt === undefined
          );
      if (!participant) continue;
      rows.push({
        _id: group._id,
        subject: group.subject,
        jid: group.jid,
        channelConfigId: group.channelConfigId,
        conversationId: group.conversationId ?? null,
        participantsCount: countParticipants(group.participants, group.participantsCount),
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

// ─────────────────────────────────────────────────────────────────────────────
// Fase 4d (perf Convex I/O): migração de `participants`/`timeline` do doc
// `groupChats` para `groupParticipants`/`groupTimeline`.
//
// Ordem em produção: deploy (dual-write liga sozinho) → backfill dryRun → real
// → finish dryRun → real (é aqui que o doc encolhe). Rollback = restore.
// Todas com `dryRun` default true, cursor e auto-reagendamento.
//
// Página pequena de propósito (default 10, teto 12): cada sala pode ter 1.024
// linhas, e a transação do Convex tem teto de 32 mil docs lidos e 16 mil
// escritos — 12 salas cheias ≈ 12,3 mil escritas no backfill (50 dariam ~51
// mil).
//
// Rodar o backfill LOGO APÓS o deploy: até lá o 1º `syncGroups` de cada canal
// insere a tabela inteira de cada sala acompanhada numa transação só (16 salas
// de 1.024 ≈ 16 mil escritas), e mesmo depois do finish o sync lê até 1.024
// linhas por sala — canal com >15 salas acompanhadas grandes pode precisar de
// sync paginado (follow-up).
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION_PAGE_DEFAULT = 10;
const MIGRATION_PAGE_MAX = 12;

const migrationArgs = {
  dryRun: v.optional(v.boolean()),
  cursor: v.optional(v.union(v.string(), v.null())),
  organizationId: v.optional(v.id("organizations")),
  // Salas por página: default 10, teto 12 (cada sala pode ter 1.024 linhas e a
  // transação aceita 16 mil escritas). Valor acima do teto é rebaixado.
  pageSize: v.optional(v.number()),
};

async function migrationPage(
  ctx: MutationCtx,
  args: { cursor?: string | null; organizationId?: Id<"organizations">; pageSize?: number }
) {
  const numItems = Math.max(
    1,
    Math.min(MIGRATION_PAGE_MAX, Math.floor(args.pageSize ?? MIGRATION_PAGE_DEFAULT))
  );
  const paginationOpts = { numItems, cursor: args.cursor ?? null };
  return args.organizationId
    ? await ctx.db
        .query("groupChats")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId!))
        .paginate(paginationOpts)
    : await ctx.db.query("groupChats").paginate(paginationOpts);
}

/**
 * Lista que a TABELA deve ter para uma sala ainda não migrada: o array legado
 * deduplicado por chave, com a regra de LGPD (sala NÃO acompanhada = vazia —
 * o `internalApplyJoinedGroup` legado chegava a gravar membros de sala não
 * acompanhada; esses somem na migração).
 */
function desiredParticipantsFromLegacy(group: Doc<"groupChats">) {
  return dedupeParticipants(
    participantsForStorage(group.monitored, group.participants ?? []).participants
  );
}

/** Eventos legados (cap 100) que faltam na tabela, por assinatura. */
function missingTimelineEntries(group: Doc<"groupChats">, rows: Doc<"groupTimeline">[]) {
  const have = new Set(rows.map((r) => timelineSignature(timelineRowToEntry(r))));
  return (group.timeline ?? []).slice(-GROUP_TIMELINE_CAP).filter((e) => !have.has(timelineSignature(e)));
}

/**
 * A tabela tem EXATAMENTE os eventos do array legado (mesmo multiconjunto de
 * assinaturas)? Se não, o backfill substitui a tabela pela lista do array.
 */
function timelineMatchesLegacy(group: Doc<"groupChats">, rows: Doc<"groupTimeline">[]) {
  const legacy = (group.timeline ?? []).slice(-GROUP_TIMELINE_CAP).map(timelineSignature).sort();
  const table = rows.map((r) => timelineSignature(timelineRowToEntry(r))).sort();
  return legacy.length === table.length && legacy.every((sig, i) => sig === table[i]);
}

/**
 * Passo 1: copia `participants`/`timeline` legados para as tabelas (dedupe por
 * chave / por assinatura do evento). NÃO remove os arrays; idempotente.
 */
export const internalBackfillGroupParticipants = internalMutation({
  args: migrationArgs,
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    pending: v.number(),
    alreadyMigrated: v.number(),
    participantsInserted: v.number(),
    participantsUpdated: v.number(),
    participantsDeleted: v.number(),
    timelineInserted: v.number(),
    lgpdDropped: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
    scheduledNext: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const now = Date.now();
    const page = await migrationPage(ctx, args);
    let pending = 0;
    let alreadyMigrated = 0;
    let participantsInserted = 0;
    let participantsUpdated = 0;
    let participantsDeleted = 0;
    let timelineInserted = 0;
    let lgpdDropped = 0;
    for (const group of page.page) {
      if (isGroupMigrated(group)) {
        alreadyMigrated++;
        continue;
      }
      const desired = desiredParticipantsFromLegacy(group);
      if (group.monitored !== true) lgpdDropped += (group.participants ?? []).length;
      const rows = await loadParticipantRows(ctx, group._id);
      const timelineRows = await loadTimelineRows(ctx, group._id);
      const timelineOk = timelineMatchesLegacy(group, timelineRows);
      const legacyTimeline = (group.timeline ?? []).slice(-GROUP_TIMELINE_CAP);
      const diff = diffParticipantsTable(rows, desired);
      if (!diff.ok || !timelineOk) pending++;
      if (dryRun) {
        participantsInserted += diff.missing;
        participantsUpdated += diff.changed;
        participantsDeleted += diff.extra;
        if (!timelineOk) timelineInserted += legacyTimeline.length;
        continue;
      }
      const res = await syncParticipantsTable(ctx, group, desired, now, rows);
      participantsInserted += res.inserted;
      participantsUpdated += res.updated;
      participantsDeleted += res.deleted;
      // A tabela passa a ser a cópia do array (não só "insere o que falta"):
      // o array corta pelo mais antigo INSERIDO e a tabela pelo menor `at`,
      // então um evento atrasado faria as duas divergirem para sempre.
      if (!timelineOk) {
        timelineInserted += await replaceTimelineRows(ctx, group, legacyTimeline, timelineRows);
      }
    }

    const continueCursor = page.isDone ? null : page.continueCursor;
    let scheduledNext = false;
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.groupChats.internalBackfillGroupParticipants, {
        dryRun: false,
        cursor: page.continueCursor,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        ...(args.pageSize ? { pageSize: args.pageSize } : {}),
      });
      scheduledNext = true;
    }
    console.log(
      JSON.stringify({
        op: "groupParticipantsBackfill",
        dryRun,
        scanned: page.page.length,
        pending,
        participantsInserted,
        timelineInserted,
      })
    );
    return {
      dryRun,
      scanned: page.page.length,
      pending,
      alreadyMigrated,
      participantsInserted,
      participantsUpdated,
      participantsDeleted,
      timelineInserted,
      lgpdDropped,
      isDone: page.isDone,
      continueCursor,
      scheduledNext,
    };
  },
});

/**
 * Passo 2: para cada sala cuja tabela de MEMBROS bate com o array legado
 * (mesmas chaves, linhas iguais campo a campo), carimba
 * `participantsMigratedAt` e apaga `participants`/`timeline` do doc — é aqui
 * que o doc encolhe. Sala com membros divergentes é RECUSADA e reportada (rode
 * o backfill de novo). Divergência só de LINHA DO TEMPO é apenas reportada
 * (`timelineDivergent`), sem bloquear: o array corta pelo mais antigo inserido
 * e a tabela pelo menor `at`, então um evento atrasado pode deixá-las
 * diferentes para sempre, e o único leitor da linha do tempo é o `getGroup`.
 */
export const internalFinishGroupParticipantsMigration = internalMutation({
  args: migrationArgs,
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    finished: v.number(),
    alreadyMigrated: v.number(),
    divergent: v.number(),
    // Salas com eventos do array que faltam na tabela (só reportado; não
    // impede o finish) + amostra dos ids.
    timelineDivergent: v.number(),
    timelineDivergentSample: v.array(v.id("groupChats")),
    divergentSample: v.array(
      v.object({
        groupChatId: v.id("groupChats"),
        missing: v.number(),
        extra: v.number(),
        changed: v.number(),
        timelineMissing: v.number(),
        sample: v.array(v.string()),
      })
    ),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
    scheduledNext: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const now = Date.now();
    const page = await migrationPage(ctx, args);
    let finished = 0;
    let alreadyMigrated = 0;
    let divergent = 0;
    let timelineDivergent = 0;
    const timelineDivergentSample: Id<"groupChats">[] = [];
    const divergentSample: {
      groupChatId: Id<"groupChats">;
      missing: number;
      extra: number;
      changed: number;
      timelineMissing: number;
      sample: string[];
    }[] = [];
    for (const group of page.page) {
      if (isGroupMigrated(group)) {
        alreadyMigrated++;
        continue;
      }
      const rows = await loadParticipantRows(ctx, group._id);
      const desired = desiredParticipantsFromLegacy(group);
      const diff = diffParticipantsTable(rows, desired);
      const timelineMissing = missingTimelineEntries(group, await loadTimelineRows(ctx, group._id))
        .length;
      if (timelineMissing > 0) {
        timelineDivergent++;
        if (timelineDivergentSample.length < 20) timelineDivergentSample.push(group._id);
      }
      if (!diff.ok) {
        divergent++;
        if (divergentSample.length < 20) {
          divergentSample.push({
            groupChatId: group._id,
            missing: diff.missing,
            extra: diff.extra,
            changed: diff.changed,
            timelineMissing,
            sample: diff.sample,
          });
        }
        continue;
      }
      finished++;
      if (!dryRun) {
        // Sem o array, a contagem passa a vir SÓ de `participantsCount` — doc
        // antigo pode não ter o campo (ou tê-lo defasado), então ele é
        // recalculado aqui pela mesma regra de `countParticipants` (lista
        // não vazia vence; sala sem lista mantém o que estava gravado).
        const active = desired.filter((p) => p.leftAt === undefined).length;
        await ctx.db.patch(group._id, {
          participantsMigratedAt: now,
          participants: undefined,
          timeline: undefined,
          ...(desired.length > 0 ? { participantsCount: active } : {}),
        });
        // Contagem espelhada na conversa (fase 4c) — só grava se mudou.
        await syncGroupSummaryToConversation(ctx, {
          ...group,
          participants: undefined,
          participantsCount: desired.length > 0 ? active : group.participantsCount,
        });
      }
    }

    const continueCursor = page.isDone ? null : page.continueCursor;
    let scheduledNext = false;
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.groupChats.internalFinishGroupParticipantsMigration, {
        dryRun: false,
        cursor: page.continueCursor,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        ...(args.pageSize ? { pageSize: args.pageSize } : {}),
      });
      scheduledNext = true;
    }
    console.log(
      JSON.stringify({
        op: "groupParticipantsFinish",
        dryRun,
        scanned: page.page.length,
        finished,
        divergent,
        timelineDivergent,
      })
    );
    return {
      dryRun,
      scanned: page.page.length,
      finished,
      alreadyMigrated,
      divergent,
      timelineDivergent,
      timelineDivergentSample,
      divergentSample,
      isDone: page.isDone,
      continueCursor,
      scheduledNext,
    };
  },
});

/**
 * Rollback: recompõe `participants`/`timeline` no doc a partir das tabelas e
 * limpa `participantsMigratedAt` (a leitura volta ao array; o dual-write
 * mantém as tabelas em dia). As tabelas NÃO são apagadas.
 */
export const internalRestoreGroupArraysFromTable = internalMutation({
  args: migrationArgs,
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    restored: v.number(),
    notMigrated: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
    scheduledNext: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const page = await migrationPage(ctx, args);
    let restored = 0;
    let notMigrated = 0;
    for (const group of page.page) {
      if (!isGroupMigrated(group)) {
        notMigrated++;
        continue;
      }
      restored++;
      if (dryRun) continue;
      const participants = await participantsOf(ctx, group);
      const timeline = await timelineOf(ctx, group);
      await ctx.db.patch(group._id, {
        participants,
        timeline,
        participantsMigratedAt: undefined,
      });
    }

    const continueCursor = page.isDone ? null : page.continueCursor;
    let scheduledNext = false;
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.groupChats.internalRestoreGroupArraysFromTable, {
        dryRun: false,
        cursor: page.continueCursor,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        ...(args.pageSize ? { pageSize: args.pageSize } : {}),
      });
      scheduledNext = true;
    }
    return {
      dryRun,
      scanned: page.page.length,
      restored,
      notMigrated,
      isDone: page.isDone,
      continueCursor,
      scheduledNext,
    };
  },
});
