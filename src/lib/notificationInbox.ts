import type { Doc } from "../../convex/_generated/dataModel";
import { PUSH_BADGE_CAP } from "../../convex/lib/webPush";
import { TAB_ROUTES } from "./routes";

/** Item do feed do sino: o doc + campos derivados por `notifications.list` (D1 back). */
export type InboxNotification = Doc<"notifications"> & {
  group?: string;
  leadId?: string | null;
  resolvedByName?: string | null;
};

type NotificationType = Doc<"notifications">["type"];

/** Badge do sino: o servidor conta até 100, a UI mostra "99+". */
export function bellBadgeLabel(n: number): string | null {
  if (!n || n <= 0) return null;
  return n >= 100 ? "99+" : String(n);
}

/** Contagem por organização: o servidor para em 20 → "20+". */
export function orgNewsLabel(n: number): string | null {
  if (!n || n <= 0) return null;
  return n >= 20 ? "20+" : String(n);
}

export function bellAriaLabel(unseen: number, unread: number): string {
  const badge = bellBadgeLabel(unseen);
  if (badge) return `Notificações, ${badge} ${unseen === 1 ? "nova" : "novas"}`;
  const unreadBadge = bellBadgeLabel(unread);
  if (unreadBadge) return `Notificações, ${unreadBadge} não lidas`;
  return "Notificações";
}

export interface OrgNewsEntry {
  organizationId: string;
  organizationName: string;
  unread: number;
  unseen: number;
}

/** Novidades das OUTRAS organizações (a ativa já aparece no sino). */
export function otherOrgNews(list: readonly OrgNewsEntry[] | undefined, activeOrgId: string | null): OrgNewsEntry[] {
  if (!list) return [];
  return list.filter((o) => o.organizationId !== activeOrgId && o.unseen > 0);
}

/** "Você tem 2 novidades em" + nome (o nome vai à parte para ficar num `<bdi>`). */
export function orgNewsParts(entry: OrgNewsEntry): { prefix: string; name: string } {
  const label = orgNewsLabel(entry.unseen) ?? "0";
  return { prefix: `Você tem ${label} ${entry.unseen === 1 ? "novidade" : "novidades"} em`, name: entry.organizationName };
}

export function orgNewsSentence(entry: OrgNewsEntry): string {
  const { prefix, name } = orgNewsParts(entry);
  return `${prefix} ${name}`;
}

// ===== Resolvido =====

export function isResolved(n: Pick<InboxNotification, "data">): boolean {
  const d = n.data as { resolvedReason?: unknown; resolvedBy?: unknown } | undefined;
  if (!d) return false;
  if (d.resolvedReason === "expired_unread") return false;
  return d.resolvedReason !== undefined || d.resolvedBy !== undefined;
}

/** "Assumido por Ana" (pedido de ajuda) ou o motivo genérico; `null` se não está resolvido. */
export function resolvedLabel(n: InboxNotification): string | null {
  if (!isResolved(n)) return null;
  const reason = (n.data as { resolvedReason?: unknown } | undefined)?.resolvedReason;
  if (n.type === "handoff_requested") {
    return n.resolvedByName ? `Assumido por ${n.resolvedByName}` : "Já assumido";
  }
  if (typeof reason === "string") {
    if (reason.includes("task") || reason.includes("complet")) return "Tarefa concluída";
    if (reason.includes("reconnect") || reason.includes("channel")) return "Canal reconectado";
  }
  return n.resolvedByName ? `Resolvido por ${n.resolvedByName}` : "Resolvido";
}

// ===== Destino do item =====

/** Caminho interno que o item abre (`null` = nada a abrir). Mesmas regras do painel antigo + lead. */
export function notificationHref(n: InboxNotification): string | null {
  const conv = n.conversationId ? `${TAB_ROUTES.inbox}?conversation=${n.conversationId}` : null;
  switch (n.type) {
    case "handoff_requested":
      return n.handoffId ? `${TAB_ROUTES.handoffs}?handoff=${n.handoffId}` : TAB_ROUTES.handoffs;
    case "handoff_resolved":
      return conv ?? TAB_ROUTES.handoffs;
    case "ai_draft_pending":
    case "group_opportunity":
    case "group_digest":
    case "group_mention":
      return conv;
    case "conversation_transferred":
    case "new_message":
      return conv ?? TAB_ROUTES.inbox;
    case "campaign_completed":
    case "campaign_paused":
      return n.campaignId ? `${TAB_ROUTES.campaigns}?campanha=${n.campaignId}` : null;
    case "channel_session_lost": {
      const isMeta = Boolean((n.data as { metaConnectionId?: unknown } | undefined)?.metaConnectionId);
      return `${TAB_ROUTES.settings}?secao=${isMeta ? "instagram" : "channels"}`;
    }
    case "group_joined":
      return TAB_ROUTES.groups;
    case "group_post_pending":
    case "group_post_failed":
      return n.groupPostId ? `${TAB_ROUTES.groups}?post=${n.groupPostId}` : TAB_ROUTES.groups;
    case "ai_spend_warning":
    case "ai_spend_reached":
      return `${TAB_ROUTES.settings}?secao=ai-usage`;
    case "ai_followup_needs_human":
      return n.taskId ? `${TAB_ROUTES.tasks}?task=${n.taskId}` : (conv ?? TAB_ROUTES.tasks);
    case "lead_assigned": {
      const leadId = n.leadId ?? (n.data as { leadId?: unknown } | undefined)?.leadId;
      return typeof leadId === "string" && leadId ? `${TAB_ROUTES.board}?lead=${leadId}` : null;
    }
    default:
      return n.taskId ? `${TAB_ROUTES.tasks}?task=${n.taskId}` : null;
  }
}

// ===== Ações no item =====

export type InboxActionId = "assume" | "review" | "snooze";

/** Ações rápidas do item (só enquanto não está resolvido). */
export function itemActions(n: InboxNotification): InboxActionId[] {
  if (isResolved(n)) return [];
  const out: InboxActionId[] = [];
  if (n.type === "handoff_requested" && n.handoffId) out.push("assume");
  if (n.type === "ai_draft_pending" && n.conversationId) out.push("review");
  if ((n.type === "task_due_soon" || n.type === "task_overdue") && n.taskId) out.push("snooze");
  return out;
}

export const SNOOZE_MS = 60 * 60 * 1000;

// ===== Lista com filtro de grupo =====

export const MAX_FILL_LOADS = 12;

/**
 * Com `group` o servidor filtra DENTRO da página: ela pode vir curta ou vazia
 * com `isDone:false`. Continua pedindo (com teto) enquanto a lista visível
 * cabe menos que uma página.
 */
export function shouldFillPage(opts: {
  group: string | null;
  status: string;
  visibleCount: number;
  pageSize: number;
  loads: number;
}): boolean {
  return (
    opts.group !== null &&
    opts.status === "CanLoadMore" &&
    opts.visibleCount < opts.pageSize &&
    opts.loads < MAX_FILL_LOADS
  );
}

// ===== Chegadas em tempo real =====

/** Tipos que pedem ação minha: único conjunto que vira toast/som (PLANO seção 4). */
export const ACTIONABLE_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "handoff_requested",
  "new_message",
  "conversation_transferred",
  "task_comment_mention",
  "group_mention",
  "ai_draft_pending",
  "task_assigned",
  "task_due_soon",
  "task_overdue",
  "channel_session_lost",
]);

/** Tipos ligados a uma conversa: não avisam se ela já está aberta na tela. */
const CONVERSATION_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "new_message",
  "conversation_transferred",
  "ai_draft_pending",
  "handoff_requested",
  "group_mention",
]);

export interface ArrivalItem {
  _id: string;
  type: NotificationType;
  createdAt: number;
  readAt?: number;
  conversationId?: string;
}

/**
 * Marca d'água inicial: o `createdAt` mais recente da janela. Janela vazia
 * semeia com 0 (nada veio antes, qualquer chegada é nova): usar o relógio do
 * aparelho faria perder avisos se ele estiver adiantado em relação ao servidor.
 */
export function seedWatermark(items: readonly Pick<ArrivalItem, "createdAt">[]): number {
  return items.length === 0 ? 0 : Math.max(...items.map((n) => n.createdAt));
}

/**
 * Itens que acabaram de chegar: `createdAt` acima da marca d'água, não lidos,
 * acionáveis e fora da conversa aberta. Pela data (e não pelo id) um item
 * antigo que entra na janela (depois de ler tudo, ou marcado como não lido
 * pela própria pessoa) nunca vira aviso; um aviso agrupado renovado ganha
 * `createdAt` novo e avisa de novo. A marca sobe a cada rodada, mesmo sem aviso.
 */
export function detectArrivals<T extends ArrivalItem>(
  watermark: number,
  items: readonly T[],
  openConversationId: string | null,
): { arrivals: T[]; nextWatermark: number } {
  let nextWatermark = watermark;
  const arrivals: T[] = [];
  for (const n of items) {
    if (n.createdAt > nextWatermark) nextWatermark = n.createdAt;
    if (n.createdAt <= watermark || n.readAt !== undefined) continue;
    if (!ACTIONABLE_TYPES.has(n.type)) continue;
    if (openConversationId && n.conversationId === openConversationId && CONVERSATION_TYPES.has(n.type)) continue;
    arrivals.push(n);
  }
  return { arrivals, nextWatermark };
}

const COUNT_PREFIX = /^\(\d+\+?\)\s/;

/** Contador do ícone do app instalado: mesmo teto do push (o SW grava o `app_badge` já limitado). */
export function appBadgeCount(unread: number): number {
  return Math.max(0, Math.min(PUSH_BADGE_CAP, Math.floor(unread)));
}

/** "(3) Conversas · HNBCRM"; sem pendências devolve o título limpo. */
export function withCountPrefix(title: string, unread: number): string {
  const clean = title.replace(COUNT_PREFIX, "");
  if (unread <= 0) return clean;
  return `(${unread > 99 ? "99+" : unread}) ${clean}`;
}

// ===== Marcar como lida / não lida =====

export const RESOLVED_CANNOT_REOPEN = "Esta notificação já foi resolvida e não volta para não lidas.";

/**
 * Alterna lida/não lida. `markUnread` devolve `false` quando o servidor recusa
 * (item resolvido por outra pessoa): nesse caso explica em vez de calar.
 */
export async function toggleRead(
  n: Pick<InboxNotification, "readAt">,
  deps: { markRead: () => Promise<unknown>; markUnread: () => Promise<boolean> },
): Promise<{ kind: "read" | "unread" | "refused"; message: string }> {
  if (!n.readAt) {
    await deps.markRead();
    return { kind: "read", message: "Marcada como lida" };
  }
  const reopened = await deps.markUnread();
  return reopened
    ? { kind: "unread", message: "Marcada como não lida" }
    : { kind: "refused", message: RESOLVED_CANNOT_REOPEN };
}
