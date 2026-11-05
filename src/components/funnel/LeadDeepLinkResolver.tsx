import { useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * Resolve o `?lead=` da URL sem quebrar a página quando o id é inválido ou de
 * outra org: a query falha dentro deste filho, que fica sob um ErrorBoundary
 * com fallback nulo (o deep-link é simplesmente ignorado).
 */
export function LeadDeepLinkResolver({
  leadId,
  onResolve,
}: {
  leadId: Id<"leads">;
  onResolve: (lead: { _id: Id<"leads">; boardId: Id<"boards"> }) => void;
}) {
  const lead = useQuery(api.leads.getLead, { leadId });
  // Aplica uma vez só: depois disso o usuário manda no board/painel, e uma
  // atualização reativa do lead não pode arrastá-lo de volta.
  const appliedRef = useRef(false);
  useEffect(() => {
    if (!lead || appliedRef.current) return;
    appliedRef.current = true;
    onResolve(lead);
  }, [lead, onResolve]);
  return null;
}
