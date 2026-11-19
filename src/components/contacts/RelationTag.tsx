import { relationBadge } from "@/lib/contactRelationList";
import { cn } from "@/lib/utils";

interface RelationTagProps {
  /** `contactRelation` da linha (valor desconhecido, Lead e sem tipo = nada). */
  relation: unknown;
  className?: string;
}

/**
 * Selo do tipo de contato estilo etiqueta do WhatsApp Web: bolinha colorida
 * (token do tema por tipo) + nome. Só para quem não é cliente (Pessoal,
 * Equipe, Fornecedor, Parceiro, Robô); lead mostra a etapa, sem tipo nada.
 */
export function RelationTag({ relation, className }: RelationTagProps) {
  const badge = relationBadge(relation);
  if (!badge) return null;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 text-caption font-medium text-text-secondary", className)}
      data-relation={badge.relation}
    >
      <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", badge.dotClass)} />
      <span className="sr-only">Tipo de contato: </span>
      {badge.label}
    </span>
  );
}
