import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { LogOut, Palette, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/usePermissions";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNavBadges } from "@/hooks/useNavBadges";
import { useOrgModules } from "@/hooks/useOrgModules";
import { Id } from "../../../convex/_generated/dataModel";
import { TAB_ROUTES, activeTabForPath, type Tab } from "@/lib/routes";
import {
  badgeA11yText,
  formatBadgeCount,
  groupNavItems,
  visibleNavItems,
  type NavBadgeSource,
  type NavItemDef,
} from "@/lib/nav";
import { OrgSwitcherTrigger } from "@/components/org/OrgSwitcher";
import { Tooltip } from "@/components/ui/Tooltip";
import { ThemePickerModal } from "@/components/settings/ThemePickerModal";
import type { UiTheme } from "@/lib/theme";
import { VOCAB } from "@/lib/vocab";
import { copilotAriaShortcut, detectIsMac } from "@/lib/copilotShortcut";

type NavGroups = ReturnType<typeof groupNavItems>;

interface SidebarViewProps {
  items: ReadonlyArray<NavItemDef>;
  groups: NavGroups;
  activeTab: Tab | undefined;
  badges: Record<NavBadgeSource, number>;
  /** Barra estreita (só ícones): botões ganham `Tooltip`. */
  collapsed: boolean;
  orgName: string;
  onNavigate: (tab: Tab) => void;
  onSignOut: () => void;
  onOpenOrgSwitcher: () => void;
  onOpenAppearance: () => void;
  /** Só com o Copiloto ativo na organização; sem ele o item não aparece. */
  onOpenCopilot?: () => void;
  /** `aria-keyshortcuts` do atalho do Copiloto na plataforma (padrão: Ctrl+K). */
  copilotKeys?: string;
}

/** Sidebar pura: recebe o modelo já filtrado e as contagens. */
export function SidebarView({
  groups,
  activeTab,
  badges,
  collapsed,
  orgName,
  onNavigate,
  onSignOut,
  onOpenOrgSwitcher,
  onOpenAppearance,
  onOpenCopilot,
  copilotKeys = copilotAriaShortcut(false),
}: SidebarViewProps) {
  const withTip = (label: string, node: React.ReactElement<{ "aria-describedby"?: string }>) =>
    collapsed ? (
      <Tooltip content={label} wrapperClassName="flex w-full">
        {node}
      </Tooltip>
    ) : (
      node
    );

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

      {/* Itens por grupo */}
      <nav aria-label="Menu principal" className="flex-1 py-3 px-2 overflow-y-auto">
        {groups.map((group, index) => (
          <div
            key={group.id}
            role="group"
            aria-label={group.label ?? undefined}
            className={cn("space-y-1", index > 0 && "mt-3 pt-3 border-t border-border")}
          >
            {group.label && (
              <p className="hidden lg:block px-3 pb-1 text-caption font-medium text-text-muted">
                {group.label}
              </p>
            )}
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              const count = item.badge ? badges[item.badge] : 0;
              const badgeLabel = formatBadgeCount(count);
              const a11y = badgeA11yText(item.badge, count);
              return (
                <div key={item.id}>
                  {withTip(
                    item.label,
                    <button
                      type="button"
                      onClick={() => onNavigate(item.id)}
                      className={cn(
                        "relative w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                        "min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                        isActive
                          ? "bg-brand-500/10 text-brand-500"
                          : "text-text-secondary hover:text-text-primary hover:bg-surface-overlay"
                      )}
                      aria-current={isActive ? "page" : undefined}
                      aria-label={a11y ? `${item.label}, ${a11y}` : item.label}
                    >
                      <Icon size={20} className="shrink-0" aria-hidden="true" />
                      <span className="hidden lg:block truncate">{item.label}</span>
                      {badgeLabel && (
                        <>
                          {/* Sidebar expandida: pill no fim da linha */}
                          <span
                            className="hidden lg:flex ml-auto min-w-[18px] h-[18px] px-1 items-center justify-center rounded-full bg-brand-600 text-white text-micro font-semibold leading-none tabular-nums"
                            aria-hidden="true"
                          >
                            {badgeLabel}
                          </span>
                          {/* Sidebar colapsada (só ícones): pill sobre o ícone */}
                          <span
                            className="lg:hidden absolute top-1 right-1 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-brand-600 text-white text-micro font-semibold leading-none tabular-nums"
                            aria-hidden="true"
                          >
                            {badgeLabel}
                          </span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="border-t border-border p-2 space-y-1 shrink-0">
        {onOpenCopilot &&
          withTip(
            VOCAB.copilot.name,
            <button
              type="button"
              onClick={onOpenCopilot}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={VOCAB.copilot.name}
              aria-haspopup="dialog"
              aria-keyshortcuts={copilotKeys}
            >
              <Sparkles size={20} className="shrink-0" aria-hidden="true" />
              <span className="hidden lg:block">{VOCAB.copilot.name}</span>
            </button>
          )}
        {withTip(
          `Organização: ${orgName}`,
          <OrgSwitcherTrigger orgName={orgName} onClick={onOpenOrgSwitcher} />
        )}
        {withTip(
          "Aparência",
          <button
            type="button"
            onClick={onOpenAppearance}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Aparência"
            aria-haspopup="dialog"
          >
            <Palette size={20} className="shrink-0" aria-hidden="true" />
            <span className="hidden lg:block">Aparência</span>
          </button>
        )}
        {withTip(
          "Sair",
          <button
            type="button"
            onClick={onSignOut}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Sair"
          >
            <LogOut size={20} className="shrink-0" aria-hidden="true" />
            <span className="hidden lg:block">Sair</span>
          </button>
        )}
      </div>
    </aside>
  );
}

interface SidebarProps {
  onSignOut: () => void;
  organizationId: Id<"organizations">;
  orgName: string;
  onOpenOrgSwitcher: () => void;
  theme: UiTheme;
  setTheme: (theme: UiTheme) => void;
  onOpenCopilot?: () => void;
}

export function Sidebar({ onSignOut, organizationId, orgName, onOpenOrgSwitcher, theme, setTheme, onOpenCopilot }: SidebarProps) {
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = activeTabForPath(location.pathname);
  const { can } = usePermissions(organizationId);
  const { modules } = useOrgModules(organizationId);
  const expanded = useMediaQuery("(min-width: 1024px)");

  const items = useMemo(() => visibleNavItems(can, modules), [can, modules]);
  const groups = useMemo(() => groupNavItems(items), [items]);
  const badges = useNavBadges(organizationId, items);

  return (
    <>
    <SidebarView
      items={items}
      groups={groups}
      activeTab={activeTab}
      badges={badges}
      collapsed={!expanded}
      orgName={orgName}
      onNavigate={(tab) => navigate(TAB_ROUTES[tab])}
      onSignOut={onSignOut}
      onOpenOrgSwitcher={onOpenOrgSwitcher}
      onOpenAppearance={() => setAppearanceOpen(true)}
      onOpenCopilot={onOpenCopilot}
      copilotKeys={copilotAriaShortcut(detectIsMac())}
    />
    <ThemePickerModal open={appearanceOpen} organizationId={organizationId} onClose={() => setAppearanceOpen(false)} theme={theme} setTheme={setTheme} />
    </>
  );
}
