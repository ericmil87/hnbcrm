import type { PermissionCategory } from "../../convex/lib/permissions";
import type { OrgModules } from "@/hooks/useOrgModules";
import type { BillingMode } from "@/lib/billingPanel";
import { SETTINGS_GROUPS, SETTINGS_PANELS, type SettingsGroupId, type SettingsPanelDef } from "@/components/settings/registry";

/** O que a visibilidade de um painel pode consultar. */
export interface SettingsCtx {
  can: (category: PermissionCategory, level: string) => boolean;
  modules: OrgModules;
  /** Modo do plano da org (`getMyEntitlements`); `undefined` = ainda carregando. */
  billingMode?: BillingMode | null;
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

export interface ResolvedSettingsPanel<P> {
  /** Painel a abrir (o pedido ou o substituto do mesmo grupo), ou `null`. */
  panel: P | null;
  /** O painel pedido existe mas este usuário/org não o vê: `panel` é só o substituto. */
  denied: boolean;
  /** Painel pedido e conhecido (para citar o nome no aviso). */
  requested: P | null;
}

/**
 * Valor de `?secao=` -> painel a abrir, ou `null` (ausente/desconhecido).
 * Painel conhecido mas invisível cai no primeiro visível do mesmo grupo e vem com `denied: true`.
 * `all` é o catálogo completo (para saber o grupo de um painel oculto).
 */
export function resolveSettingsPanelState<P extends SettingsPanelMeta = SettingsPanelDef>(
  param: string | null,
  visible: ReadonlyArray<P>,
  all: ReadonlyArray<P> = SETTINGS_PANELS as unknown as ReadonlyArray<P>
): ResolvedSettingsPanel<P> {
  if (!param) return { panel: null, denied: false, requested: null };
  const known = all.find((p) => p.id === param);
  if (!known) return { panel: null, denied: false, requested: null };
  const direct = visible.find((p) => p.id === param);
  if (direct) return { panel: direct, denied: false, requested: known };
  return { panel: visible.find((p) => p.group === known.group) ?? null, denied: true, requested: known };
}

/** Só o painel de `resolveSettingsPanelState`. */
export function resolveSettingsPanel<P extends SettingsPanelMeta = SettingsPanelDef>(
  param: string | null,
  visible: ReadonlyArray<P>,
  all: ReadonlyArray<P> = SETTINGS_PANELS as unknown as ReadonlyArray<P>
): P | null {
  return resolveSettingsPanelState(param, visible, all).panel;
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
