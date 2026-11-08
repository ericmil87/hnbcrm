import { useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Doc, Id } from "../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import { TAB_ROUTES } from "@/lib/routes";
import { formatRelativeTime } from "@/lib/auditUtils";

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

interface NotificationPanelProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
  /** Botão do sino: ancora o painel no desktop e recebe o foco de volta ao fechar. */
  anchor: RefObject<HTMLElement | null>;
}

interface NotificationPanelShellProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  hasUnread: boolean;
  onMarkAllRead: () => void;
  children: ReactNode;
}

/**
 * Casca do painel: dropdown ancorado no desktop, folha inferior no mobile. Sempre
 * em portal no `body`: o header do app usa `backdrop-blur` (cria bloco de
 * contenção para `position: fixed`), e um painel `fixed` dentro dele encolhia
 * para a altura do header e escondia a lista.
 */
export function NotificationPanelShell({
  open,
  onClose,
  anchor,
  hasUnread,
  onMarkAllRead,
  children,
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
      aria-label="Notificações"
      className={cn(
        "flex flex-col overflow-hidden",
        sheet ? "h-[80dvh]" : "w-96 max-w-[calc(100vw-1rem)] max-h-[32rem]",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-semibold text-text-primary">Notificações</h2>
        {hasUnread && (
          <Button type="button" variant="ghost" size="sm" onClick={onMarkAllRead} className="shrink-0 text-brand-500">
            Marcar todas como lidas
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </Popover>
  );
}

// Painel do sino: lista paginada de notificações dentro da casca acima.
export function NotificationPanel({ organizationId, open, onClose, anchor }: NotificationPanelProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // Mudou de rota (ex.: botão voltar) com o painel aberto: fecha.
  const openedAt = useRef(pathname);
  useEffect(() => {
    if (!open) openedAt.current = pathname;
    else if (pathname !== openedAt.current) onClose();
  }, [open, pathname, onClose]);

  // list() usa returns: v.any() (paginado) — o cast segue o padrão de FormSubmissionsPage.tsx
  const listRef = api.notifications.list as unknown as PaginatedQueryReference;
  const { results, status, loadMore } = usePaginatedQuery(listRef, open ? { organizationId } : "skip", {
    initialNumItems: PAGE_SIZE,
  });
  const notifications = (results ?? []) as NotificationDoc[];

  const markRead = useMutation(api.notifications.markRead);
  const markAllRead = useMutation(api.notifications.markAllRead);
  // Oportunidade detectada num grupo (F4): o botão do item cria contato+lead a
  // partir do membro e abre a conversa PRIVADA. A IA nunca manda a DM sozinha
  // (D3) — quem escreve é quem clica, com o rascunho já no compositor.
  const createLeadFromMember = useMutation(api.groupChats.createLeadFromMember);
  const [convertingId, setConvertingId] = useState<string | null>(null);

  if (!open) return null;

  const handleItemClick = async (n: NotificationDoc) => {
    if (!n.readAt) {
      try {
        await markRead({ organizationId, notificationId: n._id });
      } catch {
        // não bloqueia a navegação por causa disso
      }
    }
    onClose();
    // Repasse pendente abre a fila já com o peek da conversa aberto; resolvido
    // leva direto à conversa (quando o repasse tinha uma).
    if (n.type === "handoff_requested" && n.handoffId) {
      navigate(`${TAB_ROUTES.handoffs}?handoff=${n.handoffId}`);
      return;
    }
    if (n.type === "handoff_resolved") {
      navigate(n.conversationId ? `${TAB_ROUTES.inbox}?conversation=${n.conversationId}` : TAB_ROUTES.handoffs);
      return;
    }
    // Rascunho da IA esperando revisão → abre a conversa direto no inbox.
    if (n.type === "ai_draft_pending" && n.conversationId) {
      navigate(`${TAB_ROUTES.inbox}?conversation=${n.conversationId}`);
      return;
    }
    if ((n.type === "campaign_completed" || n.type === "campaign_paused") && n.campaignId) {
      navigate(`${TAB_ROUTES.campaigns}?campanha=${n.campaignId}`);
      return;
    }
    // Grupo: oportunidade e digest abrem a conversa da sala. A conversão em
    // lead tem botão PRÓPRIO no item — clicar no corpo não cria nada.
    if ((n.type === "group_opportunity" || n.type === "group_digest") && n.conversationId) {
      navigate(`${TAB_ROUTES.inbox}?conversation=${n.conversationId}`);
      return;
    }
    // Mencionaram o nosso número numa sala (ou disparou uma palavra de alerta):
    // abre a conversa do grupo no inbox. É a notificação MAIS FREQUENTE da
    // feature, e até aqui clicar nela não fazia nada (review de correção
    // nº 21) — o painel fechava e nenhuma tela abria.
    if (n.type === "group_mention" && n.conversationId) {
      navigate(`${TAB_ROUTES.inbox}?conversation=${n.conversationId}`);
      return;
    }
    // Entramos num grupo novo: a decisão de acompanhar é humana e mora na
    // página de Grupos.
    if (n.type === "channel_session_lost") {
      // Instagram/Messenger desconectado mora em "Instagram e Messenger", não em "Números conectados".
      const isMeta = Boolean((n.data as { metaConnectionId?: unknown } | undefined)?.metaConnectionId);
      navigate(`${TAB_ROUTES.settings}?secao=${isMeta ? "instagram" : "channels"}`);
      return;
    }
    if (n.type === "group_joined") {
      navigate(TAB_ROUTES.groups);
      return;
    }
    // Publicação programada em grupo: abre a aba Publicações já no item.
    if (n.type === "group_post_pending" || n.type === "group_post_failed") {
      navigate(n.groupPostId ? `${TAB_ROUTES.groups}?post=${n.groupPostId}` : TAB_ROUTES.groups);
      return;
    }
    // A IA não conseguiu executar um follow-up que ela mesma agendou: a
    // tarefa é onde a equipe decide o que fazer agora — só cai na conversa se
    // por algum motivo a tarefa não vier junto.
    if (n.type === "conversation_transferred" || n.type === "new_message") {
      navigate(n.conversationId ? `${TAB_ROUTES.inbox}?conversation=${n.conversationId}` : TAB_ROUTES.inbox);
      return;
    }
    // Gasto de IA do mês: o painel de uso e o teto ficam em Configurações → Atendente IA → Uso e limites de gasto.
    if (n.type === "ai_spend_warning" || n.type === "ai_spend_reached") {
      navigate(`${TAB_ROUTES.settings}?secao=ai-usage`);
      return;
    }
    if (n.type === "ai_followup_needs_human") {
      navigate(
        n.taskId
          ? `${TAB_ROUTES.tasks}?task=${n.taskId}`
          : n.conversationId
            ? `${TAB_ROUTES.inbox}?conversation=${n.conversationId}`
            : TAB_ROUTES.tasks,
      );
      return;
    }
    if (n.taskId) {
      navigate(`/app/tarefas?task=${n.taskId}`);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllRead({ organizationId });
    } catch {
      toast.error("Não foi possível marcar as notificações como lidas.");
    }
  };

  const handleCreateLeadFromOpportunity = async (n: NotificationDoc) => {
    const participantKey = (n.data as { participantKey?: string } | undefined)?.participantKey;
    if (!n.groupChatId || !participantKey) {
      toast.error("Esta notificação não aponta para um membro do grupo");
      return;
    }
    setConvertingId(n._id);
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
      toast.error(e instanceof Error ? e.message.split("\n")[0] : "Não foi possível criar o lead.");
    } finally {
      setConvertingId(null);
    }
  };

  const hasUnread = notifications.some((n) => !n.readAt);
  const loading = status === "LoadingFirstPage";

  return (
    <NotificationPanelShell
      open={open}
      onClose={onClose}
      anchor={anchor}
      hasUnread={hasUnread}
      onMarkAllRead={() => void handleMarkAllRead()}
    >
      <>
        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner size="md" />
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <div className="h-12 w-12 flex items-center justify-center rounded-full bg-surface-raised mb-3">
              <Bell size={22} className="text-text-muted" />
            </div>
            <p className="text-sm font-medium text-text-primary">Nenhuma notificação por aqui</p>
            <p className="text-xs text-text-muted mt-1">Você será avisado quando algo precisar da sua atenção</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {notifications.map((n) => {
              const Icon = TYPE_ICON[n.type] ?? Bell;
              const unread = !n.readAt;
              return (
                <li key={n._id}>
                  <button
                    type="button"
                    onClick={() => handleItemClick(n)}
                    className={cn(
                      "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised",
                      unread && "bg-brand-500/5",
                    )}
                  >
                    <span
                      className={cn(
                        "shrink-0 flex items-center justify-center h-8 w-8 rounded-full",
                        unread ? "bg-brand-500/10 text-brand-500" : "bg-surface-raised text-text-muted",
                      )}
                      aria-hidden="true"
                    >
                      <Icon size={15} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "text-sm truncate",
                            unread ? "font-semibold text-text-primary" : "font-medium text-text-secondary",
                          )}
                        >
                          {n.title}
                        </span>
                        {unread && (
                          <span className="h-1.5 w-1.5 rounded-full bg-brand-500 shrink-0" aria-hidden="true" />
                        )}
                      </span>
                      {n.body && <span className="block text-xs text-text-secondary truncate mt-0.5">{n.body}</span>}
                      <span className="block text-caption text-text-muted mt-1">{formatRelativeTime(n.createdAt)}</span>
                    </span>
                  </button>
                  {n.type === "group_opportunity" && (n.data as { hasPhone?: boolean } | undefined)?.hasPhone && (
                    <div className="px-4 pb-3 -mt-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={convertingId === n._id}
                        onClick={() => void handleCreateLeadFromOpportunity(n)}
                      >
                        {convertingId === n._id ? "Criando…" : "Criar lead + abrir no privado"}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {status === "CanLoadMore" && (
          <div className="flex justify-center py-3">
            <Button variant="ghost" size="sm" onClick={() => loadMore(PAGE_SIZE)}>
              Carregar mais
            </Button>
          </div>
        )}
        {status === "LoadingMore" && (
          <div className="flex justify-center py-3">
            <Spinner size="sm" />
          </div>
        )}
      </>
    </NotificationPanelShell>
  );
}
