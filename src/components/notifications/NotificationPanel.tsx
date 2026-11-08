import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMutation, usePaginatedQuery, type PaginatedQueryReference } from "convex/react";
import {
  Bell,
  UserPlus,
  AtSign,
  Clock,
  AlertTriangle,
  ArrowLeftRight,
  CheckCheck,
  Sparkles,
  Megaphone,
  PauseCircle,
  Users,
  CalendarClock,
  CalendarX,
  TrendingUp,
  FileText,
  Bot,
  ArrowRightLeft,
  WifiOff,
  Gauge,
  MessageCircle,
  UserCheck,
  Building2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_GROUP_LABELS,
  type NotificationGroup,
} from "../../../convex/lib/notificationGroups";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { Tabs, tabDomId, tabPanelDomId } from "@/components/ui/Tabs";
import { FilterChips } from "@/components/ui/FilterChips";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useNow } from "@/hooks/useNow";
import { useOrgNews } from "@/hooks/useOrgNews";
import { usePermissions } from "@/hooks/usePermissions";
import { cn } from "@/lib/utils";
import { TAB_ROUTES } from "@/lib/routes";
import { formatDateTime, formatRelative } from "@/lib/format";
import { mutationErrorMessage } from "@/lib/errors";
import {
  itemActions,
  notificationHref,
  orgNewsParts,
  resolvedLabel,
  MAX_FILL_LOADS,
  shouldFillPage,
  SNOOZE_MS,
  toggleRead,
  type InboxActionId,
  type InboxNotification,
  type OrgNewsEntry,
} from "@/lib/notificationInbox";
import { buildOpenLink, ORG_NEWS_TARGET } from "@/lib/openLink";
import { getSoundPref, playNotificationSound, setSoundPref } from "@/lib/notificationSound";

type NotificationDoc = Doc<"notifications">;

const TYPE_ICON: Record<NotificationDoc["type"], React.ElementType> = {
  task_assigned: UserPlus,
  task_comment_mention: AtSign,
  task_due_soon: Clock,
  task_overdue: AlertTriangle,
  handoff_requested: ArrowLeftRight,
  handoff_resolved: CheckCheck,
  ai_draft_pending: Sparkles,
  campaign_completed: Megaphone,
  campaign_paused: PauseCircle,
  group_joined: Users,
  group_mention: AtSign,
  group_post_pending: CalendarClock,
  group_post_failed: CalendarX,
  group_opportunity: TrendingUp,
  group_digest: FileText,
  // v0.60 — a IA não conseguiu fazer o follow-up que ela mesma agendou; a
  // tarefa voltou para a equipe.
  ai_followup_needs_human: Bot,
  // Central — conversa transferida para você ou para o seu setor.
  conversation_transferred: ArrowRightLeft,
  // F1 — relay agrupado das mensagens de um cliente para quem atende.
  new_message: MessageCircle,
  // T02 — canal desconectado (WhatsApp perdeu a sessão; Instagram/Messenger pedem reconexão).
  channel_session_lost: WifiOff,
  // v0.69 — gasto de IA do mês: aviso (80%) / teto atingido.
  ai_spend_warning: Gauge,
  ai_spend_reached: Gauge,
  // B2 — lead atribuído a você.
  lead_assigned: UserCheck,
};

const PAGE_SIZE = 15;

type InboxTab = "unread" | "all";
type ListStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

// ===== Casca =====

interface NotificationPanelShellProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  hasUnread: boolean;
  onMarkAllRead: () => void;
  /** Rótulo do botão (padrão "Marcar todas como lidas"). */
  markAllLabel?: string;
  children: ReactNode;
  /** Abas Não lidas/Todas (linha ao lado de "Marcar todas"). */
  tabs?: ReactNode;
  /** Chips de grupo e linhas de novidades de outras organizações. */
  filters?: ReactNode;
  /** Controle extra no cabeçalho (som). */
  headerExtra?: ReactNode;
  /** Texto para leitores de tela (região `aria-live="polite"`). */
  liveMessage?: string;
}

/**
 * Casca do painel: dropdown ancorado no desktop, folha inferior (com alça e
 * "Fechar" de 44 px) no mobile. Sempre em portal no `body`: o header do app usa
 * `backdrop-blur` (cria bloco de contenção para `position: fixed`), e um painel
 * `fixed` dentro dele encolhia para a altura do header e escondia a lista.
 * Diálogo modal: foco preso (hook local, o Modal ganha o seu no A2).
 */
export function NotificationPanelShell({
  open,
  onClose,
  anchor,
  hasUnread,
  onMarkAllRead,
  markAllLabel,
  children,
  tabs,
  filters,
  headerExtra,
  liveMessage,
}: NotificationPanelShellProps) {
  const sheet = useMediaQuery("(max-width: 767px)");
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      anchor={anchor}
      side="bottom"
      align="end"
      sheet={sheet}
      role="dialog"
      aria-modal
      aria-label="Notificações"
      className={cn(
        "flex flex-col overflow-hidden",
        sheet ? "h-[80dvh]" : "w-96 max-w-[calc(100vw-1rem)] max-h-[32rem]",
      )}
    >
      <ShellBody
        sheet={sheet}
        onClose={onClose}
        hasUnread={hasUnread}
        onMarkAllRead={onMarkAllRead}
        markAllLabel={markAllLabel}
        anchor={anchor}
        tabs={tabs}
        filters={filters}
        headerExtra={headerExtra}
        liveMessage={liveMessage}
      >
        {children}
      </ShellBody>
    </Popover>
  );
}

function ShellBody({
  sheet,
  onClose,
  hasUnread,
  onMarkAllRead,
  markAllLabel,
  anchor,
  children,
  tabs,
  filters,
  headerExtra,
  liveMessage,
}: Omit<NotificationPanelShellProps, "open"> & { sheet: boolean }) {
  const trapRef = useRef<HTMLDivElement>(null);
  useFocusTrap(trapRef, true, anchor);
  return (
    <div ref={trapRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
      {sheet && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong" aria-hidden="true" />}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold text-text-primary">Notificações</h2>
        <div className="flex items-center gap-1">
          {headerExtra}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="min-h-11 min-w-11 text-text-secondary"
          >
            Fechar
          </Button>
        </div>
      </div>
      {(tabs || hasUnread) && (
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2">
          <div className="min-w-0">{tabs}</div>
          {hasUnread && (
            <Button type="button" variant="ghost" size="sm" onClick={onMarkAllRead} className="shrink-0 text-brand-500">
              {markAllLabel ?? "Marcar todas como lidas"}
            </Button>
          )}
        </div>
      )}
      {filters}
      <div className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </div>
  );
}

// ===== Lista (apresentacional) =====

interface NotificationInboxListProps {
  items: readonly InboxNotification[];
  now: number;
  tab: InboxTab;
  status: ListStatus;
  busyId: string | null;
  canAssume: boolean;
  onOpen: (n: InboxNotification) => void;
  onToggleRead: (n: InboxNotification) => void;
  onAction: (n: InboxNotification, action: InboxActionId) => void;
  onLoadMore: () => void;
  onCreateLead: (n: InboxNotification) => void;
  /** Rolagem infinita ligada. Desligada (filtro de grupo sem achar mais), só o botão "Carregar mais". */
  autoLoad?: boolean;
}

const ACTION_LABEL: Record<InboxActionId, string> = {
  assume: "Assumir",
  review: "Revisar rascunho",
  snooze: "Adiar 1 h",
};

export function NotificationInboxList({
  items,
  now,
  tab,
  status,
  busyId,
  canAssume,
  onOpen,
  onToggleRead,
  onAction,
  onLoadMore,
  onCreateLead,
  autoLoad = true,
}: NotificationInboxListProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasObserver = typeof IntersectionObserver !== "undefined";
  const useSentinel = hasObserver && autoLoad;

  // Rolagem infinita: o sentinela no fim pede a próxima página ao ficar visível.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !useSentinel || status !== "CanLoadMore") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadMore();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [status, useSentinel, onLoadMore, items.length]);

  if (status === "LoadingFirstPage") {
    return (
      <div className="flex justify-center py-10">
        <Spinner size="md" />
      </div>
    );
  }

  if (items.length === 0 && status === "CanLoadMore" && !autoLoad) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <p className="text-sm text-text-muted">Nada deste grupo nos avisos mais recentes</p>
        <Button variant="ghost" size="sm" onClick={onLoadMore}>
          Carregar mais
        </Button>
      </div>
    );
  }

  if (items.length === 0 && status !== "CanLoadMore" && status !== "LoadingMore") {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-raised">
          <Bell size={22} className="text-text-muted" aria-hidden="true" />
        </div>
        <p className="text-sm font-medium text-text-primary">
          {tab === "unread" ? "Tudo em dia" : "Nenhuma notificação por aqui"}
        </p>
        <p className="mt-1 text-xs text-text-muted">
          {tab === "unread"
            ? "Você não tem avisos novos"
            : "Você será avisado quando algo precisar da sua atenção"}
        </p>
      </div>
    );
  }

  return (
    <>
      <ul className="divide-y divide-border">
        {items.map((n) => {
          const Icon = TYPE_ICON[n.type] ?? Bell;
          const unread = !n.readAt;
          const resolved = resolvedLabel(n);
          const actions = itemActions(n).filter((a) => a !== "assume" || canAssume);
          const busy = busyId === n._id;
          return (
            <li key={n._id} className={cn(resolved && "opacity-70")}>
              <button
                type="button"
                onClick={() => onOpen(n)}
                className={cn(
                  "flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
                  unread && !resolved && "bg-brand-500/5",
                )}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                    unread && !resolved ? "bg-brand-500/10 text-brand-500" : "bg-surface-raised text-text-muted",
                  )}
                  aria-hidden="true"
                >
                  <Icon size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-start gap-1.5">
                    <span
                      className={cn(
                        "line-clamp-2 text-sm",
                        unread && !resolved ? "font-semibold text-text-primary" : "font-medium text-text-secondary",
                      )}
                    >
                      <bdi>{n.title}</bdi>
                    </span>
                    {unread && !resolved && (
                      <>
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden="true" />
                        <span className="sr-only">Não lida</span>
                      </>
                    )}
                  </span>
                  {n.body && (
                    <span dir="auto" className="mt-0.5 line-clamp-2 block text-xs text-text-secondary">
                      {n.body}
                    </span>
                  )}
                  {resolved && (
                    <span className="mt-1 inline-flex items-center gap-1 text-caption font-medium text-text-muted">
                      <CheckCheck size={12} aria-hidden="true" />
                      <bdi>{resolved}</bdi>
                    </span>
                  )}
                  <time
                    dateTime={new Date(n.createdAt).toISOString()}
                    title={formatDateTime(n.createdAt)}
                    className="mt-1 block text-caption tabular-nums text-text-muted"
                  >
                    {formatRelative(n.createdAt, now)}
                  </time>
                </span>
              </button>
              <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
                {actions.map((a) => (
                  <Button
                    key={a}
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => onAction(n, a)}
                  >
                    {ACTION_LABEL[a]}
                  </Button>
                ))}
                {n.type === "group_opportunity" && (n.data as { hasPhone?: boolean } | undefined)?.hasPhone && (
                  <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => onCreateLead(n)}>
                    {busy ? "Criando…" : "Criar lead + abrir no privado"}
                  </Button>
                )}
                {!resolved && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onToggleRead(n)}
                    className="text-text-secondary"
                  >
                    {unread ? "Marcar como lida" : "Marcar como não lida"}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {status === "CanLoadMore" && (
        <div ref={useSentinel ? sentinelRef : undefined} className="flex justify-center py-3">
          {!useSentinel && (
            <Button variant="ghost" size="sm" onClick={onLoadMore}>
              Carregar mais
            </Button>
          )}
        </div>
      )}
      {status === "LoadingMore" && (
        <div className="flex justify-center py-3">
          <Spinner size="sm" />
        </div>
      )}
    </>
  );
}

// ===== Filtros (apresentacional) =====

interface NotificationFiltersProps {
  tab: InboxTab;
  onTab: (tab: InboxTab) => void;
  unreadCount: number;
  group: NotificationGroup | null;
  onGroup: (group: NotificationGroup | null) => void;
}

const TAB_PREFIX = "notif";

export function NotificationTabs({ tab, onTab, unreadCount }: Pick<NotificationFiltersProps, "tab" | "onTab" | "unreadCount">) {
  return (
    <Tabs
      variant="pills"
      ariaLabel="Mostrar notificações"
      idPrefix={TAB_PREFIX}
      value={tab}
      onValueChange={(id) => onTab(id as InboxTab)}
      items={[
        { id: "unread", label: unreadCount > 0 ? `Não lidas ${unreadCount >= 100 ? "99+" : unreadCount}` : "Não lidas" },
        { id: "all", label: "Todas" },
      ]}
    />
  );
}

export function NotificationGroupChips({ group, onGroup }: Pick<NotificationFiltersProps, "group" | "onGroup">) {
  return (
    <FilterChips
      ariaLabel="Filtrar por grupo"
      className="shrink-0 px-3 py-2"
      chips={NOTIFICATION_GROUPS.map((g) => ({
        id: g,
        label: NOTIFICATION_GROUP_LABELS[g],
        pressed: group === g,
      }))}
      onToggle={(id) => onGroup(group === id ? null : (id as NotificationGroup))}
    />
  );
}

/** Linhas "Você tem N novidades em {org}" (outras organizações). */
export function OrgNewsLines({ entries, onOpen }: { entries: readonly OrgNewsEntry[]; onOpen: (e: OrgNewsEntry) => void }) {
  if (entries.length === 0) return null;
  return (
    <ul className="shrink-0 border-b border-border">
      {entries.map((e) => (
        <li key={e.organizationId}>
          <button
            type="button"
            onClick={() => onOpen(e)}
            className="flex min-h-11 w-full items-center gap-2 bg-brand-500/10 px-4 py-2 text-left text-xs font-medium text-text-primary hover:bg-brand-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
          >
            <Building2 size={14} className="shrink-0 text-brand-500" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {orgNewsParts(e).prefix} <bdi>{e.organizationName}</bdi>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ===== Container =====

interface NotificationPanelProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
  /** Botão do sino: ancora o painel no desktop e recebe o foco de volta ao fechar. */
  anchor: RefObject<HTMLElement | null>;
  /** Não lidas reais (teto 100), vindas do `unreadSummary` do sino. */
  unreadCount: number;
}

// Painel do sino: caixa de entrada (abas, grupos, ações) dentro da casca acima.
export function NotificationPanel({ organizationId, open, onClose, anchor, unreadCount }: NotificationPanelProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { can } = usePermissions(organizationId);
  const now = useNow(open);
  const { others: orgNews } = useOrgNews(organizationId);

  // Mudou de rota (ex.: botão voltar) com o painel aberto: fecha.
  const openedAt = useRef(pathname);
  useEffect(() => {
    if (!open) openedAt.current = pathname;
    else if (pathname !== openedAt.current) onClose();
  }, [open, pathname, onClose]);

  const [tab, setTab] = useState<InboxTab>("unread");
  const [group, setGroup] = useState<NotificationGroup | null>(null);
  const [sound, setSound] = useState(getSoundPref);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Anúncio para leitores de tela: o contador faz o mesmo texto ser lido de novo.
  const [liveState, setLiveState] = useState({ text: "", n: 0 });
  const setLive = (text: string) => setLiveState((prev) => ({ text, n: prev.n + 1 }));
  const live = liveState.n % 2 === 0 ? liveState.text : `${liveState.text}\u00a0`;

  // list() usa returns: v.any() (paginado) — o cast segue o padrão de FormSubmissionsPage.tsx
  const listRef = api.notifications.list as unknown as PaginatedQueryReference;
  const { results, status, loadMore } = usePaginatedQuery(
    listRef,
    open
      ? {
          organizationId,
          ...(tab === "unread" ? { unreadOnly: true } : {}),
          ...(group ? { group } : {}),
        }
      : "skip",
    { initialNumItems: PAGE_SIZE },
  );
  const items = (results ?? []) as InboxNotification[];

  // Com grupo, as páginas podem vir curtas: continua pedindo (com teto) até encher.
  const [fillLoads, setFillLoads] = useState(0);
  useEffect(() => {
    setFillLoads(0);
  }, [tab, group, open]);
  useEffect(() => {
    if (!open) return;
    if (shouldFillPage({ group, status, visibleCount: items.length, pageSize: PAGE_SIZE, loads: fillLoads })) {
      setFillLoads((n) => n + 1);
      loadMore(PAGE_SIZE);
    }
  }, [open, group, status, items.length, fillLoads, loadMore]);
  // Sem grupo a rolagem infinita é livre; com grupo, depois do teto só o botão.
  const autoLoad = !group || fillLoads < MAX_FILL_LOADS;

  const handleLoadMore = useCallback(() => loadMore(PAGE_SIZE), [loadMore]);

  const markRead = useMutation(api.notifications.markRead);
  const markUnread = useMutation(api.notifications.markUnread);
  const markAllRead = useMutation(api.notifications.markAllRead);
  const acceptHandoff = useMutation(api.handoffs.acceptHandoff);
  const snoozeTask = useMutation(api.tasks.snoozeTask);
  // Oportunidade detectada num grupo (F4): o botão do item cria contato+lead a
  // partir do membro e abre a conversa PRIVADA. A IA nunca manda a DM sozinha
  // (D3) — quem escreve é quem clica, com o rascunho já no compositor.
  const createLeadFromMember = useMutation(api.groupChats.createLeadFromMember);

  if (!open) return null;

  const handleOpen = async (n: InboxNotification) => {
    // Dispara e segue: a navegação não espera o "lido".
    if (!n.readAt) void markRead({ organizationId, notificationId: n._id }).catch(() => undefined);
    onClose();
    const href = notificationHref(n);
    if (href) navigate(href);
  };

  const handleToggleRead = async (n: InboxNotification) => {
    try {
      const result = await toggleRead(n, {
        markRead: () => markRead({ organizationId, notificationId: n._id }),
        markUnread: () => markUnread({ organizationId, notificationId: n._id }),
      });
      if (result.kind === "refused") toast.info(result.message);
      else setLive(result.message);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível atualizar a notificação."));
    }
  };

  const handleAction = async (n: InboxNotification, action: InboxActionId) => {
    if (action === "review") {
      await handleOpen(n);
      return;
    }
    setBusyId(n._id);
    try {
      if (action === "assume" && n.handoffId) {
        const result = (await acceptHandoff({ handoffId: n.handoffId })) as { conversationId?: string | null } | null;
        onClose();
        if (result?.conversationId) {
          toast.success("Conversa assumida — abrindo");
          navigate(`${TAB_ROUTES.inbox}?conversation=${result.conversationId}`);
        } else {
          toast.success("Conversa assumida");
        }
      } else if (action === "snooze" && n.taskId) {
        await snoozeTask({ taskId: n.taskId, snoozedUntil: Date.now() + SNOOZE_MS });
        if (!n.readAt) await markRead({ organizationId, notificationId: n._id }).catch(() => undefined);
        toast.success("Lembrete adiado por 1 h");
      }
    } catch (e) {
      toast.error(
        mutationErrorMessage(
          e,
          action === "assume" ? "Não foi possível assumir a conversa." : "Não foi possível adiar o lembrete.",
        ),
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllRead({ organizationId, ...(group ? { group } : {}) });
      setLive("Notificações marcadas como lidas");
    } catch {
      toast.error("Não foi possível marcar as notificações como lidas.");
    }
  };

  const handleCreateLead = async (n: InboxNotification) => {
    const participantKey = (n.data as { participantKey?: string } | undefined)?.participantKey;
    if (!n.groupChatId || !participantKey) {
      toast.error("Esta notificação não aponta para um membro do grupo");
      return;
    }
    setBusyId(n._id);
    try {
      const result = await createLeadFromMember({
        groupChatId: n.groupChatId,
        participantKey,
      });
      if (!n.readAt) {
        try {
          await markRead({ organizationId, notificationId: n._id });
        } catch {
          // a navegação é mais importante que o "lido"
        }
      }
      // O rascunho da primeira mensagem viaja no estado da navegação: o
      // compositor abre preenchido, e quem aperta "enviar" é uma pessoa.
      const suggestedDm = (n.data as { suggestedDm?: string } | undefined)?.suggestedDm;
      onClose();
      navigate(`${TAB_ROUTES.inbox}?conversation=${result.conversationId}`, {
        state: suggestedDm ? { draftMessage: suggestedDm } : undefined,
      });
      toast.success("Lead criado — a conversa privada está aberta");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível criar o lead."));
    } finally {
      setBusyId(null);
    }
  };

  const handleOrgNews = (entry: OrgNewsEntry) => {
    onClose();
    navigate(buildOpenLink(entry.organizationId, ORG_NEWS_TARGET), { replace: false });
  };

  const toggleSound = () => {
    const next = !sound;
    setSoundPref(next);
    setSound(next);
    // Gesto do usuário: toca uma prévia (também destrava o áudio do navegador).
    if (next) playNotificationSound();
    setLive(next ? "Som de aviso ligado" : "Som de aviso desligado");
  };

  const uiStatus: ListStatus = status as ListStatus;
  const SoundIcon = sound ? Volume2 : VolumeX;

  return (
    <NotificationPanelShell
      open={open}
      onClose={onClose}
      anchor={anchor}
      hasUnread={unreadCount > 0}
      onMarkAllRead={() => void handleMarkAllRead()}
      markAllLabel={group ? "Marcar estas como lidas" : undefined}
      tabs={<NotificationTabs tab={tab} onTab={setTab} unreadCount={unreadCount} />}
      filters={
        <>
          <OrgNewsLines entries={orgNews} onOpen={handleOrgNews} />
          <NotificationGroupChips group={group} onGroup={setGroup} />
        </>
      }
      // Ponto de encaixe do cabeçalho: o C2 põe aqui o menu "Pausar avisos" e o indicador "Pausado até …".
      headerExtra={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={sound ? "Desligar som de aviso" : "Ligar som de aviso"}
          aria-pressed={sound}
          onClick={toggleSound}
          className="text-text-secondary"
        >
          <SoundIcon size={16} aria-hidden="true" />
        </Button>
      }
      liveMessage={live}
    >
      <div role="tabpanel" id={tabPanelDomId(TAB_PREFIX, tab)} aria-labelledby={tabDomId(TAB_PREFIX, tab)}>
        <NotificationInboxList
          items={items}
          now={now}
          tab={tab}
          status={uiStatus}
          busyId={busyId}
          canAssume={can("inbox", "reply")}
          onOpen={(n) => void handleOpen(n)}
          onToggleRead={(n) => void handleToggleRead(n)}
          onAction={(n, a) => void handleAction(n, a)}
          onLoadMore={handleLoadMore}
          onCreateLead={(n) => void handleCreateLead(n)}
          autoLoad={autoLoad}
        />
      </div>
    </NotificationPanelShell>
  );
}
