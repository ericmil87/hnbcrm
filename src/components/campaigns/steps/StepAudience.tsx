import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, usePaginatedQuery, useQuery, type PaginatedQueryReference } from "convex/react";
import { toast } from "sonner";
import { AlertTriangle, FileSpreadsheet, Filter, ListPlus, MessagesSquare, Trash2, UserRoundSearch, Users } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import type {
  AudiencePreview,
  AudienceSource,
  CampaignRecipient,
  ImportDryRunHeaders,
  ImportDryRunSummary,
  ImportMapping,
} from "../types";
import { RECIPIENT_STATUS_LABELS, formatPhone, xlsxFileToCsv } from "../campaignUtils";
import type { WizardDraft } from "../wizardState";
import { GroupsTab, GroupMembersTab, useMonitoredGroups } from "./GroupAudienceTabs";

interface StepAudienceProps {
  organizationId: Id<"organizations">;
  campaignId: Id<"campaigns"> | null;
  draft: WizardDraft;
  setDraft: (updater: (prev: WizardDraft) => WizardDraft) => void;
  isDraft: boolean; // status === "draft"
  now: number;
  onRecipientsChanged?: () => void;
}

const SOURCE_TABS: { id: AudienceSource; label: string; icon: React.ElementType; hint: string }[] = [
  { id: "segment", label: "Segmento", icon: Filter, hint: "Leads que já estão no CRM" },
  { id: "import", label: "Importar", icon: FileSpreadsheet, hint: "CSV ou XLSX com novos números" },
  { id: "manual", label: "Manual", icon: ListPlus, hint: "Colar números" },
];

/** Só aparecem quando o canal é bridge E tem grupo acompanhado (v0.57 / F5). */
const GROUP_SOURCE_TABS: { id: AudienceSource; label: string; icon: React.ElementType; hint: string }[] = [
  { id: "groups", label: "Grupos", icon: MessagesSquare, hint: "Postar nas salas monitoradas" },
  { id: "group_members", label: "Membros de grupos", icon: UserRoundSearch, hint: "Privado, 1 a 1, para os participantes" },
];

const EXCLUSION_LABELS: Record<string, string> = {
  no_contact: "sem contato",
  no_phone: "sem telefone",
  invalid_phone: "telefone inválido",
  duplicate_phone: "telefone repetido",
  opted_out: "em supressão (opt-out)",
  window_closed: "janela de 24h fechada",
  campaigned_recently: "receberam campanha há pouco",
  replied_before: "já responderam a campanha",
};

const selectClass =
  "w-full h-10 rounded-lg border border-border bg-surface-raised px-3 text-base md:text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-500";

export function StepAudience({ organizationId, campaignId, draft, setDraft, isDraft, now, onRecipientsChanged }: StepAudienceProps) {
  const source = draft.audience.source;
  // Grupos existem só no bridge, e só fazem sentido se houver sala acompanhada.
  const monitoredGroups = useMonitoredGroups(
    organizationId,
    draft.provider === "bridge" ? draft.channelConfigId : null
  );
  const groupsAvailable = (monitoredGroups?.length ?? 0) > 0;
  // Um rascunho salvo num público de grupo mantém os cartões visíveis mesmo se
  // a lista ainda não carregou — senão a aba sumiria ao reabrir a campanha.
  const showGroupTabs = groupsAvailable || source === "groups" || source === "group_members";
  const tabs = showGroupTabs ? [...SOURCE_TABS, ...GROUP_SOURCE_TABS] : SOURCE_TABS;
  return (
    <div className="space-y-6">
      <div className={cn("grid gap-2", showGroupTabs ? "grid-cols-2 sm:grid-cols-5" : "grid-cols-3")}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = source === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              disabled={!isDraft}
              onClick={() => setDraft((d) => ({ ...d, audience: { ...d.audience, source: tab.id } }))}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors min-h-[44px]",
                active ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface-sunken hover:bg-surface-overlay",
                !isDraft && "opacity-60 cursor-not-allowed"
              )}
              aria-pressed={active}
            >
              <div className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                <Icon size={15} />
                {tab.label}
              </div>
              <p className="text-[11px] text-text-muted mt-0.5 hidden sm:block">{tab.hint}</p>
            </button>
          );
        })}
      </div>

      {source === "segment" && <SegmentTab organizationId={organizationId} draft={draft} setDraft={setDraft} now={now} />}
      {source === "import" && (
        <ImportTab campaignId={campaignId} isDraft={isDraft} onImported={onRecipientsChanged} />
      )}
      {source === "manual" && <ManualTab campaignId={campaignId} isDraft={isDraft} onAdded={onRecipientsChanged} />}
      {source === "groups" && (
        <GroupsTab organizationId={organizationId} draft={draft} setDraft={setDraft} isDraft={isDraft} now={now} />
      )}
      {source === "group_members" && (
        <GroupMembersTab organizationId={organizationId} draft={draft} setDraft={setDraft} isDraft={isDraft} now={now} />
      )}

      {(source === "import" || source === "manual") && campaignId && (
        <RecipientsList campaignId={campaignId} isDraft={isDraft} onChanged={onRecipientsChanged} />
      )}

      {/* Onde o lead nasce — no público "grupos" ninguém vira lead (D1/D3). */}
      {source !== "groups" && (
        <TargetSection organizationId={organizationId} draft={draft} setDraft={setDraft} disabled={!isDraft} />
      )}
    </div>
  );
}

// ── Segmento ──

function SegmentTab({
  organizationId,
  draft,
  setDraft,
  now,
}: {
  organizationId: Id<"organizations">;
  draft: WizardDraft;
  setDraft: StepAudienceProps["setDraft"];
  now: number;
}) {
  const filters = draft.audience.filters;
  const boards = useQuery(api.boards.getBoards, { organizationId }) as { _id: Id<"boards">; name: string }[] | undefined;
  const stages = useQuery(api.boards.getStages, filters.boardId ? { boardId: filters.boardId } : "skip") as
    | { _id: Id<"stages">; name: string; color?: string }[]
    | undefined;
  const members = useQuery(api.teamMembers.getTeamMembers, { organizationId }) as
    | { _id: Id<"teamMembers">; name: string; type?: string }[]
    | undefined;

  // Debounce dos filtros antes de bater no servidor
  const [debounced, setDebounced] = useState(filters);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(filters), 400);
    return () => clearTimeout(t);
  }, [filters]);
  const cleanFilters = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(debounced)) {
      if (v === undefined || v === "" || v === null || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = v;
    }
    return out;
  }, [debounced]);
  const preview = useQuery(api.campaigns.previewAudience, { organizationId, filters: cleanFilters, now }) as
    | AudiencePreview
    | undefined;

  const update = (patch: Partial<typeof filters>) =>
    setDraft((d) => ({ ...d, audience: { ...d.audience, filters: { ...d.audience.filters, ...patch } } }));

  const [tagsText, setTagsText] = useState((filters.tags ?? []).join(", "));
  const toggleStage = (id: Id<"stages">) => {
    const current = filters.stageIds ?? [];
    update({ stageIds: current.includes(id) ? current.filter((s) => s !== id) : [...current, id] });
  };

  const toDateInput = (ts?: number) => (ts ? new Date(ts).toISOString().slice(0, 10) : "");
  const fromDateInput = (value: string, endOfDay: boolean) => {
    if (!value) return undefined;
    const d = new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}`);
    return Number.isNaN(d.getTime()) ? undefined : d.getTime();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="block text-[13px] font-medium text-text-secondary mb-1.5">Funil</span>
            <select
              className={selectClass}
              value={filters.boardId ?? ""}
              onChange={(e) =>
                update({ boardId: (e.target.value || undefined) as Id<"boards"> | undefined, stageIds: [] })
              }
            >
              <option value="">Todos os funis</option>
              {(boards ?? []).map((b) => (
                <option key={b._id} value={b._id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[13px] font-medium text-text-secondary mb-1.5">Responsável</span>
            <select
              className={selectClass}
              value={filters.assignedTo ?? ""}
              onChange={(e) => update({ assignedTo: (e.target.value || undefined) as Id<"teamMembers"> | undefined })}
            >
              <option value="">Qualquer um</option>
              {(members ?? []).map((m) => (
                <option key={m._id} value={m._id}>
                  {m.name}
                  {m.type === "ai" ? " (IA)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {filters.boardId && stages && stages.length > 0 && (
          <div>
            <span className="block text-[13px] font-medium text-text-secondary mb-1.5">Estágios</span>
            <div className="flex flex-wrap gap-1.5">
              {stages.map((s) => {
                const active = (filters.stageIds ?? []).includes(s._id);
                return (
                  <button
                    key={s._id}
                    type="button"
                    onClick={() => toggleStage(s._id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors min-h-[36px]",
                      active ? "border-brand-500 bg-brand-500/10 text-brand-400" : "border-border text-text-secondary hover:bg-surface-overlay"
                    )}
                    aria-pressed={active}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color ?? "#71717A" }} />
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-3">
          <label className="block">
            <span className="block text-[13px] font-medium text-text-secondary mb-1.5">Temperatura</span>
            <select
              className={selectClass}
              value={filters.temperature ?? ""}
              onChange={(e) => update({ temperature: (e.target.value || undefined) as typeof filters.temperature })}
            >
              <option value="">Qualquer</option>
              <option value="cold">Frio</option>
              <option value="warm">Morno</option>
              <option value="hot">Quente</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-[13px] font-medium text-text-secondary mb-1.5">Prioridade</span>
            <select
              className={selectClass}
              value={filters.priority ?? ""}
              onChange={(e) => update({ priority: (e.target.value || undefined) as typeof filters.priority })}
            >
              <option value="">Qualquer</option>
              <option value="low">Baixa</option>
              <option value="medium">Média</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </select>
          </label>
          <Input
            label="Tags (separadas por vírgula)"
            value={tagsText}
            onChange={(e) => {
              setTagsText(e.target.value);
              update({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) });
            }}
            placeholder="vip, retorno"
          />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Input
            type="date"
            label="Última atividade depois de"
            value={toDateInput(filters.lastActivityAfter)}
            onChange={(e) => update({ lastActivityAfter: fromDateInput(e.target.value, false) })}
          />
          <Input
            type="date"
            label="Última atividade antes de"
            value={toDateInput(filters.lastActivityBefore)}
            onChange={(e) => update({ lastActivityBefore: fromDateInput(e.target.value, true) })}
          />
        </div>

        <div className="space-y-2.5">
          {draft.provider === "meta" && (
            <Checkbox
              checked={filters.onlyOpenWindow ?? false}
              onChange={(e) => update({ onlyOpenWindow: e.target.checked || undefined })}
              label="Só quem tem a janela de 24h aberta"
              description="Permite texto livre (sem template) na Cloud API. Quem escreveu para o número nas últimas 24h."
            />
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <Checkbox
              checked={filters.excludeCampaignedWithinDays !== undefined}
              onChange={(e) => update({ excludeCampaignedWithinDays: e.target.checked ? 30 : undefined })}
              label="Não recebeu campanha nos últimos"
            />
            <input
              type="number"
              min={1}
              max={365}
              disabled={filters.excludeCampaignedWithinDays === undefined}
              value={filters.excludeCampaignedWithinDays ?? 30}
              onChange={(e) => update({ excludeCampaignedWithinDays: Math.max(1, Number(e.target.value) || 1) })}
              className="h-10 w-20 rounded-lg border border-border bg-surface-raised px-2 text-base md:text-sm text-text-primary disabled:opacity-50 tabular-nums"
              aria-label="Dias"
            />
            <span className="text-sm text-text-secondary">dias</span>
          </div>
          <Checkbox
            checked={filters.excludeRepliedToCampaigns ?? false}
            onChange={(e) => update({ excludeRepliedToCampaigns: e.target.checked || undefined })}
            label="Excluir quem já respondeu a alguma campanha"
            description="Quem respondeu virou conversa — trate no inbox, não em massa."
          />
        </div>
      </div>

      <aside className="rounded-lg border border-border bg-surface-sunken p-4 space-y-3 h-fit">
        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Users size={16} className="text-brand-500" />
          Público estimado
        </div>
        {preview === undefined ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Spinner size="sm" /> calculando…
          </div>
        ) : (
          <>
            <p className="text-3xl font-semibold text-text-primary tabular-nums">{preview.count.toLocaleString("pt-BR")}</p>
            <p className="text-xs text-text-muted">
              {preview.scanned.toLocaleString("pt-BR")} leads analisados
              {preview.truncated ? " (amostra — o total real é calculado no lançamento)" : ""}
            </p>
            {Object.entries(preview.excluded).filter(([, n]) => n > 0).length > 0 && (
              <div className="text-xs text-text-secondary space-y-0.5">
                <p className="font-medium text-text-muted">Fora do público:</p>
                {Object.entries(preview.excluded)
                  .filter(([, n]) => n > 0)
                  .map(([reason, n]) => (
                    <p key={reason} className="tabular-nums">
                      {n} {EXCLUSION_LABELS[reason] ?? reason}
                    </p>
                  ))}
              </div>
            )}
            {preview.sample.length > 0 && (
              <div className="pt-2 border-t border-border">
                <p className="text-xs font-medium text-text-muted mb-1.5">Amostra</p>
                <ul className="space-y-1 text-xs">
                  {preview.sample.map((s) => (
                    <li key={s.leadId ?? s.phone} className="flex justify-between gap-2">
                      <span className="text-text-primary truncate">{s.displayName ?? "Sem nome"}</span>
                      <span className="text-text-muted tabular-nums shrink-0">{formatPhone(s.phone ?? "")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        <p className="text-[11px] text-text-muted">
          O público é congelado no lançamento: mudar o filtro depois não altera uma campanha em andamento.
        </p>
      </aside>
    </div>
  );
}

// ── Importar CSV/XLSX ──

type ImportPhase = "pick" | "map" | "check" | "done";

function ImportTab({
  campaignId,
  isDraft,
  onImported,
}: {
  campaignId: Id<"campaigns"> | null;
  isDraft: boolean;
  onImported?: () => void;
}) {
  const importCsv = useAction(api.campaigns.importRecipientsCsv);
  const [file, setFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [phase, setPhase] = useState<ImportPhase>("pick");
  const [headersInfo, setHeadersInfo] = useState<ImportDryRunHeaders | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({ phone: "" });
  const [summary, setSummary] = useState<ImportDryRunSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (next: File | null) => {
    setFile(next);
    setSummary(null);
    setHeadersInfo(null);
    setPhase("pick");
    if (!next) {
      setCsvText(null);
      return;
    }
    try {
      const lower = next.name.toLowerCase();
      const text = lower.endsWith(".xlsx") || lower.endsWith(".xls") ? await xlsxFileToCsv(next) : await next.text();
      setCsvText(text);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível ler o arquivo"));
      setCsvText(null);
    }
  };

  const readHeaders = async () => {
    if (!campaignId || !csvText) return;
    setBusy(true);
    try {
      const result = (await importCsv({ campaignId, csvText, dryRun: true })) as unknown as ImportDryRunHeaders;
      setHeadersInfo(result);
      setMapping({
        phone: result.suggestedMapping.phone ?? "",
        name: result.suggestedMapping.name ?? undefined,
        email: result.suggestedMapping.email ?? undefined,
        company: result.suggestedMapping.company ?? undefined,
        varsColumns: [],
      });
      setPhase("map");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Falha ao ler o CSV"));
    } finally {
      setBusy(false);
    }
  };

  const runDryRun = async () => {
    if (!campaignId || !csvText || !mapping.phone) return;
    setBusy(true);
    try {
      const result = (await importCsv({ campaignId, csvText, mapping: cleanMapping(mapping), dryRun: true })) as unknown as ImportDryRunSummary;
      setSummary(result);
      setPhase("check");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Falha na validação"));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!campaignId || !csvText || !mapping.phone) return;
    setBusy(true);
    try {
      const result = (await importCsv({ campaignId, csvText, mapping: cleanMapping(mapping), dryRun: false })) as unknown as ImportDryRunSummary;
      setSummary(result);
      setPhase("done");
      toast.success(`${result.added ?? 0} destinatários adicionados`);
      onImported?.();
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Falha ao importar"));
    } finally {
      setBusy(false);
    }
  };

  if (!campaignId) {
    return <p className="text-sm text-text-muted">Salve o rascunho (avance do passo Canal) para importar destinatários.</p>;
  }
  if (!isDraft) {
    return <p className="text-sm text-text-muted">Campanha já lançada — o público não pode mais ser alterado.</p>;
  }

  const otherColumns = (headersInfo?.headers ?? []).filter(
    (h) => h !== mapping.phone && h !== mapping.name && h !== mapping.email && h !== mapping.company
  );

  return (
    <div className="space-y-4">
      <FileDropZone
        file={file}
        onFileChange={(f) => void handleFile(f)}
        accept=".csv,.xlsx,.xls"
        maxSizeBytes={5 * 1024 * 1024}
        hint="CSV (vírgula ou ponto e vírgula) ou planilha Excel — a 1ª planilha é usada. Precisa de uma coluna de telefone."
        disabled={busy}
      />
      {file && csvText && phase === "pick" && (
        <Button onClick={() => void readHeaders()} disabled={busy}>
          {busy ? <Spinner size="sm" /> : null}
          Ler colunas
        </Button>
      )}

      {headersInfo && (phase === "map" || phase === "check" || phase === "done") && (
        <div className="rounded-lg border border-border bg-surface-sunken p-4 space-y-3">
          <p className="text-sm font-medium text-text-primary">
            Mapeamento das colunas <span className="text-text-muted font-normal">({headersInfo.rowCount} linhas)</span>
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <MappingSelect
              label="Telefone (obrigatório)"
              value={mapping.phone}
              headers={headersInfo.headers}
              onChange={(v) => setMapping((m) => ({ ...m, phone: v }))}
              required
            />
            <MappingSelect label="Nome" value={mapping.name ?? ""} headers={headersInfo.headers} onChange={(v) => setMapping((m) => ({ ...m, name: v || undefined }))} />
            <MappingSelect label="E-mail" value={mapping.email ?? ""} headers={headersInfo.headers} onChange={(v) => setMapping((m) => ({ ...m, email: v || undefined }))} />
            <MappingSelect label="Empresa" value={mapping.company ?? ""} headers={headersInfo.headers} onChange={(v) => setMapping((m) => ({ ...m, company: v || undefined }))} />
          </div>
          {otherColumns.length > 0 && (
            <div>
              <p className="text-[13px] font-medium text-text-secondary mb-1.5">
                Outras colunas como variáveis <span className="text-text-muted font-normal">(use {"{{coluna}}"} na mensagem)</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {otherColumns.map((col) => {
                  const on = (mapping.varsColumns ?? []).includes(col);
                  return (
                    <button
                      key={col}
                      type="button"
                      onClick={() =>
                        setMapping((m) => ({
                          ...m,
                          varsColumns: on ? (m.varsColumns ?? []).filter((c) => c !== col) : [...(m.varsColumns ?? []), col],
                        }))
                      }
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-xs font-medium min-h-[36px]",
                        on ? "border-brand-500 bg-brand-500/10 text-brand-400" : "border-border text-text-secondary"
                      )}
                      aria-pressed={on}
                    >
                      {`{{${col}}}`}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {phase === "map" && (
            <Button onClick={() => void runDryRun()} disabled={busy || !mapping.phone}>
              {busy ? <Spinner size="sm" /> : null}
              Validar
            </Button>
          )}
        </div>
      )}

      {summary && (phase === "check" || phase === "done") && (
        <div className="rounded-lg border border-border bg-surface-sunken p-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
            <ImportStat label="Válidos" value={summary.valid} tone="success" />
            <ImportStat label="Inválidos" value={summary.invalidCount} tone={summary.invalidCount > 0 ? "error" : undefined} />
            <ImportStat label="Repetidos" value={summary.duplicates} />
            <ImportStat label="Em supressão" value={summary.suppressed} tone={summary.suppressed > 0 ? "warning" : undefined} />
            <ImportStat label="Já são contatos" value={summary.existingContacts} />
          </div>
          {summary.invalid.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-text-secondary">Ver inválidos (amostra)</summary>
              <ul className="mt-1.5 space-y-0.5 text-text-muted">
                {summary.invalid.map((i) => (
                  <li key={`${i.row}-${i.phone}`}>
                    linha {i.row}: <span className="text-text-primary">{i.phone || "(vazio)"}</span> — {i.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-xs text-text-muted">
            Contato e lead são criados só no momento do envio — importar não é contatar. Se você cancelar a campanha, nada é criado.
          </p>
          {phase === "check" && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setPhase("map")} disabled={busy}>
                Voltar ao mapeamento
              </Button>
              <Button onClick={() => void commit()} disabled={busy || summary.valid === 0}>
                {busy ? <Spinner size="sm" /> : null}
                Importar {summary.valid} destinatários
              </Button>
            </div>
          )}
          {phase === "done" && (
            <p className="text-sm text-semantic-success">
              {summary.added ?? 0} adicionados
              {summary.duplicatesInCampaign ? ` · ${summary.duplicatesInCampaign} já estavam na campanha` : ""}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function cleanMapping(m: ImportMapping): ImportMapping {
  const out: ImportMapping = { phone: m.phone };
  if (m.name) out.name = m.name;
  if (m.email) out.email = m.email;
  if (m.company) out.company = m.company;
  if (m.varsColumns && m.varsColumns.length > 0) out.varsColumns = m.varsColumns;
  return out;
}

function MappingSelect({
  label,
  value,
  headers,
  onChange,
  required,
}: {
  label: string;
  value: string;
  headers: string[];
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-text-secondary mb-1.5">{label}</span>
      <select className={selectClass} value={value} onChange={(e) => onChange(e.target.value)} required={required}>
        <option value="">{required ? "Escolha a coluna" : "— não usar —"}</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </label>
  );
}

function ImportStat({ label, value, tone }: { label: string; value: number; tone?: "success" | "error" | "warning" }) {
  return (
    <div className="rounded-lg bg-surface-raised border border-border px-3 py-2">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "success" && "text-semantic-success",
          tone === "error" && "text-semantic-error",
          tone === "warning" && "text-semantic-warning",
          !tone && "text-text-primary"
        )}
      >
        {value.toLocaleString("pt-BR")}
      </p>
    </div>
  );
}

// ── Manual ──

function ManualTab({ campaignId, isDraft, onAdded }: { campaignId: Id<"campaigns"> | null; isDraft: boolean; onAdded?: () => void }) {
  const addManual = useMutation(api.campaigns.addManualRecipients);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: number; invalid: { phone: string; reason: string }[]; duplicates: number; suppressed: number } | null>(null);

  const parsed = useMemo(() => {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [phone, ...rest] = line.split(/[,;\t]/);
        const name = rest.join(" ").trim();
        return { phone: phone.trim(), ...(name ? { name } : {}) };
      });
  }, [text]);

  const handleAdd = async () => {
    if (!campaignId || parsed.length === 0) return;
    setBusy(true);
    const totals = { added: 0, invalid: [] as { phone: string; reason: string }[], duplicates: 0, suppressed: 0 };
    try {
      for (let i = 0; i < parsed.length; i += 500) {
        const res = await addManual({ campaignId, entries: parsed.slice(i, i + 500) });
        totals.added += res.added;
        totals.invalid.push(...res.invalid);
        totals.duplicates += res.duplicates;
        totals.suppressed += res.suppressed;
      }
      setResult(totals);
      setText("");
      toast.success(`${totals.added} destinatários adicionados`);
      onAdded?.();
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Falha ao adicionar"));
    } finally {
      setBusy(false);
    }
  };

  if (!campaignId) {
    return <p className="text-sm text-text-muted">Salve o rascunho (avance do passo Canal) para adicionar números.</p>;
  }
  if (!isDraft) {
    return <p className="text-sm text-text-muted">Campanha já lançada — o público não pode mais ser alterado.</p>;
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="block text-[13px] font-medium text-text-secondary mb-1.5">
          Um número por linha — opcionalmente <code className="text-text-primary">telefone, nome</code>
        </span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={"5511999991234, Maria\n(11) 98888-7766\n+55 21 97777-1111, João"}
          className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-base md:text-sm text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
          style={{ fontSize: "16px" }}
        />
      </label>
      <div className="flex items-center gap-3 flex-wrap">
        <Button onClick={() => void handleAdd()} disabled={busy || parsed.length === 0}>
          {busy ? <Spinner size="sm" /> : null}
          Adicionar {parsed.length > 0 ? parsed.length : ""}
        </Button>
        <span className="text-xs text-text-muted">Sem DDI assume Brasil (+55). Celulares ganham o 9º dígito.</span>
      </div>
      {result && (
        <div className="rounded-lg border border-border bg-surface-sunken p-3 text-sm space-y-1">
          <p className="text-text-primary">
            <span className="font-semibold text-semantic-success">{result.added}</span> adicionados · {result.duplicates} repetidos ·{" "}
            {result.suppressed} em supressão · {result.invalid.length} inválidos
          </p>
          {result.invalid.length > 0 && (
            <ul className="text-xs text-text-muted space-y-0.5">
              {result.invalid.slice(0, 10).map((i, idx) => (
                <li key={`${i.phone}-${idx}`}>
                  <span className="text-text-primary">{i.phone}</span> — {i.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Lista de destinatários já adicionados ──

function RecipientsList({ campaignId, isDraft, onChanged }: { campaignId: Id<"campaigns">; isDraft: boolean; onChanged?: () => void }) {
  const listRef = api.campaigns.getCampaignRecipients as unknown as PaginatedQueryReference;
  const { results, status, loadMore } = usePaginatedQuery(listRef, { campaignId }, { initialNumItems: 25 });
  const recipients = (results ?? []) as CampaignRecipient[];
  const campaign = useQuery(api.campaigns.getCampaign, { campaignId }) as { stats: { total: number } } | null | undefined;
  const removeRecipient = useMutation(api.campaigns.removeRecipient);
  const clearRecipients = useMutation(api.campaigns.clearRecipients);
  const [confirmClear, setConfirmClear] = useState(false);

  const total = campaign?.stats.total ?? recipients.length;

  return (
    <div className="rounded-lg border border-border bg-surface-sunken">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
        <p className="text-sm font-medium text-text-primary">
          Destinatários <span className="text-text-muted font-normal tabular-nums">({total.toLocaleString("pt-BR")})</span>
        </p>
        {isDraft && total > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
            <Trash2 size={14} /> Limpar todos
          </Button>
        )}
      </div>
      {recipients.length === 0 ? (
        <p className="px-4 py-6 text-sm text-text-muted text-center">Nenhum destinatário ainda.</p>
      ) : (
        <ul className="divide-y divide-border max-h-72 overflow-y-auto">
          {recipients.map((r) => (
            <li key={r._id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="text-text-primary truncate">{r.displayName ?? r.vars?.nome ?? "Sem nome"}</p>
                <p className="text-xs text-text-muted tabular-nums">{formatPhone(r.phone)}</p>
              </div>
              <Badge>{RECIPIENT_STATUS_LABELS[r.status]}</Badge>
              {isDraft && (
                <button
                  type="button"
                  onClick={() =>
                    void removeRecipient({ recipientId: r._id })
                      .then(() => onChanged?.())
                      .catch((e) => toast.error(mutationErrorMessage(e, "Falha ao remover")))
                  }
                  className="h-9 w-9 flex items-center justify-center rounded-full text-text-muted hover:text-semantic-error hover:bg-semantic-error/10"
                  aria-label="Remover destinatário"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {status === "CanLoadMore" && (
        <div className="px-4 py-2 border-t border-border">
          <Button variant="ghost" size="sm" onClick={() => loadMore(50)}>
            Carregar mais
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          void clearRecipients({ campaignId })
            .then(() => onChanged?.())
            .catch((e) => toast.error(mutationErrorMessage(e, "Falha ao limpar")));
        }}
        title="Limpar destinatários?"
        description="Todos os números adicionados a este rascunho serão removidos."
        confirmLabel="Limpar"
        variant="danger"
      />
    </div>
  );
}

// ── Destino de números novos ──

function TargetSection({
  organizationId,
  draft,
  setDraft,
  disabled,
}: {
  organizationId: Id<"organizations">;
  draft: WizardDraft;
  setDraft: StepAudienceProps["setDraft"];
  disabled: boolean;
}) {
  const boards = useQuery(api.boards.getBoards, { organizationId }) as { _id: Id<"boards">; name: string; isDefault?: boolean }[] | undefined;
  const stages = useQuery(api.boards.getStages, draft.audience.targetBoardId ? { boardId: draft.audience.targetBoardId } : "skip") as
    | { _id: Id<"stages">; name: string }[]
    | undefined;
  const [tagsText, setTagsText] = useState(draft.audience.targetTags.join(", "));

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-4 space-y-3">
      <div>
        <p className="text-sm font-medium text-text-primary">Onde criar os leads de números novos</p>
        <p className="text-xs text-text-muted mt-0.5">
          Quem ainda não é contato vira contato + lead + conversa no momento do envio, com a fonte "Campanha". A resposta cai no inbox e no
          atendente IA, se o canal tiver um.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block">
          <span className="block text-[13px] font-medium text-text-secondary mb-1.5">Funil</span>
          <select
            className={selectClass}
            disabled={disabled}
            value={draft.audience.targetBoardId ?? ""}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                audience: {
                  ...d.audience,
                  targetBoardId: (e.target.value || undefined) as Id<"boards"> | undefined,
                  targetStageId: undefined,
                },
              }))
            }
          >
            <option value="">Funil padrão</option>
            {(boards ?? []).map((b) => (
              <option key={b._id} value={b._id}>
                {b.name}
                {b.isDefault ? " (padrão)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[13px] font-medium text-text-secondary mb-1.5">Estágio</span>
          <select
            className={selectClass}
            disabled={disabled || !draft.audience.targetBoardId}
            value={draft.audience.targetStageId ?? ""}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                audience: { ...d.audience, targetStageId: (e.target.value || undefined) as Id<"stages"> | undefined },
              }))
            }
          >
            <option value="">Primeiro estágio</option>
            {(stages ?? []).map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Tags para o lead"
          disabled={disabled}
          value={tagsText}
          onChange={(e) => {
            setTagsText(e.target.value);
            const tags = e.target.value.split(",").map((t) => t.trim()).filter(Boolean);
            setDraft((d) => ({ ...d, audience: { ...d.audience, targetTags: tags } }));
          }}
          placeholder="campanha-setembro"
        />
      </div>
      {draft.audience.source === "segment" && (
        <p className="text-[11px] text-text-muted flex items-start gap-1.5">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          Num segmento todos já são leads; o destino só vale para números novos de importação/manual.
        </p>
      )}
    </div>
  );
}
