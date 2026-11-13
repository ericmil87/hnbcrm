import { VOCAB } from "./vocab";
import { aiStateReasonLabel } from "./aiStateReasons";

// Lógica pura da tela de Conversas (sem React): suspeita de robô, repasse
// pendente, chip de estado da IA, filtros da lista e a decisão "param da URL →
// conversa aberta". Testada em `inboxState.test.ts`.

// Guardrail anti-bot (v0.65): `conversations.botSuspicion` sem `clearedAt` =
// a IA parou de responder porque o outro lado parece um robô. "Devolver para
// IA" (ou rejeitar o repasse) limpa no backend.
export type BotSuspicion = {
  at: number;
  source: "heuristic" | "model";
  reason: string;
  clearedAt?: number;
};

export function activeBotSuspicion(
  conversation: { botSuspicion?: BotSuspicion } | null | undefined
): BotSuspicion | null {
  const s = conversation?.botSuspicion;
  return s && s.clearedAt === undefined ? s : null;
}

// `lead.handoffState` some quando nunca houve repasse; "completed" é repasse
// já resolvido. Qualquer outro estado = alguém precisa assumir a conversa.
export type LeadHandoffState = { status: string; reason?: string } | undefined | null;

export function isHandoffPending(state: LeadHandoffState): boolean {
  return !!state && state.status !== "completed";
}

export type AiConvState =
  | {
      status: string;
      reason: string | null;
      at: number;
      afterLastInbound: boolean;
    }
  | null
  | undefined;

export type AiChipInfo = { label: string; tone: "processing" | "waiting" };

// "done" ou item antigo (já superado por uma mensagem inbound mais nova) → sem chip.
export function aiStateChipInfo(state: AiConvState): AiChipInfo | null {
  if (!state || state.status === "done") return null;
  if (state.status === "pending" || state.status === "processing") {
    return { label: "IA preparando resposta…", tone: "processing" };
  }
  if ((state.status === "skipped" || state.status === "failed") && state.afterLastInbound) {
    const reasonLabel = state.reason ? aiStateReasonLabel(state.reason) : "motivo desconhecido";
    return { label: `IA em espera: ${reasonLabel}`, tone: "waiting" };
  }
  return null;
}

// Filtro "Todas / Diretas / Grupos" da lista de conversas.
export type ConversationKindFilter = "all" | "direct" | "group";
export const KIND_FILTER_KEY = "hnbcrm.inbox.kindFilter";
export const KIND_FILTERS: { id: ConversationKindFilter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "direct", label: "Diretas" },
  { id: "group", label: "Grupos" },
];

export function readKindFilter(
  storage: Pick<Storage, "getItem"> | null = typeof window === "undefined" ? null : window.localStorage
): ConversationKindFilter {
  try {
    const stored = storage?.getItem(KIND_FILTER_KEY);
    if (stored === "direct" || stored === "group" || stored === "all") return stored;
  } catch {
    /* localStorage bloqueado (janela anônima, dados de site desligados) */
  }
  return "all";
}

interface FilterableConversation {
  _id?: string;
  kind?: string;
  labelIds?: readonly string[] | null;
  unreadCount?: number | null;
}

/**
 * Filtros SÓ de tela da lista (etiqueta, Diretas/Grupos e "Não lidas"): não
 * mudam a query do servidor, então o lote carregado é mantido.
 */
export function filterConversations<T extends FilterableConversation>(
  list: readonly T[],
  {
    kind,
    labelId,
    unreadOnly = false,
    keepId = null,
  }: {
    kind: ConversationKindFilter;
    labelId: string | null;
    unreadOnly?: boolean;
    /** Conversa aberta: não some de "Não lidas" ao ser marcada como lida. */
    keepId?: string | null;
  }
): T[] {
  return list.filter((c) => {
    if (unreadOnly && !((c.unreadCount ?? 0) > 0) && !(keepId && c._id === keepId)) return false;
    if (labelId && !((c.labelIds ?? []) as readonly string[]).includes(labelId)) return false;
    if (kind === "group") return c.kind === "group";
    if (kind === "direct") return c.kind !== "group";
    return true;
  });
}

/** Conversas com mensagem não lida no lote carregado (contador do chip "Não lidas"). */
export function countUnreadConversations(list: readonly { unreadCount?: number | null }[]): number {
  return list.reduce((n, c) => n + ((c.unreadCount ?? 0) > 0 ? 1 : 0), 0);
}

/** Filtros de tela que os chips do celular ligam/desligam. */
export interface InboxChipState {
  kind: ConversationKindFilter;
  unreadOnly: boolean;
  /** Chip "Minhas": responsável do lead ou conversa roteada para mim (filtro de servidor, `mine`). */
  mine: boolean;
  labelId: string | null;
  /** Canal/conta (preferência em localStorage, escolhida no ⋯ ou no desktop). */
  channel: string | null;
  configId: string | null;
}

/** Nenhum filtro de tela: é quando "Todas" fica marcado. */
export const NO_CHIP_FILTERS: InboxChipState = {
  kind: "all",
  unreadOnly: false,
  mine: false,
  labelId: null,
  channel: null,
  configId: null,
};

export interface InboxChip {
  /** "all" | "unread" | "group" | "direct" | "label:<id>" */
  id: string;
  label: string;
  pressed: boolean;
  count?: number;
  /** Cor da etiqueta (bolinha antes do nome). */
  color?: string;
  /** O contador é um mínimo ("12+"). */
  countMore?: boolean;
}

const LABEL_CHIP = "label:";

/**
 * Chips da lista no celular (estilo WhatsApp): Todas · Não lidas · Grupos ·
 * uma por etiqueta. "Grupos" só com grupo na org (ou o filtro guardado em
 * "Grupos"). "Diretas", canal e conta (escolhidos no ⋯ ou no desktop e
 * guardados no aparelho) só aparecem quando ativos, sempre marcados: nunca há
 * filtro ativo sem chip que o desligue, e "Todas" só fica marcado sem nenhum.
 * `unreadMore` = pode haver mais não lidas além do lote ("12+").
 */
export function inboxFilterChips(
  state: InboxChipState,
  {
    labels,
    showGroups,
    unreadCount,
    unreadMore = false,
    channelLabel,
    accountLabel,
  }: {
    labels: readonly { _id: string; name: string; color: string }[];
    showGroups: boolean;
    unreadCount: number;
    unreadMore?: boolean;
    /** Rótulos do canal/conta ativos (ex.: "Instagram", "WhatsApp ····1234"). */
    channelLabel?: string;
    accountLabel?: string;
  }
): InboxChip[] {
  const none =
    state.kind === "all" && !state.unreadOnly && !state.mine && !state.labelId && !state.channel && !state.configId;
  const chips: InboxChip[] = [
    { id: "all", label: "Todas", pressed: none },
    {
      id: "unread",
      label: "Não lidas",
      pressed: state.unreadOnly,
      count: unreadCount > 0 ? unreadCount : undefined,
      ...(unreadCount > 0 && unreadMore ? { countMore: true } : {}),
    },
    { id: "mine", label: "Minhas", pressed: state.mine },
  ];
  if (state.channel) chips.push({ id: "channel", label: channelLabel || state.channel, pressed: true });
  if (state.configId) chips.push({ id: "account", label: accountLabel || "Conta", pressed: true });
  if (showGroups || state.kind === "group") {
    chips.push({ id: "group", label: "Grupos", pressed: state.kind === "group" });
  }
  if (state.kind === "direct") chips.push({ id: "direct", label: "Diretas", pressed: true });
  for (const l of labels) {
    chips.push({ id: `${LABEL_CHIP}${l._id}`, label: l.name, color: l.color, pressed: state.labelId === l._id });
  }
  return chips;
}

/** Próximo estado ao tocar num chip: "Todas" limpa tudo; os demais ligam/desligam. */
export function applyInboxChip(id: string, state: InboxChipState): InboxChipState {
  if (id === "all") return NO_CHIP_FILTERS;
  if (id === "channel") return { ...state, channel: null, configId: null };
  if (id === "account") return { ...state, configId: null };
  if (id === "unread") return { ...state, unreadOnly: !state.unreadOnly };
  if (id === "mine") return { ...state, mine: !state.mine };
  if (id === "group") return { ...state, kind: state.kind === "group" ? "all" : "group" };
  if (id === "direct") return { ...state, kind: state.kind === "direct" ? "all" : "direct" };
  if (id.startsWith(LABEL_CHIP)) {
    const labelId = id.slice(LABEL_CHIP.length);
    return { ...state, labelId: state.labelId === labelId ? null : labelId };
  }
  return state;
}

/**
 * Chave do lote da lista: a combinação de filtros do SERVIDOR (arquivadas,
 * fila e canal/conta). Trocar a chave volta o lote para 50; filtros só de tela
 * não entram aqui e mantêm o limite.
 */
export function listFilterKey(
  showArchived: boolean,
  queueArgs: Record<string, unknown>,
  channelArgs: Record<string, unknown>
): string {
  return `${showArchived ? "archived" : "active"}|${JSON.stringify(queueArgs)}|${JSON.stringify(channelArgs)}`;
}

/**
 * A conversa do deep-link, fora da lista carregada, só é fixada no topo se
 * PERTENCE à aba/filtro em tela: uma conversa ativa aberta por link aparecia
 * no topo de "Arquivadas" (e um 1:1 no topo de "Grupos") só por não estar na
 * lista carregada — parecia arquivada sem estar.
 */
export function linkedMatchesView(
  linked: { archivedAt?: number | null; kind?: string } | null | undefined,
  showArchived: boolean,
  kind: ConversationKindFilter
): boolean {
  if (!linked) return false;
  if (Boolean(linked.archivedAt) !== showArchived) return false;
  if (kind === "all") return true;
  return kind === "group" ? linked.kind === "group" : linked.kind !== "group";
}

export type ConversationParamAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "select"; id: string; archivedTab?: boolean };

/**
 * Máquina "param `?conversation=` → conversa aberta" (o efeito URL → estado do
 * Inbox). Chamada só DEPOIS do guarda de escrita em voo.
 * - sem param e com conversa aberta: o "voltar" do navegador fechou → `close`;
 * - id na lista carregada: abre direto;
 * - id fora da lista (arquivada ou além do lote): espera o resolver trazer o
 *   documento e, ao chegar, abre; a aba da lista acompanha a conversa
 *   (`archivedTab`) só nesta abertura.
 */
export function decideConversationParamAction(input: {
  param: string | null;
  selected: string | null;
  listLoaded: boolean;
  inList: boolean;
  linked: { _id: string; archivedAt?: number | null } | null | undefined;
  showArchived: boolean;
}): ConversationParamAction {
  const { param, selected, listLoaded, inList, linked, showArchived } = input;
  if (!param) return selected ? { type: "close" } : { type: "none" };
  if (param === selected) return { type: "none" };
  if (!listLoaded) return { type: "none" };
  if (inList) return { type: "select", id: param };
  if (!linked || linked._id !== param) return { type: "none" };
  const linkedArchived = Boolean(linked.archivedAt);
  return linkedArchived !== showArchived
    ? { type: "select", id: param, archivedTab: linkedArchived }
    : { type: "select", id: param };
}

/**
 * Texto do estado vazio da lista. O filtro Diretas/Grupos vem ANTES de
 * "arquivadas" na cadeia (review de correção nº 17): com o filtro em "Grupos" e
 * nenhum grupo arquivado, a tela dizia "Nenhuma conversa arquivada" — mentindo,
 * porque havia conversas diretas arquivadas escondidas pelo filtro.
 * `chooseGroups` = mostrar o atalho "Escolher grupos".
 */
export function emptyListMessage(input: {
  kind: ConversationKindFilter;
  showArchived: boolean;
  queueFilterActive: boolean;
  labelId: string | null;
  unreadOnly?: boolean;
  mine?: boolean;
}): { text: string; chooseGroups: boolean } {
  const { kind, showArchived, queueFilterActive, labelId, unreadOnly, mine } = input;
  if (kind === "group") {
    return showArchived
      ? { text: "Nenhum grupo arquivado — mude o filtro para ver as conversas diretas", chooseGroups: false }
      : { text: "Nenhum grupo acompanhado", chooseGroups: true };
  }
  if (kind === "direct") {
    return { text: showArchived ? "Nenhuma conversa direta arquivada" : "Nenhuma conversa direta", chooseGroups: false };
  }
  if (queueFilterActive) {
    return {
      text: showArchived ? "Nenhuma conversa arquivada nesta fila" : "Nenhuma conversa nesta fila",
      chooseGroups: false,
    };
  }
  if (mine) return { text: "Nenhuma conversa atribuída a você", chooseGroups: false };
  if (unreadOnly) return { text: "Nenhuma conversa não lida", chooseGroups: false };
  if (showArchived) return { text: "Nenhuma conversa arquivada", chooseGroups: false };
  if (labelId) return { text: "Nenhuma conversa com essa etiqueta", chooseGroups: false };
  return { text: VOCAB.conversations.empty.title, chooseGroups: false };
}
