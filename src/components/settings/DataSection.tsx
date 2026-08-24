import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckSquare,
  Database,
  DatabaseBackup,
  Download,
  FileSpreadsheet,
  ShieldAlert,
  Target,
  Undo2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { usePermissions } from "@/hooks/usePermissions";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { formatFileSize } from "../../../convex/lib/fileValidation";
import {
  ACTIVE_IMPORT_STATUSES,
  DUPLICATE_STRATEGY_LABEL,
  IMPORT_ENTITY_LABEL,
  ImportProgressBar,
  ImportWizard,
  downloadFromUrl,
  downloadTextFile,
  formatCount,
  importStatusMeta,
  type ImportJobDoc,
} from "@/components/settings/ImportWizard";

// ===== Tipos do lado de exportação =====

type ExportStatus = "queued" | "running" | "completed" | "failed";
type ExportEntity = "contacts" | "leads" | "tasks";

interface ExportJobDoc {
  _id: Id<"exportJobs">;
  status: ExportStatus;
  format: "csv" | "json";
  scope: "entity" | "full_backup";
  entity?: ExportEntity;
  progress: { processed: number; total?: number; currentEntity?: string };
  resultFileName?: string;
  resultSize?: number;
  rowCount?: number;
  error?: string;
  expiresAt: number;
  createdAt: number;
  finishedAt?: number;
}

const EXPORT_ENTITY_LABEL: Record<ExportEntity, string> = {
  contacts: "Contatos",
  leads: "Leads",
  tasks: "Tarefas",
};

const ACTIVE_EXPORT_STATUSES: ExportStatus[] = ["queued", "running"];

function exportStatusMeta(status: ExportStatus): {
  label: string;
  variant: "default" | "brand" | "success" | "error" | "warning" | "info";
} {
  switch (status) {
    case "queued":
      return { label: "Na fila", variant: "info" };
    case "running":
      return { label: "Processando", variant: "brand" };
    case "completed":
      return { label: "Concluída", variant: "success" };
    case "failed":
    default:
      return { label: "Falhou", variant: "error" };
  }
}

function exportJobTitle(job: ExportJobDoc): string {
  if (job.scope === "full_backup") return "Backup completo (JSON)";
  const entity = job.entity ? EXPORT_ENTITY_LABEL[job.entity] : "Dados";
  return `${entity} (${job.format.toUpperCase()})`;
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/** "expira em 6 dias" / "expirado" — o blob some 7 dias após a exportação. */
function expiryLabel(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "arquivo expirado";
  const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
  if (days <= 1) return "expira em menos de 1 dia";
  return `expira em ${days} dias`;
}

// ===== Botões rápidos de exportação =====

interface ExportAction {
  key: string;
  label: string;
  description: string;
  icon: typeof Users;
  format: "csv" | "json";
  scope: "entity" | "full_backup";
  entity?: ExportEntity;
  note?: string;
}

const EXPORT_ACTIONS: ExportAction[] = [
  {
    key: "contacts",
    label: "Contatos",
    description: "CSV com todos os contatos e campos personalizados.",
    icon: Users,
    format: "csv",
    scope: "entity",
    entity: "contacts",
  },
  {
    key: "leads",
    label: "Leads",
    description: "CSV com funil, estágio, responsável e origem por extenso.",
    icon: Target,
    format: "csv",
    scope: "entity",
    entity: "leads",
  },
  {
    key: "tasks",
    label: "Tarefas",
    description: "CSV com projeto, coluna, etiquetas e responsáveis.",
    icon: CheckSquare,
    format: "csv",
    scope: "entity",
    entity: "tasks",
  },
  {
    key: "backup",
    label: "Backup completo",
    description: "JSON versionado com as tabelas principais da organização.",
    icon: DatabaseBackup,
    format: "json",
    scope: "full_backup",
    note: "Backup completo — inclui todos os dados da organização, exceto segredos e chaves.",
  },
];

// ===== Seção =====

export function DataSection({ organizationId }: { organizationId: Id<"organizations"> }) {
  const { can } = usePermissions(organizationId);
  const canManage = can("settings", "manage");

  const [wizardOpen, setWizardOpen] = useState(false);
  const [downloadJobId, setDownloadJobId] = useState<Id<"exportJobs"> | null>(null);
  const [rollbackJob, setRollbackJob] = useState<ImportJobDoc | null>(null);

  const exportJobs = useQuery(
    api.exports.getExportJobs,
    canManage ? { organizationId } : "skip"
  ) as ExportJobDoc[] | undefined;

  const importJobs = useQuery(
    api.imports.getImportJobs,
    canManage ? { organizationId } : "skip"
  ) as ImportJobDoc[] | undefined;

  const downloadUrl = useQuery(
    api.exports.getExportDownloadUrl,
    downloadJobId ? { organizationId, jobId: downloadJobId } : "skip"
  );

  const createExportJob = useMutation(api.exports.createExportJob);
  const rollbackImport = useMutation(api.imports.rollbackImport);
  const cancelImport = useMutation(api.imports.cancelImport);
  const getFailedRowsCsv = useAction(api.imports.getFailedRowsCsv);

  // A URL assinada chega pela query reativa; assim que ela resolve, dispara o
  // download com o nome de arquivo do job e libera a assinatura.
  useEffect(() => {
    if (!downloadJobId || downloadUrl === undefined) return;
    const job = exportJobs?.find((item) => item._id === downloadJobId);
    const fileName = job?.resultFileName ?? "hnbcrm-export";
    setDownloadJobId(null);
    if (!downloadUrl) {
      toast.error("Arquivo indisponível — o link de download expira 7 dias após a exportação.");
      return;
    }
    toast.promise(downloadFromUrl(downloadUrl, fileName), {
      loading: "Baixando arquivo...",
      success: "Download concluído",
      error: (error: unknown) => mutationErrorMessage(error, "Falha ao baixar o arquivo"),
    });
  }, [downloadJobId, downloadUrl, exportJobs]);

  if (!canManage) {
    return (
      <Card>
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <ShieldAlert size={40} className="text-text-muted" />
          <div>
            <h3 className="text-base font-semibold text-text-primary">Acesso restrito</h3>
            <p className="mt-1 text-sm text-text-secondary">
              Só quem administra as configurações pode exportar ou importar dados da organização.
              Peça acesso a um administrador.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const activeExport = exportJobs?.find((job) => ACTIVE_EXPORT_STATUSES.includes(job.status));
  const activeImport = importJobs?.find((job) => ACTIVE_IMPORT_STATUSES.includes(job.status));
  const now = Date.now();

  const handleExport = (action: ExportAction) => {
    toast.promise(
      createExportJob({
        organizationId,
        format: action.format,
        scope: action.scope,
        entity: action.entity,
      }),
      {
        loading: "Preparando a exportação...",
        success: "Exportação iniciada — o arquivo aparece no histórico em instantes.",
        error: (error: unknown) => mutationErrorMessage(error, "Falha ao iniciar a exportação"),
      }
    );
  };

  const handleRollback = (job: ImportJobDoc) => {
    toast.promise(rollbackImport({ organizationId, jobId: job._id }), {
      loading: "Desfazendo a importação...",
      success: "Desfazendo — o histórico é atualizado ao terminar.",
      error: (error: unknown) => mutationErrorMessage(error, "Falha ao desfazer a importação"),
    });
    setRollbackJob(null);
  };

  const handleCancelImport = (job: ImportJobDoc) => {
    toast.promise(cancelImport({ organizationId, jobId: job._id }), {
      loading: "Cancelando...",
      success: "Importação cancelada",
      error: (error: unknown) => mutationErrorMessage(error, "Falha ao cancelar a importação"),
    });
  };

  const handleDownloadFailedRows = (job: ImportJobDoc) => {
    toast.promise(
      (async () => {
        const csv = await getFailedRowsCsv({ organizationId, jobId: job._id });
        if (!csv) throw new Error("Nenhuma linha com erro para baixar");
        downloadTextFile(csv, `erros-${job.fileName}`, "text/csv;charset=utf-8");
      })(),
      {
        loading: "Gerando o arquivo de erros...",
        success: "Arquivo com as linhas de erro baixado",
        error: (error: unknown) =>
          mutationErrorMessage(error, "Falha ao gerar o arquivo de erros"),
      }
    );
  };

  return (
    <div className="space-y-6">
      {/* ===== Exportar ===== */}
      <Card>
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/10">
            <Download size={20} className="text-brand-500" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-text-primary">Exportar dados</h3>
            <p className="text-sm text-text-secondary">
              Gere um arquivo para planilha ou um backup completo. O link fica disponível por 7 dias.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {EXPORT_ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.key}
                type="button"
                onClick={() => handleExport(action)}
                disabled={Boolean(activeExport)}
                className={cn(
                  "flex min-h-[68px] items-start gap-3 rounded-card border border-border bg-surface-sunken p-3 text-left transition-colors",
                  "hover:border-brand-500/60 hover:bg-surface-overlay",
                  "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-raised",
                  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-surface-sunken"
                )}
              >
                <Icon size={20} className="mt-0.5 shrink-0 text-brand-500" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text-primary">
                    {action.label}{" "}
                    <span className="text-text-muted">({action.format.toUpperCase()})</span>
                  </span>
                  <span className="block text-xs text-text-secondary">{action.description}</span>
                  {action.note && (
                    <span className="mt-1 block text-xs text-semantic-warning">{action.note}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {activeExport && (
          <p className="mt-3 text-xs text-text-muted">
            Existe uma exportação em andamento — aguarde a conclusão para iniciar outra.
          </p>
        )}

        <div className="mt-5">
          <h4 className="mb-2 text-sm font-semibold text-text-primary">Exportações recentes</h4>

          {exportJobs === undefined && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}

          {exportJobs && exportJobs.length === 0 && (
            <p className="py-2 text-sm text-text-secondary">Nenhuma exportação gerada ainda.</p>
          )}

          {exportJobs && exportJobs.length > 0 && (
            <ul className="space-y-2">
              {exportJobs.map((job) => {
                const meta = exportStatusMeta(job.status);
                const running = job.status === "running" || job.status === "queued";
                const expired = job.expiresAt <= now;
                return (
                  <li
                    key={job._id}
                    className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">
                          {exportJobTitle(job)}
                        </span>
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-text-muted tabular-nums">
                        {formatDateTime(job.createdAt)}
                        {running && (
                          <>
                            {" · "}
                            {formatCount(job.progress.processed)} registro(s) processado(s)
                            {job.progress.currentEntity ? ` (${job.progress.currentEntity})` : ""}
                          </>
                        )}
                        {job.status === "completed" && (
                          <>
                            {" · "}
                            {formatCount(job.rowCount ?? 0)} registro(s)
                            {job.resultSize ? ` · ${formatFileSize(job.resultSize)}` : ""}
                            {" · "}
                            {expiryLabel(job.expiresAt, now)}
                          </>
                        )}
                      </p>
                      {job.status === "failed" && job.error && (
                        <p className="mt-1 flex items-start gap-1.5 text-xs text-semantic-error">
                          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                          {job.error}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {running && <Spinner size="sm" />}
                      {job.status === "completed" && !expired && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setDownloadJobId(job._id)}
                          disabled={downloadJobId === job._id}
                        >
                          <Download size={14} />
                          Baixar
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      {/* ===== Importar ===== */}
      <Card>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/10">
              <Upload size={20} className="text-brand-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Importar dados</h3>
              <p className="text-sm text-text-secondary">
                Traga contatos e leads de outro sistema por CSV, com mapeamento de colunas e
                pré-visualização antes de gravar.
              </p>
            </div>
          </div>
          <Button onClick={() => setWizardOpen(true)}>
            <Upload size={18} />
            {activeImport ? "Retomar importação" : "Nova importação"}
          </Button>
        </div>

        <h4 className="mb-2 text-sm font-semibold text-text-primary">Importações recentes</h4>

        {importJobs === undefined && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}

        {importJobs && importJobs.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <FileSpreadsheet size={32} className="text-text-muted" />
            <p className="text-sm text-text-secondary">Nenhuma importação por aqui ainda.</p>
          </div>
        )}

        {importJobs && importJobs.length > 0 && (
          <ul className="space-y-2">
            {importJobs.map((job) => {
              const meta = importStatusMeta(job.status);
              const active = ACTIVE_IMPORT_STATUSES.includes(job.status);
              const canCancel = job.status === "mapping" || job.status === "preview_ready";
              const canRollback =
                job.status === "completed" || job.status === "completed_with_errors";
              const finished =
                job.status === "completed" ||
                job.status === "completed_with_errors" ||
                job.status === "rolled_back";

              return (
                <li
                  key={job._id}
                  className="rounded-lg border border-border bg-surface-sunken p-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-text-primary" title={job.fileName}>
                          {job.fileName}
                        </span>
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-text-muted tabular-nums">
                        {IMPORT_ENTITY_LABEL[job.entity]} ·{" "}
                        {DUPLICATE_STRATEGY_LABEL[job.duplicateStrategy].toLowerCase()} ·{" "}
                        {formatDateTime(job.createdAt)}
                      </p>
                      {(job.status === "running" || finished) && (
                        <p className="mt-1 text-xs text-text-secondary tabular-nums">
                          {formatCount(job.progress.created)} criado(s) ·{" "}
                          {formatCount(job.progress.updated)} atualizado(s) ·{" "}
                          {formatCount(job.progress.skipped)} pulado(s) ·{" "}
                          <span
                            className={cn(
                              job.progress.failed > 0 ? "text-semantic-error" : "text-text-secondary"
                            )}
                          >
                            {formatCount(job.progress.failed)} com erro
                          </span>
                        </p>
                      )}
                      {job.error && (
                        <p className="mt-1 flex items-start gap-1.5 text-xs text-semantic-error">
                          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                          {job.error}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      {active && (
                        <Button variant="secondary" size="sm" onClick={() => setWizardOpen(true)}>
                          {job.status === "running" ? "Acompanhar" : "Continuar"}
                        </Button>
                      )}
                      {canCancel && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCancelImport(job)}
                        >
                          <X size={14} />
                          Cancelar
                        </Button>
                      )}
                      {job.progress.failed > 0 && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDownloadFailedRows(job)}
                        >
                          <Download size={14} />
                          Linhas com erro
                        </Button>
                      )}
                      {canRollback && (
                        <Button variant="ghost" size="sm" onClick={() => setRollbackJob(job)}>
                          <Undo2 size={14} />
                          Desfazer
                        </Button>
                      )}
                    </div>
                  </div>

                  {job.status === "running" && (
                    <div className="mt-2">
                      <ImportProgressBar
                        processed={job.progress.processed}
                        total={job.progress.total}
                      />
                      <p className="mt-1 text-xs text-text-muted tabular-nums">
                        {formatCount(job.progress.processed)} de {formatCount(job.progress.total)}{" "}
                        linhas
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Rodapé informativo */}
      <div className="flex items-start gap-2 px-1 text-xs text-text-muted">
        <Database size={14} className="mt-0.5 shrink-0" />
        <p>
          Arquivos CSV saem com BOM (abrem direto no Excel e no LibreOffice) e datas em formato ISO.
          Toda exportação e importação fica registrada na Auditoria.
        </p>
      </div>

      <ImportWizard
        organizationId={organizationId}
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        initialJobId={activeImport?._id ?? null}
      />

      <ConfirmDialog
        open={rollbackJob !== null}
        onClose={() => setRollbackJob(null)}
        onConfirm={() => {
          if (rollbackJob) handleRollback(rollbackJob);
        }}
        title="Desfazer importação"
        description="Os registros criados por esta importação serão apagados e os atualizados voltarão ao estado anterior. Atividades e webhooks já disparados não são revertidos. Esta ação não pode ser desfeita."
        confirmLabel="Desfazer"
        variant="danger"
      />
    </div>
  );
}
