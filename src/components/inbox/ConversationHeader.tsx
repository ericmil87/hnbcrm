import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, ArrowLeftRight, Bot, ChevronDown, Clock, ExternalLink, Languages, PhoneOff, Users } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { AiControlMenu } from "@/components/inbox/AiControlMenu";
import { ReturnToAiButton } from "@/components/inbox/AiDraftCard";
import { ChannelAvatar } from "@/components/inbox/ChannelAvatar";
import { ConversationActionsMenu } from "@/components/inbox/ConversationActionsMenu";
import { ConversationSearchBar } from "@/components/inbox/ConversationSearchBar";
import { FollowUpChip } from "@/components/inbox/FollowUpChip";
import { ConversationLanguageChip, ConversationLanguageDialog } from "@/components/inbox/ConversationLanguageChip";
import { useConversationLanguage } from "@/components/inbox/useConversationLanguage";
import { useTranslationSettings } from "@/hooks/useTranslationSettings";
import { conversationLanguageState } from "@/lib/translationRules";
import { GroupMenuItems, type GroupMenuActions } from "@/components/inbox/GroupMenuItems";
import { InlineNameEditor, type InlineNameContact, type InlineNameLead } from "@/components/inbox/InlineNameEditor";
import { NOT_FOUND_BADGE, NOT_ON_WHATSAPP_BADGE, isBridgeWhatsapp, numberWarningOf } from "@/lib/messageDelivery";
import { Avatar } from "@/components/ui/Avatar";
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
  aiStateChipInfo,
  isHandoffPending,
  type AiConvState,
  type LeadHandoffState,
} from "@/lib/inboxState";
import { headerSubtitle, readHeaderDetailsOpen, writeHeaderDetailsOpen } from "@/lib/conversationHeader";
import { TAB_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";

type ConversationDoc = Record<string, any>;

/** Chip fino da faixa de detalhes (uma linha, sem quebra). */
const chipClass =
  "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-surface-overlay/60 px-2.5 text-xs text-text-secondary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 coarse:h-9";

interface ConversationHeaderProps {
  organizationId: Id<"organizations">;
  conversation: ConversationDoc;
  /** `inbox:reply`: sem ele os botões de repasse não aparecem. */
  canReply: boolean;
  isGroup: boolean;
  groupSubject: string;
  groupParticipantsCount: number;
  /** Ações do menu "⋮" de uma sala (ausente fora de grupo). */
  groupMenu?: Omit<GroupMenuActions, "groupAiPaused">;
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
  windowInfo: { text: string; tone: string; closed?: boolean } | null;
  onBack: () => void;
  onOpenContact: () => void;
  onOpenLead: () => void;
  onOpenMembers: () => void;
  /** Arquivou/desarquivou pelo menu. */
  onArchivedChange: (archived: boolean) => void;
  onLeadDeleted: () => void;
  /** Recolhível no celular (barra de roteamento da Central). */
  children?: ReactNode;
  /** Avisos sempre à vista, junto dos de repasse e robô (ex.: outro app controla a conversa). */
  banners?: ReactNode;
}

/**
 * Cabeçalho da conversa aberta, estilo WhatsApp: uma linha (voltar, avatar,
 * nome + subtítulo único, IA, detalhes, ⋮), a faixa de detalhes recolhível no
 * celular (funil, origem, idioma, follow-up, janela e a barra da Central) e os
 * avisos de ação urgente (pedido de ajuda, suspeita de robô) em uma linha.
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
  banners,
}: ConversationHeaderProps) {
  const navigate = useNavigate();
  // Faixa de detalhes: recolhida por padrão no celular (preferência local do visualizador); no desktop sempre aberta.
  const [detailsOpen, setDetailsOpen] = useState(readHeaderDetailsOpen);
  const toggleDetails = () => {
    setDetailsOpen((open) => {
      writeHeaderDetailsOpen(!open);
      return !open;
    });
  };
  // "Pesquisar na conversa" (menu ⋮): a barra de pesquisa ocupa a linha do cabeçalho.
  const [searching, setSearching] = useState(false);
  // Ao fechar a pesquisa (seta ←, X ou Esc) o foco volta ao ⋮, que reaparece no próximo render.
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const closeSearch = () => {
    restoreFocusRef.current = true;
    setSearching(false);
  };
  useEffect(() => {
    if (searching || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    menuTriggerRef.current?.focus();
  }, [searching]);
  const conversationId = conversation._id as Id<"conversations">;
  const convChannel: string | undefined = conversation.channel;
  const convTransport: string | undefined = conversation.channelProvider;
  const contactName = `${conversation.contact?.firstName ?? ""} ${conversation.contact?.lastName ?? ""}`.trim();
  const openContactId = conversation.contact?._id as Id<"contacts"> | undefined;

  // Tradução automática: pílula de leitura quando o lead fala outro idioma e
  // "Idioma da conversa…" no menu ⋮ (o seletor completo mora no composer).
  const translationSettings = useTranslationSettings(organizationId);
  const languageState = conversationLanguageState(conversation, translationSettings);
  const conversationLanguage = useConversationLanguage(conversationId);
  const [languageDialogOpen, setLanguageDialogOpen] = useState(false);
  const languageOptions = {
    state: languageState,
    teamLanguage: translationSettings.teamLanguage,
    onSelect: (choice: Parameters<typeof conversationLanguage.choose>[0]) => void conversationLanguage.choose(choice),
    showBoth: conversationLanguage.showBoth,
    onShowBothChange: conversationLanguage.setShowBoth,
    hasContact: !!conversation.contact,
  };
  const languagePill =
    !isGroup && languageState.foreign ? (
      <ConversationLanguageChip {...languageOptions} variant="header" readOnly={!canReply} />
    ) : null;

  // Estado do atendente nesta conversa (v4.2): alimenta o chip "IA em espera / preparando".
  const aiConvState = useQuery(api.attendant.getConversationAiState, aiActive ? { conversationId } : "skip");

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
  const funnelChip = leadBoardId ? (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {openLeadId ? (
        <button
          type="button"
          onClick={onOpenLead}
          aria-label="Ver detalhes do lead"
          className={cn(chipClass, "hover:text-brand-500")}
        >
          <span>{VOCAB.funnel.nav}:</span>
          <span className="font-medium text-text-primary">{leadBoardName ?? "…"}</span>
          <span aria-hidden>→</span>
          <span className="font-medium text-text-primary">{leadStageName ?? "…"}</span>
        </button>
      ) : (
        <span className={chipClass}>
          {VOCAB.funnel.nav}: <span className="font-medium text-text-primary">{leadBoardName ?? "…"}</span> →{" "}
          <span className="font-medium text-text-primary">{leadStageName ?? "…"}</span>
        </span>
      )}
      <button
        type="button"
        onClick={() => navigate(`${TAB_ROUTES.board}?board=${leadBoardId}` + (openLeadId ? `&lead=${openLeadId}` : ""))}
        aria-label="Abrir no funil"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-overlay hover:text-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500 coarse:h-9 coarse:w-9"
      >
        <ExternalLink size={14} aria-hidden />
      </button>
    </span>
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
    <span className={cn(chipClass, "max-w-[16rem]")}>
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
          : !isGroup && languageState.eligible && canReply
            ? (close) => (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    setLanguageDialogOpen(true);
                  }}
                  className="w-full coarse:min-h-11 flex items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-raised transition-colors"
                >
                  <Languages size={15} />
                  Idioma da conversa…
                </button>
              )
            : undefined
      }
      leadId={!isGroup && conversation.leadId ? (conversation.leadId as Id<"leads">) : undefined}
      onLeadDeleted={onLeadDeleted}
      onSearchInConversation={() => setSearching(true)}
      triggerRef={menuTriggerRef}
    />
  );
  const aiPaused = typeof conversation.aiPausedUntil === "number" && conversation.aiPausedUntil > Date.now();
  const aiProcessing = aiConvState?.status === "pending" || aiConvState?.status === "processing";
  const subtitle = headerSubtitle({
    typing: contactTyping,
    isGroup,
    participantsCount: groupParticipantsCount,
    handoffPending,
    botSuspected: !!botSuspicion,
    aiProcessing,
    aiWaiting: aiStateChipInfo(aiConvState as AiConvState)?.tone === "waiting" && !(aiPaused && aiConvState?.reason === "ia_pausada"),
    funnel: leadBoardId ? { board: leadBoardName, stage: leadStageName } : null,
  });
  const subtitleTone =
    subtitle?.tone === "typing"
      ? "text-brand-500 motion-safe:animate-pulse"
      : subtitle?.tone === "attention"
        ? "text-semantic-warning"
        : subtitle?.tone === "ai"
          ? "text-ai-400"
          : "text-text-muted";
  const displayName = isGroup ? groupSubject : contactName || "Sem nome";
  const primaryAction = isGroup ? onOpenMembers : onOpenContact;
  const canOpenPrimary = isGroup || !!openContactId;
  const primaryLabel = isGroup
    ? "Ver participantes da sala"
    : `Ver detalhes do contato${contactName ? ` ${contactName}` : ""}`;

  const avatar = isGroup ? (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-text-muted">
      <Users size={20} aria-hidden />
    </span>
  ) : (
    <Avatar
      name={displayName === "Sem nome" ? "?" : displayName}
      size="md"
      imageUrl={(conversation.contact as { avatarUrl?: string | null } | null | undefined)?.avatarUrl}
    />
  );
  const subtitleLine = subtitle ? (
    <span className={cn("block truncate text-xs", subtitleTone)} role={subtitle.tone === "typing" ? "status" : undefined}>
      {subtitle.text}
    </span>
  ) : null;

  const windowClosed = windowInfo?.closed === true;
  const hasStripItems = !!(funnelChip || originLine || languagePill || showAiControls || windowInfo);

  return (
    <>
      <div className="shrink-0 border-b border-border bg-chat-header md:bg-surface-raised">
        {searching && (
          <ConversationSearchBar
            organizationId={organizationId}
            conversationId={conversationId}
            onClose={closeSearch}
          />
        )}
        {/* Linha única: voltar · avatar · nome + subtítulo · IA · detalhes · ⋮ */}
        <div
          className={cn(
            "flex min-h-14 items-center gap-1 px-1 pt-[env(safe-area-inset-top)] md:pt-0 md:min-h-16 md:gap-2 md:px-4",
            searching && "hidden md:hidden"
          )}
        >
          <button
            type="button"
            onClick={onBack}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-primary transition-colors hover:bg-surface-overlay md:hidden"
            aria-label="Voltar"
          >
            <ArrowLeft size={22} aria-hidden />
          </button>

          {/* Celular: avatar e nome são um só alvo de toque (sem contato, só informam) */}
          {(() => {
            const inner = (
              <>
                {avatar}
                <span className="min-w-0 flex-1">
                  <h2 className="truncate text-base font-semibold leading-tight text-text-primary">{displayName}</h2>
                  {subtitleLine}
                </span>
              </>
            );
            return canOpenPrimary ? (
              <button
                type="button"
                onClick={primaryAction}
                aria-label={primaryLabel}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 md:hidden"
              >
                {inner}
              </button>
            ) : (
              <div className="flex min-h-11 min-w-0 flex-1 items-center gap-3 md:hidden">{inner}</div>
            );
          })()}

          {/* Desktop: nome editável ali mesmo (lápis) e subtítulo clicável na sala */}
          <div className="hidden min-w-0 flex-1 items-center gap-3 md:flex">
            {avatar}
            <div className="min-w-0 flex-1">
              {isGroup ? (
                <h2 className="truncate text-base font-semibold text-text-primary">{groupSubject}</h2>
              ) : openContactId && conversation.contact ? (
                <h2 className="text-base font-semibold text-text-primary truncate">
                  {/* Clicar no nome abre o contato; o lápis (ou o próprio "Sem nome") renomeia. */}
                  <InlineNameEditor
                    contact={conversation.contact as InlineNameContact}
                    lead={conversation.lead as InlineNameLead}
                    onOpen={onOpenContact}
                    openLabel={`Ver detalhes do contato${contactName ? ` ${contactName}` : ""}`}
                  />
                </h2>
              ) : (
                <h2 className="truncate text-base font-semibold text-text-primary">{displayName}</h2>
              )}
              {isGroup && subtitle ? (
                <button
                  type="button"
                  onClick={onOpenMembers}
                  className={cn(
                    "block max-w-full truncate rounded text-left text-xs hover:text-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                    subtitleTone
                  )}
                >
                  {subtitle.text}
                </button>
              ) : (
                subtitleLine
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center">
            {showAiControls && (
              <AiControlMenu
                conversationId={conversationId}
                aiPausedUntil={conversation.aiPausedUntil as number | undefined}
                aiMode={conversation.aiMode as string | undefined}
                hasPendingDraft={hasPendingDraft}
                aiState={aiConvState as AiConvState}
                canReply={canReply}
              />
            )}
            {(hasStripItems || !!children) && (
            <button
              type="button"
              onClick={toggleDetails}
              aria-expanded={detailsOpen}
              aria-label={detailsOpen ? "Ocultar detalhes da conversa" : "Mostrar detalhes da conversa"}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary md:hidden"
            >
              <ChevronDown size={20} aria-hidden className={cn("transition-transform", detailsOpen && "rotate-180")} />
            </button>
            )}
            {actionsMenu}
          </div>
        </div>

        {/* Janela fechada: sempre à vista no celular (no desktop vai para a faixa) */}
        {windowInfo && windowClosed && (
          <p className={cn("flex items-center gap-1.5 px-4 pb-1.5 text-xs md:hidden", windowInfo.tone)}>
            <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {windowInfo.text}
          </p>
        )}

        {/* Detalhes: recolhíveis no celular, sempre à vista no desktop */}
        <div className={cn(detailsOpen ? "block" : "hidden md:block")}>
          {(funnelChip || originLine || languagePill || windowInfo || (showAiControls && !isGroup)) && (
            <div
              className="flex items-center gap-2 overflow-x-auto px-3 pb-1.5 [-ms-overflow-style:none] [scrollbar-width:none] md:px-4 [&::-webkit-scrollbar]:hidden"
              role="toolbar"
              aria-label="Detalhes da conversa"
            >
              {funnelChip}
              {originLine}
              {languagePill}
              {showAiControls && <FollowUpChip conversationId={conversationId} />}
              {windowInfo && (
                <span className={cn(chipClass, windowInfo.tone, windowClosed && "hidden md:inline-flex")}>
                  <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {windowInfo.text}
                </span>
              )}
            </div>
          )}
          {children}
        </div>
      </div>

      <ConversationLanguageDialog
        open={languageDialogOpen}
        onClose={() => setLanguageDialogOpen(false)}
        {...languageOptions}
      />

      {banners}

      {/* Repasse pendente — uma vez só, abaixo do cabeçalho */}
      {handoffPending && (
        <div className="shrink-0 border-b border-semantic-warning/40 bg-semantic-warning/5 px-3 py-1.5 md:px-4">
          <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-xs">
              <ArrowLeftRight size={14} className="shrink-0 text-semantic-warning" aria-hidden />
              <span className="min-w-0 truncate" title={handoffReason}>
                <span className="font-medium text-semantic-warning">A IA pediu ajuda</span>
                {handoffReason && <span className="text-text-secondary"> — {handoffReason}</span>}
              </span>
            </p>
            {canReply && (
              <div className="flex shrink-0 flex-wrap items-center gap-2">
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

      {/* Número sem WhatsApp (marcador vale só para o número atual) */}
      {!isGroup && isBridgeWhatsapp(conversation.channel, conversation.channelProvider) && numberWarningOf(conversation.contact) && (
        <div className="shrink-0 border-b border-semantic-warning/40 bg-semantic-warning/5 px-3 py-1.5 md:px-4">
          <p className="mx-auto flex w-full max-w-4xl items-start gap-2 text-xs">
            <PhoneOff size={14} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden />
            <span>
              <span className="font-medium text-semantic-warning">{(numberWarningOf(conversation.contact) === "not_found" ? NOT_FOUND_BADGE : NOT_ON_WHATSAPP_BADGE).label}</span>
              <span className="text-text-secondary"> — {(numberWarningOf(conversation.contact) === "not_found" ? NOT_FOUND_BADGE : NOT_ON_WHATSAPP_BADGE).explanation}</span>
            </span>
          </p>
        </div>
      )}

      {/* Suspeita de robô (v0.65) — adicional ao banner de repasse */}
      {botSuspicion && !isGroup && (
        <div className="shrink-0 border-b border-semantic-warning/40 bg-semantic-warning/5 px-3 py-1.5 md:px-4">
          <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-xs">
              <Bot size={14} className="shrink-0 text-semantic-warning" aria-hidden />
              <span className="min-w-0 truncate" title={botSuspicion.reason || undefined}>
                <span className="font-medium text-semantic-warning">
                  A IA parou de responder: o outro lado parece um robô ou mensagem automática
                </span>
                {botSuspicion.reason && <span className="text-text-secondary"> — {botSuspicion.reason}</span>}
              </span>
            </p>
            {canReply && (
              <div className="flex shrink-0 flex-wrap items-center gap-2">
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
