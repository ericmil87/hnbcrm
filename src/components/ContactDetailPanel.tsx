import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";
import { TAB_ROUTES } from "@/lib/routes";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { SocialIcons } from "@/components/SocialIcons";
import { CustomFieldsRenderer } from "@/components/CustomFieldsRenderer";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { LeadDetailPanel } from "@/components/LeadDetailPanel";
import { Trash2, Bot, ExternalLink, Target } from "lucide-react";
import { cn } from "@/lib/utils";

interface ContactDetailPanelProps {
  contactId: Id<"contacts">;
  onClose: () => void;
}

// All form fields in a single object
interface ContactForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  title: string;
  whatsappNumber: string;
  telegramUsername: string;
  tags: string;
  bio: string;
  photoUrl: string;
  linkedinUrl: string;
  instagramUrl: string;
  facebookUrl: string;
  twitterUrl: string;
  city: string;
  state: string;
  country: string;
  industry: string;
  companySize: string;
  cnpj: string;
  companyWebsite: string;
  preferredContactTime: string;
  deviceType: string;
  utmSource: string;
  acquisitionChannel: string;
  instagramFollowers: string;
  linkedinConnections: string;
  socialInfluenceScore: string;
  customFields: Record<string, any>;
}

function contactToForm(c: any): ContactForm {
  return {
    firstName: c.firstName || "",
    lastName: c.lastName || "",
    email: c.email || "",
    phone: c.phone || "",
    company: c.company || "",
    title: c.title || "",
    whatsappNumber: c.whatsappNumber || "",
    telegramUsername: c.telegramUsername || "",
    tags: (c.tags || []).join(", "),
    bio: c.bio || "",
    photoUrl: c.photoUrl || "",
    linkedinUrl: c.linkedinUrl || "",
    instagramUrl: c.instagramUrl || "",
    facebookUrl: c.facebookUrl || "",
    twitterUrl: c.twitterUrl || "",
    city: c.city || "",
    state: c.state || "",
    country: c.country || "",
    industry: c.industry || "",
    companySize: c.companySize || "",
    cnpj: c.cnpj || "",
    companyWebsite: c.companyWebsite || "",
    preferredContactTime: c.preferredContactTime || "",
    deviceType: c.deviceType || "",
    utmSource: c.utmSource || "",
    acquisitionChannel: c.acquisitionChannel || "",
    instagramFollowers: c.instagramFollowers != null ? String(c.instagramFollowers) : "",
    linkedinConnections: c.linkedinConnections != null ? String(c.linkedinConnections) : "",
    socialInfluenceScore: c.socialInfluenceScore != null ? String(c.socialInfluenceScore) : "",
    customFields: c.customFields || {},
  };
}

export function ContactDetailPanel({ contactId, onClose }: ContactDetailPanelProps) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<"info" | "leads">("info");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ContactForm | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Lead aberto a partir da aba "Leads Vinculados" — painel sobreposto a este.
  const [selectedLeadId, setSelectedLeadId] = useState<Id<"leads"> | null>(null);

  const contactData = useQuery(api.contacts.getContactWithLeads, { contactId });
  const fieldDefs = useQuery(
    api.fieldDefinitions.getFieldDefinitions,
    contactData ? { organizationId: contactData.organizationId, entityType: "contact" as const } : "skip"
  );

  const updateContact = useMutation(api.contacts.updateContact);
  const updateContactPhoto = useMutation(api.contacts.updateContactPhoto);
  const deleteContact = useMutation(api.contacts.deleteContact);

  // Initialize form when data first loads
  useEffect(() => {
    if (contactData && !initialized) {
      setForm(contactToForm(contactData));
      setInitialized(true);
    }
  }, [contactData, initialized]);

  const updateField = useCallback((key: keyof ContactForm, value: any) => {
    setForm((prev) => prev ? { ...prev, [key]: value } : prev);
  }, []);

  const handleSave = async () => {
    if (!contactData || !form) return;

    const tagsArray = form.tags.split(",").map((t) => t.trim()).filter(Boolean);

    const updatePromise = updateContact({
      contactId,
      firstName: form.firstName.trim() || undefined,
      lastName: form.lastName.trim() || undefined,
      email: form.email.trim() || undefined,
      phone: form.phone.trim() || undefined,
      company: form.company.trim() || undefined,
      title: form.title.trim() || undefined,
      whatsappNumber: form.whatsappNumber.trim() || undefined,
      telegramUsername: form.telegramUsername.trim() || undefined,
      tags: tagsArray,
      bio: form.bio.trim() || undefined,
      photoUrl: form.photoUrl.trim() || undefined,
      linkedinUrl: form.linkedinUrl.trim() || undefined,
      instagramUrl: form.instagramUrl.trim() || undefined,
      facebookUrl: form.facebookUrl.trim() || undefined,
      twitterUrl: form.twitterUrl.trim() || undefined,
      city: form.city.trim() || undefined,
      state: form.state.trim() || undefined,
      country: form.country.trim() || undefined,
      industry: form.industry.trim() || undefined,
      companySize: form.companySize || undefined,
      cnpj: form.cnpj.trim() || undefined,
      companyWebsite: form.companyWebsite.trim() || undefined,
      preferredContactTime: (form.preferredContactTime || undefined) as any,
      deviceType: (form.deviceType || undefined) as any,
      utmSource: form.utmSource.trim() || undefined,
      acquisitionChannel: form.acquisitionChannel.trim() || undefined,
      instagramFollowers: form.instagramFollowers ? Number(form.instagramFollowers) : undefined,
      linkedinConnections: form.linkedinConnections ? Number(form.linkedinConnections) : undefined,
      socialInfluenceScore: form.socialInfluenceScore ? Number(form.socialInfluenceScore) : undefined,
      customFields: Object.keys(form.customFields).length > 0 ? form.customFields : undefined,
    });

    toast.promise(updatePromise, {
      loading: "Salvando...",
      success: () => {
        setEditing(false);
        return "Contato atualizado com sucesso";
      },
      error: "Falha ao atualizar contato",
    });
  };

  const handleCancel = () => {
    if (contactData) setForm(contactToForm(contactData));
    setEditing(false);
  };

  const handleDelete = async () => {
    const deletePromise = deleteContact({ contactId });
    toast.promise(deletePromise, {
      loading: "Excluindo...",
      success: () => { onClose(); return "Contato excluído com sucesso"; },
      error: "Falha ao excluir contato",
    });
  };

  if (!contactData || !form) {
    return (
      <SlideOver open={true} onClose={onClose}>
        <div className="flex justify-center items-center py-12">
          <Spinner size="lg" />
        </div>
      </SlideOver>
    );
  }

  const contact = contactData;
  const leads = contactData.leads || [];
  const activeLeads = leads.filter((l: any) => l.archivedAt == null);
  const archivedLeads = leads.filter((l: any) => l.archivedAt != null);
  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  const displayName = fullName || contact.email || contact.phone || "Sem nome";
  const initials = [contact.firstName?.[0], contact.lastName?.[0]].filter(Boolean).join("").toUpperCase() || "?";
  const enrichMeta = contact.enrichmentMeta as Record<string, { source: string; updatedAt: number; confidence?: number }> | undefined;

  // Section field counts
  const countFilled = (fields: (string | undefined)[]) => fields.filter(Boolean).length;

  const identityFields = [contact.photoUrl, contact.firstName, contact.lastName, contact.bio];
  const contactFields = [contact.email, contact.phone, contact.whatsappNumber, contact.telegramUsername];
  const socialFields = [contact.linkedinUrl, contact.instagramUrl, contact.facebookUrl, contact.twitterUrl];
  const professionalFields = [contact.company, contact.title, contact.industry, contact.companySize, contact.cnpj, contact.companyWebsite];
  const locationFields = [contact.city, contact.state, contact.country];
  const behavioralFields = [contact.preferredContactTime, contact.deviceType, contact.utmSource, contact.acquisitionChannel];
  const metricsFields = [
    contact.instagramFollowers != null ? String(contact.instagramFollowers) : undefined,
    contact.linkedinConnections != null ? String(contact.linkedinConnections) : undefined,
    contact.socialInfluenceScore != null ? String(contact.socialInfluenceScore) : undefined,
  ];

  return (
    <>
    <SlideOver open={true} onClose={onClose} title={displayName}>
      <div className="flex flex-col h-full">
        {/* Tabs */}
        <div className="border-b border-border px-4 md:px-6 shrink-0">
          <div className="flex gap-4">
            <button
              onClick={() => setActiveTab("info")}
              className={cn(
                "px-1 py-3 text-sm font-medium border-b-2 transition-colors",
                activeTab === "info"
                  ? "border-brand-500 text-brand-500"
                  : "border-transparent text-text-secondary hover:text-text-primary"
              )}
            >
              Informações
            </button>
            <button
              onClick={() => setActiveTab("leads")}
              className={cn(
                "px-1 py-3 text-sm font-medium border-b-2 transition-colors",
                activeTab === "leads"
                  ? "border-brand-500 text-brand-500"
                  : "border-transparent text-text-secondary hover:text-text-primary"
              )}
            >
              Leads Vinculados ({leads.length})
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4">
          {activeTab === "info" ? (
            <div>
              {/* Edit toggle */}
              {!editing ? (
                <div className="mb-4">
                  <Button variant="primary" size="md" onClick={() => setEditing(true)} className="w-full">
                    Editar Informações
                  </Button>
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

              {/* Identidade */}
              <CollapsibleSection
                title="Identidade"
                defaultOpen={countFilled(identityFields) > 0 || editing}
                filledCount={countFilled(identityFields)}
                totalCount={identityFields.length}
              >
                {!editing ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <AvatarUpload
                        currentPhotoUrl={contact.photoUrl}
                        initials={initials}
                        organizationId={contact.organizationId}
                        fileType="contact_photo"
                        contactId={contactId}
                        onPhotoChange={(fileId) => {
                          updateContactPhoto({ contactId, photoFileId: fileId });
                        }}
                        size="md"
                      />
                      <div>
                        <div className="font-medium text-text-primary">{displayName}</div>
                        {contact.title && <div className="text-sm text-text-muted">{contact.title}</div>}
                      </div>
                    </div>
                    {contact.bio && <ViewField label="Bio" value={contact.bio} enrichMeta={enrichMeta?.bio} />}
                    {contact.tags && contact.tags.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-text-secondary mb-1">Tags</div>
                        <div className="flex flex-wrap gap-1">
                          {contact.tags.map((tag: string, idx: number) => (
                            <Badge key={idx} variant="default">{tag}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex justify-center">
                      <AvatarUpload
                        currentPhotoUrl={contact.photoUrl}
                        initials={initials}
                        organizationId={contact.organizationId}
                        fileType="contact_photo"
                        contactId={contactId}
                        onPhotoChange={(fileId) => {
                          updateContactPhoto({ contactId, photoFileId: fileId });
                        }}
                        size="lg"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <EditField label="Nome" value={form.firstName} onChange={(v) => updateField("firstName", v)} />
                      <EditField label="Sobrenome" value={form.lastName} onChange={(v) => updateField("lastName", v)} />
                    </div>
                    <EditField label="Bio" value={form.bio} onChange={(v) => updateField("bio", v)} multiline />
                    <EditField label="Tags (separadas por vírgula)" value={form.tags} onChange={(v) => updateField("tags", v)} placeholder="cliente, vip, parceiro" />
                  </div>
                )}
              </CollapsibleSection>

              {/* Contato */}
              <CollapsibleSection
                title="Contato"
                defaultOpen={countFilled(contactFields) > 0 || editing}
                filledCount={countFilled(contactFields)}
                totalCount={contactFields.length}
              >
                {!editing ? (
                  <div className="space-y-3">
                    <ViewField label="Email" value={contact.email} enrichMeta={enrichMeta?.email} />
                    <ViewField label="Telefone" value={contact.phone} enrichMeta={enrichMeta?.phone} />
                    <ViewField label="WhatsApp" value={contact.whatsappNumber} enrichMeta={enrichMeta?.whatsappNumber} />
                    <ViewField label="Telegram" value={contact.telegramUsername} enrichMeta={enrichMeta?.telegramUsername} />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <EditField label="Email" value={form.email} onChange={(v) => updateField("email", v)} type="email" />
                    <EditField label="Telefone" value={form.phone} onChange={(v) => updateField("phone", v)} />
                    <EditField label="WhatsApp" value={form.whatsappNumber} onChange={(v) => updateField("whatsappNumber", v)} />
                    <EditField label="Telegram" value={form.telegramUsername} onChange={(v) => updateField("telegramUsername", v)} placeholder="@username" />
                  </div>
                )}
              </CollapsibleSection>

              {/* Redes Sociais */}
              <CollapsibleSection
                title="Redes Sociais"
                defaultOpen={countFilled(socialFields) > 0}
                filledCount={countFilled(socialFields)}
                totalCount={socialFields.length}
              >
                {!editing ? (
                  <div className="space-y-3">
                    <SocialIcons
                      linkedinUrl={contact.linkedinUrl}
                      instagramUrl={contact.instagramUrl}
                      facebookUrl={contact.facebookUrl}
                      twitterUrl={contact.twitterUrl}
                    />
                    {!contact.linkedinUrl && !contact.instagramUrl && !contact.facebookUrl && !contact.twitterUrl && (
                      <p className="text-sm text-text-muted">Nenhuma rede social cadastrada</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <EditField label="LinkedIn URL" value={form.linkedinUrl} onChange={(v) => updateField("linkedinUrl", v)} placeholder="https://linkedin.com/in/..." />
                    <EditField label="Instagram URL" value={form.instagramUrl} onChange={(v) => updateField("instagramUrl", v)} placeholder="https://instagram.com/..." />
                    <EditField label="Facebook URL" value={form.facebookUrl} onChange={(v) => updateField("facebookUrl", v)} placeholder="https://facebook.com/..." />
                    <EditField label="Twitter/X URL" value={form.twitterUrl} onChange={(v) => updateField("twitterUrl", v)} placeholder="https://x.com/..." />
                  </div>
                )}
              </CollapsibleSection>

              {/* Profissional */}
              <CollapsibleSection
                title="Profissional"
                defaultOpen={countFilled(professionalFields) > 0 || editing}
                filledCount={countFilled(professionalFields)}
                totalCount={professionalFields.length}
              >
                {!editing ? (
                  <div className="space-y-3">
                    <ViewField label="Empresa" value={contact.company} enrichMeta={enrichMeta?.company} />
                    <ViewField label="Cargo" value={contact.title} enrichMeta={enrichMeta?.title} />
                    <ViewField label="Indústria" value={contact.industry} enrichMeta={enrichMeta?.industry} />
                    <ViewField label="Porte da Empresa" value={contact.companySize} enrichMeta={enrichMeta?.companySize} />
                    <ViewField label="CNPJ" value={contact.cnpj} enrichMeta={enrichMeta?.cnpj} />
                    <ViewField label="Site da Empresa" value={contact.companyWebsite} enrichMeta={enrichMeta?.companyWebsite} link />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <EditField label="Empresa" value={form.company} onChange={(v) => updateField("company", v)} />
                    <EditField label="Cargo" value={form.title} onChange={(v) => updateField("title", v)} />
                    <EditField label="Indústria" value={form.industry} onChange={(v) => updateField("industry", v)} />
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1">Porte da Empresa</label>
                      <select
                        value={form.companySize}
                        onChange={(e) => updateField("companySize", e.target.value)}
                        className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-sm"
                      >
                        <option value="">Selecionar...</option>
                        <option value="1-10">1-10</option>
                        <option value="11-50">11-50</option>
                        <option value="51-200">51-200</option>
                        <option value="201-1000">201-1000</option>
                        <option value="1000+">1000+</option>
                      </select>
                    </div>
                    <EditField label="CNPJ" value={form.cnpj} onChange={(v) => updateField("cnpj", v)} />
                    <EditField label="Site da Empresa" value={form.companyWebsite} onChange={(v) => updateField("companyWebsite", v)} placeholder="https://..." />
                  </div>
                )}
              </CollapsibleSection>

              {/* Localizacao */}
              <CollapsibleSection
                title="Localização"
                defaultOpen={countFilled(locationFields) > 0}
                filledCount={countFilled(locationFields)}
                totalCount={locationFields.length}
              >
                {!editing ? (
                  <div className="space-y-3">
                    <ViewField label="Cidade" value={contact.city} enrichMeta={enrichMeta?.city} />
                    <ViewField label="Estado" value={contact.state} enrichMeta={enrichMeta?.state} />
                    <ViewField label="País" value={contact.country} enrichMeta={enrichMeta?.country} />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <EditField label="Cidade" value={form.city} onChange={(v) => updateField("city", v)} />
                    <EditField label="Estado" value={form.state} onChange={(v) => updateField("state", v)} />
                    <EditField label="País" value={form.country} onChange={(v) => updateField("country", v)} />
                  </div>
                )}
              </CollapsibleSection>

              {/* Comportamental */}
              <CollapsibleSection
                title="Comportamental"
                defaultOpen={countFilled(behavioralFields) > 0}
                filledCount={countFilled(behavioralFields)}
                totalCount={behavioralFields.length}
              >
                {!editing ? (
                  <div className="space-y-3">
                    <ViewField label="Horário Preferido" value={
                      contact.preferredContactTime === "morning" ? "Manhã" :
                      contact.preferredContactTime === "afternoon" ? "Tarde" :
                      contact.preferredContactTime === "evening" ? "Noite" : undefined
                    } enrichMeta={enrichMeta?.preferredContactTime} />
                    <ViewField label="Dispositivo" value={contact.deviceType} enrichMeta={enrichMeta?.deviceType} />
                    <ViewField label="UTM Source" value={contact.utmSource} enrichMeta={enrichMeta?.utmSource} />
                    <ViewField label="Canal de Aquisição" value={contact.acquisitionChannel} enrichMeta={enrichMeta?.acquisitionChannel} />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1">Horário Preferido</label>
                      <select
                        value={form.preferredContactTime}
                        onChange={(e) => updateField("preferredContactTime", e.target.value)}
                        className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-sm"
                      >
                        <option value="">Selecionar...</option>
                        <option value="morning">Manhã</option>
                        <option value="afternoon">Tarde</option>
                        <option value="evening">Noite</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1">Dispositivo</label>
                      <select
                        value={form.deviceType}
                        onChange={(e) => updateField("deviceType", e.target.value)}
                        className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-sm"
                      >
                        <option value="">Selecionar...</option>
                        <option value="android">Android</option>
                        <option value="iphone">iPhone</option>
                        <option value="desktop">Desktop</option>
                        <option value="unknown">Desconhecido</option>
                      </select>
                    </div>
                    <EditField label="UTM Source" value={form.utmSource} onChange={(v) => updateField("utmSource", v)} />
                    <EditField label="Canal de Aquisição" value={form.acquisitionChannel} onChange={(v) => updateField("acquisitionChannel", v)} />
                  </div>
                )}
              </CollapsibleSection>

              {/* Metricas Sociais */}
              <CollapsibleSection
                title="Métricas Sociais"
                defaultOpen={countFilled(metricsFields) > 0}
                filledCount={countFilled(metricsFields)}
                totalCount={metricsFields.length}
              >
                {!editing ? (
                  <div className="space-y-3">
                    <ViewField label="Seguidores Instagram" value={contact.instagramFollowers != null ? String(contact.instagramFollowers) : undefined} enrichMeta={enrichMeta?.instagramFollowers} />
                    <ViewField label="Conexoes LinkedIn" value={contact.linkedinConnections != null ? String(contact.linkedinConnections) : undefined} enrichMeta={enrichMeta?.linkedinConnections} />
                    <ViewField label="Score de Influência (0-100)" value={contact.socialInfluenceScore != null ? String(contact.socialInfluenceScore) : undefined} enrichMeta={enrichMeta?.socialInfluenceScore} />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <EditField label="Seguidores Instagram" value={form.instagramFollowers} onChange={(v) => updateField("instagramFollowers", v)} type="number" />
                    <EditField label="Conexoes LinkedIn" value={form.linkedinConnections} onChange={(v) => updateField("linkedinConnections", v)} type="number" />
                    <EditField label="Score de Influência (0-100)" value={form.socialInfluenceScore} onChange={(v) => updateField("socialInfluenceScore", v)} type="number" />
                  </div>
                )}
              </CollapsibleSection>

              {/* Campos Personalizados */}
              {(fieldDefs && fieldDefs.length > 0) && (
                <CollapsibleSection
                  title="Campos Personalizados"
                  defaultOpen={Object.keys(contact.customFields || {}).length > 0 || editing}
                  filledCount={Object.keys(contact.customFields || {}).filter((k) => (contact.customFields || {})[k] != null && (contact.customFields || {})[k] !== "").length}
                  totalCount={fieldDefs.length}
                >
                  <CustomFieldsRenderer
                    fieldDefinitions={fieldDefs}
                    customFields={editing ? form.customFields : (contact.customFields || {})}
                    editing={editing}
                    onChange={(key, value) => {
                      setForm((prev) => prev ? {
                        ...prev,
                        customFields: { ...prev.customFields, [key]: value },
                      } : prev);
                    }}
                  />
                </CollapsibleSection>
              )}
            </div>
          ) : (
            /* Leads tab */
            <div className="space-y-3">
              {leads.length === 0 ? (
                <div className="flex flex-col items-center text-center py-10">
                  <div className="w-14 h-14 rounded-full bg-surface-overlay flex items-center justify-center mb-3">
                    <Target size={26} className="text-text-muted" />
                  </div>
                  <p className="text-sm font-medium text-text-primary">Nenhum lead vinculado</p>
                  <p className="text-sm text-text-secondary mt-1 max-w-xs">
                    Os leads criados para este contato aparecem aqui.
                  </p>
                </div>
              ) : (
                <>
                  {activeLeads.length === 0 && (
                    <p className="text-sm text-text-secondary py-2">
                      Nenhum lead ativo — veja os arquivados abaixo.
                    </p>
                  )}
                  {activeLeads.map((lead: any) => (
                    <LinkedLeadCard
                      key={lead._id}
                      lead={lead}
                      onOpen={() => setSelectedLeadId(lead._id as Id<"leads">)}
                      onOpenBoard={() => navigate(`${TAB_ROUTES.board}?lead=${lead._id}`)}
                    />
                  ))}

                  {archivedLeads.length > 0 && (
                    <CollapsibleSection title={`Arquivados (${archivedLeads.length})`}>
                      <div className="space-y-3">
                        {archivedLeads.map((lead: any) => (
                          <LinkedLeadCard
                            key={lead._id}
                            lead={lead}
                            archived
                            onOpen={() => setSelectedLeadId(lead._id as Id<"leads">)}
                            onOpenBoard={() => navigate(`${TAB_ROUTES.board}?lead=${lead._id}`)}
                          />
                        ))}
                      </div>
                    </CollapsibleSection>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer - Delete button */}
        <div className="border-t border-border px-4 md:px-6 py-4 shrink-0">
          <Button variant="danger" size="md" onClick={() => setShowDeleteConfirm(true)} className="w-full">
            <Trash2 size={18} className="mr-2" />
            Excluir Contato
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Excluir Contato"
        description="Tem certeza que deseja excluir este contato? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
      />
    </SlideOver>

    {/* Montado depois do SlideOver do contato para ficar por cima dele. */}
    {selectedLeadId && (
      <LeadDetailPanel
        leadId={selectedLeadId}
        organizationId={contact.organizationId as Id<"organizations">}
        onClose={() => setSelectedLeadId(null)}
        initialTab="details"
      />
    )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Card de lead vinculado                                             */
/* ------------------------------------------------------------------ */

function formatRelativeDate(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `há ${days} dia${days > 1 ? "s" : ""}`;
  return new Date(timestamp).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function LinkedLeadCard({
  lead,
  archived,
  onOpen,
  onOpenBoard,
}: {
  lead: any;
  archived?: boolean;
  onOpen: () => void;
  onOpenBoard: () => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Abrir os detalhes do lead ${lead.title}`}
        className="w-full text-left p-4 pr-14 bg-surface-sunken border border-border rounded-card cursor-pointer transition-colors hover:bg-surface-overlay hover:border-border-strong focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        <div className="flex items-start gap-2">
          <span className="flex-1 min-w-0 font-medium text-text-primary">{lead.title}</span>
          {archived && (
            <Badge variant="default" className="shrink-0">
              Arquivado
            </Badge>
          )}
        </div>

        {lead.value > 0 && (
          <div className="text-sm text-text-secondary mt-0.5 tabular-nums">
            {new Intl.NumberFormat("pt-BR", {
              style: "currency",
              currency: "BRL",
            }).format(lead.value)}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
          {lead.stage?.name && (
            <span className="inline-flex items-center gap-1.5 text-text-secondary">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: lead.stage.color || "#71717A" }}
                aria-hidden="true"
              />
              {lead.stage.name}
            </span>
          )}
          {lead.boardName && <span className="truncate">{lead.boardName}</span>}
          <span className="truncate">{lead.assigneeName || "Não atribuído"}</span>
          {lead.updatedAt && <span>Atualizado {formatRelativeDate(lead.updatedAt)}</span>}
        </div>
      </button>

      <button
        type="button"
        onClick={onOpenBoard}
        title="Abrir no funil"
        aria-label={`Abrir o lead ${lead.title} no funil`}
        className="absolute top-2 right-2 flex items-center justify-center min-h-[44px] min-w-[44px] rounded-full text-text-muted transition-colors hover:text-brand-500 hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        <ExternalLink size={16} />
      </button>
    </div>
  );
}

// View field with optional enrichment indicator
function ViewField({
  label,
  value,
  enrichMeta,
  link,
}: {
  label: string;
  value?: string;
  enrichMeta?: { source: string; updatedAt: number; confidence?: number };
  link?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-xs font-medium text-text-secondary">{label}</span>
        {enrichMeta && enrichMeta.source !== "manual" && (
          <span title={`Fonte: ${enrichMeta.source} | ${new Date(enrichMeta.updatedAt).toLocaleDateString("pt-BR")}${enrichMeta.confidence != null ? ` | Confianca: ${Math.round(enrichMeta.confidence * 100)}%` : ""}`}>
            <Bot size={12} className="text-brand-400" />
          </span>
        )}
      </div>
      {link && value ? (
        <a
          href={value.startsWith("http") ? value : `https://${value}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-brand-400 hover:underline"
        >
          {value}
        </a>
      ) : (
        <div className="text-sm text-text-primary">{value || "\u2014"}</div>
      )}
    </div>
  );
}

// Edit field input
function EditField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const inputClass =
    "w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500";

  return (
    <div>
      <label className="block text-xs font-medium text-text-secondary mb-1">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={cn(inputClass, "resize-none")}
          style={{ fontSize: "16px" }}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={inputClass}
          style={{ fontSize: "16px" }}
        />
      )}
    </div>
  );
}
