/**
 * Campos que a LISTA do inbox precisa, desnormalizados em `conversations`
 * (perf Convex I/O, fase 4c).
 *
 * Antes, `getConversations` lia por conversa: a última mensagem (`first()` em
 * `messages` — e por isso reexecutava a cada recibo/reação/transcrição na
 * última mensagem), o doc inteiro do grupo (60–90 KB com `participants`) e o
 * `channelConfigs` (que muda a cada health check). Agora:
 *
 *  - última mensagem: `lastMessagePatchFor` é aplicado em TODO insert de
 *    `messages`, dentro do patch que já existe na conversa na mesma transação.
 *    Regra "não anda para trás": só grava se o `createdAt` da mensagem é ≥ o
 *    da prévia atual — exatamente o que o `first()` desc por
 *    `by_conversation_and_created` devolveria. Desde a onda 2 de I/O a prévia
 *    é a da última mensagem NÃO interna (inbound/outbound): nota interna e
 *    rascunho da IA (`isInternal`/`direction:"internal"`) não gravam prévia —
 *    toda sugestão da IA regravava os campos da lista. `lastMessageAt` não
 *    mudou de semântica (continua andando com qualquer mensagem).
 *  - grupo: `syncGroupSummaryToConversation` onde `subject`/`participants`/
 *    `participantsCount` mudam.
 *  - canal: `channelProviderPatch` onde `channelConfigId` é gravado.
 *
 * Leitura com fallback por campo: conversa sem o campo (não backfilled) cai no
 * caminho antigo só para ela. `INBOX_DENORM_READ=0` (env, lido em runtime)
 * força o caminho antigo inteiro — kill switch.
 *
 * `lastMessageBridgeExtra` NÃO é desnormalizado (enquete/contato/evento podem
 * ser grandes e a lista não usa): no caminho novo a query devolve `null`.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export const LIST_PREVIEW_MAX = 80;

type ContentType = "text" | "image" | "file" | "audio";
type Direction = "inbound" | "outbound" | "internal";

/** O mínimo de uma mensagem que a prévia lê. */
export type PreviewMessage = {
  content?: string;
  contentType: ContentType;
  direction: Direction;
  isInternal: boolean;
  createdAt: number;
  metadata?: any;
};

// Fallback label when a media message carries no caption of its own — mirrors the
// bracketed placeholders the ingress uses (see MEDIA_PLACEHOLDERS in whatsapp.ts).
export function mediaPlaceholder(contentType: ContentType, bridgeType: string | undefined): string {
  if (bridgeType === "sticker") return "[figurinha]";
  if (bridgeType === "video") return "[vídeo]";
  switch (contentType) {
    case "image":
      return "[imagem]";
    case "audio":
      return "[mensagem de voz]";
    case "file":
      return "[arquivo]";
    default:
      return "";
  }
}

// The list-row summary of a conversation's most recent NON-internal message: a
// short preview plus the few fields the inbox list needs to render an icon/state
// without loading the message. Internal notes / AI drafts never become the
// preview (onda 2 de I/O); `previewTextOf` still prefixes "Nota: " defensively.
export type LastMessageFields = {
  lastMessagePreview: string | null;
  lastMessageContentType: ContentType | null;
  lastMessageDirection: Direction | null;
  lastMessageBridgeType: string | null;
  // "Apagar para todos" (metadata.revoked) e o `bridgeExtra` da última
  // mensagem — a prévia da lista diz "Mensagem apagada" / usa a enquete/álbum.
  lastMessageRevoked: boolean;
  lastMessageBridgeExtra: Record<string, unknown> | null;
};

export const EMPTY_LAST_MESSAGE_FIELDS: LastMessageFields = {
  lastMessagePreview: null,
  lastMessageContentType: null,
  lastMessageDirection: null,
  lastMessageBridgeType: null,
  lastMessageRevoked: false,
  lastMessageBridgeExtra: null,
};

function bridgeTypeOf(message: PreviewMessage): string | null {
  return typeof message.metadata?.bridgeType === "string"
    ? (message.metadata.bridgeType as string)
    : null;
}

export function previewTextOf(message: PreviewMessage): string {
  const raw = (message.content ?? "").trim();
  let body =
    raw.length > 0 ? raw : mediaPlaceholder(message.contentType, bridgeTypeOf(message) ?? undefined);
  if (body.length > LIST_PREVIEW_MAX) {
    body = `${body.slice(0, LIST_PREVIEW_MAX - 1)}…`;
  }
  return message.isInternal ? `Nota: ${body}` : body;
}

/** A mensagem pode ser a prévia da lista? Nota interna e rascunho da IA, não. */
export function isPreviewMessage(message: Pick<PreviewMessage, "isInternal" | "direction">): boolean {
  return !message.isInternal && message.direction !== "internal";
}

/** Quantas mensagens recentes o fallback/backfill varre atrás da última não interna. */
export const PREVIEW_SCAN_LIMIT = 20;

/**
 * Última mensagem NÃO interna da conversa, varrendo no máximo
 * `PREVIEW_SCAN_LIMIT` mensagens (desc por criação). `unknown: true` quando as
 * 20 mais recentes são todas internas e há mais atrás — o chamador não sabe a
 * resposta (o backfill então não mexe na prévia).
 */
export async function findLastPreviewMessage(
  ctx: { db: QueryCtx["db"] | MutationCtx["db"] },
  conversationId: Id<"conversations">
): Promise<{ message: Doc<"messages"> | null; unknown: boolean }> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .take(PREVIEW_SCAN_LIMIT);
  const message = recent.find((m) => isPreviewMessage(m)) ?? null;
  return { message, unknown: message === null && recent.length === PREVIEW_SCAN_LIMIT };
}

/** Caminho antigo (lido da mensagem): inclui `lastMessageBridgeExtra`. */
export function lastMessageFieldsFor(message: PreviewMessage | null): LastMessageFields {
  if (!message) return { ...EMPTY_LAST_MESSAGE_FIELDS };
  const extra = message.metadata?.bridgeExtra;
  return {
    lastMessagePreview: previewTextOf(message),
    lastMessageContentType: message.contentType,
    lastMessageDirection: message.direction,
    lastMessageBridgeType: bridgeTypeOf(message),
    lastMessageRevoked: message.metadata?.revoked === true,
    lastMessageBridgeExtra:
      extra && typeof extra === "object" && !Array.isArray(extra)
        ? (extra as Record<string, unknown>)
        : null,
  };
}

/** Os campos gravados na conversa (sem condição). */
export type LastMessagePatch = {
  lastMessageId: Id<"messages">;
  lastMessagePreview: string;
  lastMessageContentType: ContentType;
  lastMessageDirection: Direction;
  lastMessageBridgeType: string | undefined;
  lastMessageRevoked: true | undefined;
  lastMessagePreviewAt: number;
};

export function lastMessageFieldsPatch(
  messageId: Id<"messages">,
  message: PreviewMessage
): LastMessagePatch {
  return {
    lastMessageId: messageId,
    lastMessagePreview: previewTextOf(message),
    lastMessageContentType: message.contentType,
    lastMessageDirection: message.direction,
    // `undefined` no patch REMOVE o campo — limpa o valor da mensagem anterior.
    lastMessageBridgeType: bridgeTypeOf(message) ?? undefined,
    lastMessageRevoked: message.metadata?.revoked === true ? true : undefined,
    lastMessagePreviewAt: message.createdAt,
  };
}

/** O que `lastMessagePatchFor` lê da conversa (o doc ANTES do patch). */
export type PreviewFloorConversation = {
  lastMessagePreviewAt?: number;
  lastMessageAt?: number;
  messageCount?: number;
};

/**
 * Patch da prévia para uma mensagem recém-inserida, ou `null` se ela é mais
 * antiga que a prévia atual (histórico do aparelho importado depois). Empate
 * vence a mais nova (inserida depois), como no índice.
 *
 * Piso quando a conversa JÁ tem mensagens mas ainda não tem prévia (antes do
 * backfill, ou prévia limpa pelo reparse): o piso é `lastMessageAt`, não 0.
 * Senão uma mensagem ANTIGA (histórico do aparelho, `createdAt = sentAt`)
 * gravaria a prévia e ela "andaria para trás" — e a leitura não corrige,
 * porque com o campo presente o fallback (`first()`) não roda. Abaixo do piso
 * não grava nada: a leitura segue no fallback até a próxima mensagem nova ou
 * o backfill.
 */
export function lastMessagePatchFor(
  conversation: PreviewFloorConversation,
  messageId: Id<"messages">,
  message: PreviewMessage
): LastMessagePatch | null {
  // Nota interna / rascunho da IA não viram prévia (onda 2 de I/O).
  if (!isPreviewMessage(message)) return null;
  const floor =
    conversation.lastMessagePreviewAt !== undefined
      ? conversation.lastMessagePreviewAt
      : (conversation.messageCount ?? 0) > 0
        ? (conversation.lastMessageAt ?? 0)
        : 0;
  if (message.createdAt < floor) return null;
  return lastMessageFieldsPatch(messageId, message);
}

/** Campos de prévia vazios — a leitura cai no fallback (`first()`). */
export const CLEARED_LAST_MESSAGE_PATCH = {
  lastMessageId: undefined,
  lastMessagePreview: undefined,
  lastMessageContentType: undefined,
  lastMessageDirection: undefined,
  lastMessageBridgeType: undefined,
  lastMessageRevoked: undefined,
  lastMessagePreviewAt: undefined,
} as const;

/**
 * Lê a mensagem recém-inserida e devolve o patch (ou `{}`), para os pontos de
 * escrita que só têm o id (ex.: `applyOutboundMessageSideEffects`).
 */
export async function lastMessagePatchForId(
  ctx: { db: MutationCtx["db"] },
  conversation: PreviewFloorConversation,
  messageId: Id<"messages">
): Promise<Partial<LastMessagePatch>> {
  const message = await ctx.db.get(messageId);
  if (!message) return {};
  return lastMessagePatchFor(conversation, messageId, message) ?? {};
}

// ── Leitura ──

/** Kill switch: `INBOX_DENORM_READ=0` volta a ler tudo pelo caminho antigo. */
export function inboxDenormReadEnabled(): boolean {
  return process.env.INBOX_DENORM_READ !== "0";
}

/** A conversa tem a prévia desnormalizada (ou não tem mensagem nenhuma)? */
export function hasDenormLastMessage(conversation: Doc<"conversations">): boolean {
  return conversation.lastMessagePreviewAt !== undefined || conversation.messageCount === 0;
}

export function lastMessageFieldsFromConversation(
  conversation: Doc<"conversations">
): LastMessageFields {
  if (conversation.lastMessagePreviewAt === undefined) return { ...EMPTY_LAST_MESSAGE_FIELDS };
  return {
    lastMessagePreview: conversation.lastMessagePreview ?? "",
    lastMessageContentType: conversation.lastMessageContentType ?? null,
    lastMessageDirection: conversation.lastMessageDirection ?? null,
    lastMessageBridgeType: conversation.lastMessageBridgeType ?? null,
    lastMessageRevoked: conversation.lastMessageRevoked === true,
    // Não desnormalizado (ver o cabeçalho).
    lastMessageBridgeExtra: null,
  };
}

// ── Grupo ──

type GroupLike = {
  subject: string;
  participants?: Array<{ leftAt?: number }>;
  participantsCount?: number;
};

/**
 * Membros ativos — a MESMA conta que a lista sempre fez: recontado da lista
 * (o `/group/list` do wuzapi devolve o campo dele zerado), com
 * `participantsCount` como fallback quando não há lista.
 */
export function groupParticipantsCountOf(group: GroupLike): number {
  return (
    group.participants?.filter((p) => p.leftAt === undefined).length ??
    group.participantsCount ??
    0
  );
}

export function groupSummaryFieldsOf(group: GroupLike): {
  groupSubject: string;
  groupParticipantsCount: number;
} {
  return { groupSubject: group.subject, groupParticipantsCount: groupParticipantsCountOf(group) };
}

/** Patch só com o que mudou (ou `null`). */
export function groupSummaryPatchFor(
  conversation: { groupSubject?: string; groupParticipantsCount?: number },
  group: GroupLike
): { groupSubject?: string; groupParticipantsCount?: number } | null {
  const next = groupSummaryFieldsOf(group);
  const patch: { groupSubject?: string; groupParticipantsCount?: number } = {};
  if (conversation.groupSubject !== next.groupSubject) patch.groupSubject = next.groupSubject;
  if (conversation.groupParticipantsCount !== next.groupParticipantsCount) {
    patch.groupParticipantsCount = next.groupParticipantsCount;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Espelha nome/contagem do grupo na conversa da sala. `group` deve ser o
 * estado DEPOIS da mudança (o doc + o patch aplicado). Sem conversa = no-op;
 * só escreve se mudou (não reexecuta a lista à toa).
 */
export async function syncGroupSummaryToConversation(
  ctx: { db: MutationCtx["db"] },
  group: GroupLike & { conversationId?: Id<"conversations"> }
): Promise<boolean> {
  if (!group.conversationId) return false;
  const conversation = await ctx.db.get(group.conversationId);
  if (!conversation) return false;
  const patch = groupSummaryPatchFor(conversation, group);
  if (!patch) return false;
  await ctx.db.patch(conversation._id, patch);
  return true;
}

/** Monta o `groupChat` da lista a partir da conversa (sem ler `groupChats`). */
export function groupChatFromConversation(
  conversation: Doc<"conversations">
): { subject: string; participantsCount: number; jid: string } | null {
  if (conversation.kind !== "group" || conversation.groupSubject === undefined) return null;
  return {
    subject: conversation.groupSubject,
    participantsCount: conversation.groupParticipantsCount ?? 0,
    // O JID da sala é o destino do dispatch da conversa (`externalChatId`),
    // o mesmo `groupChats.jid`.
    jid: conversation.externalChatId ?? "",
  };
}

// ── Canal ──

export function channelProviderOf(
  config: { provider?: "meta" | "bridge" | null } | null | undefined
): "meta" | "bridge" | undefined {
  if (!config) return undefined;
  return config.provider === "bridge" ? "bridge" : "meta";
}

/**
 * `channelProvider` para gravar junto com `channelConfigId`. Config ausente =
 * `undefined` (remove o campo; a leitura cai no fallback e trata como hoje).
 */
export function channelProviderPatch(
  config: { provider?: "meta" | "bridge" | null } | null | undefined
): { channelProvider: "meta" | "bridge" | undefined } {
  return { channelProvider: channelProviderOf(config) };
}

/**
 * Patch de `channelConfigId` + `channelProvider` quando o canal da conversa
 * muda (ou ainda não tem o provider espelhado). `{}` quando nada a fazer.
 */
export async function channelConfigPatchFor(
  ctx: { db: MutationCtx["db"] },
  conversation: { channelConfigId?: Id<"channelConfigs">; channelProvider?: "meta" | "bridge" },
  channelConfigId: Id<"channelConfigs"> | undefined
): Promise<{ channelConfigId?: Id<"channelConfigs">; channelProvider?: "meta" | "bridge" }> {
  if (!channelConfigId) return {};
  if (conversation.channelConfigId === channelConfigId && conversation.channelProvider !== undefined) {
    return {};
  }
  const config = await ctx.db.get(channelConfigId);
  return { channelConfigId, ...channelProviderPatch(config) };
}

/**
 * A mensagem mudou depois do insert (apagar para todos, edição): se ela é a
 * última da conversa, recalcula a prévia. Mensagem antiga não mexe em nada.
 */
export async function refreshLastMessagePreviewIfLast(
  ctx: { db: MutationCtx["db"] },
  message: PreviewMessage & { _id: Id<"messages">; conversationId: Id<"conversations"> }
): Promise<boolean> {
  const conversation = await ctx.db.get(message.conversationId);
  if (!conversation || conversation.lastMessageId !== message._id) return false;
  await ctx.db.patch(conversation._id, lastMessageFieldsPatch(message._id, message));
  return true;
}

// ── Backfill ──

const LAST_MESSAGE_KEYS = [
  "lastMessageId",
  "lastMessagePreview",
  "lastMessageContentType",
  "lastMessageDirection",
  "lastMessageBridgeType",
  "lastMessageRevoked",
  "lastMessagePreviewAt",
] as const;

/**
 * O que falta/difere na conversa, dado o estado real (última mensagem, grupo,
 * config). Patch vazio = já está certo — rodar de novo não escreve nada.
 *
 * Duas mudanças de comportamento ACEITAS na revisão da fase 4c (o caminho
 * antigo lia a fonte a cada render; o novo lê o espelho guardado):
 *  - canal: conversa cujo `channelConfigs` foi apagado DEPOIS de o provider
 *    ser espelhado continua usando o `channelProvider` guardado na janela de
 *    serviço (antes, config ausente = sem provider). Rodar este backfill
 *    nela remove o campo (`channelProviderOf(null)` = `undefined`) e a
 *    leitura volta ao comportamento antigo.
 *  - grupo: conversa de grupo cuja sala (`groupChats`) foi apagada pela
 *    cascata mostra o `groupSubject` guardado em vez do genérico "Grupo"
 *    (sem `source.group` o backfill não toca nos campos de grupo).
 */
export function listFieldsBackfillPatch(
  conversation: Doc<"conversations">,
  source: {
    // Última mensagem NÃO interna (`findLastPreviewMessage`); `undefined` =
    // desconhecida (só notas nas 20 mais recentes) → a prévia não é tocada.
    lastMessage: (PreviewMessage & { _id: Id<"messages"> }) | null | undefined;
    group: (GroupLike & { _id: Id<"groupChats"> }) | null;
    config: { provider?: "meta" | "bridge" | null } | null;
  }
): {
  patch: Record<string, unknown>;
  lastMessage: boolean;
  group: boolean;
  provider: boolean;
} {
  const patch: Record<string, unknown> = {};
  let lastMessage = false;
  if (source.lastMessage !== undefined) {
    const desired: Record<string, unknown> =
      source.lastMessage && isPreviewMessage(source.lastMessage)
        ? lastMessageFieldsPatch(source.lastMessage._id, source.lastMessage)
        : CLEARED_LAST_MESSAGE_PATCH;
    for (const key of LAST_MESSAGE_KEYS) {
      if ((conversation as Record<string, unknown>)[key] !== desired[key]) {
        patch[key] = desired[key];
        lastMessage = true;
      }
    }
  }
  let group = false;
  if (conversation.kind === "group" && source.group) {
    const groupPatch = groupSummaryPatchFor(conversation, source.group);
    if (groupPatch) {
      Object.assign(patch, groupPatch);
      group = true;
    }
  }
  let provider = false;
  if (conversation.channelConfigId) {
    const desiredProvider = channelProviderOf(source.config);
    if (conversation.channelProvider !== desiredProvider) {
      patch.channelProvider = desiredProvider;
      provider = true;
    }
  }
  return { patch, lastMessage, group, provider };
}
