import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { ArrowLeft, Search, UserPlus, UserRound } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { SearchInput } from "@/components/ui/SearchInput";
import { Spinner } from "@/components/ui/Spinner";
import { fillVocab } from "@/lib/agendaCopy";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { formatClientPhone } from "@/lib/agendaClientPicker";
import { newContactArgs, newContactErrors, NEW_CONTACT_COPY, prefillNewContact, type NewContactForm } from "@/lib/agendaNewContact";
import { mutationErrorMessage } from "@/lib/errors";
import { resolveDefaultCountry } from "../../../../convex/lib/orgPhone";

const t = VIEWS_COPY.clientPicker;

export interface PickedClient {
  contactId: string;
  name: string;
}

export interface ClientCandidate {
  _id: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface ClientPickerViewProps {
  /** "seg, 23/11 às 14:30 em Sala 2": a folha mostra para onde o horário vai. */
  context: string;
  term: string;
  onTermChange: (term: string) => void;
  /** `undefined` = buscando; `[]` = nada achado. Sem termo, a lista nem é pedida. */
  results: readonly ClientCandidate[] | undefined;
  onPick: (client: PickedClient) => void;
  /** "Novo contato": abre o formulário de criar contato que já existe; ausente = sem o atalho. */
  onNewContact?: () => void;
}

/** Escolha de quem será atendido (a grade e o botão da agenda não têm cliente). Apresentacional. */
export function ClientPickerView({ context, term, onTermChange, results, onPick, onNewContact }: ClientPickerViewProps) {
  const hasTerm = term.trim().length >= 2;
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{context}</p>
      <SearchInput value={term} onValueChange={onTermChange} placeholder={t.search} ariaLabel={t.searchLabel} />
      {onNewContact && (
        <Button variant="secondary" size="sm" onClick={onNewContact}>
          <UserPlus size={16} aria-hidden="true" />
          {t.newContact}
        </Button>
      )}
      {!hasTerm ? (
        <div className="flex items-center gap-2 py-6 text-sm text-text-muted">
          <Search size={16} aria-hidden="true" />
          {t.typeMore}
        </div>
      ) : results === undefined ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-text-muted">
          <Spinner size="sm" />
          {t.searching}
        </div>
      ) : results.length === 0 ? (
        <EmptyState icon={UserRound} size="sm" title={t.none.title} description={onNewContact ? t.none.hintNew : t.none.hint} />
      ) : (
        <ul className="space-y-1" aria-label={t.searchLabel}>
          {results.map((c) => {
            const name = c.name?.trim() || t.noName;
            const sub = c.phone ? formatClientPhone(c.phone) : c.email ?? "";
            return (
              <li key={`client:${c._id}`}>
                <button
                  type="button"
                  onClick={() => onPick({ contactId: c._id, name })}
                  aria-label={fillVocab(t.pick, { nome: name })}
                  className="flex min-h-14 w-full items-center gap-3 rounded-card px-3 text-left hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <UserRound size={18} className="shrink-0 text-text-muted" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-text-primary">{name}</span>
                    {sub && <span className="block truncate text-caption text-text-secondary">{sub}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export interface NewContactFormViewProps {
  value: NewContactForm;
  onChange: (next: NewContactForm) => void;
  /** Só aparecem depois da primeira tentativa de criar. */
  errors: { name?: string; phone?: string };
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
}

const nc = NEW_CONTACT_COPY;

/** Formulário mínimo (nome + telefone) de "Novo contato". Apresentacional. */
export function NewContactFormView({ value, onChange, errors, busy, onSubmit, onBack }: NewContactFormViewProps) {
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p className="text-sm text-text-secondary">{nc.hint}</p>
      <FormField label={nc.name} error={errors.name}>
        {(aria) => <Input {...aria} value={value.name} maxLength={80} autoComplete="off" autoFocus disabled={busy} onChange={(e) => onChange({ ...value, name: e.target.value })} />}
      </FormField>
      <FormField label={nc.phone} error={errors.phone} hint={nc.phoneHelp}>
        {(aria) => <Input {...aria} type="tel" inputMode="tel" autoComplete="off" value={value.phone} disabled={busy} onChange={(e) => onChange({ ...value, phone: e.target.value })} />}
      </FormField>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="secondary" className="flex-1" disabled={busy} onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          {nc.back}
        </Button>
        <Button type="submit" className="flex-1" loading={busy}>
          {busy ? nc.creating : nc.create}
        </Button>
      </div>
    </form>
  );
}

interface ClientPickerSheetProps {
  organizationId: Id<"organizations">;
  open: boolean;
  context: string;
  onClose: () => void;
  onPick: (client: PickedClient) => void;
}

/**
 * Contêiner: busca contatos (`contacts.searchContacts`, só com 2+ letras) e entrega ao `ClientPickerView`.
 * "Novo contato" (só com `contacts:edit`) troca o conteúdo da própria folha pelo formulário mínimo e, criado o
 * contato, já o escolhe: a pessoa segue direto para o passo de horário.
 */
export function ClientPickerSheet({ organizationId, open, context, onClose, onPick }: ClientPickerSheetProps) {
  const [term, setTerm] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<NewContactForm>({ name: "", phone: "" });
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const { can } = usePermissions(organizationId);
  const createContact = useMutation(api.contacts.createContact);
  const orgs = useQuery(api.organizations.getUserOrganizations, creating ? {} : "skip");
  const org = orgs?.find((o) => o?._id === organizationId);
  const defaultCountry = org ? resolveDefaultCountry(org.settings) : undefined;
  const active = open && !creating && term.trim().length >= 2;
  const results = useQuery(api.contacts.searchContacts, active ? { organizationId, searchText: term.trim(), limit: 8 } : "skip") as
    | ClientCandidate[]
    | undefined;
  const errors = newContactErrors(form, defaultCountry);

  const startCreating = () => {
    setForm(prefillNewContact(term));
    setShowErrors(false);
    setCreating(true);
  };
  const submit = async () => {
    if (busy) return;
    if (errors.name || errors.phone) {
      setShowErrors(true);
      return;
    }
    setBusy(true);
    try {
      const contactId = await createContact({ organizationId, ...newContactArgs(form, defaultCountry) });
      toast.success(nc.created);
      onPick({ contactId, name: form.name.replace(/\s+/g, " ").trim() });
    } catch (e) {
      toast.error(mutationErrorMessage(e, nc.failed));
    } finally {
      setBusy(false);
    }
  };

  // Esc/fechar enquanto cria volta para a busca (a pilha de Esc fecha uma camada por vez); só então fecha a folha.
  return (
    <Modal open={open} onClose={creating ? (busy ? () => undefined : () => setCreating(false)) : onClose} title={creating ? nc.title : t.title}>
      {creating ? (
        <NewContactFormView value={form} onChange={setForm} errors={showErrors ? errors : {}} busy={busy} onSubmit={() => void submit()} onBack={() => setCreating(false)} />
      ) : (
        <ClientPickerView
          context={context}
          term={term}
          onTermChange={setTerm}
          results={active ? results : []}
          onPick={onPick}
          onNewContact={can("contacts", "edit") ? startCreating : undefined}
        />
      )}
    </Modal>
  );
}
