/**
 * Shared permission types, defaults, and comparison logic.
 * Used by both backend (requirePermission) and frontend (usePermissions).
 */

// Permission categories
export type PermissionCategory =
  | "leads"
  | "contacts"
  | "inbox"
  | "tasks"
  | "reports"
  | "team"
  | "settings"
  | "auditLogs"
  | "apiKeys"
  | "campaigns";

// Level definitions per category
export type LeadsLevel = "none" | "view_own" | "view_all" | "edit_own" | "edit_all" | "full";
export type ContactsLevel = "none" | "view" | "edit" | "full";
export type InboxLevel = "none" | "view_own" | "view_all" | "reply" | "full";
export type TasksLevel = "none" | "view_own" | "view_all" | "edit_own" | "edit_all" | "full";
export type ReportsLevel = "none" | "view" | "full";
export type TeamLevel = "none" | "view" | "manage";
export type SettingsLevel = "none" | "view" | "manage";
export type AuditLogsLevel = "none" | "view";
export type ApiKeysLevel = "none" | "view" | "manage";
export type CampaignsLevel = "none" | "view" | "manage" | "full";

export interface Permissions {
  leads: LeadsLevel;
  contacts: ContactsLevel;
  inbox: InboxLevel;
  tasks: TasksLevel;
  reports: ReportsLevel;
  team: TeamLevel;
  settings: SettingsLevel;
  auditLogs: AuditLogsLevel;
  apiKeys: ApiKeysLevel;
  campaigns: CampaignsLevel;
}

export type Role = "admin" | "manager" | "agent" | "ai";

// Level hierarchies — each array is ordered from lowest to highest
const LEVEL_HIERARCHIES: Record<PermissionCategory, string[]> = {
  leads: ["none", "view_own", "view_all", "edit_own", "edit_all", "full"],
  contacts: ["none", "view", "edit", "full"],
  inbox: ["none", "view_own", "view_all", "reply", "full"],
  tasks: ["none", "view_own", "view_all", "edit_own", "edit_all", "full"],
  reports: ["none", "view", "full"],
  team: ["none", "view", "manage"],
  settings: ["none", "view", "manage"],
  auditLogs: ["none", "view"],
  apiKeys: ["none", "view", "manage"],
  // manage = criar/editar/pausar; full = lançar, cancelar, excluir, override de tetos
  campaigns: ["none", "view", "manage", "full"],
};

// Default permissions per role
export const DEFAULT_PERMISSIONS: Record<Role, Permissions> = {
  admin: {
    leads: "full",
    contacts: "full",
    inbox: "full",
    tasks: "full",
    reports: "full",
    team: "manage",
    settings: "manage",
    auditLogs: "view",
    apiKeys: "manage",
    campaigns: "full",
  },
  manager: {
    leads: "edit_all",
    contacts: "edit",
    inbox: "full",
    tasks: "edit_all",
    reports: "view",
    team: "view",
    settings: "view",
    auditLogs: "view",
    apiKeys: "manage",
    campaigns: "manage",
  },
  agent: {
    leads: "edit_own",
    contacts: "edit",
    inbox: "reply",
    tasks: "edit_own",
    reports: "view",
    team: "none",
    settings: "none",
    auditLogs: "none",
    apiKeys: "none",
    campaigns: "view",
  },
  ai: {
    leads: "edit_own",
    contacts: "edit",
    inbox: "reply",
    tasks: "edit_own",
    reports: "view",
    team: "none",
    settings: "none",
    auditLogs: "none",
    apiKeys: "none",
    campaigns: "view",
  },
};

/**
 * Resolve effective permissions for a team member.
 * If explicit permissions are set, use those; otherwise fall back to role defaults.
 */
export function resolvePermissions(
  role: Role,
  explicit?: (Partial<Permissions> & Omit<Permissions, "campaigns">) | null
): Permissions {
  const defaults = DEFAULT_PERMISSIONS[role];
  if (!explicit) return defaults;
  // Categorias criadas depois de o membro ter permissões explícitas gravadas
  // (ex.: campaigns) caem no default do role em vez de "undefined" (= negado).
  return { ...explicit, campaigns: explicit.campaigns ?? defaults.campaigns };
}

/**
 * Check if a permission level meets or exceeds the required level.
 */
export function hasPermission(
  permissions: Permissions,
  category: PermissionCategory,
  requiredLevel: string
): boolean {
  const hierarchy = LEVEL_HIERARCHIES[category];
  const currentLevel = permissions[category];
  const currentIndex = hierarchy.indexOf(currentLevel);
  const requiredIndex = hierarchy.indexOf(requiredLevel);
  if (currentIndex === -1 || requiredIndex === -1) return false;
  return currentIndex >= requiredIndex;
}

/**
 * Get the hierarchy of levels for a category (for UI rendering).
 */
export function getLevelsForCategory(category: PermissionCategory): string[] {
  return LEVEL_HIERARCHIES[category];
}

// PT-BR labels for categories
export const CATEGORY_LABELS: Record<PermissionCategory, string> = {
  leads: "Leads",
  contacts: "Contatos",
  inbox: "Caixa de Entrada",
  tasks: "Tarefas",
  reports: "Relatórios",
  team: "Equipe",
  settings: "Configurações",
  auditLogs: "Auditoria",
  apiKeys: "Chaves API",
  campaigns: "Campanhas",
};

// PT-BR labels for levels
export const LEVEL_LABELS: Record<string, string> = {
  none: "Nenhum",
  view_own: "Ver Próprios",
  view_all: "Ver Todos",
  edit_own: "Editar Próprios",
  edit_all: "Editar Todos",
  full: "Total",
  view: "Visualizar",
  edit: "Editar",
  reply: "Responder",
  manage: "Gerenciar",
};
