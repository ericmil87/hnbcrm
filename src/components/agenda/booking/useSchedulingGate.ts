import type { Id } from "../../../../convex/_generated/dataModel";
import { useAgendaAccess } from "@/hooks/useAgendaAccess";
import { useOrgModules } from "@/hooks/useOrgModules";

/**
 * Porta única das entradas da Agenda v2 fora da página (conversa, lead, contato): `enabled` = módulo ligado
 * e `agenda:view_own` (pode ler); `canBook` = módulo ligado e `agenda:edit`. Com o módulo desligado tudo é
 * falso e quem usa o hook passa `"skip"` nas queries: nenhuma assinatura nova.
 */
export function useSchedulingGate(organizationId: Id<"organizations">): { enabled: boolean; canBook: boolean } {
  const { modules } = useOrgModules(organizationId);
  const access = useAgendaAccess(organizationId);
  return { enabled: modules.scheduling && access.canView, canBook: modules.scheduling && access.canEdit };
}
