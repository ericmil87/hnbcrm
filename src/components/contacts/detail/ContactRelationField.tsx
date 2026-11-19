import { ChevronRight, CircleDashed, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { RELATION_ICON } from "@/components/contacts/ContactRelationSheet";
import { offBusinessRelation, relationLabel, type ContactRelation } from "@/lib/contactRelationUi";
import { cn } from "@/lib/utils";

interface ContactRelationFieldProps {
  relation: ContactRelation | undefined;
  /** "Marcado por Kenji em 18/11/2026 (pelo Telegram)" ou `null`. */
  metaLine: string | null;
  /** `contacts:edit`: sem ele o campo só informa. */
  canEdit: boolean;
  onChangeType: () => void;
  onTurnLead: () => void;
}

/**
 * "Tipo de contato" no topo da aba Informações: o tipo atual (toque abre a
 * folha "Quem é <Nome>?"), quem marcou e quando, e o botão grande "Virar lead"
 * quando o contato não é cliente.
 */
export function ContactRelationField({ relation, metaLine, canEdit, onChangeType, onTurnLead }: ContactRelationFieldProps) {
  const Icon = relation ? RELATION_ICON[relation] : CircleDashed;
  const off = offBusinessRelation(relation);
  const content = (
    <>
      <Icon size={18} aria-hidden className={off ? "text-semantic-info" : "text-text-secondary"} />
      <span className="min-w-0 flex-1">
        <span className="block text-caption text-text-muted">Tipo de contato</span>
        <span className="block truncate text-sm font-medium text-text-primary">{relationLabel(relation)}</span>
      </span>
    </>
  );
  return (
    <section aria-label="Tipo de contato" className="mb-4 space-y-2">
      {canEdit ? (
        <button
          type="button"
          onClick={onChangeType}
          aria-label={`Tipo de contato: ${relationLabel(relation)}. Trocar tipo`}
          className={cn(
            "flex min-h-14 w-full items-center gap-3 rounded-card border border-border bg-surface-raised px-3 py-2 text-left transition-colors hover:bg-surface-sunken",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          )}
        >
          {content}
          <span className="flex shrink-0 items-center gap-0.5 text-caption text-text-muted">
            Trocar
            <ChevronRight size={16} aria-hidden />
          </span>
        </button>
      ) : (
        <div className="flex min-h-14 w-full items-center gap-3 rounded-card border border-border bg-surface-raised px-3 py-2">
          {content}
        </div>
      )}
      {metaLine && <p className="px-1 text-caption text-text-muted">{metaLine}</p>}
      {off && canEdit && (
        <Button type="button" size="lg" onClick={onTurnLead} className="w-full">
          <UserCheck size={18} aria-hidden />
          Virar lead
        </Button>
      )}
      {off && (
        <p className="px-1 text-caption text-text-muted">A IA não responde este contato e ele fica fora do funil.</p>
      )}
    </section>
  );
}
