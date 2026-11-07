import { Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { formatRelative } from "@/lib/format";
import { attentionItemDetail, attentionItemReason, attentionItemTitle, attentionUrgency } from "@/lib/attentionList";
import { cn } from "@/lib/utils";
import type { AttentionItem } from "./AttentionRow";

interface AttentionListItemProps {
  handoff: AttentionItem;
  now: number;
  /** Pedido aberto na espiada (`?handoff=`). */
  selected?: boolean;
  /** Abre a espiada; as decisões (assumir, devolver, instruir) ficam lá. */
  onOpen: () => void;
}

/**
 * Linha do "Requer atenção" no celular, no formato da lista de Conversas:
 * avatar · nome + hora · ponto + motivo + resumo, numa linha que trunca.
 * Sem botões na linha: o toque abre a espiada com as ações no rodapé.
 */
export function AttentionListItem({ handoff, now, selected = false, onOpen }: AttentionListItemProps) {
  const title = attentionItemTitle(handoff);
  const detail = attentionItemDetail(handoff);
  const late = attentionUrgency(handoff.createdAt, now) === "late";
  const reason = attentionItemReason(handoff);

  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full min-w-0 min-h-[72px] items-center gap-3 px-4 py-3 text-left transition-colors",
          // Hover só com mouse: no toque o Safari deixaria a linha "presa" acesa.
          "[@media(hover:hover)]:hover:bg-surface-overlay active:bg-surface-overlay",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
          selected && "bg-brand-500/10"
        )}
      >
        <span aria-hidden="true" className="shrink-0" data-avatar={handoff.isGroup ? "group" : "person"}>
          {handoff.isGroup ? (
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-overlay text-brand-500">
              <Users size={18} />
            </span>
          ) : (
            <Avatar name={title} size="md" />
          )}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
              {title}
            </span>
            <span
              className={cn(
                "shrink-0 text-caption tabular-nums",
                late ? "font-medium text-semantic-error" : "text-text-muted"
              )}
            >
              {formatRelative(handoff.createdAt, now)}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              data-urgency={late ? "late" : "waiting"}
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                late ? "bg-semantic-error" : "bg-semantic-warning"
              )}
            />
            <span className="min-w-0 flex-1 truncate text-caption">
              <span className="font-medium text-text-secondary">{reason}</span>
              {detail && <span className="text-text-muted">{` · ${detail}`}</span>}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
