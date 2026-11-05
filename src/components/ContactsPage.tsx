import { usePageTitle } from "@/hooks/usePageTitle";
import { VOCAB } from "@/lib/vocab";
import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate, useOutletContext } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { Contact2, Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { Pagination } from "@/components/ui/Pagination";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import { numberParam, stringParam } from "@/lib/searchParamState";
import { ContactDetailPanel } from "./contacts/detail/ContactDetailPanel";
import { CreateContactModal } from "./CreateContactModal";
import { SocialIcons } from "@/components/SocialIcons";
import { cn } from "@/lib/utils";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";

type ColumnKey = "contact" | "company" | "email" | "phone" | "tags" | "city" | "state" | "country" | "industry" | "social" | "companySize" | "acquisitionChannel" | string;

interface ColumnDefinition {
  key: ColumnKey;
  label: string;
  fixed?: boolean;
}

const AVAILABLE_COLUMNS: ColumnDefinition[] = [
  { key: "contact", label: "Contato", fixed: true },
  { key: "company", label: "Empresa" },
  { key: "email", label: "E-mail" },
  { key: "phone", label: "Telefone" },
  { key: "tags", label: "Etiquetas" },
  { key: "city", label: "Cidade" },
  { key: "state", label: "Estado" },
  { key: "country", label: "País" },
  { key: "industry", label: "Indústria" },
  { key: "social", label: "Redes sociais" },
  { key: "companySize", label: "Porte" },
  { key: "acquisitionChannel", label: "Canal" },
];

const DEFAULT_COLUMNS: ColumnKey[] = ["contact", "company", "email", "tags"];

const CONTACTS_PAGE_SIZE = 50;
/** `?page=` é 1-based na URL (a primeira página sai da URL). Codec constante do módulo. */
const PAGE_PARAM = numberParam({ min: 1 });
/** Marca a entrada de histórico criada por um push nosso ao abrir um contato. */
const OWN_ENTRY = { contactPushed: true };

export function ContactsPage() {
  usePageTitle(VOCAB.contact.nav);
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { can } = usePermissions(organizationId);
  const navigate = useNavigate();
  const location = useLocation();
  // A URL é a fonte da verdade: contato aberto (push), busca e página (replace).
  const contactParam = useSearchParamState("contact", stringParam, { history: "push" });
  const searchParam = useSearchParamState("q", stringParam);
  const pageParam = useSearchParamState("page", PAGE_PARAM);
  const selectedContactId = contactParam.value as Id<"contacts"> | null;
  const debouncedSearch = searchParam.value ?? "";
  const requestedPage = (pageParam.value ?? 1) - 1;
  const ownsEntry = (location.state as { contactPushed?: boolean } | null)?.contactPushed === true;
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showColumnSelector, setShowColumnSelector] = useState(false);
  const columnSelectorRef = useRef<HTMLDivElement>(null);

  // Query field definitions for custom fields
  const fieldDefinitions = useQuery(
    api.fieldDefinitions.getFieldDefinitions,
    { organizationId, entityType: "contact" }
  );

  // Build available columns with custom fields
  const allAvailableColumns: ColumnDefinition[] = [
    ...AVAILABLE_COLUMNS,
    ...(fieldDefinitions || []).map((field) => ({
      key: `custom_${field._id}`,
      label: field.name,
    })),
  ];

  // Initialize active columns from localStorage or defaults
  const [activeColumns, setActiveColumns] = useState<ColumnKey[]>(() => {
    try {
      const stored = localStorage.getItem(`hnbcrm:contact-columns:${organizationId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Ensure "contact" is always included
        if (!parsed.includes("contact")) {
          return ["contact", ...parsed];
        }
        return parsed;
      }
    } catch (e) {
      // Ignore parse errors
    }
    return DEFAULT_COLUMNS;
  });

  // Persist active columns to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(
        `hnbcrm:contact-columns:${organizationId}`,
        JSON.stringify(activeColumns)
      );
    } catch (e) {
      // Ignore storage errors
    }
  }, [activeColumns, organizationId]);

  // Close column selector on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        columnSelectorRef.current &&
        !columnSelectorRef.current.contains(event.target as Node)
      ) {
        setShowColumnSelector(false);
      }
    };

    if (showColumnSelector) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [showColumnSelector]);

  // Use search query when search text is >= 2 chars, otherwise get all contacts
  const searchResults = useQuery(
    api.contacts.searchContacts,
    debouncedSearch.length >= 2 ? { organizationId, searchText: debouncedSearch } : "skip"
  );

  const allContacts = useQuery(
    api.contacts.getContacts,
    debouncedSearch.length < 2 ? { organizationId } : "skip"
  );

  const contacts = debouncedSearch.length >= 2 ? searchResults : allContacts;

  const totalContacts = contacts?.length ?? 0;
  // Página pedida além do fim (a lista encolheu): mostra a última.
  const contactPage = Math.min(requestedPage, Math.max(0, Math.ceil(totalContacts / CONTACTS_PAGE_SIZE) - 1));
  const paginatedContacts = contacts?.slice(
    contactPage * CONTACTS_PAGE_SIZE,
    (contactPage + 1) * CONTACTS_PAGE_SIZE
  );

  const handleSearchChange = (value: string) => {
    searchParam.set(value, { also: { page: null } });
  };

  const handlePageChange = (page: number) => {
    pageParam.set(page === 0 ? null : page + 1);
  };

  // Abrir um contato empilha uma entrada (o "voltar" fecha); trocar de contato
  // com o painel aberto só substitui. Abrir outro contato limpa a aba antiga.
  const handleRowClick = (contactId: Id<"contacts">) => {
    const push = contactParam.raw === null;
    contactParam.set(contactId, {
      also: { contactTab: null },
      history: push ? "push" : "replace",
      ...(push || ownsEntry ? { state: OWN_ENTRY } : {}),
    });
  };

  // Entrada criada por nós: volta uma entrada; deep link ou recarga: substitui.
  const closeRequested = useRef<string | null>(null);
  const handleClosePanel = () => {
    if (contactParam.raw === null) return;
    if (ownsEntry) {
      if (closeRequested.current === location.key) return;
      closeRequested.current = location.key;
      contactParam.expectWrite(null);
      navigate(-1);
    } else {
      contactParam.set(null, { history: "replace", also: { contactTab: null } });
    }
  };

  const handleCloseCreateModal = () => {
    setShowCreateModal(false);
  };

  const toggleColumn = (columnKey: ColumnKey) => {
    if (columnKey === "contact") return; // Can't toggle fixed column

    setActiveColumns((prev) => {
      if (prev.includes(columnKey)) {
        return prev.filter((k) => k !== columnKey);
      } else {
        return [...prev, columnKey];
      }
    });
  };

  const renderCellContent = (contact: any, columnKey: ColumnKey) => {
    const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
    const displayName = fullName || contact.email || contact.phone || "Sem nome";

    switch (columnKey) {
      case "contact":
        return (
          <div className="flex items-center gap-3">
            <Avatar name={displayName} size="sm" />
            <div>
              <div className="text-sm font-medium text-text-primary">
                {displayName}
              </div>
              {contact.title && (
                <div className="text-xs text-text-muted">{contact.title}</div>
              )}
            </div>
          </div>
        );
      case "company":
        return (
          <div className="text-sm text-text-primary">
            {contact.company || "—"}
          </div>
        );
      case "email":
        return (
          <div className="text-sm text-text-secondary">
            {contact.email || "—"}
          </div>
        );
      case "phone":
        return (
          <div className="text-sm text-text-secondary">
            {contact.phone || "—"}
          </div>
        );
      case "tags":
        const tags = contact.tags || [];
        return (
          <div className="flex flex-wrap gap-1">
            {tags.slice(0, 2).map((tag: string, idx: number) => (
              <Badge key={idx} variant="default">
                {tag}
              </Badge>
            ))}
            {tags.length > 2 && (
              <Badge variant="default">+{tags.length - 2}</Badge>
            )}
          </div>
        );
      case "city":
        return (
          <div className="text-sm text-text-secondary">
            {contact.city || "—"}
          </div>
        );
      case "state":
        return (
          <div className="text-sm text-text-secondary">
            {contact.state || "—"}
          </div>
        );
      case "country":
        return (
          <div className="text-sm text-text-secondary">
            {contact.country || "—"}
          </div>
        );
      case "industry":
        return (
          <div className="text-sm text-text-secondary">
            {contact.industry || "—"}
          </div>
        );
      case "companySize":
        return (
          <div className="text-sm text-text-secondary">
            {contact.companySize || "—"}
          </div>
        );
      case "acquisitionChannel":
        return (
          <div className="text-sm text-text-secondary">
            {contact.acquisitionChannel || "—"}
          </div>
        );
      case "social":
        return (
          <SocialIcons
            linkedinUrl={contact.linkedinUrl}
            instagramUrl={contact.instagramUrl}
            facebookUrl={contact.facebookUrl}
            twitterUrl={contact.twitterUrl}
            size="sm"
          />
        );
      default:
        // Handle custom fields
        if (columnKey.startsWith("custom_")) {
          const fieldId = columnKey.replace("custom_", "") as Id<"fieldDefinitions">;
          const value = contact.customFields?.[fieldId];
          return (
            <div className="text-sm text-text-secondary">
              {value !== undefined && value !== null ? String(value) : "—"}
            </div>
          );
        }
        return <div className="text-sm text-text-secondary">—</div>;
    }
  };

  return (
    <>
      <div className="max-w-7xl">
        <SpotlightTooltip spotlightId="contacts" organizationId={organizationId} />

        <div className="flex flex-col gap-4 mb-6">
          <PageHeader
            title={VOCAB.contact.nav}
            subtitle="Gerencie seus contatos e relacionamentos"
            actions={
              can("contacts", "edit") ? (
                <Button variant="primary" size="md" onClick={() => setShowCreateModal(true)} className="shrink-0">
                  <Plus size={20} aria-hidden="true" />
                  {VOCAB.contact.new}
                </Button>
              ) : undefined
            }
          />

          {/* Busca e seletor de colunas */}
          <div className="flex items-center gap-2">
            <SearchInput
              className="flex-1"
              value={debouncedSearch}
              onValueChange={handleSearchChange}
              placeholder="Buscar por nome, e-mail ou empresa…"
              ariaLabel="Buscar contatos"
            />

            {/* Seletor de colunas (só no desktop) */}
            <div className="relative hidden md:block" ref={columnSelectorRef}>
              <button
                onClick={() => setShowColumnSelector(!showColumnSelector)}
                className="p-2.5 bg-surface-raised border border-border-strong text-text-secondary hover:text-text-primary hover:border-brand-500 rounded-field transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
                aria-label="Configurar colunas"
              >
                <Settings2 size={20} />
              </button>

              {showColumnSelector && (
                <div className="absolute right-0 top-full mt-2 w-64 bg-surface-overlay border border-border rounded-xl shadow-lg z-50 overflow-hidden">
                  <div className="p-3 border-b border-border">
                    <h3 className="text-sm font-semibold text-text-primary">
                      Colunas visíveis
                    </h3>
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {allAvailableColumns.map((col) => {
                      const isActive = activeColumns.includes(col.key);
                      const isFixed = col.fixed;

                      return (
                        <div
                          key={col.key}
                          className={cn(
                            "flex items-center gap-3 px-3 py-2.5 transition-colors",
                            isFixed ? "opacity-50" : "hover:bg-surface-raised"
                          )}
                        >
                          <Checkbox
                            checked={isActive}
                            disabled={isFixed}
                            onChange={() => toggleColumn(col.key)}
                            containerClassName="flex-1"
                            label={<span className="text-text-primary">{col.label}</span>}
                          />
                          {isFixed && (
                            <span className="text-xs text-text-muted">
                              Fixo
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Content */}
        {contacts === undefined ? (
          <div className="flex justify-center items-center py-12">
            <Spinner size="lg" />
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <div className="w-16 h-16 rounded-full bg-surface-overlay flex items-center justify-center mb-4">
              <Contact2 size={32} className="text-text-muted" />
            </div>
            <h3 className="text-lg font-semibold text-text-primary mb-2">
              {debouncedSearch ? "Nenhum contato encontrado" : "Nenhum contato"}
            </h3>
            <p className="text-sm text-text-secondary mb-6 text-center max-w-md">
              {debouncedSearch
                ? "Tente ajustar sua busca ou adicione um novo contato"
                : "Adicione seu primeiro contato para começar"}
            </p>
            {!debouncedSearch && can("contacts", "edit") && (
              <Button variant="primary" size="md" onClick={() => setShowCreateModal(true)}>
                <Plus size={20} className="mr-2" />
                Criar contato
              </Button>
            )}
          </div>
        ) : (
          <>
          <div className="bg-surface-raised border border-border rounded-card overflow-hidden">
            {/* Desktop: Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    {activeColumns.map((columnKey) => {
                      const column = allAvailableColumns.find((c) => c.key === columnKey);
                      return (
                        <th
                          key={columnKey}
                          className="text-left text-xs font-medium text-text-secondary uppercase tracking-wider px-6 py-3"
                        >
                          {column?.label || columnKey}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {paginatedContacts?.map((contact) => {
                    return (
                      <tr
                        key={contact._id}
                        onClick={() => handleRowClick(contact._id)}
                        className="hover:bg-surface-overlay cursor-pointer transition-colors"
                      >
                        {activeColumns.map((columnKey) => (
                          <td key={columnKey} className="px-6 py-4">
                            {renderCellContent(contact, columnKey)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: List */}
            <div className="md:hidden divide-y divide-border">
              {paginatedContacts?.map((contact) => {
                const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
                const displayName = fullName || contact.email || contact.phone || "Sem nome";
                const hasSocial = contact.linkedinUrl || contact.instagramUrl || contact.facebookUrl || contact.twitterUrl;

                return (
                  <div
                    key={contact._id}
                    onClick={() => handleRowClick(contact._id)}
                    className="p-4 hover:bg-surface-overlay active:bg-surface-overlay transition-colors cursor-pointer"
                  >
                    <div className="flex items-start gap-3">
                      <Avatar name={displayName} size="md" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-text-primary mb-0.5">
                          {displayName}
                        </div>
                        {contact.company && (
                          <div className="text-sm text-text-secondary mb-1">
                            {contact.company}
                          </div>
                        )}
                        {hasSocial && (
                          <div className="mt-2">
                            <SocialIcons
                              linkedinUrl={contact.linkedinUrl}
                              instagramUrl={contact.instagramUrl}
                              facebookUrl={contact.facebookUrl}
                              twitterUrl={contact.twitterUrl}
                              size="sm"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {contacts && contacts.length > CONTACTS_PAGE_SIZE && (
              <Pagination
                page={contactPage}
                pageSize={CONTACTS_PAGE_SIZE}
                total={totalContacts}
                hasMore={false}
                onPageChange={handlePageChange}
                className="border-t border-border"
              />
            )}
          </div>

          {contacts && contacts.length === 500 && (
            <p className="text-xs text-text-muted text-center mt-3">
              Exibindo os primeiros 500 contatos. Use a busca para encontrar contatos específicos.
            </p>
          )}
          </>
        )}
      </div>

      {/* Contact Detail Panel */}
      {selectedContactId && (
        // Um id inválido na URL faz a query lançar: o boundary some com o painel.
        <ErrorBoundary key={selectedContactId} fallback={<></>}>
          <ContactDetailPanel contactId={selectedContactId} onClose={handleClosePanel} />
        </ErrorBoundary>
      )}

      {/* Create Contact Modal */}
      {showCreateModal && (
        <CreateContactModal organizationId={organizationId} onClose={handleCloseCreateModal} />
      )}
    </>
  );
}
