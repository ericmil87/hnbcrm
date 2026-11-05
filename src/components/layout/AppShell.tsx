import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useQuery } from "convex/react";
import { Building2, ChevronsUpDown } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { BottomTabBar } from "./BottomTabBar";
import { CopilotFab } from "@/components/copilot/CopilotFab";
import { CopilotPanel } from "@/components/copilot/CopilotPanel";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { activeTabForPath } from "@/lib/routes";
import { navItemFor } from "@/lib/nav";
import { usePageTitle } from "@/hooks/usePageTitle";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";

interface AppShellProps {
  onSignOut: () => void;
  organizationId: Id<"organizations">;
  orgName: string;
  onOpenOrgSwitcher: () => void;
  children: React.ReactNode;
}

export function AppShell({ onSignOut, organizationId, orgName, onOpenOrgSwitcher, children }: AppShellProps) {
  const [showMore, setShowMore] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const location = useLocation();
  const pageTitle = navItemFor(activeTabForPath(location.pathname))?.label;
  // Título padrão da aba do navegador; as páginas sobrescrevem quando precisam.
  usePageTitle(pageTitle ?? "HNBCRM");

  // Voltar do navegador (ou qualquer troca de rota) fecha a folha "Mais".
  useEffect(() => {
    setShowMore(false);
  }, [location.pathname]);

  const orgs = useQuery(api.organizations.getUserOrganizations);
  const hasManyOrgs = Array.isArray(orgs) && orgs.length > 1;

  // IA é opt-in por organização — sem status "active", o gatilho nem renderiza.
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });

  return (
    <div className="min-h-screen supports-[height:100dvh]:min-h-[100dvh] bg-surface-base">
      {/* Desktop sidebar */}
      <Sidebar
        onSignOut={onSignOut}
        organizationId={organizationId}
        orgName={orgName}
        onOpenOrgSwitcher={onOpenOrgSwitcher}
      />

      {/* Main content area */}
      <main className="md:ml-16 lg:ml-56 transition-all duration-200">
        {/* Header — título da página + troca de org (só mobile; no desktop fica na sidebar) + sino */}
        <header className="sticky top-0 z-30 h-14 md:h-16 flex items-center justify-between md:justify-end gap-3 px-4 md:px-6 backdrop-blur border-b border-border">
          <div className="md:hidden flex items-center gap-1 min-w-0">
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-text-primary leading-tight">{pageTitle}</p>
              {hasManyOrgs && <p className="truncate text-caption text-text-muted">{orgName}</p>}
            </div>
            <button
              type="button"
              onClick={onOpenOrgSwitcher}
              className="shrink-0 inline-flex items-center justify-center gap-1 min-h-[44px] min-w-[44px] px-2 rounded-lg text-text-muted hover:bg-surface-overlay transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
              aria-label={`Organização atual: ${orgName}. Trocar ou criar organização`}
            >
              <Building2 size={18} className="text-brand-500" aria-hidden="true" />
              <ChevronsUpDown size={12} aria-hidden="true" />
            </button>
          </div>
          <NotificationBell organizationId={organizationId} />
        </header>

        <div className="min-h-[calc(100vh-3.5rem)] supports-[height:100dvh]:min-h-[calc(100dvh-3.5rem)] md:min-h-[calc(100vh-4rem)] md:supports-[height:100dvh]:min-h-[calc(100dvh-4rem)] pb-20 md:pb-0">
          <div className="p-4 md:p-6">
            {children}
          </div>
        </div>
      </main>

      {/* Mobile bottom tab bar */}
      <BottomTabBar
        organizationId={organizationId}
        showMore={showMore}
        onToggleMore={() => setShowMore(!showMore)}
        orgName={orgName}
        onOpenOrgSwitcher={onOpenOrgSwitcher}
        onSignOut={onSignOut}
      />

      {/* Gatilho flutuante do Copiloto IA — só aparece se a org ativou a IA e o produto Copiloto */}
      {aiStatus?.active && aiStatus.copilotEnabled && (
        <>
          <CopilotFab onOpen={() => setCopilotOpen(true)} hidden={copilotOpen} />
          <CopilotPanel
            organizationId={organizationId}
            open={copilotOpen}
            onClose={() => setCopilotOpen(false)}
          />
        </>
      )}
    </div>
  );
}
