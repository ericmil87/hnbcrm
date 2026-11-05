import type { PermissionCategory } from "../../convex/lib/permissions";
import type { OrgModules } from "@/hooks/useOrgModules";
import { SETTINGS_GROUPS, SETTINGS_PANELS, type SettingsGroupId, type SettingsPanelDef } from "@/components/settings/registry";

/** O que a visibilidade de um painel pode consultar. */
export interface SettingsCtx {
  can: (category: PermissionCategory, level: string) => boolean;
  modules: OrgModules;
}

/** Parte de um painel que a navegação usa (o registro completo acrescenta ícone e componente). */
export type SettingsPanelMeta = Pick<SettingsPanelDef, "id" | "group" | "permission" | "visible">;

/** Painel visível para este usuário/org: permissão mínima e regra própria. */
export function isSettingsPanelVisible(panel: SettingsPanelMeta, ctx: SettingsCtx): boolean {
  if (panel.permission && !ctx.can(panel.permission.category, panel.permission.level)) return false;
  return panel.visible ? panel.visible(ctx) : true;
}

export function visibleSettingsPanels<P extends SettingsPanelMeta = SettingsPanelDef>(
  ctx: SettingsCtx,
  panels: ReadonlyArray<P> = SETTINGS_PANELS as unknown as ReadonlyArray<P>
): P[] {
  return panels.filter((p) => isSettingsPanelVisible(p, ctx));
}

/**
 * Valor de `?secao=` -> painel a abrir, ou `null` (ausente/desconhecido).
 * Painel conhecido mas invisível cai no primeiro visível do mesmo grupo.
 * `all` é o catálogo completo (para saber o grupo de um painel oculto).
 */
export function resolveSettingsPanel<P extends SettingsPanelMeta = SettingsPanelDef>(
  param: string | null,
  visible: ReadonlyArray<P>,
  all: ReadonlyArray<P> = SETTINGS_PANELS as unknown as ReadonlyArray<P>
): P | null {
  if (!param) return null;
  const known = all.find((p) => p.id === param);
  if (!known) return null;
  const direct = visible.find((p) => p.id === param);
  if (direct) return direct;
  return visible.find((p) => p.group === known.group) ?? null;
}

export function groupOf(panel: Pick<SettingsPanelDef, "group">): { id: SettingsGroupId; label: string } {
  return SETTINGS_GROUPS.find((g) => g.id === panel.group)!;
}

/** Painéis agrupados na ordem de `SETTINGS_GROUPS`; grupos vazios somem. */
export function groupSettingsPanels<P extends Pick<SettingsPanelDef, "group">>(
  panels: ReadonlyArray<P>
): Array<{ id: SettingsGroupId; label: string; panels: P[] }> {
  return SETTINGS_GROUPS.map((g) => ({ ...g, panels: panels.filter((p) => p.group === g.id) })).filter(
    (g) => g.panels.length > 0
  );
}
