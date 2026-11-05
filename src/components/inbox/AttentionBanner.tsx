import { Link } from "react-router";
import { useQuery } from "convex/react";
import { ArrowLeftRight } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { TAB_ROUTES } from "@/lib/routes";

interface AttentionBannerProps {
  /** Pedidos de ajuda pendentes na org (`handoffs.getPendingHandoffCount`). */
  count: number;
}

/**
 * Faixa no topo da lista de Conversas: "3 conversas precisam de você · Ver"
 * (leva a Requer atenção). Some com zero.
 */
export function AttentionBanner({ count }: AttentionBannerProps) {
  if (count <= 0) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-field border border-semantic-warning/40 bg-semantic-warning/5 px-3 py-2 text-sm"
    >
      <ArrowLeftRight size={16} className="shrink-0 text-semantic-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-text-primary">
        <span className="font-semibold tabular-nums">{count}</span>{" "}
        <span className="font-semibold">
          {count === 1 ? "conversa precisa" : "conversas precisam"} de você
        </span>
      </p>
      <span aria-hidden="true" className="text-text-muted">
        ·
      </span>
      <Link
        to={TAB_ROUTES.handoffs}
        className="inline-flex min-h-9 shrink-0 items-center rounded-full px-2 font-medium text-brand-500 hover:text-brand-400 coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        Ver
      </Link>
    </div>
  );
}

/**
 * Contagem que alimenta a faixa: a mesma query do badge do menu. `0` enquanto
 * carrega ou quando a pessoa não pode ver a fila (`skip`).
 */
export function usePendingAttentionCount(
  organizationId: Id<"organizations">,
  enabled: boolean
): number {
  return useQuery(api.handoffs.getPendingHandoffCount, enabled ? { organizationId } : "skip") ?? 0;
}
