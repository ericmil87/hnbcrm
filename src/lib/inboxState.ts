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
  kind?: string;
  labelIds?: readonly string[] | null;
}

/**
 * Filtros SÓ de tela da lista (etiqueta e Diretas/Grupos): não mudam a query
 * do servidor, então o lote carregado é mantido.
 */
export function filterConversations<T extends FilterableConversation>(
  list: readonly T[],
  { kind, labelId }: { kind: ConversationKindFilter; labelId: string | null }
): T[] {
  return list.filter((c) => {
    if (labelId && !((c.labelIds ?? []) as readonly string[]).includes(labelId)) return false;
    if (kind === "group") return c.kind === "group";
    if (kind === "direct") return c.kind !== "group";
    return true;
  });
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
}): { text: string; chooseGroups: boolean } {
  const { kind, showArchived, queueFilterActive, labelId } = input;
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
  if (showArchived) return { text: "Nenhuma conversa arquivada", chooseGroups: false };
  if (labelId) return { text: "Nenhuma conversa com essa etiqueta", chooseGroups: false };
  return { text: VOCAB.conversations.empty.title, chooseGroups: false };
}
