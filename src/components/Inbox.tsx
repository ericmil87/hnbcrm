import React, { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

interface InboxProps {
  organizationId: string;
}

export function Inbox({ organizationId }: InboxProps) {
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [isInternal, setIsInternal] = useState(false);

  const conversations = useQuery(api.conversations.getConversations, {
    organizationId: organizationId as Id<"organizations">,
  });

  const messages = useQuery(api.conversations.getMessages,
    selectedConversation ? { conversationId: selectedConversation as Id<"conversations"> } : "skip"
  );

  const sendMessage = useMutation(api.conversations.sendMessage);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedConversation) return;

    try {
      await sendMessage({
        conversationId: selectedConversation as Id<"conversations">,
        content: newMessage,
        contentType: "text",
        isInternal,
      });
      setNewMessage("");
    } catch (error) {
      console.error("Failed to send message:", error);
    }
  };

  if (!conversations) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const validConversations = conversations.filter((c): c is NonNullable<typeof c> => c !== null);

  // Message bubble styling based on sender type
  const getMessageStyle = (message: any) => {
    if (message.isInternal) {
      return {
        align: "justify-end" as const,
        bg: "bg-yellow-50 border-2 border-dashed border-yellow-300 text-gray-900",
        label: "Internal Note",
        labelColor: "text-yellow-700",
      };
    }
    if (message.direction === "inbound" || message.senderType === "contact") {
      return {
        align: "justify-start" as const,
        bg: "bg-gray-200 text-gray-900",
        label: "Contact",
        labelColor: "text-gray-500",
      };
    }
    if (message.senderType === "ai") {
      return {
        align: "justify-end" as const,
        bg: "bg-purple-600 text-white",
        label: "AI Agent",
        labelColor: "text-purple-300",
      };
    }
    // Human team member
    return {
      align: "justify-end" as const,
      bg: "bg-blue-600 text-white",
      label: "Team",
      labelColor: "text-blue-200",
    };
  };

  return (
    <div className="h-full flex">
      {/* Conversations List */}
      <div className="w-1/3 border-r bg-gray-50">
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">Conversations</h2>
        </div>

        <div className="overflow-y-auto h-full">
          {validConversations.length === 0 ? (
            <div className="p-4 text-center text-gray-500">
              No conversations yet
            </div>
          ) : (
            validConversations.map((conversation) => (
              <div
                key={conversation._id}
                onClick={() => setSelectedConversation(conversation._id)}
                className={`p-4 border-b cursor-pointer hover:bg-gray-100 ${
                  selectedConversation === conversation._id ? "bg-blue-50 border-blue-200" : ""
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium text-gray-900">
                    {conversation.contact?.firstName} {conversation.contact?.lastName}
                  </h3>
                  <span className={`px-2 py-1 rounded-full text-xs ${
                    conversation.channel === "whatsapp" ? "bg-green-100 text-green-800" :
                    conversation.channel === "telegram" ? "bg-blue-100 text-blue-800" :
                    conversation.channel === "email" ? "bg-purple-100 text-purple-800" :
                    "bg-gray-100 text-gray-800"
                  }`}>
                    {conversation.channel}
                  </span>
                </div>

                {conversation.lead && (
                  <p className="text-sm text-gray-600 mb-1">{conversation.lead.title}</p>
                )}

                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">
                    {conversation.messageCount} messages
                  </span>
                  {conversation.assignee && (
                    <div className="flex items-center gap-1">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] ${
                        conversation.assignee.type === "ai" ? "bg-orange-500" : "bg-blue-500"
                      }`}>
                        {conversation.assignee.name?.charAt(0).toUpperCase()}
                      </div>
                      <span className={`text-[10px] font-medium ${
                        conversation.assignee.type === "ai" ? "text-orange-600" : "text-blue-600"
                      }`}>
                        {conversation.assignee.type === "ai" ? "AI" : ""}
                      </span>
                    </div>
                  )}
                  {conversation.lastMessageAt && (
                    <span className="text-xs text-gray-500">
                      {new Date(conversation.lastMessageAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 flex flex-col">
        {selectedConversation ? (
          <>
            {/* Messages List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages?.map((message) => {
                const style = getMessageStyle(message);
                return (
                  <div
                    key={message._id}
                    className={`flex ${style.align}`}
                  >
                    <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${style.bg}`}>
                      {/* Sender type label */}
                      <div className={`text-[10px] font-medium mb-0.5 ${style.labelColor}`}>
                        {message.sender?.name || style.label}
                        {message.senderType && ` (${message.senderType})`}
                      </div>
                      <p className="text-sm">{message.content}</p>
                      <div className="flex items-center justify-end mt-1">
                        <span className={`text-xs ${style.labelColor} opacity-75`}>
                          {new Date(message.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Message Input */}
            <form onSubmit={handleSendMessage} className="p-4 border-t">
              <div className="flex items-center gap-2 mb-2">
                <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isInternal}
                    onChange={(e) => setIsInternal(e.target.checked)}
                    className="rounded"
                  />
                  Internal note
                </label>
                {isInternal && (
                  <span className="text-xs text-yellow-600 bg-yellow-50 px-2 py-0.5 rounded">
                    Only visible to team members
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder={isInternal ? "Write an internal note..." : "Type a message..."}
                  className={`flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    isInternal ? "border-yellow-300 bg-yellow-50" : "border-gray-300"
                  }`}
                />
                <button
                  type="submit"
                  disabled={!newMessage.trim()}
                  className={`px-4 py-2 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed ${
                    isInternal ? "bg-yellow-600 hover:bg-yellow-700" : "bg-blue-600 hover:bg-blue-700"
                  }`}
                >
                  {isInternal ? "Add Note" : "Send"}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            Select a conversation to view messages
          </div>
        )}
      </div>
    </div>
  );
}
