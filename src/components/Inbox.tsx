import React, { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Send, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { MentionTextarea } from "@/components/ui/MentionTextarea";
import { MentionRenderer } from "@/components/ui/MentionRenderer";
import { extractMentionIds } from "@/lib/mentions";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";

interface InboxProps {
  organizationId: Id<"organizations">;
}

export function Inbox({ organizationId }: InboxProps) {
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [showMessages, setShowMessages] = useState(false);

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  const conversations = useQuery(api.conversations.getConversations, {
    organizationId,
  });

  const messages = useQuery(
    api.conversations.getMessages,
    selectedConversation ? { conversationId: selectedConversation as Id<"conversations"> } : "skip"
  );

  const sendMessage = useMutation(api.conversations.sendMessage);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedConversation) return;

    try {
      const trimmed = newMessage.trim();
      const mentionedUserIds = isInternal ? extractMentionIds(trimmed) : undefined;

      await sendMessage({
        conversationId: selectedConversation as Id<"conversations">,
        content: trimmed,
        contentType: "text",
        isInternal,
        mentionedUserIds: mentionedUserIds?.length ? mentionedUserIds : undefined,
      });
      setNewMessage("");
    } catch (error) {
      toast.error("Falha ao enviar mensagem");
    }
  };

  const handleSelectConversation = (conversationId: string) => {
    setSelectedConversation(conversationId);
    setShowMessages(true);
  };

  const handleBackToList = () => {
    setShowMessages(false);
    setSelectedConversation(null);
  };

  if (!conversations) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  const validConversations = conversations.filter((c): c is NonNullable<typeof c> => c !== null);

  // Message bubble styling based on sender type
  const getMessageStyle = (message: {
    isInternal: boolean;
    direction: string;
    senderType: string;
  }) => {
    if (message.isInternal) {
      return {
        align: "justify-end" as const,
        bg: "bg-surface-overlay border border-dashed border-semantic-warning/30 text-text-primary",
        rounded: "rounded-lg rounded-br-none",
        label: "Nota Interna",
        labelColor: "text-semantic-warning",
      };
    }
    if (message.direction === "inbound" || message.senderType === "contact") {
      return {
        align: "justify-start" as const,
        bg: "bg-surface-raised text-text-primary",
        rounded: "rounded-lg rounded-bl-none",
        label: "Contato",
        labelColor: "text-text-secondary",
      };
    }
    if (message.senderType === "ai") {
      return {
        align: "justify-end" as const,
        bg: "bg-purple-600/80 text-white",
        rounded: "rounded-lg rounded-br-none",
        label: "Agente IA",
        labelColor: "text-purple-300",
      };
    }
    // Human team member
    return {
      align: "justify-end" as const,
      bg: "bg-brand-600 text-white",
      rounded: "rounded-lg rounded-br-none",
      label: "Equipe",
      labelColor: "text-brand-200",
    };
  };

  const getChannelBadgeVariant = (channel: string) => {
    switch (channel) {
      case "whatsapp":
        return "success";
      case "telegram":
        return "info";
      case "email":
        return "brand";
      default:
        return "default";
    }
  };

  return (
    <>
      <SpotlightTooltip spotlightId="inbox" organizationId={organizationId} />
      <div className="h-full flex flex-col md:flex-row">
      {/* Conversations List */}
      <div
        className={cn(
          "w-full md:w-80 lg:w-96 bg-surface-raised md:border-r md:border-border flex flex-col",
          showMessages && "hidden md:flex"
        )}
      >
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Conversas</h2>
        </div>

        <div className="overflow-y-auto flex-1">
          {validConversations.length === 0 ? (
            <div className="p-4 text-center text-text-muted">Nenhuma conversa ainda</div>
          ) : (
            validConversations.map((conversation) => (
              <div
                key={conversation._id}
                onClick={() => handleSelectConversation(conversation._id)}
                className={cn(
                  "p-4 border-b border-border cursor-pointer transition-colors",
                  "hover:bg-surface-overlay active:bg-surface-overlay",
                  selectedConversation === conversation._id &&
                    "bg-brand-500/10 border-l-2 border-l-brand-500"
                )}
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium text-text-primary truncate">
                    {conversation.contact?.firstName} {conversation.contact?.lastName}
                  </h3>
                  <Badge variant={getChannelBadgeVariant(conversation.channel)}>
                    {conversation.channel}
                  </Badge>
                </div>

                {conversation.lead && (
                  <p className="text-sm text-text-secondary mb-1 truncate">{conversation.lead.title}</p>
                )}

                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-muted tabular-nums">
                    {conversation.messageCount} {conversation.messageCount === 1 ? "mensagem" : "mensagens"}
                  </span>
                  <div className="flex items-center gap-2">
                    {conversation.assignee && (
                      <Avatar
                        name={conversation.assignee.name || "?"}
                        type={conversation.assignee.type === "ai" ? "ai" : "human"}
                        size="sm"
                      />
                    )}
                    {conversation.lastMessageAt && (
                      <span className="text-xs text-text-muted tabular-nums">
                        {new Date(conversation.lastMessageAt).toLocaleDateString("pt-BR")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        className={cn(
          "flex-1 flex flex-col bg-surface-base",
          !showMessages && "hidden md:flex"
        )}
      >
        {selectedConversation ? (
          <>
            {/* Mobile header with back button */}
            <div className="md:hidden p-4 border-b border-border bg-surface-raised flex items-center gap-3">
              <button
                onClick={handleBackToList}
                className="p-2 -ml-2 text-text-primary hover:bg-surface-overlay rounded-full transition-colors"
                aria-label="Voltar"
              >
                <ArrowLeft size={20} />
              </button>
              <h2 className="text-base font-semibold text-text-primary">
                {validConversations.find((c) => c._id === selectedConversation)?.contact?.firstName}{" "}
                {validConversations.find((c) => c._id === selectedConversation)?.contact?.lastName}
              </h2>
            </div>

            {/* Messages List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages?.map((message) => {
                const style = getMessageStyle(message);
                return (
                  <div key={message._id} className={`flex ${style.align}`}>
                    <div className={cn("max-w-xs lg:max-w-md px-4 py-2", style.bg, style.rounded)}>
                      {/* Sender type label */}
                      <div className={cn("text-xs font-medium mb-0.5", style.labelColor)}>
                        {message.sender?.name || style.label}
                      </div>
                      {message.isInternal ? (
                        <MentionRenderer content={message.content} className="text-sm" />
                      ) : (
                        <p className="text-sm">{message.content}</p>
                      )}
                      <div className="flex items-center justify-end mt-1">
                        <span className="text-xs opacity-75">
                          {new Date(message.createdAt).toLocaleTimeString("pt-BR", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Message Input */}
            <form onSubmit={handleSendMessage} className="p-4 border-t border-border bg-surface-raised">
              <div className="flex items-center gap-2 mb-2">
                <label className="flex items-center gap-1.5 text-sm text-text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isInternal}
                    onChange={(e) => setIsInternal(e.target.checked)}
                    className="rounded accent-brand-500"
                  />
                  Nota interna
                </label>
                {isInternal && (
                  <Badge variant="warning">Visível apenas para membros da equipe</Badge>
                )}
              </div>
              <div className="flex gap-2">
                <MentionTextarea
                  value={newMessage}
                  onChange={setNewMessage}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (newMessage.trim()) {
                        handleSendMessage(e as unknown as React.FormEvent);
                      }
                    }
                  }}
                  teamMembers={teamMembers ?? []}
                  mentionEnabled={isInternal}
                  placeholder={isInternal ? "Escreva uma nota interna... Use @ para mencionar" : "Digite uma mensagem..."}
                  rows={1}
                  className={cn(
                    "bg-surface-sunken",
                    isInternal
                      ? "border-semantic-warning/30 focus:border-semantic-warning focus:ring-semantic-warning/20"
                      : "border-border-strong focus:border-brand-500 focus:ring-brand-500/20"
                  )}
                />
                <Button
                  type="submit"
                  disabled={!newMessage.trim()}
                  variant={isInternal ? "secondary" : "primary"}
                  size="md"
                  className={cn(
                    "shrink-0",
                    isInternal && "bg-semantic-warning hover:bg-amber-600 text-white"
                  )}
                  aria-label={isInternal ? "Adicionar Nota" : "Enviar"}
                >
                  <Send size={16} />
                  <span className="hidden sm:inline">{isInternal ? "Adicionar Nota" : "Enviar"}</span>
                </Button>
              </div>
            </form>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-muted">
            Selecione uma conversa para ver as mensagens
          </div>
        )}
      </div>
    </div>
    </>
  );
}
