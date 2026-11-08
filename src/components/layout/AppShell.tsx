import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { useQuery } from "convex/react";
import { Building2, ChevronsUpDown, Sparkles } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { BottomTabBar } from "./BottomTabBar";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { CopilotFab } from "@/components/copilot/CopilotFab";
import { LazyCopilotPanel } from "@/components/copilot/LazyCopilotPanel";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { activeTabForPath } from "@/lib/routes";
import { navItemFor, shellPageTitle } from "@/lib/nav";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useDocumentScrollLock } from "@/hooks/useVisualViewport";
import { cn } from "@/lib/utils";
import { ChatModeProvider, type ChatModeValue } from "./chatMode";
import { PageHeaderProvider, PageHeaderSlot, usePageHeaderRegistry, type PageMenuItem } from "./pageHeader";
import { useCopilotFabPref } from "@/hooks/useCopilotFabPref";
import { detectIsMac, shouldOpenCopilotFromKey } from "@/lib/copilotShortcut";
import { VOCAB } from "@/lib/vocab";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { UiTheme } from "@/lib/theme";

interface AppShellProps {
  onSignOut: () => void;
  organizationId: Id<"organizations">;
  orgName: string;
  onOpenOrgSwitcher: () => void;
  theme: UiTheme;
  setTheme: (theme: UiTheme) => void;
  children: React.ReactNode;
}

export function AppShell({ onSignOut, organizationId, orgName, onOpenOrgSwitcher, theme, setTheme, children }: AppShellProps) {
  const [showMore, setShowMore] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const location = useLocation();
  const pageTitle = navItemFor(activeTabForPath(location.pathname))?.title;
  // Título padrão da aba do navegador. Configurações define o seu ("Configurações · painel"):
  // o efeito deste componente roda depois do da página e o sobrescreveria, então fica de fora.
  usePageTitle(shellPageTitle(location.pathname));

  // Voltar do navegador (ou qualquer troca de rota) fecha a folha "Mais".
  useEffect(() => {
    setShowMore(false);
  }, [location.pathname]);

  const orgs = useQuery(api.organizations.getUserOrganizations);
  const hasManyOrgs = Array.isArray(orgs) && orgs.length > 1;

  // IA é opt-in por organização — sem status "active", o gatilho nem renderiza.
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });
  const copilotEnabled = Boolean(aiStatus?.active && aiStatus.copilotEnabled);

  // Modo conversa (Inbox com conversa aberta): abaixo de `md` some o cabeçalho, as
  // abas e o FAB (tela cheia como o WhatsApp) e o documento para de rolar por trás.
  const [chatModeActive, setChatModeActive] = useState(false);
  // Ações e ⋯ que a página põe no cabeçalho do celular (`usePageHeader`).
  const pageHeader = usePageHeaderRegistry();
  const isMobile = useMediaQuery("(max-width: 767px)");
  useDocumentScrollLock(chatModeActive && isMobile);
  const fabPref = useCopilotFabPref();
  const [isMac] = useState(detectIsMac);
  const openCopilot = useCallback(() => setCopilotOpen(true), []);

  // Cmd+K (Mac) ou Ctrl+K abre o Copiloto em qualquer tela, menos com janela aberta (Modal/SlideOver).
  useEffect(() => {
    if (!copilotEnabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
      if (!shouldOpenCopilotFromKey(e, { modalOpen, enabled: true, isMac })) return;
      e.preventDefault();
      setCopilotOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copilotEnabled, isMac]);

  // ⋯ global do celular: "Copiloto" em toda tela (a página soma os itens dela depois).
  const globalMenuItems = useMemo<PageMenuItem[]>(
    () =>
      copilotEnabled
        ? [{ id: "copilot", label: VOCAB.copilot.name, icon: <Sparkles size={16} aria-hidden="true" />, onSelect: openCopilot }]
        : [],
    [copilotEnabled, openCopilot]
  );

  const chatMode = useMemo<ChatModeValue>(
    () => ({
      active: chatModeActive,
      setActive: setChatModeActive,
      openCopilot: copilotEnabled ? openCopilot : undefined,
    }),
    [chatModeActive, copilotEnabled, openCopilot]
  );

  return (
    <ChatModeProvider value={chatMode}>
    <PageHeaderProvider registry={pageHeader.registry}>
    <div className="min-h-screen supports-[height:100dvh]:min-h-[100dvh] bg-surface-base">
      <InstallPrompt />
      {/* Desktop sidebar */}
      <Sidebar
        onSignOut={onSignOut}
        organizationId={organizationId}
        orgName={orgName}
        onOpenOrgSwitcher={onOpenOrgSwitcher}
        theme={theme}
        setTheme={setTheme}
        onOpenCopilot={copilotEnabled ? openCopilot : undefined}
      />

      {/* Main content area */}
      <main className="md:ml-16 lg:ml-56 transition-all duration-200">
        {/* Header — título da página + troca de org (só mobile; no desktop fica na sidebar) + sino */}
        <header className={cn(
          "sticky top-0 z-30 h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] md:h-16 md:pt-0 items-center justify-between md:justify-end gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:px-6 backdrop-blur border-b border-border",
          chatModeActive ? "hidden md:flex" : "flex"
        )}>
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
          <div className="flex shrink-0 items-center">
            <NotificationBell organizationId={organizationId} />
            {/* Contribuição da página (só celular; no desktop cada tela tem o seu cabeçalho). */}
            <div className="md:hidden flex items-center">
              <PageHeaderSlot registration={pageHeader.registration} globalMenuItems={globalMenuItems} />
            </div>
          </div>
        </header>

        <div className="min-h-[calc(100vh-3.5rem-env(safe-area-inset-top))] supports-[height:100dvh]:min-h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] md:min-h-[calc(100vh-4rem)] md:supports-[height:100dvh]:min-h-[calc(100dvh-4rem)] pb-20 md:pb-0">
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
        theme={theme}
        setTheme={setTheme}
        hidden={chatModeActive}
      />

      {/* Copiloto IA — só se a org ativou a IA e o produto Copiloto. Abre pelo ⋯ (celular), pela
          barra lateral e por Ctrl/Cmd+K (computador); o botão flutuante é opcional (Aparência), por aparelho. */}
      {copilotEnabled && (
        <>
          {/* Conversa aberta: o FAB cobria o enviar/microfone; o Copiloto fica no ⋮ do cabeçalho. */}
          {fabPref && <CopilotFab onOpen={openCopilot} hidden={copilotOpen || chatModeActive} />}
          <LazyCopilotPanel
            organizationId={organizationId}
            open={copilotOpen}
            onClose={() => setCopilotOpen(false)}
          />
        </>
      )}
    </div>
    </PageHeaderProvider>
    </ChatModeProvider>
  );
}
