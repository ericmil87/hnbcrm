import { Suspense, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate, useOutletContext, useSearchParams } from "react-router";
import { AlertTriangle, Lock, SearchX, ShieldAlert } from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchInput } from "@/components/ui/SearchInput";
import { Skeleton } from "@/components/ui/Skeleton";
import { SettingsNavView } from "@/components/settings/SettingsNavView";
import { DEFAULT_SETTINGS_PANEL_ID, SETTINGS_PANELS } from "@/components/settings/registry";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useOrgModules } from "@/hooks/useOrgModules";
import { usePageTitle } from "@/hooks/usePageTitle";
import { usePermissions } from "@/hooks/usePermissions";
import { groupOf, groupSettingsPanels, resolveSettingsPanelState, visibleSettingsPanels } from "@/lib/settingsNav";
import { searchSettingsPanels } from "@/lib/settingsSearch";
import { VOCAB } from "@/lib/vocab";

/** Painel que falhou ao abrir (ex.: pedaço lazy não carregou): só ele quebra, o resto da tela segue. */
function PanelError() {
  return (
    <EmptyState
      icon={AlertTriangle}
      size="sm"
      title="Não foi possível abrir esta seção."
      description="Recarregue a página para tentar de novo."
      // Recarrega a página: um pedaço lazy que falhou fica em cache como erro e só um reload o busca de novo.
      action={{ label: "Tentar de novo", onClick: () => window.location.reload() }}
    />
  );
}

const GENERIC_LABELS: ReadonlySet<string> = new Set(["Visão geral"]);

/** Fallback estático dos painéis lazy (sem spinner piscando). */
function PanelSkeleton() {
  return (
    <Card aria-busy="true">
      <Skeleton className="mb-4 h-6 w-48" />
      <Skeleton className="mb-2 h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </Card>
  );
}

/**
 * Configurações em dois níveis. A URL (`?secao=<painel>`) é o estado: clicar num
 * painel escreve o parâmetro (push). Painéis e grupos vêm de `settings/registry.ts`.
 */
export function Settings() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { can } = usePermissions(organizationId);
  const { modules, isLoading: modulesLoading } = useOrgModules(organizationId);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");

  const visible = useMemo(() => visibleSettingsPanels({ can, modules }), [can, modules]);
  // Param desconhecido: lista (celular) ou `general` (desktop), sem erro.
  const { panel: resolved, denied, requested } = resolveSettingsPanelState(searchParams.get("secao"), visible);
  const active =
    resolved ?? (isMobile ? null : (visible.find((p) => p.id === DEFAULT_SETTINGS_PANEL_ID) ?? visible.find((p) => p.Component) ?? null));

  // Rótulo genérico ("Visão geral") ganha o grupo na frente: "Atendente IA · Visão geral".
  const panelTitle = active && can("settings", "view") ? (GENERIC_LABELS.has(active.label) ? `${groupOf(active).label} · ${active.label}` : active.label) : null;
  usePageTitle(panelTitle ? `${VOCAB.settings.title} · ${panelTitle}` : VOCAB.settings.title);

  if (!can("settings", "view")) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20">
        <ShieldAlert size={48} className="text-text-muted" />
        <p className="text-text-secondary text-sm">Você não tem permissão para acessar as configurações.</p>
      </div>
    );
  }

  // Push: o "voltar" do navegador retorna à lista. Params de outro painel (ex.: `meta`) não acompanham.
  const select = (id: string) => {
    const panel = SETTINGS_PANELS.find((p) => p.id === id);
    if (panel?.href) return navigate(panel.href);
    setSearchParams({ secao: id }, { state: { fromList: true } });
  };
  const goBack = () => {
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1);
    else setSearchParams({}, { replace: true });
  };

  if (active?.href) return <Navigate to={active.href} replace />;

  // Módulos ainda carregando: `central` pareceria invisível e cairia noutro painel por um instante.
  if (modulesLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title={VOCAB.settings.title} />
        <PanelSkeleton />
      </div>
    );
  }

  const Panel = active?.Component;
  const navItems = (panels: typeof visible) => groupSettingsPanels(panels);

  if (isMobile && !active) {
    const found = searchSettingsPanels(visible, query);
    return (
      <div className="space-y-4">
        <PageHeader title={VOCAB.settings.title} />
        <SearchInput value={query} onValueChange={setQuery} placeholder="Buscar nas configurações" ariaLabel="Buscar nas configurações" />
        {found.length === 0 ? (
          <EmptyState icon={SearchX} size="sm" title={VOCAB.settings.empty.title} description={VOCAB.settings.empty.hint} />
        ) : (
          <SettingsNavView groups={navItems(found)} active={null} onSelect={select} variant="list" />
        )}
      </div>
    );
  }

  const body = Panel && (
    <div className="space-y-4">
      {denied && requested && active && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text-secondary">
          <Lock size={14} className="shrink-0" aria-hidden="true" />
          Você não tem permissão para abrir «{requested.label}». Mostrando {active.label}.
        </p>
      )}
      <ErrorBoundary resetKey={active.id} fallback={<PanelError />}>
        <Suspense fallback={<PanelSkeleton />}>
          <Panel key={active.id} organizationId={organizationId} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );

  if (isMobile) {
    return (
      <div className="space-y-4">
        <PageHeader title={panelTitle!} back={{ onClick: goBack }} />
        {body}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={VOCAB.settings.title} />
      <div className="grid grid-cols-[14rem_minmax(0,1fr)] items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <SettingsNavView groups={navItems(visible)} active={active?.id ?? null} onSelect={select} />
        <div className="min-w-0">{body}</div>
      </div>
    </div>
  );
}
