import { useCallback, useMemo, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Ban, Cloud, Copy, Megaphone, MoreHorizontal, Pause, Pencil, Play, Plus, Radio, Trash2, XCircle } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { CampaignWizard } from "@/components/campaigns/CampaignWizard";
import { CampaignDetail } from "@/components/campaigns/CampaignDetail";
import { OptOutsPanel } from "@/components/campaigns/OptOutsPanel";
import type { CampaignListItem, CampaignProvider, CampaignStatus } from "@/components/campaigns/types";
import {
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_VARIANT,
  formatDateTime,
  formatUsd,
} from "@/components/campaigns/campaignUtils";

const STATUS_FILTERS: { id: CampaignStatus | "all" | "active"; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "active", label: "Ativas" },
  { id: "draft", label: "Rascunhos" },
  { id: "paused", label: "Pausadas" },
  { id: "completed", label: "Concluídas" },
  { id: "canceled", label: "Canceladas" },
];

export function CampaignsPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { can, isLoading } = usePermissions(organizationId);
  const canView = can("campaigns", "view");
  const canManage = can("campaigns", "manage");
  const canFull = can("campaigns", "full");

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = (searchParams.get("campanha") as Id<"campaigns"> | null) ?? null;
  const [wizardId, setWizardId] = useState<Id<"campaigns"> | null | "new">(null);
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]["id"]>("all");
  const [providerFilter, setProviderFilter] = useState<CampaignProvider | "all">("all");
  const [confirmDelete, setConfirmDelete] = useState<Id<"campaigns"> | null>(null);
  const [optOutsOpen, setOptOutsOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<Id<"campaigns"> | null>(null);

  const campaigns = useQuery(api.campaigns.listCampaigns, canView ? { organizationId } : "skip") as CampaignListItem[] | undefined;

  const pause = useMutation(api.campaigns.pauseCampaign);
  const resume = useMutation(api.campaigns.resumeCampaign);
  const cancel = useMutation(api.campaigns.cancelCampaign);
  const duplicate = useMutation(api.campaigns.duplicateCampaign);
  const remove = useMutation(api.campaigns.deleteCampaign);

  const openDetail = useCallback(
    (id: Id<"campaigns">) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("campanha", id);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );
  const closeDetail = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("campanha");
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  const filtered = useMemo(() => {
    return (campaigns ?? []).filter((c) => {
      if (providerFilter !== "all" && c.provider !== providerFilter) return false;
      if (statusFilter === "all") return true;
      if (statusFilter === "active") return c.status === "running" || c.status === "scheduled";
      return c.status === statusFilter;
    });
  }, [campaigns, statusFilter, providerFilter]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast.success(label);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Falha na ação"));
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }
  if (!canView) {
    return (
      <div className="p-6">
        <EmptyState icon={Megaphone} title="Sem acesso" description="Você não tem permissão para ver campanhas. Peça a um administrador." />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 mr-auto">
          <Megaphone size={22} className="text-brand-500" />
          <h1 className="text-xl font-semibold text-text-primary">Campanhas</h1>
        </div>
        <Button variant="secondary" onClick={() => setOptOutsOpen(true)}>
          <Ban size={16} /> Supressão
        </Button>
        {canManage && (
          <Button onClick={() => setWizardId("new")}>
            <Plus size={16} /> Nova campanha
          </Button>
        )}
      </div>
      <OptOutsPanel organizationId={organizationId} open={optOutsOpen} onClose={() => setOptOutsOpen(false)} />

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 overflow-x-auto pb-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setStatusFilter(f.id)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap min-h-[36px] transition-colors",
                statusFilter === f.id ? "bg-brand-600 text-white" : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          className="ml-auto h-9 rounded-lg border border-border bg-surface-raised px-2 text-sm text-text-primary"
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value as CampaignProvider | "all")}
          aria-label="Filtrar por canal"
        >
          <option value="all">Todos os canais</option>
          <option value="meta">Cloud API (Meta)</option>
          <option value="bridge">Bridge</option>
        </select>
      </div>

      {campaigns === undefined ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title={campaigns.length === 0 ? "Nenhuma campanha ainda" : "Nada com esse filtro"}
          description={
            campaigns.length === 0
              ? "Dispare mensagens segmentadas ou importe uma lista de números, com limites anti-ban e relatório por destinatário."
              : undefined
          }
          action={canManage && campaigns.length === 0 ? { label: "Criar a primeira", onClick: () => setWizardId("new") } : undefined}
        />
      ) : (
        <>
          {/* Mobile: cards */}
          <ul className="md:hidden space-y-2">
            {filtered.map((c) => (
              <li key={c._id}>
                <button type="button" onClick={() => openDetail(c._id)} className="w-full text-left rounded-card border border-border bg-surface-raised p-3.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-text-primary truncate flex-1">{c.name}</span>
                    <Badge variant={CAMPAIGN_STATUS_VARIANT[c.status]}>{CAMPAIGN_STATUS_LABELS[c.status]}</Badge>
                  </div>
                  <ProgressBar item={c} />
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <ProviderPill provider={c.provider} />
                    <span className="tabular-nums">{c.stats.sent + c.stats.delivered + c.stats.read + c.stats.replied}/{c.stats.total} enviadas</span>
                    <span className="ml-auto">{formatDateTime(c.startedAt ?? c.createdAt)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {/* Desktop: tabela */}
          <div className="hidden md:block rounded-card border border-border bg-surface-raised overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-text-muted border-b border-border">
                  <th className="px-4 py-2.5 font-medium">Campanha</th>
                  <th className="px-3 py-2.5 font-medium">Canal</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium w-48">Progresso</th>
                  <th className="px-3 py-2.5 font-medium text-right">Env.</th>
                  <th className="px-3 py-2.5 font-medium text-right">Entr.</th>
                  <th className="px-3 py-2.5 font-medium text-right">Lidas</th>
                  <th className="px-3 py-2.5 font-medium text-right">Resp.</th>
                  <th className="px-3 py-2.5 font-medium text-right">Falhas</th>
                  <th className="px-3 py-2.5 font-medium text-right">Opt-out</th>
                  <th className="px-3 py-2.5 font-medium text-right">Custo</th>
                  <th className="px-3 py-2.5 font-medium">Quando</th>
                  <th className="px-2 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((c) => {
                  const s = c.stats;
                  const isRunning = c.status === "running" || c.status === "scheduled";
                  return (
                    <tr key={c._id} className="hover:bg-surface-overlay/60 cursor-pointer" onClick={() => openDetail(c._id)}>
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-text-primary truncate max-w-[220px]">{c.name}</p>
                        <p className="text-xs text-text-muted truncate max-w-[220px]">{c.creatorName ?? ""}{c.pausedReason ? ` · ${c.pausedReason}` : ""}</p>
                      </td>
                      <td className="px-3 py-2.5"><ProviderPill provider={c.provider} /></td>
                      <td className="px-3 py-2.5"><Badge variant={CAMPAIGN_STATUS_VARIANT[c.status]}>{CAMPAIGN_STATUS_LABELS[c.status]}</Badge></td>
                      <td className="px-3 py-2.5"><ProgressBar item={c} /></td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-text-primary">{s.sent + s.delivered + s.read + s.replied}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{s.delivered + s.read + s.replied}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{s.read + s.replied}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-brand-400">{s.replied}</td>
                      <td className={cn("px-3 py-2.5 text-right tabular-nums", s.failed > 0 ? "text-semantic-error" : "text-text-secondary")}>{s.failed}</td>
                      <td className={cn("px-3 py-2.5 text-right tabular-nums", s.optedOut > 0 ? "text-semantic-warning" : "text-text-secondary")}>{s.optedOut}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{c.provider === "bridge" ? "—" : formatUsd(s.estimatedCostUsd)}</td>
                      <td className="px-3 py-2.5 text-xs text-text-muted tabular-nums whitespace-nowrap">{formatDateTime(c.startedAt ?? c.scheduledStartAt ?? c.createdAt)}</td>
                      <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setMenuFor(menuFor === c._id ? null : c._id)}
                            className="h-9 w-9 flex items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-surface-overlay"
                            aria-label="Ações"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                          {menuFor === c._id && (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} aria-hidden="true" />
                              <div className="absolute right-0 z-20 mt-1 min-w-[190px] rounded-xl border border-border bg-surface-overlay shadow-elevated p-1">
                                {c.status === "draft" && canManage && (
                                  <MenuItem icon={Pencil} label="Continuar rascunho" onClick={() => { setMenuFor(null); setWizardId(c._id); }} />
                                )}
                                {isRunning && canManage && (
                                  <MenuItem icon={Pause} label="Pausar" onClick={() => { setMenuFor(null); void act("Campanha pausada", () => pause({ campaignId: c._id })); }} />
                                )}
                                {c.status === "paused" && canManage && (
                                  <MenuItem icon={Play} label="Retomar" onClick={() => { setMenuFor(null); void act("Campanha retomada", () => resume({ campaignId: c._id })); }} />
                                )}
                                {canManage && (
                                  <MenuItem icon={Copy} label="Duplicar" onClick={() => { setMenuFor(null); void act("Duplicada como rascunho", async () => { const id = await duplicate({ campaignId: c._id }); setWizardId(id); }); }} />
                                )}
                                {(isRunning || c.status === "paused") && canFull && (
                                  <MenuItem icon={XCircle} label="Cancelar" danger onClick={() => { setMenuFor(null); void act("Campanha cancelada", () => cancel({ campaignId: c._id })); }} />
                                )}
                                {["draft", "canceled", "completed", "failed"].includes(c.status) && canFull && (
                                  <MenuItem icon={Trash2} label="Excluir" danger onClick={() => { setMenuFor(null); setConfirmDelete(c._id); }} />
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {wizardId !== null && (
        <CampaignWizard
          organizationId={organizationId}
          campaignId={wizardId === "new" ? null : wizardId}
          onClose={() => setWizardId(null)}
          onLaunched={(id) => openDetail(id)}
        />
      )}
      {selectedId && wizardId === null && (
        <CampaignDetail
          organizationId={organizationId}
          campaignId={selectedId}
          onClose={closeDetail}
          onEdit={(id) => { closeDetail(); setWizardId(id); }}
          onDuplicated={(id) => { closeDetail(); setWizardId(id); }}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(null);
          if (id) void act("Campanha excluída", () => remove({ campaignId: id }));
        }}
        title="Excluir a campanha?"
        description="Os destinatários e o relatório desta campanha serão apagados. As mensagens já enviadas continuam nas conversas."
        confirmLabel="Excluir"
        variant="danger"
      />
    </div>
  );
}

function ProviderPill({ provider }: { provider: CampaignProvider }) {
  return (
    <Badge variant={provider === "bridge" ? "warning" : "brand"}>
      <span className="inline-flex items-center gap-1">
        {provider === "bridge" ? <Radio size={11} /> : <Cloud size={11} />}
        {provider === "bridge" ? "Bridge" : "Cloud API"}
      </span>
    </Badge>
  );
}

function ProgressBar({ item }: { item: CampaignListItem }) {
  const s = item.stats;
  const done = s.total > 0 ? ((s.total - s.pending - s.queued) / s.total) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-surface-sunken rounded-full h-1.5 overflow-hidden">
        <div className="h-1.5 rounded-full bg-brand-600" style={{ width: `${Math.min(100, Math.max(done, s.total > 0 ? 1 : 0))}%` }} />
      </div>
      <span className="text-[11px] text-text-muted tabular-nums w-9 text-right">{Math.round(done)}%</span>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: React.ElementType; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm min-h-[40px] text-left",
        danger ? "text-semantic-error hover:bg-semantic-error/10" : "text-text-primary hover:bg-surface-raised"
      )}
    >
      <Icon size={14} /> {label}
    </button>
  );
}
