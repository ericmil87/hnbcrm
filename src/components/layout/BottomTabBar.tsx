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
  Settings,
  FileText,
  MoreHorizontal,
} from "lucide-react";
import { TAB_ROUTES, PATH_TO_TAB } from "@/lib/routes";

export type Tab = "dashboard" | "board" | "contacts" | "inbox" | "tasks" | "calendar" | "handoffs" | "team" | "audit" | "settings" | "forms";

interface NavItem {
  id: Tab;
  label: string;
  icon: React.ElementType;
  permission?: { category: PermissionCategory; level: string };
}

/** Primary tabs shown in the bottom bar */
const primaryTabs: NavItem[] = [
  { id: "dashboard", label: "Painel", icon: LayoutDashboard },
  { id: "board", label: "Pipeline", icon: Kanban, permission: { category: "leads", level: "view_own" } },
  { id: "calendar", label: "Calendario", icon: CalendarDays, permission: { category: "tasks", level: "view_own" } },
  { id: "inbox", label: "Entrada", icon: MessageSquare, permission: { category: "inbox", level: "view_own" } },
  { id: "tasks", label: "Tarefas", icon: CheckSquare, permission: { category: "tasks", level: "view_own" } },
];

/** Overflow tabs shown in the "More" menu */
const moreTabs: NavItem[] = [
  { id: "contacts", label: "Contatos", icon: Contact2, permission: { category: "contacts", level: "view" } },
  { id: "handoffs", label: "Repasses", icon: ArrowRightLeft, permission: { category: "inbox", level: "view_own" } },
  { id: "team", label: "Equipe", icon: Users, permission: { category: "team", level: "view" } },
  { id: "audit", label: "Auditoria", icon: ScrollText, permission: { category: "auditLogs", level: "view" } },
  { id: "forms", label: "Formularios", icon: FileText, permission: { category: "settings", level: "manage" } },
  { id: "settings", label: "Configurações", icon: Settings, permission: { category: "settings", level: "view" } },
];

interface BottomTabBarProps {
  organizationId: Id<"organizations">;
  showMore: boolean;
  onToggleMore: () => void;
}

export function BottomTabBar({ organizationId, showMore, onToggleMore }: BottomTabBarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = PATH_TO_TAB[location.pathname];
  const { can } = usePermissions(organizationId);

  const visiblePrimary = useMemo(() => {
    return primaryTabs.filter((t) => {
      if (!t.permission) return true;
      return can(t.permission.category, t.permission.level);
    });
  }, [can]);

  const visibleMore = useMemo(() => {
    return moreTabs.filter((t) => {
      if (!t.permission) return true;
      return can(t.permission.category, t.permission.level);
    });
  }, [can]);

  const moreTabIds = useMemo(() => new Set(visibleMore.map((t) => t.id)), [visibleMore]);
  const isMoreActive = moreTabIds.has(activeTab as Tab);

  return (
    <>
      {/* More menu overlay */}
      {showMore && (
        <div className="fixed inset-0 z-40" onClick={onToggleMore} aria-hidden="true" />
      )}

      {/* More menu popup */}
      {showMore && visibleMore.length > 0 && (
        <div className="fixed bottom-[calc(64px+env(safe-area-inset-bottom,0px))] right-2 z-50 bg-surface-overlay border border-border rounded-xl shadow-elevated animate-fade-in-up p-1 min-w-[160px]">
          {visibleMore.map((tab) => (
            <button
              key={tab.id}
              onClick={() => { navigate(TAB_ROUTES[tab.id]); onToggleMore(); }}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-colors",
                activeTab === tab.id ? "text-brand-500 bg-brand-500/10" : "text-text-secondary hover:text-text-primary hover:bg-surface-raised"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 md:hidden bg-surface-raised border-t border-border pb-safe">
        <div className="flex items-center justify-around h-16">
          {visiblePrimary.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => navigate(TAB_ROUTES[tab.id])}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 min-w-[44px] min-h-[44px] transition-colors",
                  isActive ? "text-brand-500" : "text-text-muted"
                )}
                aria-label={tab.label}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon size={20} />
                <span className="text-[11px] font-medium">{tab.label}</span>
              </button>
            );
          })}

          {/* More button (only if there are overflow items) */}
          {visibleMore.length > 0 && (
            <button
              onClick={onToggleMore}
              className={cn(
                "flex flex-col items-center justify-center gap-0.5 min-w-[44px] min-h-[44px] transition-colors",
                isMoreActive ? "text-brand-500" : "text-text-muted"
              )}
              aria-label="Mais opcoes"
            >
              <MoreHorizontal size={20} />
              <span className="text-[11px] font-medium">Mais</span>
            </button>
          )}
        </div>
      </nav>
    </>
  );
}
