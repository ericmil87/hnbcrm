import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { Trash2, MessageSquarePlus, UserX } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { TAB_ROUTES } from "@/lib/routes";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs, TabPanel } from "@/components/ui/Tabs";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LeadDetailPanel } from "@/components/LeadDetailPanel";
import { NewConversationModal } from "@/components/inbox/NewConversationModal";
import { usePermissions } from "@/hooks/usePermissions";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import { enumParam } from "@/lib/searchParamState";
import { contactFormToUpdate, contactToForm, type ContactForm } from "@/lib/contactForm";
import { ContactInfoTab } from "./ContactInfoTab";
import { ContactLeadsTab } from "./ContactLeadsTab";
import { ContactGroupsTab } from "./ContactGroupsTab";
import { ContactOptOutControl } from "./ContactOptOutControl";

export const CONTACT_TABS = ["info", "leads", "groups"] as const;
export type ContactTab = (typeof CONTACT_TABS)[number];
/** Codec constante: `?contactTab=` (replace; `info` é o padrão e sai da URL). */
const CONTACT_TAB_PARAM = enumParam<ContactTab>(CONTACT_TABS, "info");

const TABS_ID_PREFIX = "contact-detail";

interface ContactDetailPanelProps {
  contactId: Id<"contacts">;
  onClose: () => void;
}

export function ContactDetailPanel({ contactId, onClose }: ContactDetailPanelProps) {
  const navigate = useNavigate();
  const tabParam = useSearchParamState("contactTab", CONTACT_TAB_PARAM);
  const activeTab = tabParam.value;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ContactForm | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Lead aberto a partir da aba "Leads": painel sobreposto a este.
  const [selectedLeadId, setSelectedLeadId] = useState<Id<"leads"> | null>(null);
  // "Conversar no WhatsApp": abre o mesmo modal de Conversas já com este contato.
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [now] = useState(() => Date.now());

  const contactData = useQuery(api.contacts.getContactWithLeads, { contactId });
  const { can } = usePermissions(contactData?.organizationId as Id<"organizations">);
  const canStartConversation = !!contactData && can("inbox", "reply");
  const sendableChannels = useQuery(
    api.startConversation.listSendableWhatsappChannels,
    canStartConversation ? { organizationId: contactData.organizationId } : "skip"
  );
  const showStartConversation = canStartConversation && (sendableChannels?.length ?? 0) > 0;
  const fieldDefs = useQuery(
    api.fieldDefinitions.getFieldDefinitions,
    contactData ? { organizationId: contactData.organizationId, entityType: "contact" as const } : "skip"
  );
  // Grupos MONITORADOS em que este contato participa. O vínculo vem de
  // `groupChats.participants[].contactId`, que o ingest preenche quando o
  // telefone do membro já era conhecido: membro não vira contato.
  const contactGroups = useQuery(
    api.groupChats.listGroupsForContact,
    contactData ? { organizationId: contactData.organizationId, contactId } : "skip"
  );

  const updateContact = useMutation(api.contacts.updateContact);
  const updateContactPhoto = useMutation(api.contacts.updateContactPhoto);
  const deleteContact = useMutation(api.contacts.deleteContact);

  // O formulário nasce uma vez, quando os dados chegam.
  useEffect(() => {
    if (contactData && !initialized) {
      setForm(contactToForm(contactData));
      setInitialized(true);
    }
  }, [contactData, initialized]);

  const updateField = useCallback((key: keyof ContactForm, value: string) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const updateCustomField = useCallback((key: string, value: unknown) => {
    setForm((prev) => (prev ? { ...prev, customFields: { ...prev.customFields, [key]: value } } : prev));
  }, []);

  const handleSave = () => {
    if (!contactData || !form) return;
    const updatePromise = updateContact({ contactId, ...contactFormToUpdate(form) } as Parameters<typeof updateContact>[0]);
    toast.promise(updatePromise, {
      loading: "Salvando…",
      success: () => {
        setEditing(false);
        return "Contato atualizado";
      },
      error: "Não foi possível atualizar o contato.",
    });
  };

  const handleCancel = () => {
    if (contactData) setForm(contactToForm(contactData));
    setEditing(false);
  };

  const handleDelete = () => {
    toast.promise(deleteContact({ contactId }), {
      loading: "Excluindo…",
      success: () => {
        onClose();
        return "Contato excluído";
      },
      error: "Não foi possível excluir o contato.",
    });
  };

  if (contactData === null) {
    return (
      <SlideOver open onClose={onClose} title="Contato">
        <EmptyState
          icon={UserX}
          size="sm"
          title="Contato não encontrado"
          description="Ele pode ter sido excluído ou não pertence a esta organização."
          action={{ label: "Fechar", onClick: onClose }}
        />
      </SlideOver>
    );
  }

  if (!contactData || !form) {
    return (
      <SlideOver open onClose={onClose}>
        <div className="flex justify-center items-center py-12">
          <Spinner size="lg" />
        </div>
      </SlideOver>
    );
  }

  const contact = contactData;
  const organizationId = contact.organizationId as Id<"organizations">;
  const leads = contactData.leads || [];
  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  const displayName = fullName || contact.email || contact.phone || "Sem nome";
  const initials = [contact.firstName?.[0], contact.lastName?.[0]].filter(Boolean).join("").toUpperCase() || "?";

  return (
    <>
      <SlideOver open onClose={onClose} title={displayName}>
        <div className="flex flex-col h-full">
          <div className="border-b border-border px-4 md:px-6 shrink-0">
            <Tabs
              value={activeTab}
              onValueChange={(id) => tabParam.set(id as ContactTab)}
              ariaLabel="Seções do contato"
              idPrefix={TABS_ID_PREFIX}
              className="border-b-0"
              items={[
                { id: "info", label: "Informações" },
                { id: "leads", label: "Leads", badge: leads.length },
                { id: "groups", label: "Grupos", badge: contactGroups?.length },
              ]}
            />
          </div>

          <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4">
            <TabPanel id={activeTab} idPrefix={TABS_ID_PREFIX}>
              {activeTab === "groups" && (
                <ContactGroupsTab
                  groups={contactGroups}
                  onOpenConversation={(conversationId) =>
                    navigate(`${TAB_ROUTES.inbox}?conversation=${conversationId}`)
                  }
                />
              )}
              {activeTab === "leads" && (
                <ContactLeadsTab
                  leads={leads}
                  now={now}
                  onOpenLead={(leadId) => setSelectedLeadId(leadId as Id<"leads">)}
                  onOpenBoard={(leadId) => navigate(`${TAB_ROUTES.board}?lead=${leadId}`)}
                />
              )}
              {activeTab === "info" && (
                <>
                  {!editing ? (
                    <div className="mb-4 flex flex-col sm:flex-row gap-2">
                      <Button variant="primary" size="md" onClick={() => setEditing(true)} className="w-full sm:flex-1">
                        Editar informações
                      </Button>
                      {showStartConversation && (
                        <Button
                          variant="secondary"
                          size="md"
                          onClick={() => setShowNewConversation(true)}
                          className="w-full sm:flex-1"
                        >
                          <MessageSquarePlus size={16} aria-hidden="true" />
                          Conversar no WhatsApp
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="flex gap-2 mb-4">
                      <Button variant="secondary" size="md" onClick={handleCancel} className="flex-1">
                        Cancelar
                      </Button>
                      <Button variant="primary" size="md" onClick={handleSave} className="flex-1">
                        Salvar
                      </Button>
                    </div>
                  )}
                  <ContactInfoTab
                    contact={contact}
                    contactId={contactId}
                    form={form}
                    editing={editing}
                    fieldDefs={fieldDefs}
                    displayName={displayName}
                    initials={initials}
                    onChange={updateField}
                    onCustomFieldChange={updateCustomField}
                    onPhotoChange={(fileId) => {
                      void updateContactPhoto({ contactId, photoFileId: fileId });
                    }}
                  />
                </>
              )}
            </TabPanel>
          </div>

          {/* Rodapé: supressão de campanhas e exclusão */}
          <div className="border-t border-border px-4 md:px-6 py-4 shrink-0 space-y-2">
            <ContactOptOutControl contactId={contactId} organizationId={organizationId} />
            <Button variant="danger" size="md" onClick={() => setShowDeleteConfirm(true)} className="w-full">
              <Trash2 size={18} aria-hidden="true" />
              Excluir contato
            </Button>
          </div>
        </div>

        <ConfirmDialog
          open={showDeleteConfirm}
          onClose={() => setShowDeleteConfirm(false)}
          onConfirm={handleDelete}
          title="Excluir contato"
          description="Tem certeza que deseja excluir este contato? Esta ação não pode ser desfeita."
          confirmLabel="Excluir"
          variant="danger"
        />
      </SlideOver>

      {showStartConversation && (
        <NewConversationModal
          organizationId={organizationId}
          open={showNewConversation}
          onClose={() => setShowNewConversation(false)}
          initialContactId={contactId}
          onStarted={(conversationId) => {
            setShowNewConversation(false);
            onClose();
            navigate(`${TAB_ROUTES.inbox}?conversation=${conversationId}`);
          }}
        />
      )}

      {/* Montado depois do SlideOver do contato para ficar por cima dele. */}
      {selectedLeadId && (
        <LeadDetailPanel
          leadId={selectedLeadId}
          organizationId={organizationId}
          onClose={() => setSelectedLeadId(null)}
          initialTab="details"
        />
      )}
    </>
  );
}
