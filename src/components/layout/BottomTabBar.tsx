import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { Building2, LogOut, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/usePermissions";
import { useNavBadges } from "@/hooks/useNavBadges";
import { useOrgModules } from "@/hooks/useOrgModules";
import { Id } from "../../../convex/_generated/dataModel";
import { TAB_ROUTES, activeTabForPath, type Tab } from "@/lib/routes";
import {
  badgeA11yText,
  formatBadgeCount,
  moreSheetSections,
  splitMobile,
  visibleNavItems,
  type NavBadgeSource,
  type NavItemDef,
} from "@/lib/nav";
import { Modal } from "@/components/ui/Modal";

interface BottomTabBarViewProps {
  items: ReadonlyArray<NavItemDef>;
  activeTab: Tab | undefined;
  badges: Record<NavBadgeSource, number>;
  showMore: boolean;
  orgName: string;
  onNavigate: (tab: Tab) => void;
  onToggleMore: () => void;
  onOpenOrgSwitcher: () => void;
  onSignOut: () => void;
}

const BADGE_PILL =
  "min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-brand-600 text-white text-[10px] font-semibold leading-none tabular-nums";

/** Barra inferior pura: 4 primários + "Mais" (folha por grupos). */
export function BottomTabBarView({
  items,
  activeTab,
  badges,
  showMore,
  orgName,
  onNavigate,
  onToggleMore,
  onOpenOrgSwitcher,
  onSignOut,
}: BottomTabBarViewProps) {
  const { primary, more } = useMemo(() => splitMobile(items), [items]);
  const sections = useMemo(() => moreSheetSections(more), [more]);
  const isMoreActive = more.some((i) => i.id === activeTab);
  const moreHasBadge = more.some((i) => i.badge && badges[i.badge] > 0);

  return (
    <>
      {/* Folha "Mais" */}
      <Modal open={showMore} onClose={onToggleMore} title="Mais opções" className="supports-[height:100dvh]:max-h-[85dvh]">
        <div className="space-y-4">
          {sections.map((section) => (
            <section key={section.id} aria-label={section.label ?? undefined}>
              {section.label && (
                <h3 className="px-1 pb-2 text-[11px] font-medium text-text-muted">{section.label}</h3>
              )}
              <ul className="grid grid-cols-3 gap-2">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  const count = item.badge ? badges[item.badge] : 0;
                  const badgeLabel = formatBadgeCount(count);
                  const a11y = badgeA11yText(item.badge, count);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onNavigate(item.id);
                          onToggleMore();
                        }}
                        className={cn(
                          "relative w-full min-h-[72px] flex flex-col items-center justify-center gap-1 px-1 py-2 rounded-lg text-[12px] font-medium transition-colors",
                          "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                          isActive
                            ? "text-brand-500 bg-brand-500/10"
                            : "text-text-secondary hover:text-text-primary bg-surface-raised"
                        )}
                        aria-current={isActive ? "page" : undefined}
                        aria-label={a11y ? `${item.label}, ${a11y}` : item.label}
                      >
                        <span className="relative">
                          <Icon size={22} aria-hidden="true" />
                          {badgeLabel && (
                            <span className={cn("absolute -top-1.5 -right-3", BADGE_PILL)} aria-hidden="true">
                              {badgeLabel}
                            </span>
                          )}
                        </span>
                        <span className="text-center leading-tight" aria-hidden="true">
                          {item.label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {/* Conta: organização atual + sair (no desktop ficam na sidebar) */}
          <div className="pt-3 border-t border-border">
            <button
              type="button"
              onClick={() => {
                onToggleMore();
                onOpenOrgSwitcher();
              }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={`Organização atual: ${orgName}. Trocar ou criar organização`}
            >
              <Building2 size={18} className="shrink-0 text-brand-500" aria-hidden="true" />
              <span className="flex-1 min-w-0 text-left">
                <span className="block text-[11px] text-text-muted">Organização</span>
                <span className="block truncate text-text-primary">{orgName}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                onToggleMore();
                onSignOut();
              }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <LogOut size={18} className="shrink-0" aria-hidden="true" />
              <span className="flex-1 text-left">Sair</span>
            </button>
          </div>
        </div>
      </Modal>

      {/* Barra */}
      <nav aria-label="Menu principal" className="fixed bottom-0 left-0 right-0 z-30 md:hidden bg-surface-raised border-t border-border pb-safe">
        <div className="flex items-center justify-around h-16">
          {primary.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            const count = item.badge ? badges[item.badge] : 0;
            const badgeLabel = formatBadgeCount(count);
            const a11y = badgeA11yText(item.badge, count);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={cn(
                  "relative flex flex-col items-center justify-center gap-0.5 min-w-[44px] min-h-[44px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded-lg",
                  isActive ? "text-brand-500" : "text-text-muted"
                )}
                aria-label={a11y ? `${item.label}, ${a11y}` : item.label}
                aria-current={isActive ? "page" : undefined}
              >
                <span className="relative">
                  <Icon size={20} aria-hidden="true" />
                  {badgeLabel && (
                    <span className={cn("absolute -top-1.5 -right-2.5", BADGE_PILL)} aria-hidden="true">
                      {badgeLabel}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-medium" aria-hidden="true">{item.label}</span>
              </button>
            );
          })}

          {/* "Mais" sempre visível: carrega também organização e "Sair" */}
          <button
            type="button"
            onClick={onToggleMore}
            className={cn(
              "relative flex flex-col items-center justify-center gap-0.5 min-w-[44px] min-h-[44px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded-lg",
              isMoreActive ? "text-brand-500" : "text-text-muted"
            )}
            aria-label={moreHasBadge ? "Mais opções, há itens com pendência" : "Mais opções"}
            aria-haspopup="dialog"
            aria-expanded={showMore}
          >
            <span className="relative">
              <MoreHorizontal size={20} aria-hidden="true" />
              {moreHasBadge && (
                <span className="absolute -top-0.5 -right-1 h-2 w-2 rounded-full bg-brand-600" aria-hidden="true" />
              )}
            </span>
            <span className="text-[11px] font-medium" aria-hidden="true">Mais</span>
          </button>
        </div>
      </nav>
    </>
  );
}

interface BottomTabBarProps {
  organizationId: Id<"organizations">;
  showMore: boolean;
  onToggleMore: () => void;
  orgName: string;
  onOpenOrgSwitcher: () => void;
  onSignOut: () => void;
}

export function BottomTabBar({
  organizationId,
  showMore,
  onToggleMore,
  orgName,
  onOpenOrgSwitcher,
  onSignOut,
}: BottomTabBarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = activeTabForPath(location.pathname);
  const { can } = usePermissions(organizationId);
  const { modules } = useOrgModules(organizationId);
  const items = useMemo(() => visibleNavItems(can, modules), [can, modules]);
  const badges = useNavBadges(organizationId, items);

  return (
    <BottomTabBarView
      items={items}
      activeTab={activeTab}
      badges={badges}
      showMore={showMore}
      orgName={orgName}
      onNavigate={(tab) => navigate(TAB_ROUTES[tab])}
      onToggleMore={onToggleMore}
      onOpenOrgSwitcher={onOpenOrgSwitcher}
      onSignOut={onSignOut}
    />
  );
}
