import {
  BarChart3,
  BellRing,
  CalendarDays,
  CheckSquare,
  Contact2,
  FileText,
  Kanban,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  ScrollText,
  Settings,
  Users,
  Users2,
  type LucideIcon,
} from "lucide-react";
import type { PermissionCategory } from "../../convex/lib/permissions";
import type { OrgModuleKey } from "@/hooks/useOrgModules";
import { VOCAB } from "./vocab";
import type { Tab } from "./routes";

export type NavGroupId = "atendimento" | "organizacao" | "divulgacao" | "gestao";
export type NavBadgeSource = "inboxUnread" | "pendingAttention" | "pausedCampaigns";

export interface NavItemDef {
  id: Tab;
  label: string;
  icon: LucideIcon;
  /** `null` = item solto no topo, sem grupo nem rótulo (Painel). */
  group: NavGroupId | null;
  /** Categoria + nível mínimo para o item aparecer. */
  permission?: { category: PermissionCategory; level: string };
  /** Módulo da org que precisa estar ligado. */
  module?: OrgModuleKey;
  badge?: NavBadgeSource;
  mobile: "primary" | "more";
  /** Prefixos extras que ativam o item (sub-rotas). O próprio `TAB_ROUTES[id]` já conta. */
  matchPrefixes?: string[];
}

/** Grupos na ordem de exibição. `label: null` = sem rótulo (Painel). */
export const NAV_GROUPS: ReadonlyArray<{ id: NavGroupId | "topo"; label: string | null }> = [
  { id: "topo", label: null },
  { id: "atendimento", label: "Atendimento" },
  { id: "organizacao", label: "Organização" },
  { id: "divulgacao", label: "Divulgação" },
  { id: "gestao", label: "Gestão" },
];

/** Item novo no menu = uma linha aqui (mais a rota em `TAB_ROUTES`). */
export const NAV_ITEMS: ReadonlyArray<NavItemDef> = [
  { id: "dashboard", label: VOCAB.dashboard.nav, icon: LayoutDashboard, group: null, mobile: "primary" },
  { id: "inbox", label: VOCAB.conversations.nav, icon: MessageSquare, group: "atendimento", permission: { category: "inbox", level: "view_own" }, badge: "inboxUnread", mobile: "primary" },
  { id: "handoffs", label: VOCAB.attention.nav, icon: BellRing, group: "atendimento", permission: { category: "inbox", level: "view_own" }, badge: "pendingAttention", mobile: "primary" },
  { id: "board", label: VOCAB.funnel.nav, icon: Kanban, group: "atendimento", permission: { category: "leads", level: "view_own" }, mobile: "primary" },
  { id: "contacts", label: VOCAB.contact.nav, icon: Contact2, group: "atendimento", permission: { category: "contacts", level: "view" }, mobile: "more" },
  { id: "tasks", label: VOCAB.tasks.nav, icon: CheckSquare, group: "organizacao", permission: { category: "tasks", level: "view_own" }, mobile: "more" },
  { id: "calendar", label: VOCAB.agenda.nav, icon: CalendarDays, group: "organizacao", permission: { category: "tasks", level: "view_own" }, mobile: "more" },
  { id: "campaigns", label: VOCAB.campaigns.nav, icon: Megaphone, group: "divulgacao", permission: { category: "campaigns", level: "view" }, badge: "pausedCampaigns", mobile: "more" },
  { id: "groups", label: VOCAB.groups.nav, icon: Users2, group: "divulgacao", permission: { category: "inbox", level: "view_own" }, mobile: "more" },
  { id: "forms", label: VOCAB.forms.nav, icon: FileText, group: "divulgacao", permission: { category: "settings", level: "manage" }, mobile: "more" },
  { id: "central", label: VOCAB.reports.nav, icon: BarChart3, group: "gestao", permission: { category: "reports", level: "view" }, module: "central", mobile: "more" },
  { id: "team", label: VOCAB.team.nav, icon: Users, group: "gestao", permission: { category: "team", level: "view" }, mobile: "more" },
  { id: "audit", label: VOCAB.audit.nav, icon: ScrollText, group: "gestao", permission: { category: "auditLogs", level: "view" }, mobile: "more" },
  { id: "settings", label: VOCAB.settings.nav, icon: Settings, group: "gestao", permission: { category: "settings", level: "view" }, mobile: "more" },
];

/** Filtra por permissão e módulo. Pura: recebe `can` e `modules`. */
export function visibleNavItems(
  can: (category: PermissionCategory, level: string) => boolean,
  modules: Partial<Record<OrgModuleKey, boolean>>
): NavItemDef[] {
  return NAV_ITEMS.filter((item) => {
    if (item.module && !modules[item.module]) return false;
    if (!item.permission) return true;
    return can(item.permission.category, item.permission.level);
  });
}

export const MAX_MOBILE_PRIMARY = 4;

/** Divide os visíveis em barra inferior (máx. 4) e "Mais". */
export function splitMobile(items: ReadonlyArray<NavItemDef>): { primary: NavItemDef[]; more: NavItemDef[] } {
  const wanted = items.filter((i) => i.mobile === "primary");
  const primary = wanted.slice(0, MAX_MOBILE_PRIMARY);
  const more = items.filter((i) => !primary.includes(i));
  return { primary, more };
}

/** Itens agrupados na ordem de `NAV_GROUPS`; grupos vazios somem. */
export function groupNavItems(
  items: ReadonlyArray<NavItemDef>
): Array<{ id: NavGroupId | "topo"; label: string | null; items: NavItemDef[] }> {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: items.filter((i) => (i.group ?? "topo") === g.id),
  })).filter((g) => g.items.length > 0);
}

/** Item de `NAV_ITEMS` por id de aba. */
export function navItemFor(tab: Tab | undefined): NavItemDef | undefined {
  return tab ? NAV_ITEMS.find((i) => i.id === tab) : undefined;
}

/** Texto do badge: "99+" acima de 99; `null` sem contagem. */
export function formatBadgeCount(count: number | undefined): string | null {
  return count && count > 0 ? (count > 99 ? "99+" : String(count)) : null;
}

/** Texto acessível do badge: "1 não lida", "3 não lidas", "5 pendentes". */
export function badgeA11yText(source: NavBadgeSource | undefined, count: number | undefined): string | null {
  if (!count || count <= 0) return null;
  const n = count > 99 ? "mais de 99" : String(count);
  if (source === "pendingAttention") return count === 1 ? `${n} pedido de ajuda` : `${n} pedidos de ajuda`;
  if (source === "pausedCampaigns") return count === 1 ? `${n} pausada` : `${n} pausadas`;
  return count === 1 ? `${n} não lida` : `${n} não lidas`;
}

/**
 * Seções da folha "Mais" (mobile): os grupos dos itens escondidos, com o resto
 * de Atendimento (Contatos) fundido a Organização para que Contatos, Tarefas e
 * Agenda abram a folha na primeira linha.
 */
export function moreSheetSections(
  more: ReadonlyArray<NavItemDef>
): Array<{ id: string; label: string | null; items: NavItemDef[] }> {
  const groups = groupNavItems(more);
  const [first, second, ...rest] = groups;
  if (first?.id === "atendimento" && second?.id === "organizacao") {
    return [
      { id: "atendimento-organizacao", label: "Atendimento e organização", items: [...first.items, ...second.items] },
      ...rest,
    ];
  }
  return groups;
}
