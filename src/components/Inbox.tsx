import { usePageTitle } from "@/hooks/usePageTitle";
import { useState } from "react";
import { useOutletContext, useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { TAB_ROUTES } from "@/lib/routes";
import { VOCAB } from "@/lib/vocab";
import { ArrowLeft, ArrowLeftRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { assignableMembers } from "@/lib/teamMembers";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { channelSupports } from "@/lib/channelCapabilities";
import { STANDBY_BANNER_TEXT } from "@/lib/serviceWindow";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useInboxFilters } from "@/hooks/useInboxFilters";
import { useConversationList } from "@/hooks/useConversationList";
import { useConversationSelection } from "@/hooks/useConversationSelection";
import { useBulkConversationSelection } from "@/hooks/useBulkConversationSelection";
import { filterConversations } from "@/lib/inboxState";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";
import { NewConversationModal } from "@/components/inbox/NewConversationModal";
import { usePendingAttentionCount } from "@/components/inbox/AttentionBanner";
import { Composer } from "@/components/inbox/Composer";
import { ConversationDeepLinkResolver } from "@/components/inbox/ConversationDeepLinkResolver";
import { ConversationHeader } from "@/components/inbox/ConversationHeader";
import { InboxListColumn } from "@/components/inbox/InboxListColumn";
import type { ConversationListEntry } from "@/components/inbox/ConversationListItem";
import { ConversationThread } from "@/components/inbox/ConversationThread";
import { ConversationInteractionProvider, useInteractionState } from "@/components/inbox/conversationInteraction";
import { InboxOverlays, useInboxOverlays } from "@/components/inbox/InboxOverlays";
import { useConversationHeaderState } from "@/components/inbox/useConversationHeaderState";
import { useGroupMode } from "@/components/inbox/useGroupMode";
import { ConversationRoutingBar } from "@/components/inbox/central/ConversationRoutingBar";
import { useChatFrame } from "@/hooks/useVisualViewport";

/**
 * Orquestrador de Conversas (/app/entrada): liga os hooks de filtros, lista,
 * seleção (URL) e lote à lista, ao cabeçalho, ao thread e ao composer
 * compartilhados com o painel do lead (ConversationThread e Composer, em inbox/).
 */
export function Inbox() {
  usePageTitle(VOCAB.conversations.title);
  const { organizationId } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();
  const { can } = usePermissions(organizationId);
  const canReply = can("inbox", "reply");
  const sendableChannels = useQuery(
    api.startConversation.listSendableWhatsappChannels,
    canReply ? { organizationId } : "skip"
  );
  const showNewConversation = canReply && (sendableChannels?.length ?? 0) > 0;

  // Busca em mensagens (a lista vira lista de resultados; termo com debounce do SearchInput).
  const [searchTerm, setSearchTerm] = useState("");
  const [searchMonth, setSearchMonth] = useState(""); // "YYYY-MM" ou ""
  const isSearching = searchTerm.trim().length >= 2;

  // Citação, rascunho e salto pendente: compartilhados entre thread e composer.
  const interaction = useInteractionState();

  // Filtros (URL: arquivadas e etiqueta; localStorage: tipo e canal; Central: fila),
  // lista em lotes, conversa aberta (`?conversation=`, `?nova=`) e seleção em lote.
  const filters = useInboxFilters(organizationId);
  const { showArchived, kindFilter, filterLabelId, conversationLabels, centralModules, centralEnabled } = filters;
  const list = useConversationList({
    organizationId,
    showArchived,
    queueArgs: filters.queueArgs,
    channelArgs: filters.channelArgs,
    unreadArgs: filters.unreadArgs,
    isSearching,
  });
  const { validConversations } = list;
  const selection = useConversationSelection({
    validConversations,
    listLoaded: list.conversations !== undefined,
    showArchived,
    setShowArchived: filters.setShowArchived,
    kindFilter,
    onSelectionChange: interaction.reset,
    onDraft: interaction.setDraft,
  });
  const { selectedConversation, showMessages, currentConversation } = selection;
  // Celular com conversa aberta = tela cheia que segue o teclado (useChatFrame).
  const chatFrame = useChatFrame(showMessages && !!selectedConversation);
  const bulk = useBulkConversationSelection({ organizationId, showArchived });
  const attentionCount = usePendingAttentionCount(organizationId, can("inbox", "view_own"));
  const overlays = useInboxOverlays(selectedConversation);
  const { groupPanels } = overlays;

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });
  // IA em grupos (F4): o mestre da org + o interruptor do produto. Os recursos
  // POR GRUPO (responder, radar, digest) ficam na política de cada sala.
  const groupAiEnabled = Boolean(aiStatus?.active && aiStatus?.groupAgentEnabled);
  const headerState = useConversationHeaderState(selectedConversation, currentConversation);

  // Recorte do mês selecionado → range [início, fim] em ms.
  const monthRange = (() => {
    if (!/^\d{4}-\d{2}$/.test(searchMonth)) return null;
    const [y, m] = searchMonth.split("-").map(Number);
    return { dateFrom: new Date(y, m - 1, 1).getTime(), dateTo: new Date(y, m, 1).getTime() - 1 };
  })();
  const searchResults = useQuery(
    api.conversations.searchMessages,
    isSearching ? { organizationId, searchQuery: searchTerm, ...(monthRange ?? {}) } : "skip"
  );

  const labelById = new Map((conversationLabels ?? []).map((l) => [l._id as string, l]));
  // Os chips aparecem com grupo na lista OU filtro guardado diferente de "Todas":
  // sem a 2ª condição, um filtro "Grupos" persistido escondia os próprios chips
  // quando a org parava de acompanhar salas, e a caixa ficava vazia sem saída.
  const hasGroupConversations =
    validConversations.some((c) => c.kind === "group") || kindFilter !== "all";
  const filteredConversations = filterConversations(validConversations, {
    kind: kindFilter, labelId: filterLabelId, unreadOnly: filters.unreadOnly, keepId: selectedConversation,
  });
  const listedConversations: ConversationListEntry[] = selection.pinnedConversation
    ? [selection.pinnedConversation as ConversationListEntry, ...filteredConversations]
    : filteredConversations;

  // Conversa de GRUPO (v0.57): sala, assunto e membros (nomes por JID ficam no thread).
  const { isGroupConversation, groupChatId, groupChat, groupSubject, groupParticipantsCount } =
    useGroupMode(currentConversation, undefined);
  // Mexer na sala (acompanhar, entrar, sair) é `settings:manage` (D11).
  const canManageGroups = can("settings", "manage");
  // Disparar para os membros é campanha (F5), não configuração de canal.
  const canManageCampaigns = can("campaigns", "manage");

  /** Abre o wizard de campanha já preenchido com este grupo (F5). */
  const dispatchToGroupMembers = (source: "group_members" | "manual", phones?: string[]) => {
    if (!groupChatId) return;
    const params =
      source === "manual" && phones && phones.length > 0
        ? `source=manual&sourceGroupChatId=${groupChatId}&phones=${encodeURIComponent(phones.join(","))}`
        : `source=group_members&groupChatId=${groupChatId}`;
    navigate(`${TAB_ROUTES.campaigns}?novo=1&${params}`);
  };

  const openContactId = currentConversation?.contact?._id as Id<"contacts"> | undefined;
  const openLeadId = currentConversation?.leadId as Id<"leads"> | undefined;
  const handleBackToList = selection.close;

  // Conversa iniciada/reaberta: abre como o deep-link (também no mobile), volta a
  // aba para "ativas" na mesma escrita da URL e desfaz o filtro "Grupos".
  const handleNewConversationStarted = (conversationId: Id<"conversations">) => {
    if (kindFilter === "group") filters.setKindFilter("all");
    selection.select(conversationId, { archived: null });
  };

  // Resultado da busca: na conversa aberta o thread rola até a mensagem; em outra, o salto fica pendente.
  const handleOpenSearchResult = (result: { _id: string; conversationId: string }) => {
    if (result.conversationId === selectedConversation) {
      selection.setShowMessages(true);
      interaction.requestJump(result._id);
      return;
    }
    interaction.pendingJumpRef.current = result._id;
    selection.select(result.conversationId);
  };

  if (!list.conversations) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  // Controles de IA (pausar/retomar): canais oficiais sempre; bridge só após o aceite de risco
  // do atendente. Não mexe na janela de 24h/templates do composer.
  const aiControlsAllowed =
    currentConversation?.serviceWindowApplies !== false || aiStatus?.bridgeAiAckDone === true;
  const showAiControls = Boolean(
    aiStatus?.active &&
      channelSupports(currentConversation?.channel, currentConversation?.channelProvider, "aiAttendant") &&
      aiControlsAllowed &&
      !isGroupConversation
  );

  return (
    <div {...chatFrame}>
      {/* Dica de onboarding (só md+: no celular a lista começa logo abaixo do cabeçalho) */}
      <div className="hidden shrink-0 px-4 pt-4 md:block md:px-6 md:empty:hidden">
        <SpotlightTooltip spotlightId="inbox" organizationId={organizationId} />
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
      <InboxListColumn
        className={showMessages ? "hidden md:flex" : undefined}
        conversations={listedConversations}
        selectedId={selectedConversation}
        labelById={labelById}
        filters={filters}
        list={list}
        bulk={bulk}
        attentionCount={attentionCount}
        showKindFilter={hasGroupConversations}
        search={{
          term: searchTerm,
          onTermChange: (term) => {
            setSearchTerm(term);
            if (!term) setSearchMonth("");
          },
          active: isSearching,
          month: searchMonth,
          onMonthChange: setSearchMonth,
          results: searchResults,
          onOpenResult: handleOpenSearchResult,
        }}
        onSelect={(id) => selection.select(id)}
        onNewConversation={showNewConversation ? selection.openNewConversation : undefined}
      />

      {/* Conversa aberta: cabeçalho, thread e composer */}
      <div
        className={cn(
          "flex-1 flex flex-col bg-surface-base min-h-0",
          centralEnabled && "min-w-0",
          !showMessages && "hidden md:flex"
        )}
      >
        {selectedConversation ? (
          <ConversationInteractionProvider value={interaction}>
            {currentConversation ? (
              // Cabeçalho e composer são irmãos: chaves com prefixo próprio. Com o mesmo id
              // nos dois o React perde o cabeçalho antigo e eles empilham a cada troca.
              <ConversationHeader
                key={`header:${currentConversation._id}`}
                organizationId={organizationId}
                conversation={currentConversation}
                canReply={canReply}
                isGroup={isGroupConversation}
                groupSubject={groupSubject}
                groupParticipantsCount={groupParticipantsCount}
                groupMenu={
                  isGroupConversation
                    ? {
                        canManageGroups,
                        canManageCampaigns,
                        canReply,
                        groupAiEnabled,
                        onOpenMembers: () => groupPanels.setShowMembersPanel(true),
                        onOpenSummary: () => groupPanels.setShowGroupSummary(true),
                        onUnmonitor: () => groupPanels.setConfirmGroupAction("unmonitor"),
                        onLeave: () => groupPanels.setConfirmGroupAction("leave"),
                        onDispatch: () => dispatchToGroupMembers("group_members"),
                      }
                    : undefined
                }
                channelAccounts={filters.channelAccounts}
                accountById={filters.accountById}
                aiActive={Boolean(aiStatus?.active)}
                showAiControls={showAiControls}
                hasPendingDraft={headerState.hasPendingDraft}
                contactTyping={headerState.contactTyping}
                windowInfo={headerState.windowInfo}
                onBack={handleBackToList}
                onOpenContact={() => overlays.setShowContactPanel(true)}
                onOpenLead={() => overlays.setShowLeadPanel(true)}
                onOpenMembers={() => groupPanels.setShowMembersPanel(true)}
                onArchivedChange={(archived) => {
                  if (archived && !showArchived) handleBackToList();
                }}
                onLeadDeleted={handleBackToList}
                banners={
                  headerState.standbyActive && !isGroupConversation ? (
                    <div className="shrink-0 border-b border-semantic-warning/40 bg-semantic-warning/5 px-3 py-1.5 md:px-4">
                      <p className="mx-auto flex w-full max-w-4xl items-start gap-2 text-xs text-text-secondary">
                        <ArrowLeftRight size={14} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden />
                        <span className="min-w-0">{STANDBY_BANNER_TEXT}</span>
                      </p>
                    </div>
                  ) : undefined
                }
              >
                {/* Central (opcional): unidade/setor/responsável/tipo/desfecho + origem */}
                {centralEnabled && !isGroupConversation && (
                  <ConversationRoutingBar
                    key={currentConversation._id}
                    organizationId={organizationId}
                    conversationId={currentConversation._id as Id<"conversations">}
                    modules={centralModules}
                    lead={
                      currentConversation.lead
                        ? {
                            _id: currentConversation.lead._id as Id<"leads">,
                            boardId: currentConversation.lead.boardId as Id<"boards">,
                            value: currentConversation.lead.value as number | undefined,
                            customFields: currentConversation.lead.customFields as
                              | Record<string, unknown>
                              | undefined,
                          }
                        : null
                    }
                    canReply={canReply}
                    canEditLead={can("leads", "edit_own")}
                    teamMembers={assignableMembers(teamMembers ?? [])}
                  />
                )}

              </ConversationHeader>
            ) : (
              <div className="md:hidden shrink-0 p-2 border-b border-border bg-chat-header">
                <button
                  type="button"
                  onClick={handleBackToList}
                  className="flex h-11 w-11 items-center justify-center text-text-primary hover:bg-surface-overlay rounded-full transition-colors"
                  aria-label="Voltar"
                >
                  <ArrowLeft size={20} />
                </button>
              </div>
            )}

            <ConversationThread
              organizationId={organizationId}
              conversationId={selectedConversation as Id<"conversations">}
              onOpenGroupMemberContact={groupPanels.setMemberContactId}
            />
            <Composer
              key={`composer:${selectedConversation}`}
              organizationId={organizationId}
              conversationId={selectedConversation as Id<"conversations">}
              canReply={canReply}
            />
          </ConversationInteractionProvider>
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-muted">
            Selecione uma conversa para ver as mensagens
          </div>
        )}
      </div>
    </div>

      {/* Deep-link ?conversation= fora da lista carregada (arquivada ou antiga) */}
      {selection.deepLinkId && (
        <ErrorBoundary key={selection.deepLinkId} fallback={<></>}>
          <ConversationDeepLinkResolver
            conversationId={selection.deepLinkId as Id<"conversations">}
            onResolve={selection.handleResolveLinkedConversation}
          />
        </ErrorBoundary>
      )}

      <ConfirmDialog
        open={!!bulk.confirmBulk}
        onClose={() => bulk.setConfirmBulk(null)}
        onConfirm={bulk.confirmPending}
        title={
          bulk.confirmBulk?.action === "archive"
            ? `${showArchived ? "Desarquivar" : "Arquivar"} ${bulk.selectedIds.size} conversas?`
            : `Etiquetar ${bulk.selectedIds.size} conversas?`
        }
        description={
          bulk.confirmBulk?.action === "archive"
            ? showArchived
              ? "As conversas selecionadas voltam para a lista de ativas."
              : "As conversas selecionadas saem da lista de ativas. Dá para desarquivar depois."
            : "A etiqueta será aplicada a todas as conversas selecionadas."
        }
        confirmLabel="Confirmar"
      />

      {showNewConversation && (
        <NewConversationModal
          organizationId={organizationId}
          open={selection.novaOpen}
          onClose={selection.closeNewConversation}
          initialContactId={selection.novaContactId}
          onStarted={handleNewConversationStarted}
        />
      )}

      <InboxOverlays
        organizationId={organizationId}
        overlays={overlays}
        openLeadId={openLeadId}
        openContactId={openContactId}
        group={
          isGroupConversation && groupChatId
            ? {
                groupChatId,
                groupSubject,
                groupChat,
                onDispatchSelected: canManageCampaigns
                  ? (phones) => dispatchToGroupMembers("manual", phones)
                  : undefined,
                onLeft: handleBackToList,
              }
            : undefined
        }
      />
    </div>
  );
}
