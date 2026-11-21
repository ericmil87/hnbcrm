import { useState } from "react";
import { useQuery } from "convex/react";
import { Search, UserRound } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { SearchInput } from "@/components/ui/SearchInput";
import { Spinner } from "@/components/ui/Spinner";
import { fillVocab } from "@/lib/agendaCopy";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { formatClientPhone } from "@/lib/agendaClientPicker";

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
}

/** Escolha de quem será atendido (a grade e o botão da agenda não têm cliente). Apresentacional. */
export function ClientPickerView({ context, term, onTermChange, results, onPick }: ClientPickerViewProps) {
  const hasTerm = term.trim().length >= 2;
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{context}</p>
      <SearchInput value={term} onValueChange={onTermChange} placeholder={t.search} ariaLabel={t.searchLabel} />
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
        <EmptyState icon={UserRound} size="sm" title={t.none.title} description={t.none.hint} />
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

interface ClientPickerSheetProps {
  organizationId: Id<"organizations">;
  open: boolean;
  context: string;
  onClose: () => void;
  onPick: (client: PickedClient) => void;
}

/** Contêiner: busca contatos (`contacts.searchContacts`, só com 2+ letras) e entrega ao `ClientPickerView`. */
export function ClientPickerSheet({ organizationId, open, context, onClose, onPick }: ClientPickerSheetProps) {
  const [term, setTerm] = useState("");
  const active = open && term.trim().length >= 2;
  const results = useQuery(api.contacts.searchContacts, active ? { organizationId, searchText: term.trim(), limit: 8 } : "skip") as
    | ClientCandidate[]
    | undefined;
  return (
    <Modal open={open} onClose={onClose} title={t.title}>
      <ClientPickerView context={context} term={term} onTermChange={setTerm} results={active ? results : []} onPick={onPick} />
    </Modal>
  );
}
