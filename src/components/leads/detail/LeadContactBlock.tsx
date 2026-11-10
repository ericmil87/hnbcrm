import { useState } from "react";
import { NotOnWhatsappBadge } from "@/components/inbox/NotOnWhatsappBadge";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { ExternalLink, Link as LinkIcon, Search, X } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { InlineNameEditor, type InlineNameContact } from "@/components/inbox/InlineNameEditor";
import { mutationErrorMessage } from "@/lib/errors";
import { EMPTY } from "@/lib/format";
import { LeadBlockHeading, type LeadDoc } from "./LeadBlockHeading";

interface LeadContactBlockProps {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
  lead: LeadDoc;
}

/** "Contato vinculado": dados do contato, trocar e desvincular. */
export function LeadContactBlock({ leadId, organizationId, lead }: LeadContactBlockProps) {
  const linkContact = useMutation(api.leads.linkContact);
  const [showPicker, setShowPicker] = useState(false);
  const [searchText, setSearchText] = useState("");
  const contacts = useQuery(api.contacts.getContacts, { organizationId });

  const closePicker = () => {
    setShowPicker(false);
    setSearchText("");
  };

  const handleLink = async (contactId: Id<"contacts">) => {
    try {
      await linkContact({ leadId, contactId });
      closePicker();
      toast.success("Contato vinculado");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível vincular o contato."));
    }
  };

  const handleUnlink = async () => {
    try {
      await linkContact({ leadId });
      toast.success("Contato desvinculado");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível desvincular o contato."));
    }
  };

  const needle = searchText.trim().toLowerCase();
  const filtered = contacts?.filter((contact) => {
    if (!needle) return true;
    const fullName = `${contact.firstName || ""} ${contact.lastName || ""}`.toLowerCase();
    return (
      fullName.includes(needle) ||
      (contact.email?.toLowerCase() || "").includes(needle) ||
      (contact.company?.toLowerCase() || "").includes(needle)
    );
  });

  return (
    <div>
      <LeadBlockHeading>Contato vinculado</LeadBlockHeading>
      {lead.contact ? (
        <div className="bg-surface-sunken rounded-card p-4 space-y-3">
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3 min-w-0">
              <span className="shrink-0 text-text-muted">Nome</span>
              {/* Renomear ali mesmo: "Alterar" troca o contato vinculado, não o nome dele. */}
              <InlineNameEditor
                contact={lead.contact as InlineNameContact}
                lead={{ _id: lead._id, title: lead.title }}
                placeholder={EMPTY}
                className="justify-end"
                textClassName="text-text-primary font-medium"
              />
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">E-mail</span>
              <span className="text-text-primary">{lead.contact.email || EMPTY}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Telefone</span>
              <span className="flex min-w-0 items-center gap-2 text-text-primary">
                <NotOnWhatsappBadge contact={lead.contact} />
                {lead.contact.phone || EMPTY}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Empresa</span>
              <span className="text-text-primary">{lead.contact.company || EMPTY}</span>
            </div>
          </div>
          <div className="flex gap-2 pt-2 border-t border-border">
            <Button onClick={() => setShowPicker(true)} variant="secondary" size="sm" className="flex-1">
              <ExternalLink size={16} aria-hidden="true" />
              Alterar
            </Button>
            <Button onClick={() => void handleUnlink()} variant="ghost" size="sm" iconOnly aria-label="Desvincular contato">
              <X size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="bg-surface-sunken rounded-card p-4 text-center">
          <p className="text-sm text-text-muted mb-3">Nenhum contato vinculado</p>
          <Button onClick={() => setShowPicker(true)} variant="primary" size="sm">
            <LinkIcon size={16} aria-hidden="true" />
            Vincular contato
          </Button>
        </div>
      )}

      {showPicker && (
        <>
          <div className="fixed inset-0 z-40" onClick={closePicker} aria-hidden="true" />
          <div className="relative z-50 mt-2 bg-surface-overlay border border-border rounded-xl shadow-elevated max-h-80 overflow-hidden">
            <div className="p-3 border-b border-border">
              <Input
                type="search"
                aria-label="Buscar contato"
                icon={<Search size={16} aria-hidden="true" />}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Buscar contato…"
                autoFocus
              />
              {contacts && contacts.length >= 500 && (
                <p className="text-xs text-text-muted mt-2">Mostrando os primeiros 500 contatos.</p>
              )}
            </div>
            <div className="overflow-y-auto max-h-64">
              {filtered && filtered.length > 0 ? (
                filtered.map((contact) => (
                  <button
                    key={contact._id}
                    type="button"
                    onClick={() => void handleLink(contact._id)}
                    className="w-full min-h-11 px-4 py-3 text-left hover:bg-surface-raised transition-colors border-b border-border-subtle last:border-0"
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
                  {contacts === undefined ? <Spinner size="sm" /> : "Nenhum contato encontrado"}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
