import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, ArrowLeftRight, Bot, Clock, ExternalLink, Users } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { AiStatusChip } from "@/components/inbox/AiStatusChip";
import { AiConversationControls, ReturnToAiButton } from "@/components/inbox/AiDraftCard";
import { ChannelAvatar } from "@/components/inbox/ChannelAvatar";
import { ConversationActionsMenu } from "@/components/inbox/ConversationActionsMenu";
import { FollowUpChip } from "@/components/inbox/FollowUpChip";
import { GroupMembersButton } from "@/components/inbox/GroupMembersPanel";
import { GroupMenuItems, type GroupMenuActions } from "@/components/inbox/GroupMenuItems";
import { InlineNameEditor, type InlineNameContact, type InlineNameLead } from "@/components/inbox/InlineNameEditor";
import { Button } from "@/components/ui/Button";
import {
  accountFullLabel,
  channelIcon,
  channelLabel,
  shouldShowAccount,
  viaLabel,
  type InboxChannelAccount,
} from "@/lib/channelAccounts";
import { mutationErrorMessage } from "@/lib/errors";
import {
  activeBotSuspicion,
  isHandoffPending,
  type AiConvState,
  type LeadHandoffState,
} from "@/lib/inboxState";
import { TAB_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";

type ConversationDoc = Record<string, any>;

interface ConversationHeaderProps {
  organizationId: Id<"organizations">;
  conversation: ConversationDoc;
  /** `inbox:reply`: sem ele os botões de repasse não aparecem. */
  canReply: boolean;
  isGroup: boolean;
  groupSubject: string;
  groupParticipantsCount: number;
  /** Ações do menu "⋮" de uma sala (ausente fora de grupo). */
  groupMenu?: GroupMenuActions;
  channelAccounts: readonly InboxChannelAccount[];
  accountById: ReadonlyMap<string, InboxChannelAccount>;
  /** IA ativa na org: liga a consulta do estado do atendente nesta conversa. */
  aiActive: boolean;
  /** Mostra pausar/retomar, chip de estado e follow-up (IA ativa, canal com atendente, 1 a 1). */
  showAiControls: boolean;
  /** Já existe um rascunho aguardando revisão (esconde "Pedir resposta sugerida"). */
  hasPendingDraft: boolean;
  /** "digitando…" do contato (TTL de 12 s já aplicado). */
  contactTyping: boolean;
  /** Janela de serviço do canal (texto + tom). */
  windowInfo: { text: string; tone: string } | null;
  onBack: () => void;
  onOpenContact: () => void;
  onOpenLead: () => void;
  onOpenMembers: () => void;
  /** Arquivou/desarquivou pelo menu. */
  onArchivedChange: (archived: boolean) => void;
  onLeadDeleted: () => void;
  /** Entre os cabeçalhos e os avisos de repasse (barra de roteamento, standby). */
  children?: ReactNode;
}

/**
 * Cabeçalho da conversa aberta (mobile e desktop) e os avisos logo abaixo:
 * contato ou sala, canal de origem, etapa do funil, chip de estado da IA,
 * pedido de ajuda pendente com "Assumir conversa" / "Devolver à IA" sempre à
 * vista e a suspeita de robô.
 */
export function ConversationHeader({
  organizationId,
  conversation,
  canReply,
  isGroup,
  groupSubject,
  groupParticipantsCount,
  groupMenu,
  channelAccounts,
  accountById,
  aiActive,
  showAiControls,
  hasPendingDraft,
  contactTyping,
  windowInfo,
  onBack,
  onOpenContact,
  onOpenLead,
  onOpenMembers,
  onArchivedChange,
  onLeadDeleted,
  children,
}: ConversationHeaderProps) {
  const navigate = useNavigate();
  const conversationId = conversation._id as Id<"conversations">;
  const convChannel: string | undefined = conversation.channel;
  const convTransport: string | undefined = conversation.channelProvider;
  const contactName = `${conversation.contact?.firstName ?? ""} ${conversation.contact?.lastName ?? ""}`.trim();
  const openContactId = conversation.contact?._id as Id<"contacts"> | undefined;

  // Estado do atendente nesta conversa (v4.2): alimenta o chip "IA em espera / preparando".
  const aiConvState = useQuery(api.attendant.getConversationAiState, aiActive ? { conversationId } : "skip");

  const renderContactHeading = (className: string) =>
    isGroup ? (
      <h2 className={className}>
        <span className="flex items-center gap-2 min-w-0">
          <Users size={16} className="shrink-0 text-text-muted" aria-hidden />
          <span className="truncate">{groupSubject}</span>
        </span>
      </h2>
    ) : openContactId && conversation.contact ? (
      <h2 className={className}>
        {/* Nome editável ali mesmo: clicar no nome abre o contato; o lápis (ou
            o próprio "Sem nome") renomeia sem passar pelo painel do lead. */}
        <InlineNameEditor
          contact={conversation.contact as InlineNameContact}
          lead={conversation.lead as InlineNameLead}
          onOpen={onOpenContact}
          openLabel={`Ver detalhes do contato${contactName ? ` ${contactName}` : ""}`}
        />
      </h2>
    ) : (
      <h2 className={className}>{contactName || "Sem nome"}</h2>
    );

  // Funil do lead da conversa aberta (C2): "Funil: <board> → <etapa>" + lead.
  const openLeadId = conversation.leadId as Id<"leads"> | undefined;
  const leadBoardId = conversation.lead?.boardId as Id<"boards"> | undefined;
  const leadStageId = conversation.lead?.stageId as Id<"stages"> | undefined;
  const leadBoards = useQuery(
    api.boards.getBoards,
    leadBoardId ? { organizationId, includeArchived: true } : "skip"
  ) as { _id: Id<"boards">; name: string }[] | undefined;
  const leadStages = useQuery(api.boards.getStages, leadBoardId ? { boardId: leadBoardId } : "skip") as
    | { _id: Id<"stages">; name: string }[]
    | undefined;
  const leadBoardName = leadBoards?.find((b) => b._id === leadBoardId)?.name;
  const leadStageName = leadStages?.find((s) => s._id === leadStageId)?.name;
  const funnelText = (
    <>
      {VOCAB.funnel.nav}: <span className="text-text-secondary font-medium">{leadBoardName ?? "…"}</span>
      {" → "}
      <span className="text-text-secondary font-medium">{leadStageName ?? "…"}</span>
    </>
  );
  const funnelLine = leadBoardId ? (
    <div className="flex items-center gap-1 min-w-0">
      {openLeadId ? (
        <button
          type="button"
          onClick={onOpenLead}
          className="flex-1 min-w-0 truncate py-2 -my-2 text-left text-xs text-text-muted hover:text-brand-500 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 rounded"
          aria-label="Ver detalhes do lead"
        >
          {funnelText}
          <span className="ml-1.5 text-brand-500">Ver lead</span>
        </button>
      ) : (
        <span className="flex-1 min-w-0 truncate text-xs text-text-muted">{funnelText}</span>
      )}
      <button
        type="button"
        onClick={() => navigate(`${TAB_ROUTES.board}?board=${leadBoardId}` + (openLeadId ? `&lead=${openLeadId}` : ""))}
        aria-label="Abrir no funil"
        className="shrink-0 flex items-center justify-center min-h-[44px] min-w-[44px] -my-3 rounded-full text-text-muted transition-colors hover:text-brand-500 hover:bg-surface-overlay focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        <ExternalLink size={14} />
      </button>
    </div>
  ) : null;

  // Origem no cabeçalho: ícone + conta completa + "via <canal>".
  const currentAccount = conversation.channelConfigId
    ? accountById.get(conversation.channelConfigId as string)
    : undefined;
  const originShown =
    !!convChannel &&
    (convChannel === "instagram" ||
      convChannel === "messenger" ||
      (!!currentAccount && shouldShowAccount(channelAccounts as InboxChannelAccount[], convChannel)));
  const originFullLabel = accountFullLabel(currentAccount);
  const originText = originFullLabel
    ? originFullLabel.toLowerCase().startsWith(channelLabel(convChannel ?? "").toLowerCase())
      ? originFullLabel
      : `${originFullLabel} · ${viaLabel(convChannel ?? "")}`
    : viaLabel(convChannel ?? "");
  const OriginIcon = channelIcon(convChannel ?? "", convTransport);
  const originLine = originShown ? (
    <span className="inline-flex items-center gap-1 min-w-0 text-xs text-text-muted">
      {currentAccount?.avatarUrl ? (
        <ChannelAvatar
          channel={convChannel ?? ""}
          transport={convTransport}
          avatarUrl={currentAccount.avatarUrl}
          size={28}
        />
      ) : (
        <OriginIcon size={12} aria-hidden="true" className="shrink-0" />
      )}
      <span className="truncate">{originText}</span>
    </span>
  ) : null;

  // Repasse pendente → "Assumir conversa" e "Devolver à IA" à vista.
  const openHandoffState = conversation.lead?.handoffState as LeadHandoffState;
  const leadHandoffPending = isHandoffPending(openHandoffState);
  const pendingLeadHandoff = useQuery(
    api.handoffs.getPendingHandoffForLead,
    leadHandoffPending && openLeadId ? { leadId: openLeadId } : "skip"
  ) as { _id: string } | null | undefined;
  // SALA DE GRUPO não tem lead, e o banner âmbar saía de
  // `conversation.lead.handoffState`: numa sala o operador não via nem que
  // havia repasse aberto nem o botão de aceitar inline. A fonte aqui é a
  // CONVERSA (índice `by_conversation_and_status`).
  const pendingGroupHandoff = useQuery(
    api.handoffs.getPendingHandoffForConversation,
    isGroup ? { conversationId } : "skip"
  ) as { _id: string; reason?: string } | null | undefined;
  const pendingHandoff = isGroup ? pendingGroupHandoff : pendingLeadHandoff;
  const handoffPending = isGroup ? !!pendingGroupHandoff : leadHandoffPending;
  const handoffReason = isGroup ? pendingGroupHandoff?.reason : openHandoffState?.reason;

  const acceptHandoff = useMutation(api.handoffs.acceptHandoff);
  const returnToAi = useMutation(api.attendant.returnToAi);

  const handleAcceptHandoff = () => {
    if (!pendingHandoff) return;
    toast.promise(acceptHandoff({ handoffId: pendingHandoff._id as Id<"handoffs"> }), {
      loading: "Assumindo conversa…",
      success: isGroup
        ? "Conversa assumida. A IA da sala fica em silêncio por 24 h"
        : "Conversa assumida. IA pausada",
      error: (e) => mutationErrorMessage(e, "Não foi possível assumir a conversa. Tente de novo."),
    });
  };

  // Suspeita de robô na conversa aberta (só 1 a 1).
  const botSuspicion = isGroup ? null : activeBotSuspicion(conversation);
  const [returningFromBot, setReturningFromBot] = useState(false);
  const handleNotABot = async () => {
    setReturningFromBot(true);
    try {
      await returnToAi({ conversationId });
      toast.success("Conversa devolvida à IA");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível devolver à IA. Tente de novo."));
    } finally {
      setReturningFromBot(false);
    }
  };

  const groupAiPaused =
    isGroup && typeof conversation.aiPausedUntil === "number" && conversation.aiPausedUntil > Date.now();
  const actionsMenu = (
    <ConversationActionsMenu
      organizationId={organizationId}
      conversationId={conversationId}
      archivedAt={conversation.archivedAt}
      labelIds={(conversation.labelIds ?? []) as string[]}
      onArchivedChange={onArchivedChange}
      renderExtraItems={
        isGroup && groupMenu
          ? (close) => (
              <GroupMenuItems close={close} conversationId={conversationId} actions={{ ...groupMenu, groupAiPaused }} />
            )
          : undefined
      }
      leadId={!isGroup && conversation.leadId ? (conversation.leadId as Id<"leads">) : undefined}
      onLeadDeleted={onLeadDeleted}
    />
  );
  const aiControls = showAiControls ? (
    <AiConversationControls
      conversationId={conversationId}
      aiPausedUntil={conversation.aiPausedUntil as number | undefined}
      hasPendingDraft={hasPendingDraft}
    />
  ) : null;

  const typingText = isGroup ? "alguém está digitando…" : "digitando…";

  return (
    <>
      {/* Mobile header with back button */}
      <div className="md:hidden shrink-0 p-4 border-b border-border bg-chat-header flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex h-11 w-11 -ml-2 items-center justify-center text-text-primary hover:bg-surface-overlay rounded-full transition-colors"
            aria-label="Voltar"
          >
            <ArrowLeft size={20} />
          </button>
          {renderContactHeading("flex-1 min-w-0 truncate text-base font-semibold text-text-primary")}
          {actionsMenu}
        </div>
        {funnelLine && <div className="pl-11">{funnelLine}</div>}
        {isGroup && (
          <div className="pl-11">
            <GroupMembersButton participantsCount={groupParticipantsCount} onClick={onOpenMembers} />
          </div>
        )}
        {originLine && <div className="pl-11 flex">{originLine}</div>}
        {contactTyping && <span className="pl-11 text-xs text-brand-500 animate-pulse">{typingText}</span>}
        {showAiControls && (
          <div className="pl-11 flex flex-wrap items-center gap-2">
            {aiControls}
            <AiStatusChip state={aiConvState as AiConvState} />
            <FollowUpChip conversationId={conversationId} />
          </div>
        )}
        {windowInfo && (
          <div className={cn("flex items-center gap-1 pl-11 text-xs", windowInfo.tone)}>
            <Clock className="h-3.5 w-3.5 shrink-0" />
            {windowInfo.text}
          </div>
        )}
      </div>

      {/* Desktop header */}
      <div className="hidden md:flex shrink-0 p-4 border-b border-border bg-surface-raised items-center justify-between">
        <div className="min-w-0">
          {renderContactHeading("text-base font-semibold text-text-primary truncate")}
          {funnelLine}
          {isGroup && <GroupMembersButton participantsCount={groupParticipantsCount} onClick={onOpenMembers} />}
          {originLine && <div className="flex">{originLine}</div>}
          {contactTyping && <span className="text-xs text-brand-500 animate-pulse">{typingText}</span>}
        </div>
        <div className="flex items-center gap-2">
          {showAiControls && (
            <>
              {aiControls}
              <AiStatusChip state={aiConvState as AiConvState} />
              <FollowUpChip conversationId={conversationId} />
            </>
          )}
          {windowInfo && (
            <div className={cn("flex items-center gap-1.5 text-sm", windowInfo.tone)}>
              <Clock className="h-4 w-4 shrink-0" />
              {windowInfo.text}
            </div>
          )}
          {actionsMenu}
        </div>
      </div>

      {children}

      {/* Repasse pendente — uma vez só, abaixo dos dois headers */}
      {handoffPending && (
        <div className="shrink-0 border-b border-semantic-warning/40 bg-semantic-warning/5 px-4 py-2.5">
          <div className="max-w-4xl mx-auto w-full flex flex-col sm:flex-row sm:items-center gap-2">
            <p className="flex items-start gap-2 flex-1 min-w-0 text-sm">
              <ArrowLeftRight size={16} className="mt-0.5 shrink-0 text-semantic-warning" />
              <span className="min-w-0">
                <span className="font-medium text-semantic-warning">A IA pediu ajuda</span>
                {handoffReason && <span className="text-text-secondary"> — {handoffReason}</span>}
              </span>
            </p>
            {canReply && (
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <Button type="button" size="sm" disabled={!pendingHandoff} onClick={handleAcceptHandoff}>
                  {VOCAB.attention.accept}
                </Button>
                <ReturnToAiButton conversationId={conversationId} variant="button" buttonVariant="secondary" />
                {pendingHandoff && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(`${TAB_ROUTES.handoffs}?handoff=${pendingHandoff._id}`)}
                  >
                    Ver {VOCAB.attention.item}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Suspeita de robô (v0.65) — adicional ao banner de repasse */}
      {botSuspicion && !isGroup && (
        <div className="shrink-0 border-b border-semantic-warning/40 bg-semantic-warning/5 px-4 py-2.5">
          <div className="max-w-4xl mx-auto w-full flex flex-col sm:flex-row sm:items-center gap-2">
            <p className="flex items-start gap-2 flex-1 min-w-0 text-sm">
              <Bot size={16} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium text-semantic-warning">
                  A IA parou de responder: o outro lado parece um robô ou mensagem automática
                </span>
                {botSuspicion.reason && (
                  <span className="block text-xs text-text-secondary mt-0.5 break-words">{botSuspicion.reason}</span>
                )}
              </span>
            </p>
            {canReply && (
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <Button type="button" size="sm" disabled={returningFromBot} onClick={() => void handleNotABot()}>
                  É uma pessoa — devolver para a IA
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    navigate(
                      pendingHandoff ? `${TAB_ROUTES.handoffs}?handoff=${pendingHandoff._id}` : TAB_ROUTES.handoffs
                    )
                  }
                >
                  {VOCAB.attention.view}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
