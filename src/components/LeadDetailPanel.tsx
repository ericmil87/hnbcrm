import React, { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

interface LeadDetailPanelProps {
  leadId: string;
  organizationId: string;
  onClose: () => void;
}

type Tab = "conversation" | "details" | "activity";

export function LeadDetailPanel({ leadId, organizationId, onClose }: LeadDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>("conversation");

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-30 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-[480px] bg-white shadow-xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Lead Details</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Tab Bar */}
        <div className="flex border-b border-gray-200">
          {(["conversation", "details", "activity"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 px-4 py-3 text-sm font-medium text-center capitalize ${
                activeTab === tab
                  ? "text-blue-600 border-b-2 border-blue-600"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "conversation" && (
            <ConversationTab
              leadId={leadId}
              organizationId={organizationId}
            />
          )}
          {activeTab === "details" && (
            <DetailsTab leadId={leadId} />
          )}
          {activeTab === "activity" && (
            <ActivityTab leadId={leadId} />
          )}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Conversation Tab                                                   */
/* ------------------------------------------------------------------ */

function ConversationTab({
  leadId,
  organizationId,
}: {
  leadId: string;
  organizationId: string;
}) {
  const [messageText, setMessageText] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const conversations = useQuery(api.conversations.getConversations, {
    organizationId: organizationId as Id<"organizations">,
    leadId: leadId as Id<"leads">,
  });

  const firstConversation = conversations && conversations.length > 0 ? conversations[0] : null;

  const messages = useQuery(
    api.conversations.getMessages,
    firstConversation ? { conversationId: firstConversation._id as Id<"conversations"> } : "skip"
  );

  const sendMessage = useMutation(api.conversations.sendMessage);
  const createConversation = useMutation(api.conversations.createConversation);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!messageText.trim() || sending) return;
    setSending(true);

    try {
      let conversationId: Id<"conversations">;

      if (firstConversation) {
        conversationId = firstConversation._id as Id<"conversations">;
      } else {
        conversationId = await createConversation({
          organizationId: organizationId as Id<"organizations">,
          leadId: leadId as Id<"leads">,
          channel: "internal",
        });
      }

      await sendMessage({
        conversationId,
        content: messageText.trim(),
        contentType: "text",
        isInternal,
      });

      setMessageText("");
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {!conversations && (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
          </div>
        )}

        {conversations && conversations.length === 0 && (
          <div className="text-center py-12 text-gray-500 text-sm">
            No conversation yet. Send a message to start one.
          </div>
        )}

        {messages &&
          messages.map((msg) => {
            const isOutbound = msg.direction === "outbound";
            const isInternalMsg = msg.direction === "internal";

            return (
              <div
                key={msg._id}
                className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                    isInternalMsg
                      ? "bg-yellow-50 border-2 border-dashed border-yellow-300 text-yellow-900"
                      : isOutbound
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-900"
                  }`}
                >
                  <div
                    className={`text-xs font-medium mb-1 ${
                      isInternalMsg
                        ? "text-yellow-700"
                        : isOutbound
                        ? "text-blue-200"
                        : "text-gray-500"
                    }`}
                  >
                    {msg.senderType === "contact"
                      ? "Contact"
                      : msg.senderType === "ai"
                      ? "AI"
                      : "Human"}
                    {isInternalMsg && " (internal note)"}
                  </div>
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  <div
                    className={`text-xs mt-1 ${
                      isInternalMsg
                        ? "text-yellow-600"
                        : isOutbound
                        ? "text-blue-200"
                        : "text-gray-400"
                    }`}
                  >
                    {new Date(msg.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-gray-200 p-4">
        <div className="flex items-center gap-2 mb-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isInternal}
              onChange={(e) => setIsInternal(e.target.checked)}
              className="rounded border-gray-300 text-yellow-500 focus:ring-yellow-500"
            />
            Internal note
          </label>
        </div>
        <div className="flex gap-2">
          <textarea
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isInternal ? "Write an internal note..." : "Type a message..."}
            rows={2}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleSend}
            disabled={!messageText.trim() || sending}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed self-end"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Details Tab                                                        */
/* ------------------------------------------------------------------ */

function DetailsTab({ leadId }: { leadId: string }) {
  const lead = useQuery(api.leads.getLead, { leadId: leadId as Id<"leads"> });
  const updateLead = useMutation(api.leads.updateLead);
  const updateQualification = useMutation(api.leads.updateLeadQualification);

  const [title, setTitle] = useState("");
  const [value, setValue] = useState(0);
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [temperature, setTemperature] = useState<"cold" | "warm" | "hot">("cold");
  const [tags, setTags] = useState("");

  const [budget, setBudget] = useState(false);
  const [authority, setAuthority] = useState(false);
  const [need, setNeed] = useState(false);
  const [timeline, setTimeline] = useState(false);

  const [saving, setSaving] = useState(false);
  const [savingBant, setSavingBant] = useState(false);

  // Populate form when lead data loads
  useEffect(() => {
    if (lead) {
      setTitle(lead.title);
      setValue(lead.value);
      setPriority(lead.priority);
      setTemperature(lead.temperature);
      setTags((lead.tags || []).join(", "));
      setBudget(lead.qualification?.budget ?? false);
      setAuthority(lead.qualification?.authority ?? false);
      setNeed(lead.qualification?.need ?? false);
      setTimeline(lead.qualification?.timeline ?? false);
    }
  }, [lead]);

  if (!lead) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
      </div>
    );
  }

  const handleSaveDetails = async () => {
    setSaving(true);
    try {
      await updateLead({
        leadId: leadId as Id<"leads">,
        title,
        value,
        priority,
        temperature,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
    } catch (error) {
      console.error("Failed to update lead:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBant = async () => {
    setSavingBant(true);
    try {
      const score = [budget, authority, need, timeline].filter(Boolean).length;
      await updateQualification({
        leadId: leadId as Id<"leads">,
        qualification: { budget, authority, need, timeline, score },
      });
    } catch (error) {
      console.error("Failed to update qualification:", error);
    } finally {
      setSavingBant(false);
    }
  };

  return (
    <div className="p-4 space-y-6">
      {/* Contact Info (read-only) */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
          Contact Information
        </h3>
        <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">Name</span>
            <span className="text-gray-900 font-medium">
              {lead.contact
                ? `${lead.contact.firstName || ""} ${lead.contact.lastName || ""}`.trim() || "—"
                : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Email</span>
            <span className="text-gray-900">{lead.contact?.email || "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Phone</span>
            <span className="text-gray-900">{lead.contact?.phone || "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Company</span>
            <span className="text-gray-900">{lead.contact?.company || "—"}</span>
          </div>
        </div>
      </div>

      {/* Editable Fields */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
          Lead Details
        </h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Value</label>
            <input
              type="number"
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as typeof priority)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Temperature</label>
            <select
              value={temperature}
              onChange={(e) => setTemperature(e.target.value as typeof temperature)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="cold">Cold</option>
              <option value="warm">Warm</option>
              <option value="hot">Hot</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Tags <span className="text-gray-400 font-normal">(comma-separated)</span>
            </label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="e.g. enterprise, urgent, follow-up"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            onClick={handleSaveDetails}
            disabled={saving}
            className="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Details"}
          </button>
        </div>
      </div>

      {/* BANT Qualification */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
          BANT Qualification
        </h3>
        <div className="space-y-3">
          {[
            { label: "Budget", checked: budget, setter: setBudget },
            { label: "Authority", checked: authority, setter: setAuthority },
            { label: "Need", checked: need, setter: setNeed },
            { label: "Timeline", checked: timeline, setter: setTimeline },
          ].map(({ label, checked, setter }) => (
            <label
              key={label}
              className="flex items-center gap-2 cursor-pointer select-none"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setter(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">{label}</span>
            </label>
          ))}

          <div className="text-xs text-gray-500">
            Score: {[budget, authority, need, timeline].filter(Boolean).length}/4
          </div>

          <button
            onClick={handleSaveBant}
            disabled={savingBant}
            className="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {savingBant ? "Saving..." : "Save Qualification"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Activity Tab                                                       */
/* ------------------------------------------------------------------ */

const activityTypeConfig: Record<string, { color: string; letter: string }> = {
  created: { color: "bg-green-500", letter: "C" },
  stage_change: { color: "bg-purple-500", letter: "S" },
  assignment: { color: "bg-indigo-500", letter: "A" },
  message_sent: { color: "bg-blue-500", letter: "M" },
  handoff: { color: "bg-orange-500", letter: "H" },
  qualification_update: { color: "bg-yellow-500", letter: "Q" },
  note: { color: "bg-gray-500", letter: "N" },
  call: { color: "bg-teal-500", letter: "P" },
  email_sent: { color: "bg-cyan-500", letter: "E" },
};

function ActivityTab({ leadId }: { leadId: string }) {
  const activities = useQuery(api.activities.getActivities, {
    leadId: leadId as Id<"leads">,
  });

  if (!activities) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500 text-sm">
        No activity recorded yet.
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />

        <div className="space-y-6">
          {activities.map((activity) => {
            const config = activityTypeConfig[activity.type] || {
              color: "bg-gray-400",
              letter: "?",
            };

            return (
              <div key={activity._id} className="relative flex items-start gap-3 pl-1">
                {/* Icon */}
                <div
                  className={`relative z-10 w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold ${config.color}`}
                >
                  {config.letter}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-gray-900">
                      {activity.actorName}
                    </span>
                    <span className="text-xs text-gray-400 whitespace-nowrap">
                      {new Date(activity.createdAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mt-0.5">
                    {activity.content || activity.type.replace(/_/g, " ")}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
