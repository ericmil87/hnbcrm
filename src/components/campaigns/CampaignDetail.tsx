import { useState } from "react";
import { useMutation, usePaginatedQuery, useQuery, type PaginatedQueryReference } from "convex/react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  Copy,
  Download,
  ExternalLink,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Search,
  Target,
  XCircle,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { usePermissions } from "@/hooks/usePermissions";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { TAB_ROUTES } from "@/lib/routes";
import type { CampaignDoc, CampaignRecipient, CampaignReport, RecipientStatus } from "./types";
import {
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_VARIANT,
  ERROR_CODE_LABELS,
  PROVIDER_LABELS,
  RECIPIENT_STATUS_LABELS,
  RECIPIENT_STATUS_ORDER,
  RECIPIENT_STATUS_VARIANT,
  SKIP_REASON_LABELS,
  TIMELINE_LABELS,
  downloadTextFile,
  formatDateTime,
  formatPercent,
  formatPhone,
  formatUsd,
  pacingSummary,
  scheduleSummary,
  slugify,
  toCsv,
} from "./campaignUtils";

interface CampaignDetailProps {
  organizationId: Id<"organizations">;
  campaignId: Id<"campaigns">;
  onClose: () => void;
  onEdit: (campaignId: Id<"campaigns">) => void;
  onDuplicated: (campaignId: Id<"campaigns">) => void;
}

export function CampaignDetail({ organizationId, campaignId, onClose, onEdit, onDuplicated }: CampaignDetailProps) {
  const navigate = useNavigate();
  const { can } = usePermissions(organizationId);
  const canManage = can("campaigns", "manage");
  const canFull = can("campaigns", "full");

  const campaign = useQuery(api.campaigns.getCampaign, { campaignId }) as CampaignDoc | null | undefined;
  const report = useQuery(api.campaigns.getCampaignReport, { campaignId }) as CampaignReport | undefined;

  const pause = useMutation(api.campaigns.pauseCampaign);
  const resume = useMutation(api.campaigns.resumeCampaign);
  const cancel = useMutation(api.campaigns.cancelCampaign);
  const duplicate = useMutation(api.campaigns.duplicateCampaign);
  const retryFailed = useMutation(api.campaigns.retryFailed);

  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Falha na ação"));
    } finally {
      setBusy(false);
    }
  };

  if (campaign === undefined || report === undefined) {
    return (
      <SlideOver open onClose={onClose} title="Campanha" className="md:w-[720px] lg:w-[980px]">
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      </SlideOver>
    );
  }
  if (campaign === null) {
    return (
      <SlideOver open onClose={onClose} title="Campanha" className="md:w-[720px]">
        <p className="p-6 text-sm text-text-muted">Campanha não encontrada.</p>
      </SlideOver>
    );
  }

  const s = report.stats;
  const isRunning = campaign.status === "running" || campaign.status === "scheduled";
  const isPaused = campaign.status === "paused";
  const canEditDraft = campaign.status === "draft" && canManage;

  return (
    <SlideOver
      open
      onClose={onClose}
      title={campaign.name}
      className="md:w-[720px] lg:w-[980px]"
      headerActions={<Badge variant={CAMPAIGN_STATUS_VARIANT[campaign.status]}>{CAMPAIGN_STATUS_LABELS[campaign.status]}</Badge>}
    >
      <div className="px-4 md:px-6 py-4 space-y-5">
        {/* Ações */}
        <div className="flex items-center gap-2 flex-wrap">
          {canEditDraft && (
            <Button size="sm" onClick={() => onEdit(campaign._id)}>
              <Pencil size={14} /> Continuar rascunho
            </Button>
          )}
          {isRunning && canManage && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run("Campanha pausada", () => pause({ campaignId }))}>
              <Pause size={14} /> Pausar
            </Button>
          )}
          {isPaused && canManage && (
            <Button size="sm" disabled={busy} onClick={() => void run("Campanha retomada", () => resume({ campaignId }))}>
              <Play size={14} /> Retomar
            </Button>
          )}
          {(isRunning || isPaused) && canFull && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmCancel(true)} className="text-semantic-error">
              <XCircle size={14} /> Cancelar
            </Button>
          )}
          {(campaign.status === "completed" || campaign.status === "paused" || campaign.status === "canceled") && canManage && s.failed + s.skipped > 0 && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run("Falhas reenfileiradas", async () => {
                  const r = await retryFailed({ campaignId });
                  if (r.requeued === 0) throw new Error("Nenhuma falha elegível para reenvio agora");
                })
              }
            >
              <RotateCcw size={14} /> Reenviar falhas elegíveis
            </Button>
          )}
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run("Campanha duplicada como rascunho", async () => {
                  const id = await duplicate({ campaignId });
                  onDuplicated(id);
                })
              }
            >
              <Copy size={14} /> Duplicar
            </Button>
          )}
        </div>

        {/* Motivo da pausa */}
        {campaign.pausedReason && (
          <div className="flex items-start gap-2.5 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3.5">
            <AlertTriangle size={18} className="shrink-0 text-semantic-warning mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary">Pausada automaticamente</p>
              <p className="text-sm text-text-secondary">{campaign.pausedReason}</p>
            </div>
            {isPaused && canManage && (
              <Button size="sm" onClick={() => void run("Campanha retomada", () => resume({ campaignId }))} disabled={busy}>
                Retomar
              </Button>
            )}
          </div>
        )}
        {campaign.lastError && !campaign.pausedReason && (
          <p className="text-sm text-semantic-error">{campaign.lastError}</p>
        )}

        {/* Progresso */}
        <div>
          <div className="flex items-center justify-between text-xs text-text-muted mb-1">
            <span>
              {(s.total - s.pending - s.queued).toLocaleString("pt-BR")} de {s.total.toLocaleString("pt-BR")} processados
            </span>
            <span className="tabular-nums">{formatPercent(report.progress)}</span>
          </div>
          <div className="w-full bg-surface-sunken rounded-full h-2 overflow-hidden">
            <div className="h-2 rounded-full bg-brand-600 transition-all duration-300" style={{ width: `${Math.max(report.progress, 1)}%` }} />
          </div>
        </div>

        {/* Tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Tile label="Enviadas" value={report.dispatched} />
          <Tile label="Entregues" value={s.delivered + s.read + s.replied} sub={formatPercent(report.rates.delivered)} tone="success" />
          <Tile label="Lidas" value={s.read + s.replied} sub={formatPercent(report.rates.read)} tone="success" />
          <Tile label="Responderam" value={s.replied} sub={formatPercent(report.rates.replied)} tone="brand" />
          <Tile label="Falhas" value={s.failed} sub={formatPercent(report.rates.failed)} tone={s.failed > 0 ? "error" : undefined} />
          <Tile label="Opt-out" value={s.optedOut} sub={formatPercent(report.rates.optedOut)} tone={s.optedOut > 0 ? "warning" : undefined} />
          <Tile label="Pulados" value={s.skipped} tone={s.skipped > 0 ? "warning" : undefined} />
          <Tile label="Custo" value={campaign.provider === "bridge" ? "—" : formatUsd(report.estimatedCostUsd)} />
        </div>
        {(s.optedOut > 0 || s.failed > 0) && (
          <p className="text-xs text-text-muted">
            Opt-out e bloqueio são os indicadores que antecedem uma restrição do número — se subirem, pause e revise a lista antes de continuar.
          </p>
        )}

        {/* Quebras */}
        {(Object.keys(report.errorBreakdown).length > 0 || Object.keys(report.skipBreakdown).length > 0) && (
          <div className="grid gap-3 md:grid-cols-2">
            {Object.keys(report.errorBreakdown).length > 0 && (
              <Breakdown title="Falhas por motivo" entries={report.errorBreakdown} labels={ERROR_CODE_LABELS} />
            )}
            {Object.keys(report.skipBreakdown).length > 0 && (
              <Breakdown title="Pulados por motivo" entries={report.skipBreakdown} labels={SKIP_REASON_LABELS} />
            )}
          </div>
        )}

        {/* Config */}
        <div className="rounded-lg border border-border bg-surface-sunken p-4 text-sm space-y-1.5">
          <Row label="Canal" value={`${campaign.channel?.displayName ?? "—"} · ${PROVIDER_LABELS[campaign.provider]}`} />
          <Row label="Público" value={campaign.audience.source === "segment" ? "Segmento" : campaign.audience.source === "import" ? "Importado" : "Manual"} />
          <Row label="Mensagem" value={campaign.content.kind === "template" ? `Template «${campaign.content.template?.name}»` : `${campaign.content.variants.length} variante(s)`} />
          <Row label="Limites" value={`${pacingSummary(campaign.pacing)}${campaign.safeMode ? " · modo seguro" : " · OVERRIDE"}`} />
          <Row label="Janela" value={scheduleSummary(campaign.schedule)} />
          {campaign.tierAtLaunch && <Row label="Tier no lançamento" value={campaign.tierAtLaunch} />}
          {campaign.targetBoardName && <Row label="Leads novos em" value={`${campaign.targetBoardName}${campaign.targetStageName ? ` → ${campaign.targetStageName}` : ""}`} />}
          <Row label="Criada por" value={`${campaign.creatorName ?? "—"} em ${formatDateTime(campaign.createdAt)}`} />
          {campaign.startedAt && <Row label="Lançada" value={formatDateTime(campaign.startedAt)} />}
          {campaign.completedAt && <Row label="Concluída" value={formatDateTime(campaign.completedAt)} />}
        </div>

        {/* Timeline */}
        {report.timeline.length > 0 && (
          <div>
            <p className="text-sm font-medium text-text-primary mb-2">Linha do tempo</p>
            <ol className="space-y-1.5 border-l border-border pl-3">
              {[...report.timeline].reverse().map((t, i) => (
                <li key={`${t.at}-${i}`} className="text-xs">
                  <span className="text-text-muted tabular-nums">{formatDateTime(t.at)}</span>{" "}
                  <span className="text-text-primary">{TIMELINE_LABELS[t.kind] ?? t.kind}</span>
                  {t.detail && <span className="text-text-secondary"> — {t.detail}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}

        <RecipientsTable campaignId={campaignId} campaignName={campaign.name} onOpenConversation={(id) => navigate(`${TAB_ROUTES.inbox}?conversation=${id}`)} onOpenLead={(id) => navigate(`${TAB_ROUTES.board}?lead=${id}`)} />
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          void run("Campanha cancelada", () => cancel({ campaignId }));
        }}
        title="Cancelar a campanha?"
        description="Os destinatários que ainda não receberam ficam como pulados. Mensagens já enviadas não são desfeitas."
        confirmLabel="Cancelar campanha"
        variant="danger"
      />
    </SlideOver>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: number | string; sub?: string; tone?: "success" | "error" | "warning" | "brand" }) {
  return (
    <div className="rounded-lg bg-surface-raised border border-border px-3 py-2">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "success" && "text-semantic-success",
          tone === "error" && "text-semantic-error",
          tone === "warning" && "text-semantic-warning",
          tone === "brand" && "text-brand-400",
          !tone && "text-text-primary"
        )}
      >
        {typeof value === "number" ? value.toLocaleString("pt-BR") : value}
      </p>
      {sub && <p className="text-[11px] text-text-muted tabular-nums">{sub}</p>}
    </div>
  );
}

function Breakdown({ title, entries, labels }: { title: string; entries: Record<string, number>; labels: Record<string, string> }) {
  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-3">
      <p className="text-xs font-medium text-text-muted mb-1.5">{title}</p>
      <ul className="space-y-1 text-xs">
        {Object.entries(entries)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => (
            <li key={k} className="flex justify-between gap-2">
              <span className="text-text-primary truncate">{labels[k] ?? k}</span>
              <span className="text-text-muted tabular-nums">{n}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-32 shrink-0 text-text-muted">{label}</span>
      <span className="text-text-primary min-w-0 break-words">{value}</span>
    </div>
  );
}

// ── Tabela de destinatários ──

function RecipientsTable({
  campaignId,
  campaignName,
  onOpenConversation,
  onOpenLead,
}: {
  campaignId: Id<"campaigns">;
  campaignName: string;
  onOpenConversation: (id: Id<"conversations">) => void;
  onOpenLead: (id: Id<"leads">) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | "">("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const listRef = api.campaigns.getCampaignRecipients as unknown as PaginatedQueryReference;
  const { results, status, loadMore } = usePaginatedQuery(
    listRef,
    { campaignId, ...(statusFilter ? { status: statusFilter } : {}), ...(search ? { search } : {}) },
    { initialNumItems: 30 }
  );
  const rows = (results ?? []) as CampaignRecipient[];
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      // Carrega até 5000 linhas em páginas antes de montar o CSV
      let guard = 0;
      while (status === "CanLoadMore" && rows.length < 5000 && guard < 50) {
        loadMore(500);
        guard++;
        await new Promise((r) => setTimeout(r, 150));
      }
      const columns = ["telefone", "nome", "status", "enviada", "entregue", "lida", "respondeu", "erro", "motivo"];
      const csv = toCsv(
        rows.map((r) => ({
          telefone: `+${r.phone}`,
          nome: r.displayName ?? r.vars?.nome ?? "",
          status: RECIPIENT_STATUS_LABELS[r.status],
          enviada: r.sentAt ? formatDateTime(r.sentAt) : "",
          entregue: r.deliveredAt ? formatDateTime(r.deliveredAt) : "",
          lida: r.readAt ? formatDateTime(r.readAt) : "",
          respondeu: r.repliedAt ? formatDateTime(r.repliedAt) : "",
          erro: r.errorCode ? String(r.errorCode) : "",
          motivo: r.lastError ?? (r.skipReason ? SKIP_REASON_LABELS[r.skipReason] ?? r.skipReason : ""),
        })),
        columns
      );
      downloadTextFile(`campanha-${slugify(campaignName)}-destinatarios.csv`, csv);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface-sunken">
      <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 border-b border-border">
        <p className="text-sm font-medium text-text-primary mr-auto">Destinatários</p>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setSearch(searchInput.trim());
            }}
            onBlur={() => setSearch(searchInput.trim())}
            placeholder="telefone ou nome"
            className="h-9 w-40 md:w-52 rounded-lg border border-border bg-surface-raised pl-8 pr-2 text-sm text-text-primary"
            aria-label="Buscar destinatário"
          />
        </div>
        <select
          className="h-9 rounded-lg border border-border bg-surface-raised px-2 text-sm text-text-primary"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as RecipientStatus | "")}
          aria-label="Filtrar por status"
        >
          <option value="">Todos</option>
          {RECIPIENT_STATUS_ORDER.map((st) => (
            <option key={st} value={st}>
              {RECIPIENT_STATUS_LABELS[st]}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => void exportCsv()} disabled={exporting || rows.length === 0}>
          {exporting ? <Spinner size="sm" /> : <Download size={14} />} CSV
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-text-muted text-center">{status === "LoadingFirstPage" ? "Carregando…" : "Nenhum destinatário."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-text-muted">
                <th className="px-3 py-2 font-medium">Destinatário</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium hidden md:table-cell">Enviada</th>
                <th className="px-3 py-2 font-medium hidden lg:table-cell">Detalhe</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r._id}>
                  <td className="px-3 py-2">
                    <p className="text-text-primary truncate max-w-[180px]">{r.displayName ?? r.vars?.nome ?? "Sem nome"}</p>
                    <p className="text-xs text-text-muted tabular-nums">{formatPhone(r.phone)}</p>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={RECIPIENT_STATUS_VARIANT[r.status]}>{RECIPIENT_STATUS_LABELS[r.status]}</Badge>
                    {r.isNewContact && <span className="ml-1 text-[10px] text-text-muted">novo</span>}
                  </td>
                  <td className="px-3 py-2 hidden md:table-cell text-xs text-text-muted tabular-nums">{formatDateTime(r.sentAt)}</td>
                  <td className="px-3 py-2 hidden lg:table-cell text-xs text-text-secondary max-w-[260px] truncate">
                    {r.lastError ?? (r.skipReason ? SKIP_REASON_LABELS[r.skipReason] ?? r.skipReason : r.errorCode ? ERROR_CODE_LABELS[String(r.errorCode)] ?? r.errorCode : "")}
                    {r.status === "pending" && r.scheduledFor && r.scheduledFor > Date.now() ? ` · retry ${formatDateTime(r.scheduledFor)}` : ""}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1 justify-end">
                      {r.conversationId && (
                        <button
                          type="button"
                          onClick={() => onOpenConversation(r.conversationId!)}
                          className="h-9 w-9 flex items-center justify-center rounded-full text-text-muted hover:text-brand-400 hover:bg-surface-overlay"
                          aria-label="Abrir conversa"
                          title="Abrir conversa"
                        >
                          <ExternalLink size={14} />
                        </button>
                      )}
                      {r.leadId && (
                        <button
                          type="button"
                          onClick={() => onOpenLead(r.leadId!)}
                          className="h-9 w-9 flex items-center justify-center rounded-full text-text-muted hover:text-brand-400 hover:bg-surface-overlay"
                          aria-label="Abrir lead"
                          title="Abrir lead"
                        >
                          <Target size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {status === "CanLoadMore" && (
        <div className="px-3 py-2 border-t border-border">
          <Button variant="ghost" size="sm" onClick={() => loadMore(50)}>
            Carregar mais
          </Button>
        </div>
      )}
    </div>
  );
}
