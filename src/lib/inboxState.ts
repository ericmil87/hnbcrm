import { VOCAB } from "./vocab";
import { aiStateReasonLabel } from "./aiStateReasons";
import { isAiPaused, type ConversationAiMode } from "../../convex/lib/conversationAiMode";
import { CONTACT_RELATION_AI_REASON } from "../../convex/lib/contactRelation";
import {
  MAIN_RELATION_FILTERS,
  MORE_RELATION_FILTERS,
  RELATION_FILTER_LABEL,
  relationEmptyMessage,
  type RelationFilter,
} from "./contactRelationList";

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
    // Contato que não é cliente: o estado é "IA desligada · <Tipo>" (botão da IA e selo), não uma espera.
    if (state.reason === CONTACT_RELATION_AI_REASON) return null;
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

/**
 * Conversa aberta que o servidor já não devolve (ex.: "Não lidas" some com ela
 * ao ser marcada como lida): entra de volta na lista, na posição da hora da
 * última mensagem (lista do mais recente ao mais antigo). Sem duplicar quando o
 * servidor ainda a devolve; sem hora, vai ao topo.
 */
export function mergeOpenConversation<T extends { _id?: string; lastMessageAt?: number | null }>(
  list: readonly T[],
  open: T | null | undefined
): T[] {
  if (!open || list.some((c) => c._id === open._id)) return [...list];
  const at = open.lastMessageAt;
  const index = typeof at === "number" ? list.findIndex((c) => (c.lastMessageAt ?? 0) < at) : 0;
  const pos = index === -1 ? list.length : index;
  return [...list.slice(0, pos), open, ...list.slice(pos)];
}

/** Conversas com mensagem não lida no lote carregado (contador do chip "Não lidas"). */
export function countUnreadConversations(list: readonly { unreadCount?: number | null }[]): number {
  return list.reduce((n, c) => n + ((c.unreadCount ?? 0) > 0 ? 1 : 0), 0);
}

export type InboxAiFilter = "on" | "off";

/** Filtros de tela que os chips do celular ligam/desligam. */
export interface InboxChipState {
  kind: ConversationKindFilter;
  unreadOnly: boolean;
  /** Chip "Minhas": responsável do lead ou conversa roteada para mim (filtro de servidor, `mine`). */
  mine: boolean;
  labelId: string | null;
  /** Chip "Etapa": etapa do funil (filtro de servidor, `stageId`). */
  stageId: string | null;
  /** Chip "IA": só onde a IA atende ("on") ou só onde não atende ("off") (filtro de servidor, `ai`). */
  ai: InboxAiFilter | null;
  /** Canal/conta (preferência em localStorage, escolhida no ⋯ ou no desktop). */
  channel: string | null;
  configId: string | null;
  /** Tipo de contato (`?tipo=`, filtro de servidor `relation`): Leads, Pessoais, Equipe… */
  relation?: RelationFilter | null;
}

/** Nenhum filtro de tela: é quando "Todas" fica marcado. */
export const NO_CHIP_FILTERS: InboxChipState = {
  kind: "all",
  unreadOnly: false,
  mine: false,
  labelId: null,
  stageId: null,
  ai: null,
  channel: null,
  configId: null,
  relation: null,
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
  /** Filtro escolhido em "Mais filtros": chip marcado com ✕ (tocar desliga). */
  removable?: boolean;
}

const LABEL_CHIP = "label:";

/** Algum filtro de tela ligado? ("Todas" só fica marcado sem nenhum.) */
export function hasChipFilters(state: InboxChipState): boolean {
  return (
    state.kind !== "all" ||
    state.unreadOnly ||
    state.mine ||
    !!state.labelId ||
    !!state.stageId ||
    !!state.ai ||
    !!state.channel ||
    !!state.configId ||
    !!state.relation
  );
}

/** Tipo escolhido fora da fileira principal (Equipe, Fornecedores… em "Mais filtros"). */
function moreRelation(state: InboxChipState): RelationFilter | null {
  return state.relation && MORE_RELATION_FILTERS.includes(state.relation) ? state.relation : null;
}

/**
 * Chips da lista (estilo WhatsApp): Todas · Não lidas · Minhas · Leads ·
 * Pessoais · Grupos. "Grupos" só com grupo na org (ou o filtro guardado em
 * "Grupos"). Canal, conta, "Diretas" e o tipo escolhido em "Mais filtros"
 * (Equipe, Fornecedores…) só aparecem quando ativos, sempre marcados: nunca há
 * filtro ativo sem chip que o desligue, e "Todas" só fica marcado sem nenhum.
 * `unreadMore` = pode haver mais não lidas além do lote ("12+").
 *
 * - `mobile` (padrão): fileira que desliza; também uma por etiqueta, "Etapa" e "IA".
 * - `desktop`: SÓ a fileira principal (sem rolagem lateral); etiqueta, etapa, IA,
 *   canal e tipo são escolhidos no "Mais filtros" (▾) e entram como chip com ✕.
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
    stageLabel,
    showAi = false,
    layout = "mobile",
  }: {
    labels: readonly { _id: string; name: string; color: string }[];
    showGroups: boolean;
    unreadCount: number;
    unreadMore?: boolean;
    /** Rótulos do canal/conta ativos (ex.: "Instagram", "WhatsApp ····1234"). */
    channelLabel?: string;
    accountLabel?: string;
    /** Nome da etapa escolhida (ainda desconhecido = "Etapa"). */
    stageLabel?: string;
    /** A org usa IA (ver `listShowsAi`): mostra o chip "IA". */
    showAi?: boolean;
    layout?: "mobile" | "desktop";
  }
): InboxChip[] {
  const desktop = layout === "desktop";
  const chips: InboxChip[] = [
    { id: "all", label: "Todas", pressed: !hasChipFilters(state) },
    {
      id: "unread",
      label: "Não lidas",
      pressed: state.unreadOnly,
      count: unreadCount > 0 ? unreadCount : undefined,
      ...(unreadCount > 0 && unreadMore ? { countMore: true } : {}),
    },
    { id: "mine", label: "Minhas", pressed: state.mine },
  ];
  for (const filter of MAIN_RELATION_FILTERS) {
    chips.push({ id: filter, label: RELATION_FILTER_LABEL[filter], pressed: state.relation === filter });
  }
  if (showGroups || state.kind === "group") {
    chips.push({ id: "group", label: "Grupos", pressed: state.kind === "group" });
  }
  // Ativos escolhidos fora da fileira: marcados, com ✕ (tocar desliga).
  const removable = desktop ? { removable: true } : {};
  const more = moreRelation(state);
  if (more) chips.push({ id: "relation", label: RELATION_FILTER_LABEL[more], pressed: true, removable: true });
  if (state.kind === "direct") chips.push({ id: "direct", label: "Diretas", pressed: true, ...removable });
  if (state.channel) chips.push({ id: "channel", label: channelLabel || state.channel, pressed: true, ...removable });
  if (state.configId) chips.push({ id: "account", label: accountLabel || "Conta", pressed: true, ...removable });
  if (desktop) {
    const label = state.labelId ? labels.find((l) => l._id === state.labelId) : undefined;
    if (label) {
      chips.push({ id: `${LABEL_CHIP}${label._id}`, label: label.name, color: label.color, pressed: true, removable: true });
    }
    if (state.stageId) chips.push({ id: "stage", label: stageLabel || "Etapa", pressed: true, removable: true });
    if (state.ai) chips.push({ id: "ai", label: AI_FILTER_LABEL[state.ai], pressed: true, removable: true });
    return chips;
  }
  for (const l of labels) {
    chips.push({ id: `${LABEL_CHIP}${l._id}`, label: l.name, color: l.color, pressed: state.labelId === l._id });
  }
  chips.push({ id: "stage", label: state.stageId ? stageLabel || "Etapa" : "Etapa", pressed: !!state.stageId });
  if (showAi || state.ai) {
    chips.push({ id: "ai", label: state.ai ? AI_FILTER_LABEL[state.ai] : "IA", pressed: !!state.ai });
  }
  return chips;
}

export interface InboxMoreFiltersModel {
  /** Chips da fileira que não couberam (desktop, uma linha só): seção "Filtros" no topo. */
  filters: { id: string; label: string; count?: number; countMore?: boolean; pressed: boolean }[];
  /** Tipo: Equipe, Fornecedores, Parceiros, Robôs, Sem tipo (escolha única; tocar no marcado desliga). */
  types: { id: RelationFilter; label: string; selected: boolean }[];
  /** Etapa (abre a escolha das etapas): rótulo com o nome escolhido. */
  stage: { label: string; active: boolean };
  /** IA (só em org que usa IA ou com o filtro ligado). */
  ai: { label: string; active: boolean } | null;
  /** Canal/Conta (só com algo para escolher ou ativo). */
  channel: { label: string; active: boolean } | null;
  labels: { id: string; name: string; color: string; selected: boolean }[];
  archived: boolean;
  /** Filtros ativos que moram aqui (marca o ▾). */
  activeCount: number;
}

/**
 * "Mais filtros" (▾ no fim da fileira): o que não cabe na fileira principal.
 * Escolher aqui liga o filtro e ele aparece na fileira como chip com ✕.
 */
export function inboxMoreFilters(
  state: InboxChipState,
  {
    labels,
    showAi = false,
    showChannel = false,
    stageLabel,
    channelLabel,
    showArchived = false,
    overflow = [],
  }: {
    labels: readonly { _id: string; name: string; color: string }[];
    /** Chips que não couberam na fileira (`fitChips`), na ordem dela. */
    overflow?: readonly Pick<InboxChip, "id" | "label" | "count" | "countMore" | "pressed">[];
    showAi?: boolean;
    /** Há canal/conta/tipo para escolher (`hasSheetFilters`). */
    showChannel?: boolean;
    stageLabel?: string;
    /** Rótulo do canal/conta ativo. */
    channelLabel?: string;
    showArchived?: boolean;
  }
): InboxMoreFiltersModel {
  const channelActive = !!state.channel || !!state.configId || state.kind === "direct";
  const activeCount =
    (moreRelation(state) ? 1 : 0) +
    (state.stageId ? 1 : 0) +
    (state.ai ? 1 : 0) +
    (channelActive ? 1 : 0) +
    (state.labelId ? 1 : 0);
  return {
    filters: overflow.map(({ id, label, count, countMore, pressed }) => ({
      id,
      label,
      pressed,
      ...(count !== undefined ? { count } : {}),
      ...(countMore ? { countMore } : {}),
    })),
    types: MORE_RELATION_FILTERS.map((id) => ({ id, label: RELATION_FILTER_LABEL[id], selected: state.relation === id })),
    stage: { label: state.stageId ? stageLabel || "Etapa" : "Todas as etapas", active: !!state.stageId },
    ai: showAi || state.ai ? { label: state.ai ? AI_FILTER_LABEL[state.ai] : "Todas", active: !!state.ai } : null,
    channel:
      showChannel || channelActive
        ? { label: channelActive ? channelLabel || (state.kind === "direct" ? "Diretas" : "Filtrado") : "Todos", active: channelActive }
        : null,
    labels: labels.map((l) => ({ id: l._id, name: l.name, color: l.color, selected: state.labelId === l._id })),
    archived: showArchived,
    activeCount,
  };
}

/** Escolher um tipo (chip ou "Mais filtros"): o mesmo de novo desliga. */
export function applyRelationFilter(state: InboxChipState, filter: RelationFilter | null): InboxChipState {
  return { ...state, relation: filter && state.relation === filter ? null : filter };
}

export const AI_FILTER_LABEL: Record<InboxAiFilter, string> = {
  on: "IA atendendo",
  off: "IA desligada",
};

/** Próximo estado ao tocar num chip: "Todas" limpa tudo; os demais ligam/desligam. */
export function applyInboxChip(id: string, state: InboxChipState): InboxChipState {
  if (id === "all") return NO_CHIP_FILTERS;
  if (id === "channel") return { ...state, channel: null, configId: null };
  if (id === "account") return { ...state, configId: null };
  if (id === "unread") return { ...state, unreadOnly: !state.unreadOnly };
  if (id === "mine") return { ...state, mine: !state.mine };
  if (id === "leads" || id === "personal") return applyRelationFilter(state, id);
  if (id === "relation") return { ...state, relation: null };
  // "Etapa" e "IA" escolhem num menu; tocar aqui só desliga (quem liga é o menu).
  if (id === "stage") return { ...state, stageId: null };
  if (id === "ai") return { ...state, ai: null };
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
  stageId?: string | null;
  ai?: InboxAiFilter | null;
  relation?: RelationFilter | null;
}): { text: string; chooseGroups: boolean; hint?: string } {
  const { kind, showArchived, queueFilterActive, labelId, unreadOnly, mine, stageId, ai, relation } = input;
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
  // Etapa e IA são pós-filtros do servidor sobre as conversas mais recentes (como "Minhas").
  if (stageId) return { text: "Nenhuma conversa nesta etapa", chooseGroups: false };
  if (ai) {
    return {
      text: `Nenhuma conversa com a ${ai === "on" ? "IA atendendo" : "IA desligada"} entre as mais recentes`,
      chooseGroups: false,
    };
  }
  if (relation) {
    const { text, hint } = relationEmptyMessage(relation);
    return { text: showArchived ? `${text} entre as arquivadas` : text, chooseGroups: false, ...(hint ? { hint } : {}) };
  }
  if (unreadOnly) return { text: "Nenhuma conversa não lida", chooseGroups: false };
  if (showArchived) return { text: "Nenhuma conversa arquivada", chooseGroups: false };
  if (labelId) return { text: "Nenhuma conversa com essa etiqueta", chooseGroups: false };
  return { text: VOCAB.conversations.empty.title, chooseGroups: false };
}

/** Id de documento do Convex (32 caracteres minúsculos/dígitos): barra lixo da URL antes de virar arg. */
export function isPlausibleConvexId(value: string | null | undefined): value is string {
  return !!value && /^[a-z0-9]{32}$/.test(value);
}

/** Campos da linha que dizem se a IA atende (`getConversations`; ausente = servidor antigo). */
export interface AiRowFields {
  aiMode?: string | null;
  aiAttending?: boolean | null;
  aiPausedUntil?: number | null;
}

/**
 * Estado da IA da linha, igual ao do cabeçalho: o servidor não lê o relógio,
 * então uma pausa COM PRAZO só aparece aqui (`isAiPaused` com `now`).
 * `null` = campo ausente (nada a mostrar).
 */
export function rowAiMode(row: AiRowFields, now: number): ConversationAiMode | null {
  const mode =
    row.aiMode === "auto" || row.aiMode === "suggest" || row.aiMode === "off"
      ? row.aiMode
      : typeof row.aiAttending === "boolean"
        ? row.aiAttending
          ? "auto"
          : "off"
        : null;
  if (mode === null) return null;
  return mode !== "off" && isAiPaused(row.aiPausedUntil ?? undefined, now) ? "off" : mode;
}

/**
 * Org que usa IA? Só então a lista mostra "desligada" (org sem IA vem toda
 * `off`) e o chip "IA". Filtro `?ai=` ativo mantém tudo visível para poder limpar.
 */
export function listShowsAi(rows: readonly AiRowFields[], aiFilterActive: boolean): boolean {
  return aiFilterActive || rows.some((r) => r.aiAttending === true || (r.aiMode && r.aiMode !== "off"));
}
