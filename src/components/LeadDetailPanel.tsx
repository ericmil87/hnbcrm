import React, { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  X,
  Search,
  ChevronDown,
  User,
  UserPlus,
  Link as LinkIcon,
  ExternalLink,
  Info,
} from "lucide-react";
import { MentionTextarea } from "@/components/ui/MentionTextarea";
import { MentionRenderer } from "@/components/ui/MentionRenderer";
import { extractMentionIds } from "@/lib/mentions";

interface LeadDetailPanelProps {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
  onClose: () => void;
}

type Tab = "conversation" | "details" | "activity";

export function LeadDetailPanel({ leadId, organizationId, onClose }: LeadDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>("conversation");

  const tabLabels: Record<Tab, string> = {
    conversation: "Conversa",
    details: "Detalhes",
    activity: "Atividade",
  };

  return (
    <SlideOver open={true} onClose={onClose} title="Detalhes do Lead">
      {/* Tab Bar */}
      <div className="flex border-b border-border bg-surface-raised">
        {(["conversation", "details", "activity"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex-1 px-4 py-3 text-sm font-medium text-center transition-colors",
              activeTab === tab
                ? "text-brand-500 border-b-2 border-brand-500"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            {tabLabels[tab]}
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
          <DetailsTab leadId={leadId} organizationId={organizationId} />
        )}
        {activeTab === "activity" && (
          <ActivityTab leadId={leadId} />
        )}
      </div>
    </SlideOver>
  );
}

/* ------------------------------------------------------------------ */
/*  Conversation Tab                                                   */
/* ------------------------------------------------------------------ */

function ConversationTab({
  leadId,
  organizationId,
}: {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
}) {
  const [messageText, setMessageText] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  const conversations = useQuery(api.conversations.getConversations, {
    organizationId,
    leadId,
  });

  const firstConversation = conversations && conversations.length > 0 ? conversations[0] : null;

  const messages = useQuery(
    api.conversations.getMessages,
    firstConversation ? { conversationId: firstConversation._id } : "skip"
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
        conversationId = firstConversation._id;
      } else {
        conversationId = await createConversation({
          organizationId,
          leadId,
          channel: "internal",
        });
      }

      const trimmed = messageText.trim();
      const mentionedUserIds = isInternal ? extractMentionIds(trimmed) : undefined;

      await sendMessage({
        conversationId,
        content: trimmed,
        contentType: "text",
        isInternal,
        mentionedUserIds: mentionedUserIds?.length ? mentionedUserIds : undefined,
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

  const getSenderLabel = (senderType: string): string => {
    const labels: Record<string, string> = {
      contact: "Contato",
      ai: "IA",
      human: "Humano",
    };
    return labels[senderType] || senderType;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {!conversations && (
          <div className="flex justify-center py-8">
            <Spinner size="md" />
          </div>
        )}

        {conversations && conversations.length === 0 && (
          <div className="text-center py-12 text-text-muted text-sm">
            Nenhuma conversa ainda. Envie uma mensagem para iniciar.
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
                  className={cn(
                    "max-w-[75%] rounded-lg px-3 py-2 text-sm",
                    isInternalMsg
                      ? "bg-surface-overlay border-2 border-dashed border-semantic-warning/40 text-text-primary"
                      : isOutbound
                      ? "bg-brand-600 text-white"
                      : "bg-surface-sunken text-text-primary"
                  )}
                >
                  <div
                    className={cn(
                      "text-xs font-medium mb-1",
                      isInternalMsg
                        ? "text-semantic-warning"
                        : isOutbound
                        ? "text-brand-100"
                        : "text-text-muted"
                    )}
                  >
                    {getSenderLabel(msg.senderType)}
                    {isInternalMsg && " (nota interna)"}
                  </div>
                  {isInternalMsg ? (
                    <MentionRenderer content={msg.content} className="whitespace-pre-wrap" />
                  ) : (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  )}
                  <div
                    className={cn(
                      "text-xs mt-1",
                      isInternalMsg
                        ? "text-semantic-warning/80"
                        : isOutbound
                        ? "text-brand-100"
                        : "text-text-muted"
                    )}
                  >
                    {new Date(msg.createdAt).toLocaleTimeString("pt-BR", {
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
      <div className="border-t border-border p-4 bg-surface-raised">
        <div className="flex items-center gap-2 mb-2">
          <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isInternal}
              onChange={(e) => setIsInternal(e.target.checked)}
              className="rounded border-border-strong text-semantic-warning focus:ring-semantic-warning accent-semantic-warning"
            />
            Nota interna
          </label>
        </div>
        <div className="flex gap-2">
          <MentionTextarea
            value={messageText}
            onChange={setMessageText}
            onKeyDown={handleKeyDown}
            teamMembers={teamMembers ?? []}
            mentionEnabled={isInternal}
            placeholder={isInternal ? "Escreva uma nota interna... Use @ para mencionar" : "Digite uma mensagem..."}
            rows={2}
          />
          <Button
            onClick={handleSend}
            disabled={!messageText.trim() || sending}
            variant="primary"
            size="md"
            className="self-end"
          >
            {sending ? "Enviando..." : "Enviar"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BANT Info Tooltip                                                  */
/* ------------------------------------------------------------------ */

function BantInfoTooltip() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-0.5 rounded-full text-text-muted hover:text-brand-400 hover:bg-brand-500/10 transition-colors"
        aria-label="O que é BANT?"
      >
        <Info size={14} />
      </button>

      {open && (
        <>
          {/* Mobile: fixed overlay */}
          <div className="fixed inset-0 z-40 bg-black/40 sm:hidden" onClick={() => setOpen(false)} />

          {/* Mobile: bottom sheet style */}
          <div className="fixed inset-x-0 bottom-0 z-50 sm:hidden animate-in slide-in-from-bottom">
            <div className="bg-surface-overlay border-t border-border rounded-t-2xl p-5 pb-8 safe-bottom">
              <div className="w-10 h-1 bg-border rounded-full mx-auto mb-4" />
              <BantInfoContent />
              <button
                onClick={() => setOpen(false)}
                className="mt-4 w-full py-2.5 bg-surface-raised text-text-secondary rounded-full text-sm font-medium hover:bg-surface-sunken transition-colors"
              >
                Entendi
              </button>
            </div>
          </div>

          {/* Desktop: popover (opens upward) */}
          <div className="hidden sm:block absolute left-0 bottom-full mb-2 w-72 bg-surface-overlay border border-border rounded-card shadow-elevated z-50 p-4">
            <div className="absolute -bottom-1.5 left-3 w-3 h-3 bg-surface-overlay border-r border-b border-border rotate-45" />
            <BantInfoContent />
          </div>
        </>
      )}
    </div>
  );
}

function BantInfoContent() {
  const items = [
    { letter: "B", label: "Budget", desc: "O prospect tem verba para comprar?" },
    { letter: "A", label: "Authority", desc: "Está falando com quem decide?" },
    { letter: "N", label: "Need", desc: "Existe uma dor real que seu produto resolve?" },
    { letter: "T", label: "Timeline", desc: "Há urgência ou prazo definido?" },
  ];

  return (
    <div>
      <h4 className="text-sm font-semibold text-text-primary mb-1">O que é BANT?</h4>
      <p className="text-xs text-text-secondary mb-3 leading-relaxed">
        Framework de qualificação de leads usado em vendas B2B. Quanto mais critérios atendidos, maior a chance de fechamento.
      </p>
      <div className="space-y-2.5">
        {items.map(({ letter, label, desc }) => (
          <div key={letter} className="flex items-start gap-2.5">
            <span className="flex-shrink-0 w-6 h-6 rounded-md bg-brand-600 text-white text-xs font-bold flex items-center justify-center">
              {letter}
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-text-primary">{label}</span>
              <p className="text-xs text-text-muted leading-tight">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Details Tab                                                        */
/* ------------------------------------------------------------------ */

function DetailsTab({ leadId, organizationId }: { leadId: Id<"leads">; organizationId: Id<"organizations"> }) {
  const lead = useQuery(api.leads.getLead, { leadId });
  const updateLead = useMutation(api.leads.updateLead);
  const updateQualification = useMutation(api.leads.updateLeadQualification);
  const linkContactMutation = useMutation(api.leads.linkContact);
  const assignLeadMutation = useMutation(api.leads.assignLead);
  const moveLeadToStageMutation = useMutation(api.leads.moveLeadToStage);

  // Contact picker state
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [contactSearchText, setContactSearchText] = useState("");
  const contacts = useQuery(api.contacts.getContacts, { organizationId });

  // Assignee picker state
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  // Stage picker state
  const [showStagePicker, setShowStagePicker] = useState(false);
  const boards = useQuery(api.boards.getBoards, { organizationId });
  const [selectedBoardId, setSelectedBoardId] = useState<Id<"boards"> | null>(null);
  const stages = useQuery(
    api.boards.getStages,
    selectedBoardId ? { boardId: selectedBoardId } : "skip"
  );

  const [title, setTitle] = useState("");
  const [value, setValue] = useState(0);
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [temperature, setTemperature] = useState<"cold" | "warm" | "hot">("cold");
  const [tags, setTags] = useState("");

  const [budget, setBudget] = useState(false);
  const [authority, setAuthority] = useState(false);
  const [need, setNeed] = useState(false);
  const [timeline, setTimeline] = useState(false);
  const bantScore = [budget, authority, need, timeline].filter(Boolean).length;

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
        <Spinner size="md" />
      </div>
    );
  }

  const handleSaveDetails = async () => {
    setSaving(true);
    try {
      await updateLead({
        leadId,
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
        leadId,
        qualification: { budget, authority, need, timeline, score },
      });
    } catch (error) {
      console.error("Failed to update qualification:", error);
    } finally {
      setSavingBant(false);
    }
  };

  // Contact handlers
  const handleLinkContact = async (contactId: Id<"contacts">) => {
    try {
      await linkContactMutation({ leadId, contactId });
      setShowContactPicker(false);
      setContactSearchText("");
      toast.success("Contato vinculado com sucesso");
    } catch (error: any) {
      toast.error(error.message || "Falha ao vincular contato");
    }
  };

  const handleUnlinkContact = async () => {
    try {
      await linkContactMutation({ leadId });
      toast.success("Contato desvinculado com sucesso");
    } catch (error: any) {
      toast.error(error.message || "Falha ao desvincular contato");
    }
  };

  // Assignee handlers
  const handleAssignLead = async (assignedTo?: Id<"teamMembers">) => {
    try {
      await assignLeadMutation({ leadId, assignedTo });
      setShowAssigneePicker(false);
      toast.success(assignedTo ? "Lead atribuído com sucesso" : "Lead desatribuído com sucesso");
    } catch (error: any) {
      toast.error(error.message || "Falha ao atribuir lead");
    }
  };

  // Stage handlers
  const handleMoveToStage = async (stageId: Id<"stages">) => {
    try {
      await moveLeadToStageMutation({ leadId, stageId });
      setShowStagePicker(false);
      setSelectedBoardId(null);
      toast.success("Lead movido com sucesso");
    } catch (error: any) {
      toast.error(error.message || "Falha ao mover lead");
    }
  };

  // Filter contacts by search text
  const filteredContacts = contacts?.filter((contact) => {
    if (!contactSearchText.trim()) return true;
    const searchLower = contactSearchText.toLowerCase();
    const fullName = `${contact.firstName || ""} ${contact.lastName || ""}`.toLowerCase();
    const email = contact.email?.toLowerCase() || "";
    const company = contact.company?.toLowerCase() || "";
    return fullName.includes(searchLower) || email.includes(searchLower) || company.includes(searchLower);
  });

  return (
    <div className="p-4 space-y-6">
      {/* Contact Section - Interactive */}
      <div>
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Contato Vinculado
        </h3>
        {lead.contact ? (
          <div className="bg-surface-sunken rounded-card p-4 space-y-3">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-muted">Nome</span>
                <span className="text-text-primary font-medium">
                  {`${lead.contact.firstName || ""} ${lead.contact.lastName || ""}`.trim() || "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Email</span>
                <span className="text-text-primary">{lead.contact.email || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Telefone</span>
                <span className="text-text-primary">{lead.contact.phone || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Empresa</span>
                <span className="text-text-primary">{lead.contact.company || "—"}</span>
              </div>
            </div>
            <div className="flex gap-2 pt-2 border-t border-border">
              <Button
                onClick={() => setShowContactPicker(true)}
                variant="secondary"
                size="sm"
                className="flex-1"
              >
                <ExternalLink size={16} />
                Alterar
              </Button>
              <Button
                onClick={handleUnlinkContact}
                variant="ghost"
                size="sm"
                aria-label="Desvincular contato"
              >
                <X size={16} />
              </Button>
            </div>
          </div>
        ) : (
          <div className="bg-surface-sunken rounded-card p-4 text-center">
            <p className="text-sm text-text-muted mb-3">Nenhum contato vinculado</p>
            <Button
              onClick={() => setShowContactPicker(true)}
              variant="primary"
              size="sm"
            >
              <LinkIcon size={16} />
              Vincular Contato
            </Button>
          </div>
        )}

        {/* Contact Picker Dropdown */}
        {showContactPicker && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => {
                setShowContactPicker(false);
                setContactSearchText("");
              }}
            />
            <div className="relative z-50 mt-2 bg-surface-overlay border border-border rounded-xl shadow-xl max-h-80 overflow-hidden">
              <div className="p-3 border-b border-border">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
                  <input
                    type="text"
                    value={contactSearchText}
                    onChange={(e) => setContactSearchText(e.target.value)}
                    placeholder="Buscar contato..."
                    className="w-full pl-9 pr-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                    style={{ fontSize: "16px" }}
                    autoFocus
                  />
                </div>
                {contacts && contacts.length >= 500 && (
                  <p className="text-xs text-text-muted mt-2">
                    Mostrando os primeiros 500 contatos.
                  </p>
                )}
              </div>
              <div className="overflow-y-auto max-h-64">
                {filteredContacts && filteredContacts.length > 0 ? (
                  filteredContacts.map((contact) => (
                    <button
                      key={contact._id}
                      onClick={() => handleLinkContact(contact._id)}
                      className="w-full px-4 py-3 text-left hover:bg-surface-raised transition-colors border-b border-border-subtle last:border-0"
                    >
                      <div className="font-medium text-sm text-text-primary">
                        {`${contact.firstName || ""} ${contact.lastName || ""}`.trim() || "Sem nome"}
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">
                        {contact.email}
                        {contact.company && ` • ${contact.company}`}
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-text-muted">
                    {contacts === undefined ? (
                      <Spinner size="sm" />
                    ) : (
                      "Nenhum contato encontrado"
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Assignee Section */}
      <div className="relative">
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Atribuído a
        </h3>
        <button
          onClick={() => setShowAssigneePicker(!showAssigneePicker)}
          className="w-full px-4 py-3 bg-surface-sunken rounded-card text-left hover:bg-surface-raised transition-colors flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <User size={16} className="text-text-muted" />
            <span className="text-sm text-text-primary font-medium">
              {lead.assignee ? lead.assignee.name : "Não atribuído"}
            </span>
            {lead.assignee && (
              <Badge variant="default" className="text-xs">
                {lead.assignee.type === "ai" ? "IA" : lead.assignee.role === "admin" ? "Admin" : lead.assignee.role === "manager" ? "Gerente" : "Agente"}
              </Badge>
            )}
          </div>
          <ChevronDown size={16} className="text-text-muted" />
        </button>

        {/* Assignee Picker Dropdown */}
        {showAssigneePicker && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setShowAssigneePicker(false)}
            />
            <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-surface-overlay border border-border rounded-xl shadow-xl max-h-80 overflow-y-auto">
              <button
                onClick={() => handleAssignLead()}
                className={cn(
                  "w-full px-4 py-3 text-left hover:bg-surface-raised transition-colors border-b border-border-subtle",
                  !lead.assignedTo && "bg-brand-500/10"
                )}
              >
                <div className="flex items-center gap-2">
                  <UserPlus size={16} className="text-text-muted" />
                  <span className="text-sm text-text-primary font-medium">Não atribuído</span>
                </div>
              </button>
              {teamMembers?.map((member) => (
                <button
                  key={member._id}
                  onClick={() => handleAssignLead(member._id)}
                  className={cn(
                    "w-full px-4 py-3 text-left hover:bg-surface-raised transition-colors border-b border-border-subtle last:border-0",
                    lead.assignedTo === member._id && "bg-brand-500/10"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-text-primary font-medium">{member.name}</span>
                      <Badge variant="default" className="text-xs">
                        {member.type === "ai" ? "IA" : member.role === "admin" ? "Admin" : member.role === "manager" ? "Gerente" : "Agente"}
                      </Badge>
                    </div>
                  </div>
                  {member.email && (
                    <div className="text-xs text-text-muted mt-0.5">{member.email}</div>
                  )}
                </button>
              ))}
              {!teamMembers && (
                <div className="px-4 py-8 text-center">
                  <Spinner size="sm" />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Stage Section */}
      <div className="relative">
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Pipeline e Etapa
        </h3>
        <button
          onClick={() => {
            setShowStagePicker(!showStagePicker);
            if (!showStagePicker && lead.board) {
              setSelectedBoardId(lead.board._id);
            }
          }}
          className="w-full px-4 py-3 bg-surface-sunken rounded-card text-left hover:bg-surface-raised transition-colors flex items-center justify-between"
        >
          <div>
            <div className="text-xs text-text-muted">{lead.board?.name || "Pipeline"}</div>
            <div className="text-sm text-text-primary font-medium mt-0.5">
              {lead.stage?.name || "Sem etapa"}
            </div>
          </div>
          <ChevronDown size={16} className="text-text-muted" />
        </button>

        {/* Stage Picker Dropdown */}
        {showStagePicker && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => {
                setShowStagePicker(false);
                setSelectedBoardId(null);
              }}
            />
            <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-surface-overlay border border-border rounded-xl shadow-xl max-h-96 overflow-hidden">
              {/* Board selector */}
              <div className="p-3 border-b border-border bg-surface-raised">
                <label className="block text-xs text-text-muted mb-1.5">Pipeline</label>
                <select
                  value={selectedBoardId || ""}
                  onChange={(e) => setSelectedBoardId(e.target.value as Id<"boards">)}
                  className="w-full px-3 py-2 bg-surface-sunken border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  style={{ fontSize: "16px" }}
                >
                  <option value="">Selecione um pipeline</option>
                  {boards?.map((board) => (
                    <option key={board._id} value={board._id}>
                      {board.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Stages list */}
              <div className="overflow-y-auto max-h-64">
                {stages && stages.length > 0 ? (
                  stages.map((stage) => (
                    <button
                      key={stage._id}
                      onClick={() => handleMoveToStage(stage._id)}
                      className={cn(
                        "w-full px-4 py-3 text-left hover:bg-surface-raised transition-colors border-b border-border-subtle last:border-0",
                        lead.stageId === stage._id && "bg-brand-500/10"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-text-primary font-medium">{stage.name}</span>
                        {(stage.isClosedWon || stage.isClosedLost) && (
                          <Badge variant={stage.isClosedWon ? "success" : "error"} className="text-xs">
                            {stage.isClosedWon ? "Ganho" : "Perdido"}
                          </Badge>
                        )}
                      </div>
                    </button>
                  ))
                ) : selectedBoardId ? (
                  <div className="px-4 py-8 text-center text-sm text-text-muted">
                    {stages === undefined ? (
                      <Spinner size="sm" />
                    ) : (
                      "Nenhuma etapa encontrada"
                    )}
                  </div>
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-text-muted">
                    Selecione um pipeline acima
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Editable Fields */}
      <div>
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Detalhes do Lead
        </h3>
        <div className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Título</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Valor</label>
            <input
              type="number"
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Prioridade</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as typeof priority)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            >
              <option value="low">Baixa</option>
              <option value="medium">Média</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </select>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Temperatura</label>
            <select
              value={temperature}
              onChange={(e) => setTemperature(e.target.value as typeof temperature)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            >
              <option value="cold">Frio</option>
              <option value="warm">Morno</option>
              <option value="hot">Quente</option>
            </select>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">
              Tags <span className="text-text-muted font-normal">(separadas por vírgula)</span>
            </label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="ex: enterprise, urgente, follow-up"
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
              style={{ fontSize: "16px" }}
            />
          </div>

          <Button
            onClick={handleSaveDetails}
            disabled={saving}
            variant="primary"
            size="md"
            className="w-full"
          >
            {saving ? "Salvando..." : "Salvar Detalhes"}
          </Button>
        </div>
      </div>

      {/* BANT Qualification */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide">
            Qualificação BANT
          </h3>
          <BantInfoTooltip />
        </div>
        <div className="space-y-3">
          {([
            { key: "budget" as const, label: "Orçamento", desc: "O prospect tem verba disponível?", checked: budget, setter: setBudget },
            { key: "authority" as const, label: "Autoridade", desc: "Está falando com o decisor?", checked: authority, setter: setAuthority },
            { key: "need" as const, label: "Necessidade", desc: "Existe uma dor real a resolver?", checked: need, setter: setNeed },
            { key: "timeline" as const, label: "Prazo", desc: "Há urgência ou prazo definido?", checked: timeline, setter: setTimeline },
          ] as const).map(({ key, label, desc, checked, setter }) => (
            <label
              key={key}
              className="flex items-start gap-2.5 cursor-pointer select-none group"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setter(e.target.checked)}
                className="mt-0.5 rounded border-border-strong text-brand-500 focus:ring-brand-500 accent-brand-500"
              />
              <div className="flex-1 min-w-0">
                <span className="text-sm text-text-primary font-medium">{label}</span>
                <p className="text-xs text-text-muted leading-tight">{desc}</p>
              </div>
            </label>
          ))}

          {/* Score bar */}
          <div className="pt-1">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-text-muted">Pontuação</span>
              <span className={cn(
                "text-xs font-semibold tabular-nums",
                bantScore === 4 ? "text-semantic-success" :
                bantScore >= 2 ? "text-semantic-warning" :
                "text-text-muted"
              )}>
                {bantScore}/4
              </span>
            </div>
            <div className="flex gap-1">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={cn(
                    "h-1.5 flex-1 rounded-full transition-colors",
                    i < bantScore
                      ? bantScore === 4 ? "bg-semantic-success"
                        : bantScore >= 2 ? "bg-semantic-warning"
                        : "bg-semantic-error"
                      : "bg-surface-raised"
                  )}
                />
              ))}
            </div>
          </div>

          <Button
            onClick={handleSaveBant}
            disabled={savingBant}
            variant="primary"
            size="md"
            className="w-full"
          >
            {savingBant ? "Salvando..." : "Salvar Qualificação"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Activity Tab                                                       */
/* ------------------------------------------------------------------ */

const activityTypeConfig: Record<string, { color: string; letter: string }> = {
  created: { color: "bg-semantic-success", letter: "C" },
  stage_change: { color: "bg-purple-500", letter: "S" },
  assignment: { color: "bg-indigo-500", letter: "A" },
  message_sent: { color: "bg-brand-500", letter: "M" },
  handoff: { color: "bg-brand-600", letter: "H" },
  qualification_update: { color: "bg-semantic-warning", letter: "Q" },
  note: { color: "bg-surface-overlay", letter: "N" },
  call: { color: "bg-teal-500", letter: "P" },
  email_sent: { color: "bg-semantic-info", letter: "E" },
};

function ActivityTab({ leadId }: { leadId: Id<"leads"> }) {
  const activities = useQuery(api.activities.getActivities, {
    leadId,
  });

  if (!activities) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="text-center py-12 text-text-muted text-sm">
        Nenhuma atividade registrada ainda.
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-border" />

        <div className="space-y-6">
          {activities.map((activity) => {
            const config = activityTypeConfig[activity.type] || {
              color: "bg-text-muted",
              letter: "?",
            };

            return (
              <div key={activity._id} className="relative flex items-start gap-3 pl-1">
                {/* Icon */}
                <div
                  className={cn(
                    "relative z-10 w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold",
                    config.color
                  )}
                >
                  {config.letter}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-text-primary">
                      {activity.actorName}
                    </span>
                    <span className="text-xs text-text-muted whitespace-nowrap">
                      {new Date(activity.createdAt).toLocaleString("pt-BR", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="text-sm text-text-secondary mt-0.5">
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
