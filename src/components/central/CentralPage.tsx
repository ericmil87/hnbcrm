import { useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router";
import { useQuery } from "convex/react";
import { AlertTriangle, BarChart3, LayoutDashboard, ShieldAlert } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { useOrgModules } from "@/hooks/useOrgModules";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { TAB_ROUTES } from "@/lib/routes";
import type { CentralDashboard } from "./CentralKpi";
import { OverviewTab } from "./OverviewTab";
import { UnitsTab } from "./UnitsTab";
import { MarketingTab } from "./MarketingTab";
import { ServiceTab } from "./ServiceTab";
import { formatFullDate, lastNDays, localDateString } from "./centralFormat";

type CentralTab = "geral" | "hoteis" | "marketing" | "atendimento";
type PeriodPreset = "7" | "30" | "90" | "custom";

const PRESETS: Array<{ id: PeriodPreset; label: string }> = [
  { id: "7", label: "7 dias" },
  { id: "30", label: "30 dias" },
  { id: "90", label: "90 dias" },
  { id: "custom", label: "Intervalo" },
];

const selectClass =
  "min-h-[44px] w-full sm:w-auto bg-surface-raised border border-border-strong text-text-primary rounded-field px-3 py-2 text-base md:text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20";

export function CentralPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();
  const { can, isLoading: permsLoading } = usePermissions(organizationId);
  const { modules, isLoading: modulesLoading } = useOrgModules(organizationId);
  const [searchParams, setSearchParams] = useSearchParams();

  const today = useMemo(() => localDateString(new Date()), []);
  const [preset, setPreset] = useState<PeriodPreset>("30");
  const [customFrom, setCustomFrom] = useState(() => lastNDays(30, today).from);
  const [customTo, setCustomTo] = useState(today);
  const [unitId, setUnitId] = useState<Id<"units"> | "">("");

  const tabs: Array<{ id: CentralTab; label: string }> = [
    { id: "geral", label: "Visão geral" },
    ...(modules.units ? [{ id: "hoteis" as const, label: "Por hotel" }] : []),
    { id: "marketing", label: "Marketing" },
    { id: "atendimento", label: "Atendimento" },
  ];
  const tabParam = searchParams.get("aba");
  const activeTab: CentralTab = tabs.some((t) => t.id === tabParam) ? (tabParam as CentralTab) : "geral";
  const setTab = (id: CentralTab) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id === "geral") next.delete("aba");
        else next.set("aba", id);
        return next;
      },
      { replace: true }
    );
  };

  const range =
    preset === "custom"
      ? customFrom && customTo && customFrom <= customTo
        ? { from: customFrom, to: customTo }
        : null
      : lastNDays(Number(preset), today);

  const canView = can("reports", "view");
  const enabled = modules.central && canView;
  const units = useQuery(api.units.listUnits, enabled && modules.units ? { organizationId } : "skip");
  const live = useQuery(
    api.centralAnalytics.getCentralDashboard,
    enabled && range
      ? { organizationId, fromDate: range.from, toDate: range.to, ...(unitId ? { unitId } : {}) }
      : "skip"
  );
  // Troca de período/unidade: mantém o último painel na tela (esmaecido) em
  // vez de piscar o esqueleto.
  const lastRef = useRef<{ orgId: string; data: CentralDashboard } | null>(null);
  if (live) lastRef.current = { orgId: organizationId, data: live };
  const data = live ?? (lastRef.current?.orgId === organizationId ? lastRef.current.data : null);
  const refreshing = live === undefined && data !== null;

  if (permsLoading || modulesLoading) return <PageSkeleton />;

  if (!modules.central) {
    return (
      <EmptyState
        icon={LayoutDashboard}
        title="Painel da Central desligado"
        description="O Painel da Central é um módulo opcional. Um administrador pode ligá-lo em Configurações → Central."
        action={
          can("settings", "manage")
            ? { label: "Abrir Configurações", onClick: () => navigate(`${TAB_ROUTES.settings}?secao=central`) }
            : undefined
        }
      />
    );
  }
  if (!canView) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20">
        <ShieldAlert size={48} className="text-text-muted" />
        <p className="text-sm text-text-secondary">Você não tem permissão para ver relatórios.</p>
      </div>
    );
  }

  const hasActivity = data ? data.totals.conversations + data.totals.leads + data.totals.converted + data.totals.spend > 0 : false;
  const unitList = units ?? [];

  return (
    <div className="w-full max-w-[1920px] space-y-4 md:space-y-6">
      {/* Cabeçalho */}
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl md:text-3xl font-bold text-text-primary">Painel da Central</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-semantic-success/10 px-2.5 py-0.5 text-xs font-medium text-semantic-success">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-semantic-success opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-semantic-success" />
            </span>
            Ao vivo
          </span>
        </div>
        <p className="text-sm text-text-secondary">
          Preenchido sozinho a cada conversa
          {data ? (
            <>
              {" · "}
              <span className="tabular-nums">
                {formatFullDate(data.period.from)} a {formatFullDate(data.period.to)}
              </span>
            </>
          ) : null}
        </p>
      </header>

      {/* Filtros */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex rounded-full bg-surface-raised border border-border p-0.5" role="group" aria-label="Período">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                aria-pressed={preset === p.id}
                className={cn(
                  "min-h-[40px] flex-1 sm:flex-none rounded-full px-3.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                  preset === p.id ? "bg-brand-600 text-white" : "text-text-secondary hover:text-text-primary"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === "custom" && (
            <div className="flex items-center gap-2">
              <label className="sr-only" htmlFor="central-from">Início</label>
              <input
                id="central-from"
                type="date"
                value={customFrom}
                max={customTo || today}
                onChange={(e) => setCustomFrom(e.target.value)}
                className={cn(selectClass, "flex-1 sm:w-auto")}
              />
              <span className="text-sm text-text-muted">a</span>
              <label className="sr-only" htmlFor="central-to">Fim</label>
              <input
                id="central-to"
                type="date"
                value={customTo}
                min={customFrom}
                max={today}
                onChange={(e) => setCustomTo(e.target.value)}
                className={cn(selectClass, "flex-1 sm:w-auto")}
              />
            </div>
          )}
        </div>
        {modules.units && unitList.length > 0 && (
          <div>
            <label className="sr-only" htmlFor="central-unit">Unidade</label>
            <select
              id="central-unit"
              value={unitId}
              onChange={(e) => setUnitId(e.target.value as Id<"units"> | "")}
              className={selectClass}
            >
              <option value="">Todas as unidades</option>
              {unitList.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name}
                  {u.status === "onboarding" ? " (em implantação)" : u.status === "inactive" ? " (inativa)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Abas */}
      <nav className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Seções do painel">
        <div className="flex gap-1 border-b border-border min-w-max">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setTab(tab.id)}
              aria-current={activeTab === tab.id ? "page" : undefined}
              className={cn(
                "relative min-h-[44px] px-4 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded-t",
                activeTab === tab.id ? "text-text-primary" : "text-text-muted hover:text-text-secondary"
              )}
            >
              {tab.label}
              {/* Indicador sem transição: some/aparece no mesmo render do conteúdo */}
              {activeTab === tab.id && (
                <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-brand-500" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      </nav>

      {preset === "custom" && !range && (
        <p className="text-sm text-semantic-warning">Escolha um início anterior ou igual ao fim.</p>
      )}

      {data?.truncated && (
        <div className="flex items-start gap-2 rounded-card border border-semantic-warning/30 bg-semantic-warning/10 p-3 text-sm text-text-secondary">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden="true" />
          <p>Muito movimento neste período — os números abaixo são parciais. Escolha um período menor para ver tudo.</p>
        </div>
      )}

      {!data ? (
        <PageSkeleton bodyOnly />
      ) : !hasActivity ? (
        <EmptyState
          icon={BarChart3}
          title="Sem movimento neste período"
          description="Assim que chegarem conversas no WhatsApp, o painel se preenche sozinho. Tente um período maior ou outra unidade."
        />
      ) : (
        <div className={cn("w-full transition-opacity", refreshing && "opacity-60")} aria-busy={refreshing}>
          {activeTab === "geral" && <OverviewTab data={data} />}
          {activeTab === "hoteis" && <UnitsTab data={data} units={unitList} showSpend={modules.attribution} />}
          {activeTab === "marketing" && <MarketingTab data={data} showSpend={modules.attribution} />}
          {activeTab === "atendimento" && <ServiceTab data={data} showDepartments={modules.departments} />}
        </div>
      )}
    </div>
  );
}

function PageSkeleton({ bodyOnly }: { bodyOnly?: boolean }) {
  return (
    <div className="w-full max-w-[1920px] space-y-6" aria-label="Carregando painel">
      {!bodyOnly && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} variant="card" className="h-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton variant="card" className="h-72" />
        <Skeleton variant="card" className="h-72" />
      </div>
    </div>
  );
}
