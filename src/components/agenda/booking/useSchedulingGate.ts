import type { Id } from "../../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { useOrgModules } from "@/hooks/useOrgModules";
import { resolveSchedulingGate, type SchedulingGate } from "@/lib/schedulingGate";

/**
 * Porta única das entradas da Agenda v2 fora da página (conversa, lead, contato). A regra é pura
 * (`lib/schedulingGate`); aqui só se leem módulo e permissão. Desligado: tudo falso e quem usa o hook
 * passa `"skip"` nas queries (`gatedArgs`).
 */
export function useSchedulingGate(organizationId: Id<"organizations">): SchedulingGate {
  const { modules } = useOrgModules(organizationId);
  const { can } = usePermissions(organizationId);
  return resolveSchedulingGate(modules, can);
}
