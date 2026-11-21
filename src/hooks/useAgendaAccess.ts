import type { Id } from "../../convex/_generated/dataModel";
import { usePermissions } from "./usePermissions";
import { agendaAccess, type AgendaAccess } from "@/lib/agendaAccess";

/** `can("agenda", nível)` em quatro booleanos (ver `lib/agendaAccess.ts`); não recalcula permissão. */
export function useAgendaAccess(organizationId: Id<"organizations">): AgendaAccess & { isLoading: boolean } {
  const { can, isLoading } = usePermissions(organizationId);
  return { ...agendaAccess(can), isLoading };
}
