import { useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import { MESSAGES_MAX_LIMIT } from "@/lib/inboxPaging";
import { cn } from "@/lib/utils";
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

  const [forwardTarget, setForwardTarget] = useState<InboxMessage | null>(null);
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(() => new Set());
  const [describingIds, setDescribingIds] = useState<Set<string>>(() => new Set());
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(() => new Set());

  const ready = messageDocReady && messages !== undefined;
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
      <div
        ref={paging.scrollRef}
        onScroll={paging.onScroll}
        className="flex-1 min-h-0 overflow-y-auto bg-chat-bg chat-wallpaper"
      >
        <div
          className={cn(
            "min-h-full flex flex-col justify-end w-full p-4 space-y-4",
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
            <div className="text-center py-2 mb-2">
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
            <div className="text-center py-2 mb-2">
              <span className="text-xs text-bubble-system-fg bg-bubble-system inline-block px-3 py-1.5 rounded-full">
                Exibindo as últimas {MESSAGES_MAX_LIMIT} mensagens
              </span>
            </div>
          ) : null}

          {(ready ? (messages as InboxMessage[]) : []).map((message) =>
            message.metadata?.kind === "transfer" && message.metadata?.transfer ? (
              // Transferência de setor (Central): evento de sistema, não bolha
              <TransferEvent
                key={message._id}
                actorName={message.sender?.name ?? null}
                transfer={message.metadata.transfer}
                createdAt={message.createdAt}
              />
            ) : getAiDraft(message) ? (
              // Rascunho do atendente IA (modo sugestão): revisão humana
              <AiDraftCard key={message._id} message={message} />
            ) : (
              <MessageBubble
                key={message._id}
                message={message}
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
              />
            )
          )}
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
