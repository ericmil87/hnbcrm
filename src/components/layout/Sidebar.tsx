import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/usePermissions";
import { Id } from "../../../convex/_generated/dataModel";
import type { PermissionCategory } from "../../../convex/lib/permissions";
import {
  LayoutDashboard,
  Kanban,
  Contact2,
  MessageSquare,
  CheckSquare,
  CalendarDays,
  ArrowRightLeft,
  Users,
  ScrollText,
  FileText,
  Settings,
  LogOut,
} from "lucide-react";
import type { Tab } from "./BottomTabBar";
import { TAB_ROUTES, PATH_TO_TAB } from "@/lib/routes";

interface NavItem {
  id: Tab;
  label: string;
  icon: React.ElementType;
  /** Permission category + minimum level required to see this nav item */
  permission?: { category: PermissionCategory; level: string };
}

const navItems: NavItem[] = [
  { id: "dashboard", label: "Painel", icon: LayoutDashboard },
  { id: "board", label: "Pipeline", icon: Kanban, permission: { category: "leads", level: "view_own" } },
  { id: "contacts", label: "Contatos", icon: Contact2, permission: { category: "contacts", level: "view" } },
  { id: "inbox", label: "Caixa de Entrada", icon: MessageSquare, permission: { category: "inbox", level: "view_own" } },
  { id: "handoffs", label: "Repasses", icon: ArrowRightLeft, permission: { category: "inbox", level: "view_own" } },
  { id: "tasks", label: "Tarefas", icon: CheckSquare, permission: { category: "tasks", level: "view_own" } },
  { id: "calendar", label: "Calendario", icon: CalendarDays, permission: { category: "tasks", level: "view_own" } },
  { id: "team", label: "Equipe", icon: Users, permission: { category: "team", level: "view" } },
  { id: "audit", label: "Auditoria", icon: ScrollText, permission: { category: "auditLogs", level: "view" } },
  { id: "forms", label: "Formularios", icon: FileText, permission: { category: "settings", level: "manage" } },
  { id: "settings", label: "Configurações", icon: Settings, permission: { category: "settings", level: "view" } },
];

interface SidebarProps {
  onSignOut: () => void;
  organizationId: Id<"organizations">;
  orgSelector?: React.ReactNode;
}

export function Sidebar({ onSignOut, organizationId, orgSelector }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = PATH_TO_TAB[location.pathname];
  const { can } = usePermissions(organizationId);

  const visibleItems = useMemo(() => {
    return navItems.filter((item) => {
      if (!item.permission) return true;
      return can(item.permission.category, item.permission.level);
    });
  }, [can]);

  return (
    <aside className="hidden md:flex fixed left-0 top-0 bottom-0 z-20 flex-col bg-surface-raised border-r border-border w-16 lg:w-56 transition-all duration-200">
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 h-16 border-b border-border shrink-0">
        <img
          src="/orange_icon_logo_transparent-bg-528x488.png"
          alt="HNBCRM"
          className="h-8 w-8 object-contain shrink-0"
        />
        <span className="hidden lg:block text-lg font-bold text-text-primary tracking-tight">
          HNBCRM
        </span>
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-3 px-2 space-y-1 overflow-y-auto">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => navigate(TAB_ROUTES[item.id])}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                "min-h-[44px]",
                isActive
                  ? "bg-brand-500/10 text-brand-500"
                  : "text-text-secondary hover:text-text-primary hover:bg-surface-overlay"
              )}
              aria-current={isActive ? "page" : undefined}
              title={item.label}
            >
              <Icon size={20} className="shrink-0" />
              <span className="hidden lg:block truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div className="border-t border-border p-2 space-y-1 shrink-0">
        {orgSelector && (
          <div className="px-1 py-2">
            {orgSelector}
          </div>
        )}
        <button
          onClick={onSignOut}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors min-h-[44px]"
          title="Sair"
        >
          <LogOut size={20} className="shrink-0" />
          <span className="hidden lg:block">Sair</span>
        </button>
      </div>
    </aside>
  );
}
