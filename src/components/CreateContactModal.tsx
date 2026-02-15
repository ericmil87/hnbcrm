import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { CustomFieldsRenderer } from "@/components/CustomFieldsRenderer";
import { ChevronDown, ChevronUp } from "lucide-react";

interface CreateContactModalProps {
  organizationId: Id<"organizations">;
  onClose: () => void;
}

export function CreateContactModal({ organizationId, onClose }: CreateContactModalProps) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [telegramUsername, setTelegramUsername] = useState("");
  const [tags, setTags] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Expandable section toggle
  const [showMoreFields, setShowMoreFields] = useState(false);

  // Social fields
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [instagramUrl, setInstagramUrl] = useState("");
  const [facebookUrl, setFacebookUrl] = useState("");
  const [twitterUrl, setTwitterUrl] = useState("");

  // Location fields
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [country, setCountry] = useState("");

  // Professional fields
  const [industry, setIndustry] = useState("");
  const [companySize, setCompanySize] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [companyWebsite, setCompanyWebsite] = useState("");

  // Custom fields
  const [customFields, setCustomFields] = useState<Record<string, any>>({});

  const createContact = useMutation(api.contacts.createContact);

  // Query for required custom field definitions
  const fieldDefinitions = useQuery(
    api.fieldDefinitions.getFieldDefinitions,
    { organizationId, entityType: "contact" }
  );

  const requiredFields = fieldDefinitions?.filter((f) => f.isRequired) || [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // At least one field must be filled
    if (
      !firstName.trim() &&
      !lastName.trim() &&
      !email.trim() &&
      !phone.trim() &&
      !company.trim()
    ) {
      toast.error("Forneça pelo menos um nome, email, telefone ou empresa");
      return;
    }

    setSubmitting(true);

    // Validate required custom fields
    for (const field of requiredFields) {
      const value = customFields[field.key];
      if (value === undefined || value === null || value === "") {
        toast.error(`Campo obrigatório: ${field.name}`);
        setSubmitting(false);
        return;
      }
    }

    const createPromise = createContact({
      organizationId,
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      company: company.trim() || undefined,
      title: title.trim() || undefined,
      whatsappNumber: whatsappNumber.trim() || undefined,
      telegramUsername: telegramUsername.trim() || undefined,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean) || undefined,
      // Enrichment fields
      linkedinUrl: linkedinUrl.trim() || undefined,
      instagramUrl: instagramUrl.trim() || undefined,
      facebookUrl: facebookUrl.trim() || undefined,
      twitterUrl: twitterUrl.trim() || undefined,
      city: city.trim() || undefined,
      state: state.trim() || undefined,
      country: country.trim() || undefined,
      industry: industry.trim() || undefined,
      companySize: companySize || undefined,
      cnpj: cnpj.trim() || undefined,
      companyWebsite: companyWebsite.trim() || undefined,
      customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
    });

    toast.promise(createPromise, {
      loading: "Criando contato...",
      success: () => {
        onClose();
        return "Contato criado com sucesso";
      },
      error: "Falha ao criar contato",
    });

    try {
      await createPromise;
    } catch (err) {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={true} onClose={onClose} title="Criar Novo Contato">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">
              Nome
            </label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
              style={{ fontSize: "16px" }}
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">
              Sobrenome
            </label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
              style={{ fontSize: "16px" }}
            />
          </div>
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Telefone
          </label>
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Empresa
          </label>
          <input
            type="text"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Cargo
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            WhatsApp
          </label>
          <input
            type="text"
            value={whatsappNumber}
            onChange={(e) => setWhatsappNumber(e.target.value)}
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Telegram
          </label>
          <input
            type="text"
            value={telegramUsername}
            onChange={(e) => setTelegramUsername(e.target.value)}
            placeholder="@username"
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
          />
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            Tags (separadas por vírgula)
          </label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="cliente, vip, parceiro"
            className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
            style={{ fontSize: "16px" }}
          />
        </div>

        {/* Required Custom Fields */}
        {requiredFields.length > 0 && (
          <div className="space-y-3">
            <div className="text-sm font-semibold text-text-primary border-t border-border pt-3">
              Campos Obrigatórios
            </div>
            <CustomFieldsRenderer
              fieldDefinitions={requiredFields}
              customFields={customFields}
              editing={true}
              onChange={(key, value) => setCustomFields({ ...customFields, [key]: value })}
            />
          </div>
        )}

        {/* Expandable "Mais campos" section */}
        <div className="border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setShowMoreFields(!showMoreFields)}
            className="flex items-center gap-2 w-full text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            {showMoreFields ? (
              <ChevronUp size={16} />
            ) : (
              <ChevronDown size={16} />
            )}
            Mais campos
          </button>
        </div>

        {showMoreFields && (
          <div className="space-y-4 animate-in fade-in duration-200">
            {/* Social Section */}
            <div className="space-y-3">
              <div className="text-sm font-semibold text-text-primary">Redes Sociais</div>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">
                  LinkedIn
                </label>
                <input
                  type="url"
                  value={linkedinUrl}
                  onChange={(e) => setLinkedinUrl(e.target.value)}
                  placeholder="https://linkedin.com/in/..."
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                  style={{ fontSize: "16px" }}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">
                  Instagram
                </label>
                <input
                  type="url"
                  value={instagramUrl}
                  onChange={(e) => setInstagramUrl(e.target.value)}
                  placeholder="https://instagram.com/..."
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                  style={{ fontSize: "16px" }}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">
                  Facebook
                </label>
                <input
                  type="url"
                  value={facebookUrl}
                  onChange={(e) => setFacebookUrl(e.target.value)}
                  placeholder="https://facebook.com/..."
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                  style={{ fontSize: "16px" }}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">
                  Twitter/X
                </label>
                <input
                  type="url"
                  value={twitterUrl}
                  onChange={(e) => setTwitterUrl(e.target.value)}
                  placeholder="https://twitter.com/..."
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                  style={{ fontSize: "16px" }}
                />
              </div>
            </div>

            {/* Location Section */}
            <div className="space-y-3">
              <div className="text-sm font-semibold text-text-primary">Localização</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[13px] font-medium text-text-secondary mb-1">
                    Cidade
                  </label>
                  <input
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                    style={{ fontSize: "16px" }}
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-text-secondary mb-1">
                    Estado
                  </label>
                  <input
                    type="text"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                    style={{ fontSize: "16px" }}
                  />
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">
                  País
                </label>
                <input
                  type="text"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                  style={{ fontSize: "16px" }}
                />
              </div>
            </div>

            {/* Professional Section */}
            <div className="space-y-3">
              <div className="text-sm font-semibold text-text-primary">Dados Profissionais</div>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">
                  Setor
                </label>
                <input
                  type="text"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="Tecnologia, Saúde, etc."
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                  style={{ fontSize: "16px" }}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">
                  Tamanho da Empresa
                </label>
                <select
                  value={companySize}
                  onChange={(e) => setCompanySize(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  style={{ fontSize: "16px" }}
                >
                  <option value="">Selecionar...</option>
                  <option value="1-10">1-10 funcionários</option>
                  <option value="11-50">11-50 funcionários</option>
                  <option value="51-200">51-200 funcionários</option>
                  <option value="201-1000">201-1000 funcionários</option>
                  <option value="1000+">1000+ funcionários</option>
                </select>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">
                  CNPJ
                </label>
                <input
                  type="text"
                  value={cnpj}
                  onChange={(e) => setCnpj(e.target.value)}
                  placeholder="00.000.000/0000-00"
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                  style={{ fontSize: "16px" }}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1">
                  Site da Empresa
                </label>
                <input
                  type="url"
                  value={companyWebsite}
                  onChange={(e) => setCompanyWebsite(e.target.value)}
                  placeholder="https://exemplo.com.br"
                  className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                  style={{ fontSize: "16px" }}
                />
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-4">
          <Button
            type="button"
            onClick={onClose}
            variant="secondary"
            size="md"
            className="flex-1"
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            disabled={submitting}
            variant="primary"
            size="md"
            className="flex-1"
          >
            {submitting ? "Criando..." : "Criar Contato"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
