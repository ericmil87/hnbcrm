import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslationSettings } from "@/hooks/useTranslationSettings";
import { useShowOriginalPref } from "@/lib/translationPrefs";
import { bubbleTranslation, conversationLanguageState, hasFreshUntranslated } from "@/lib/translationRules";
import { ConversationTranslationBanner } from "@/components/inbox/ConversationTranslationBanner";
import { useAction, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import { MESSAGES_MAX_LIMIT } from "@/lib/inboxPaging";
import { cn } from "@/lib/utils";
import { formatDayLabel } from "@/lib/format";
import { layoutThread } from "@/lib/threadLayout";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { AiDraftCard, getAiDraft } from "@/components/inbox/AiDraftCard";
import { TransferEvent } from "@/components/inbox/central/CentralChips";
import { useConversationInteraction } from "@/components/inbox/conversationInteraction";
import { ForwardModal } from "@/components/inbox/ForwardModal";
import { mentionTokensFor } from "@/components/inbox/GroupMentionText";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { getReactions, type InboxMessage } from "@/components/inbox/types";
import { useConversationDoc } from "@/components/inbox/useConversationDoc";
import { useGroupMode } from "@/components/inbox/useGroupMode";
import { useMarkReadAndPresence } from "@/components/inbox/useMarkReadAndPresence";
import { useThreadPaging } from "@/components/inbox/useThreadPaging";

const EMPTY_MESSAGES: InboxMessage[] = [];

export interface ConversationThreadProps {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  /** `embedded` = dentro do painel do lead (mostra o "digitando…" ele mesmo). */
  variant?: "page" | "embedded";
  /**
   * Reservado para superfícies que abram o lead a partir do thread; hoje quem
   * abre o lead é o cabeçalho da conversa, então nenhum elemento do thread o usa.
   */
  onOpenLead?: (leadId: Id<"leads">) => void;
  /** Conversa de grupo: abre o contato de um membro (painel do Inbox). */
  onOpenGroupMemberContact?: (contactId: Id<"contacts">) => void;
}

/**
 * Mensagens da conversa: paginação para cima com âncora de rolagem, auto-scroll
 * em mensagem nova, marcar como lida, "digitando…" e as ações da bolha (reagir,
 * transcrever, ler imagem, baixar mídia, encaminhar). Compartilhado entre
 * Conversas e a aba Conversa do lead; precisa de `ConversationInteractionProvider`
 * (citação e salto pendente são compartilhados com o composer).
 */
export function ConversationThread({
  organizationId,
  conversationId,
  variant = "page",
  onOpenGroupMemberContact,
}: ConversationThreadProps) {
  const embedded = variant === "embedded";
  const { can, member } = usePermissions(organizationId);
  const canReply = can("inbox", "reply");
  const currentMemberId = member?._id ?? null;
  const { setReplyTo, pendingJumpRef, jumpRequest } = useConversationInteraction();

  const conversation = useConversationDoc(conversationId);
  // Bolhas só aparecem com o canal conhecido: o scroll inicial e o salto esperam o mesmo `ready`.
  const messageDocReady = conversation !== undefined && conversation !== null;
  const paging = useThreadPaging(conversationId, pendingJumpRef, messageDocReady);
  const { messages, loadingOlder } = paging;
  // Resultado da busca na conversa já aberta: rola (e sobe o limite se preciso).
  // Um pedido que já existia ao montar é de antes deste thread e é ignorado.
  const handledJumpRef = useRef(jumpRequest?.nonce ?? null);
  useEffect(() => {
    if (!jumpRequest || jumpRequest.nonce === handledJumpRef.current) return;
    handledJumpRef.current = jumpRequest.nonce;
    paging.jumpToMessage(jumpRequest.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest]);
  const { contactTyping } = useMarkReadAndPresence({
    conversationId,
    messages,
    showPresence: embedded,
  });
  const { isGroupConversation, groupNameByKey } = useGroupMode(conversation, messages);

  // Visão é um AND (D10 do plano): IA ativa na org E leitura de imagens ligada.
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });
  const visionEnabled = Boolean(aiStatus?.active && aiStatus?.visionEnabled);

  const reactToMessage = useMutation(api.conversations.reactToMessage);
  const transcribe = useAction(api.transcription.transcribe);
  const describeImage = useAction(api.vision.describeImage);
  const downloadDeferredMedia = useAction(api.groupChats.downloadDeferredMedia);
  const translateMessage = useAction(api.translation.translateMessage);
  const retryOutbound = useMutation(api.translation.retryOutbound);
  const sendUntranslated = useMutation(api.translation.sendUntranslated);
  const setConversationLanguage = useMutation(api.translation.setConversationLanguage);

  // Tradução automática (v0.80): estado da conversa + preferência do visualizador.
  const translationSettings = useTranslationSettings(organizationId);
  const languageState = conversationLanguageState(conversation, translationSettings);
  const [showBoth] = useShowOriginalPref();
  const [translatingIds, setTranslatingIds] = useState<Set<string>>(() => new Set());
  // Relógio do "Traduzindo…" inferido: só anda enquanto há recebida recente sem estado.
  const [now, setNow] = useState(() => Date.now());
  const freshUntranslated =
    hasFreshUntranslated(messages as InboxMessage[] | undefined, now, languageState.active);
  useEffect(() => {
    if (!freshUntranslated) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [freshUntranslated]);
  // Mensagem nova chegando: o relógio parte do instante atual.
  const lastMessageAt = (messages as InboxMessage[] | undefined)?.at(-1)?.createdAt;
  useEffect(() => {
    if (lastMessageAt) setNow(Date.now());
  }, [lastMessageAt]);

  const [forwardTarget, setForwardTarget] = useState<InboxMessage | null>(null);
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(() => new Set());
  const [describingIds, setDescribingIds] = useState<Set<string>>(() => new Set());
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(() => new Set());

  const ready = messageDocReady && messages !== undefined;
  // Blocos estilo WhatsApp (cauda, espaço, rótulo) e separadores de dia.
  // Transferência e rascunho da IA não são bolhas: quebram o bloco.
  const threadMessages = ready ? (messages as InboxMessage[]) : EMPTY_MESSAGES;
  const layout = useMemo(
    () =>
      layoutThread(threadMessages, {
        isGroup: isGroupConversation,
        currentMemberId,
        isBubble: (m) => !(m.metadata?.kind === "transfer" && m.metadata?.transfer) && !getAiDraft(m),
      }),
    [threadMessages, isGroupConversation, currentMemberId]
  );
  const convChannel: string | undefined = conversation?.channel;
  const convTransport: string | undefined = conversation?.channelProvider;
  const contactName =
    `${conversation?.contact?.firstName ?? ""} ${conversation?.contact?.lastName ?? ""}`.trim();

  /** Marca a mensagem como "em andamento" enquanto `run` não termina. */
  const withBusy = async (
    setBusy: React.Dispatch<React.SetStateAction<Set<string>>>,
    id: string,
    run: () => Promise<void>
  ) => {
    setBusy((prev) => new Set(prev).add(id));
    try {
      await run();
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleReact = async (message: InboxMessage, emoji: string) => {
    const mine = getReactions(message).find((r) => r.sender === currentMemberId)?.emoji ?? null;
    const next = mine === emoji ? "" : emoji;
    try {
      await reactToMessage({ messageId: message._id as Id<"messages">, emoji: next });
    } catch {
      toast.error("Não foi possível reagir à mensagem.");
    }
  };

  const handleTranscribe = (message: InboxMessage) =>
    withBusy(setTranscribingIds, message._id, async () => {
      try {
        const result = await transcribe({ organizationId, messageId: message._id as Id<"messages"> });
        if (result.status === "failed") toast.error("Não foi possível transcrever o áudio.");
      } catch {
        toast.error("Não foi possível transcrever o áudio.");
      }
    });

  const handleDescribeImage = (message: InboxMessage) =>
    withBusy(setDescribingIds, message._id, async () => {
      try {
        const result = await describeImage({ organizationId, messageId: message._id as Id<"messages"> });
        if (result.status === "failed") toast.error("Não foi possível ler a imagem");
      } catch {
        toast.error("Não foi possível ler a imagem");
      }
    });

  const handleTranslate = (message: InboxMessage) =>
    withBusy(setTranslatingIds, message._id, async () => {
      try {
        const result = await translateMessage({ messageId: message._id as Id<"messages"> });
        if (result.status === "failed") toast.error(result.error ?? "Não foi possível traduzir.");
        else if (result.status === "skipped") toast.info(result.error ?? "Esta mensagem já está no idioma da equipe");
      } catch (error) {
        toast.error(mutationErrorMessage(error, "Não foi possível traduzir."));
      }
    });

  // F3, idioma incerto: uma escrita para o idioma da conversa, depois a tradução.
  const handleTranslateAs = (message: InboxMessage, lang: string) =>
    withBusy(setTranslatingIds, message._id, async () => {
      try {
        await setConversationLanguage({ conversationId: message.conversationId as Id<"conversations">, lang, mode: "auto" });
        const result = await translateMessage({ messageId: message._id as Id<"messages"> });
        if (result.status === "failed") toast.error(result.error ?? "Não foi possível traduzir.");
      } catch (error) {
        toast.error(mutationErrorMessage(error, "Não foi possível traduzir."));
      }
    });

  const handleRetryOutbound = (message: InboxMessage) =>
    withBusy(setTranslatingIds, message._id, async () => {
      try {
        await retryOutbound({ messageId: message._id as Id<"messages"> });
      } catch (error) {
        toast.error(mutationErrorMessage(error, "Não foi possível tentar de novo."));
      }
    });

  const handleSendUntranslated = (message: InboxMessage) =>
    withBusy(setTranslatingIds, message._id, async () => {
      try {
        await sendUntranslated({ messageId: message._id as Id<"messages"> });
        toast.success("Mensagem enviada sem tradução");
      } catch (error) {
        toast.error(mutationErrorMessage(error, "Não foi possível enviar a mensagem."));
      }
    });

  // Mídia de grupo que a política não baixou (v0.62): o servidor devolve o
  // motivo em PT-BR pronto (vencida, quota…); o sucesso aparece sozinho, pela
  // query reativa trocando o placeholder pelo arquivo.
  const handleDownloadMedia = (message: InboxMessage) =>
    withBusy(setDownloadingIds, message._id, async () => {
      try {
        const result = await downloadDeferredMedia({
          organizationId,
          messageId: message._id as Id<"messages">,
        });
        if (!result.ok) toast.error(result.reason);
      } catch (error) {
        toast.error(mutationErrorMessage(error, "Não foi possível baixar a mídia"));
      }
    });

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {embedded && contactTyping && (
        <div className="shrink-0 px-4 py-1.5 border-b border-border bg-surface-raised">
          <span className="text-xs text-brand-500 animate-pulse">
            {contactName || "Contato"} está digitando…
          </span>
        </div>
      )}
      {conversation && !isGroupConversation && (
        <ConversationTranslationBanner
          organizationId={organizationId}
          conversation={conversation}
          settings={translationSettings}
          state={languageState}
          canReply={canReply}
        />
      )}
      <div
        ref={paging.scrollRef}
        onScroll={paging.onScroll}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-chat-bg chat-wallpaper"
      >
        <div
          className={cn(
            "min-h-full flex flex-col justify-end w-full px-1.5 pt-2 pb-3 md:px-4",
            !embedded && "max-w-4xl mx-auto"
          )}
        >
          {!ready && conversation !== null && (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          )}

          {conversation === null && (
            <div className="text-center py-12 text-text-muted text-sm">
              Conversa não encontrada.
            </div>
          )}

          {ready && (loadingOlder || paging.canLoadOlder) ? (
            <div className="text-center py-2">
              <div ref={paging.sentinelRef} aria-hidden="true" className="h-px" />
              <Button
                variant="ghost"
                size="sm"
                onClick={paging.loadOlder}
                disabled={loadingOlder}
                aria-busy={loadingOlder}
              >
                {loadingOlder ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner size="sm" />
                    Carregando mensagens anteriores…
                  </span>
                ) : (
                  "Carregar mensagens anteriores"
                )}
              </Button>
            </div>
          ) : ready && paging.reachedMax ? (
            <div className="text-center py-2">
              <span className="text-xs text-bubble-system-fg bg-bubble-system inline-block px-3 py-1.5 rounded-full">
                Exibindo as últimas {MESSAGES_MAX_LIMIT} mensagens
              </span>
            </div>
          ) : null}

          {threadMessages.map((message, index) => {
            const place = layout[index];
            return (
              <Fragment key={message._id}>
                {place?.daySeparator && (
                  <div className="flex justify-center py-2" role="separator" aria-label={formatDayLabel(message.createdAt, now)}>
                    <span className="rounded-full bg-bubble-system px-3 py-1 text-caption font-medium text-bubble-system-fg shadow-bubble">
                      {formatDayLabel(message.createdAt, now)}
                    </span>
                  </div>
                )}
                <div className={place?.daySeparator ? undefined : place?.first ?? true ? "mt-2.5" : "mt-0.5"}>
                  {message.metadata?.kind === "transfer" && message.metadata?.transfer ? (
                    // Transferência de setor (Central): evento de sistema, não bolha
                    <TransferEvent
                      actorName={message.sender?.name ?? null}
                      transfer={message.metadata.transfer}
                      createdAt={message.createdAt}
                    />
                  ) : getAiDraft(message) ? (
                    // Rascunho do atendente IA (modo sugestão): revisão humana
                    <AiDraftCard message={message} />
                  ) : (
                    <MessageBubble
                      message={message}
                      run={place}
                      channel={convChannel}
                      transport={convTransport}
                      canInteract={canReply}
                      currentMemberId={currentMemberId}
                      contactName={contactName}
                      transcribing={transcribingIds.has(message._id)}
                      describing={describingIds.has(message._id)}
                      downloadingMedia={downloadingIds.has(message._id)}
                      visionEnabled={visionEnabled}
                      highlighted={paging.highlightId === message._id}
                      group={
                        isGroupConversation
                          ? {
                              mentionTokens: mentionTokensFor(message.mentions, groupNameByKey),
                              onOpenContact: onOpenGroupMemberContact
                                ? (contactId) => onOpenGroupMemberContact(contactId as Id<"contacts">)
                                : undefined,
                            }
                          : undefined
                      }
                      onReply={setReplyTo}
                      onReact={handleReact}
                      onForward={setForwardTarget}
                      onTranscribe={handleTranscribe}
                      onDescribeImage={(m) => void handleDescribeImage(m)}
                      {...(canReply
                        ? { onDownloadMedia: (m: InboxMessage) => void handleDownloadMedia(m) }
                        : {})}
                      onJumpToMessage={paging.jumpToMessage}
                      translation={(() => {
                        // Módulo desligado: só a enviada retida (pending/failed) mantém as ações.
                        const decided = bubbleTranslation(message, {
                          moduleEnabled: translationSettings.moduleEnabled,
                          isGroup: isGroupConversation,
                          teamLanguage: translationSettings.teamLanguage,
                          conversationActive: languageState.active,
                          now,
                          conversation,
                        });
                        return decided
                          ? { ...decided, showBoth, busy: translatingIds.has(message._id) }
                          : undefined;
                      })()}
                      onTranslate={(m) => void handleTranslate(m)}
                      onTranslateAs={canReply ? (m, lang) => void handleTranslateAs(m, lang) : undefined}
                      onRetryOutbound={(m) => void handleRetryOutbound(m)}
                      onSendUntranslated={(m) => void handleSendUntranslated(m)}
                    />
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>

      <ForwardModal
        open={!!forwardTarget}
        organizationId={organizationId}
        message={forwardTarget}
        currentConversationId={conversationId}
        onClose={() => setForwardTarget(null)}
      />
    </div>
  );
}
