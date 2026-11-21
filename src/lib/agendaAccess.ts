import type { PermissionCategory } from "../../convex/lib/permissions";
import type { OrgModules } from "@/hooks/useOrgModules";

type Can = (category: PermissionCategory, level: string) => boolean;

/** Níveis da categoria `agenda`, do menor ao maior (fonte: `convex/lib/permissions.ts`). */
export const AGENDA_LEVELS = ["none", "view_own", "view_all", "edit", "manage"] as const;
export type AgendaLevel = (typeof AGENDA_LEVELS)[number];

export interface AgendaAccess {
  /** Vê a agenda (a própria, no mínimo). */
  canView: boolean;
  /** Vê a agenda de todos. */
  canViewAll: boolean;
  /** Marca, remarca, cancela, muda status, fecha/abre recurso no dia. */
  canEdit: boolean;
  /** Serviços, recursos, horários, regras e política da IA. */
  canManage: boolean;
}

/**
 * Atalhos de `can("agenda", nível)` — o `can` vem de `usePermissions` (não há segundo cálculo de
 * permissão aqui). O servidor continua sendo a barreira; isto só decide o que oferecer.
 */
export function agendaAccess(can: Can): AgendaAccess {
  return {
    canView: can("agenda", "view_own"),
    canViewAll: can("agenda", "view_all"),
    canEdit: can("agenda", "edit"),
    canManage: can("agenda", "manage"),
  };
}

/** A agenda v2 (recursos, marcar horário) existe para esta org: módulo ligado. Desligado = tela de hoje. */
export function isSchedulingOn(modules: Pick<OrgModules, "scheduling">): boolean {
  return modules.scheduling === true;
}

/** Marcar horário: módulo ligado e `agenda:edit`. */
export function canBookAppointments(modules: Pick<OrgModules, "scheduling">, can: Can): boolean {
  return isSchedulingOn(modules) && can("agenda", "edit");
}

/** Configurar a agenda v2 (painéis de Configurações): módulo ligado e `agenda:manage`. */
export function canConfigureScheduling(modules: Pick<OrgModules, "scheduling">, can: Can): boolean {
  return isSchedulingOn(modules) && can("agenda", "manage");
}

/**
 * Cartão "Ativar agendamento": só com o módulo DESLIGADO, para quem tem `agenda:manage`. Ligar de fato
 * exige `settings:manage` (é `setOrgModules`); sem ele o cartão explica em vez de oferecer o botão.
 */
export function enableCardState(modules: Pick<OrgModules, "scheduling">, can: Can): "hidden" | "locked" | "ready" {
  if (isSchedulingOn(modules) || !can("agenda", "manage")) return "hidden";
  return can("settings", "manage") ? "ready" : "locked";
}
