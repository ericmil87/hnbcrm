import { Badge } from "@/components/ui/Badge";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { AvatarUpload } from "@/components/ui/AvatarUpload";
import { SocialIcons } from "@/components/SocialIcons";
import { CustomFieldsRenderer } from "@/components/CustomFieldsRenderer";
import { countFilled, PREFERRED_TIME_LABELS, type ContactForm } from "@/lib/contactForm";
import { EditField, EditSelect, ViewField, type EnrichMeta } from "./ContactFields";
import type { Id } from "../../../../convex/_generated/dataModel";

type FieldDefinitions = React.ComponentProps<typeof CustomFieldsRenderer>["fieldDefinitions"];

const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-1000", "1000+"].map((v) => ({ value: v, label: v }));
const PREFERRED_TIMES = Object.entries(PREFERRED_TIME_LABELS).map(([value, label]) => ({ value, label }));
const DEVICES = [
  { value: "android", label: "Android" },
  { value: "iphone", label: "iPhone" },
  { value: "desktop", label: "Computador" },
  { value: "unknown", label: "Desconhecido" },
];

const numberText = (n: number | null | undefined) => (n != null ? String(n) : undefined);

interface ContactInfoTabProps {
  /** Contato como veio de `getContactWithLeads` (retorno solto). */
  contact: Record<string, any>;
  contactId: Id<"contacts">;
  form: ContactForm;
  editing: boolean;
  fieldDefs: FieldDefinitions | undefined;
  displayName: string;
  initials: string;
  onChange: (key: keyof ContactForm, value: string) => void;
  onCustomFieldChange: (key: string, value: unknown) => void;
  onPhotoChange: (fileId: Id<"files"> | undefined) => void;
}

/** Aba "Informações": quatro seções (Dados, Endereço e empresa, Origem, Etiquetas e notas). */
export function ContactInfoTab({
  contact,
  contactId,
  form,
  editing,
  fieldDefs,
  displayName,
  initials,
  onChange,
  onCustomFieldChange,
  onPhotoChange,
}: ContactInfoTabProps) {
  const enrichMeta = contact.enrichmentMeta as Record<string, EnrichMeta> | undefined;
  const meta = (key: string) => enrichMeta?.[key];
  const edit = (key: keyof ContactForm) => (value: string) => onChange(key, value);

  const dataFields = [
    contact.firstName, contact.lastName, contact.photoUrl,
    contact.email, contact.phone, contact.whatsappNumber, contact.telegramUsername,
    contact.linkedinUrl, contact.instagramUrl, contact.facebookUrl, contact.twitterUrl,
  ];
  const companyFields = [
    contact.company, contact.title, contact.industry, contact.companySize, contact.cnpj, contact.companyWebsite,
    contact.city, contact.state, contact.country,
  ];
  const originFields = [
    contact.preferredContactTime, contact.deviceType, contact.utmSource, contact.acquisitionChannel,
    numberText(contact.instagramFollowers), numberText(contact.linkedinConnections), numberText(contact.socialInfluenceScore),
  ];
  const notesFields = [contact.bio, (contact.tags ?? []).length > 0 ? "tags" : undefined];

  const customFields = (contact.customFields ?? {}) as Record<string, unknown>;
  const hasCustomFields = !!fieldDefs && fieldDefs.length > 0;
  const hasSocial = contact.linkedinUrl || contact.instagramUrl || contact.facebookUrl || contact.twitterUrl;

  const avatar = (size: "md" | "lg") => (
    <AvatarUpload
      currentPhotoUrl={contact.photoUrl}
      initials={initials}
      organizationId={contact.organizationId}
      fileType="contact_photo"
      contactId={contactId}
      onPhotoChange={onPhotoChange}
      size={size}
    />
  );

  return (
    <div>
      {/* Dados */}
      <CollapsibleSection
        title="Dados"
        defaultOpen
        filledCount={countFilled(dataFields)}
        totalCount={dataFields.length}
      >
        {!editing ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              {avatar("md")}
              <div>
                <div className="font-medium text-text-primary">{displayName}</div>
                {contact.title && <div className="text-sm text-text-muted">{contact.title}</div>}
              </div>
            </div>
            <ViewField label="E-mail" value={contact.email} enrichMeta={meta("email")} />
            <ViewField label="Telefone" value={contact.phone} enrichMeta={meta("phone")} />
            <ViewField label="WhatsApp" value={contact.whatsappNumber} enrichMeta={meta("whatsappNumber")} />
            <ViewField label="Telegram" value={contact.telegramUsername} enrichMeta={meta("telegramUsername")} />
            <div>
              <div className="text-xs font-medium text-text-secondary mb-1">Redes sociais</div>
              <SocialIcons
                linkedinUrl={contact.linkedinUrl}
                instagramUrl={contact.instagramUrl}
                facebookUrl={contact.facebookUrl}
                twitterUrl={contact.twitterUrl}
              />
              {!hasSocial && <p className="text-sm text-text-muted">Nenhuma rede social cadastrada</p>}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-center">{avatar("lg")}</div>
            <div className="grid grid-cols-2 gap-3">
              <EditField label="Nome" value={form.firstName} onChange={edit("firstName")} />
              <EditField label="Sobrenome" value={form.lastName} onChange={edit("lastName")} />
            </div>
            <EditField label="E-mail" value={form.email} onChange={edit("email")} type="email" />
            <EditField label="Telefone" value={form.phone} onChange={edit("phone")} />
            <EditField label="WhatsApp" value={form.whatsappNumber} onChange={edit("whatsappNumber")} />
            <EditField label="Telegram" value={form.telegramUsername} onChange={edit("telegramUsername")} placeholder="@usuario" />
            <EditField label="LinkedIn" value={form.linkedinUrl} onChange={edit("linkedinUrl")} placeholder="https://linkedin.com/in/…" />
            <EditField label="Instagram" value={form.instagramUrl} onChange={edit("instagramUrl")} placeholder="https://instagram.com/…" />
            <EditField label="Facebook" value={form.facebookUrl} onChange={edit("facebookUrl")} placeholder="https://facebook.com/…" />
            <EditField label="X (Twitter)" value={form.twitterUrl} onChange={edit("twitterUrl")} placeholder="https://x.com/…" />
          </div>
        )}
        {hasCustomFields && (
          <div className="mt-4 space-y-3 border-t border-border-subtle pt-4">
            <div className="text-xs font-medium text-text-secondary">Campos personalizados</div>
            <CustomFieldsRenderer
              fieldDefinitions={fieldDefs}
              customFields={editing ? form.customFields : customFields}
              editing={editing}
              onChange={onCustomFieldChange}
            />
          </div>
        )}
      </CollapsibleSection>

      {/* Endereço e empresa */}
      <CollapsibleSection
        title="Endereço e empresa"
        defaultOpen={countFilled(companyFields) > 0 || editing}
        filledCount={countFilled(companyFields)}
        totalCount={companyFields.length}
      >
        {!editing ? (
          <div className="space-y-3">
            <ViewField label="Empresa" value={contact.company} enrichMeta={meta("company")} />
            <ViewField label="Cargo" value={contact.title} enrichMeta={meta("title")} />
            <ViewField label="Setor" value={contact.industry} enrichMeta={meta("industry")} />
            <ViewField label="Porte da empresa" value={contact.companySize} enrichMeta={meta("companySize")} />
            <ViewField label="CNPJ" value={contact.cnpj} enrichMeta={meta("cnpj")} />
            <ViewField label="Site da empresa" value={contact.companyWebsite} enrichMeta={meta("companyWebsite")} link />
            <ViewField label="Cidade" value={contact.city} enrichMeta={meta("city")} />
            <ViewField label="Estado" value={contact.state} enrichMeta={meta("state")} />
            <ViewField label="País" value={contact.country} enrichMeta={meta("country")} />
          </div>
        ) : (
          <div className="space-y-3">
            <EditField label="Empresa" value={form.company} onChange={edit("company")} />
            <EditField label="Cargo" value={form.title} onChange={edit("title")} />
            <EditField label="Setor" value={form.industry} onChange={edit("industry")} />
            <EditSelect label="Porte da empresa" value={form.companySize} onChange={edit("companySize")} options={COMPANY_SIZES} />
            <EditField label="CNPJ" value={form.cnpj} onChange={edit("cnpj")} />
            <EditField label="Site da empresa" value={form.companyWebsite} onChange={edit("companyWebsite")} placeholder="https://…" />
            <EditField label="Cidade" value={form.city} onChange={edit("city")} />
            <EditField label="Estado" value={form.state} onChange={edit("state")} />
            <EditField label="País" value={form.country} onChange={edit("country")} />
          </div>
        )}
      </CollapsibleSection>

      {/* Origem */}
      <CollapsibleSection
        title="Origem"
        defaultOpen={countFilled(originFields) > 0 || editing}
        filledCount={countFilled(originFields)}
        totalCount={originFields.length}
      >
        {!editing ? (
          <div className="space-y-3">
            <ViewField label="Origem" value={contact.acquisitionChannel} enrichMeta={meta("acquisitionChannel")} />
            <ViewField label="Campanha de anúncio (UTM)" value={contact.utmSource} enrichMeta={meta("utmSource")} />
            <ViewField label="Dispositivo" value={contact.deviceType} enrichMeta={meta("deviceType")} />
            <ViewField
              label="Horário preferido"
              value={PREFERRED_TIME_LABELS[contact.preferredContactTime as string]}
              enrichMeta={meta("preferredContactTime")}
            />
            <ViewField label="Seguidores no Instagram" value={numberText(contact.instagramFollowers)} enrichMeta={meta("instagramFollowers")} />
            <ViewField label="Conexões no LinkedIn" value={numberText(contact.linkedinConnections)} enrichMeta={meta("linkedinConnections")} />
            <ViewField label="Pontuação de influência (0 a 100)" value={numberText(contact.socialInfluenceScore)} enrichMeta={meta("socialInfluenceScore")} />
          </div>
        ) : (
          <div className="space-y-3">
            <EditField label="Origem" value={form.acquisitionChannel} onChange={edit("acquisitionChannel")} />
            <EditField label="Campanha de anúncio (UTM)" value={form.utmSource} onChange={edit("utmSource")} />
            <EditSelect label="Dispositivo" value={form.deviceType} onChange={edit("deviceType")} options={DEVICES} />
            <EditSelect label="Horário preferido" value={form.preferredContactTime} onChange={edit("preferredContactTime")} options={PREFERRED_TIMES} />
            <EditField label="Seguidores no Instagram" value={form.instagramFollowers} onChange={edit("instagramFollowers")} type="number" />
            <EditField label="Conexões no LinkedIn" value={form.linkedinConnections} onChange={edit("linkedinConnections")} type="number" />
            <EditField label="Pontuação de influência (0 a 100)" value={form.socialInfluenceScore} onChange={edit("socialInfluenceScore")} type="number" />
          </div>
        )}
      </CollapsibleSection>

      {/* Etiquetas e notas */}
      <CollapsibleSection
        title="Etiquetas e notas"
        defaultOpen={countFilled(notesFields) > 0 || editing}
        filledCount={countFilled(notesFields)}
        totalCount={notesFields.length}
      >
        {!editing ? (
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium text-text-secondary mb-1">Etiquetas</div>
              {contact.tags && contact.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {contact.tags.map((tag: string) => (
                    <Badge key={tag} variant="default">{tag}</Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-text-muted">Sem etiquetas</p>
              )}
            </div>
            <ViewField label="Notas" value={contact.bio} enrichMeta={meta("bio")} />
          </div>
        ) : (
          <div className="space-y-3">
            <EditField label="Etiquetas (separadas por vírgula)" value={form.tags} onChange={edit("tags")} placeholder="cliente, vip, parceiro" />
            <EditField label="Notas" value={form.bio} onChange={edit("bio")} multiline />
          </div>
        )}
      </CollapsibleSection>
    </div>
  );
}
