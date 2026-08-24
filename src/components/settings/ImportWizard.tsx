import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  RotateCcw,
  Target,
  Users,
  XCircle,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { FileDropZone } from "@/components/ui/FileDropZone";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { encodeHeaderKey } from "../../../convex/lib/importKeys";
import {
  CUSTOM_FIELD_PREFIX,
  IGNORE_FIELD,
  filterFieldDefs,
  listImportTargets,
  type ImportEntity,
  type ImportFieldDef,
} from "../../../convex/lib/importMapping";

// ===== Tipos e rótulos compartilhados com a aba "Dados" =====

export type ImportStatus =
  | "mapping"
  | "previewing"
  | "preview_ready"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "rolled_back"
  | "canceled";

export type DuplicateStrategy = "skip" | "update" | "create";

export interface ImportJobDoc {
  _id: Id<"importJobs">;
  organizationId: Id<"organizations">;
  status: ImportStatus;
  entity: ImportEntity;
  fileName: string;
  detectedHeaders?: string[];
  suggestedMapping?: Record<string, string>;
  mapping?: Record<string, string>;
  duplicateStrategy: DuplicateStrategy;
  dryRun?: {
    totalRows: number;
    validRows: number;
    errorRows: number;
    newRows: number;
    updateRows: number;
    skipRows: number;
    sampleErrors: Array<{ row: number; field?: string; message: string }>;
    preview: Array<Record<string, any>>;
  };
  progress: {
    processed: number;
    total: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export const IMPORT_ENTITY_LABEL: Record<ImportEntity, string> = {
  contacts: "Contatos",
  leads: "Leads",
};

export const DUPLICATE_STRATEGY_LABEL: Record<DuplicateStrategy, string> = {
  skip: "Pular duplicados",
  update: "Atualizar duplicados",
  create: "Criar sempre",
};

/** Status que ainda ocupam a vaga de "1 importação por organização". */
export const ACTIVE_IMPORT_STATUSES: ImportStatus[] = [
  "mapping",
  "previewing",
  "preview_ready",
  "running",
];

export function importStatusMeta(status: ImportStatus): {
  label: string;
  variant: "default" | "brand" | "success" | "error" | "warning" | "info";
} {
  switch (status) {
    case "mapping":
      return { label: "Aguardando mapeamento", variant: "info" };
    case "previewing":
      return { label: "Analisando", variant: "info" };
    case "preview_ready":
      return { label: "Aguardando confirmação", variant: "warning" };
    case "running":
      return { label: "Importando", variant: "brand" };
    case "completed":
      return { label: "Concluída", variant: "success" };
    case "completed_with_errors":
      return { label: "Concluída com erros", variant: "warning" };
    case "failed":
      return { label: "Falhou", variant: "error" };
    case "rolled_back":
      return { label: "Desfeita", variant: "default" };
    case "canceled":
    default:
      return { label: "Cancelada", variant: "default" };
  }
}

// ===== Download helpers (usados aqui e na aba "Dados") =====

function saveBlob(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

/** Baixa um conteúdo de texto já em memória (CSV de linhas com erro). */
export function downloadTextFile(content: string, fileName: string, mimeType: string) {
  saveBlob(new Blob([content], { type: mimeType }), fileName);
}

/**
 * Baixa uma URL assinada do storage preservando o nome do arquivo do job.
 * Se o `fetch` falhar (rede/CORS), cai para abrir a URL numa nova aba — o
 * usuário ainda consegue o arquivo.
 */
export async function downloadFromUrl(url: string, fileName: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    saveBlob(await response.blob(), fileName);
    return;
  } catch {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
}

export function formatCount(value: number): string {
  return value.toLocaleString("pt-BR");
}

// ===== Passos =====

const STEPS = ["Arquivo", "Colunas", "Prévia", "Importação", "Resultado"];

function stepFromStatus(status: ImportStatus | undefined): number {
  switch (status) {
    case undefined:
      return 0;
    case "mapping":
      return 1;
    case "previewing":
    case "preview_ready":
      return 2;
    case "running":
      return 3;
    default:
      return 4;
  }
}

function StepTrail({ current }: { current: number }) {
  return (
    <ol className="mb-5 flex items-center gap-1.5" aria-label="Etapas da importação">
      {STEPS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                done && "bg-brand-500/20 text-brand-400",
                active && "bg-brand-600 text-white",
                !done && !active && "border border-border bg-surface-overlay text-text-muted"
              )}
            >
              {done ? <Check size={12} /> : index + 1}
            </span>
            <span
              className={cn(
                "hidden text-xs sm:block",
                active ? "font-medium text-text-primary" : "text-text-muted"
              )}
            >
              {label}
            </span>
            {index < STEPS.length - 1 && (
              <span className={cn("h-px flex-1", done ? "bg-brand-500/50" : "bg-border")} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ===== Formatação de células da prévia =====

const PREVIEW_LABEL_OVERRIDES: Record<string, string> = {
  linha: "Linha",
  erro: "Erro",
  customFields: "Campos personalizados",
};

function formatPreviewValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length > 0 ? value.join("; ") : "—";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "number") return value.toLocaleString("pt-BR");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "—";
    return entries.map(([key, item]) => `${key}: ${formatPreviewValue(item)}`).join("; ");
  }
  return String(value);
}

function isEmptyPreviewValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

// ===== Componente principal =====

interface ImportWizardProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
  /** Retoma um job já existente (o wizard abre no passo correspondente ao status). */
  initialJobId?: Id<"importJobs"> | null;
}

export function ImportWizard({
  organizationId,
  open,
  onClose,
  initialJobId = null,
}: ImportWizardProps) {
  const [jobId, setJobId] = useState<Id<"importJobs"> | null>(initialJobId);
  const [entity, setEntity] = useState<ImportEntity>("contacts");
  const [file, setFile] = useState<File | null>(null);
  const [duplicateStrategy, setDuplicateStrategy] = useState<DuplicateStrategy>("skip");
  const [draftMapping, setDraftMapping] = useState<Record<string, string>>({});
  const [editingMapping, setEditingMapping] = useState(false);
  const [busy, setBusy] = useState(false);

  const seededJobRef = useRef<string | null>(null);
  const initialJobRef = useRef<Id<"importJobs"> | null>(initialJobId);
  initialJobRef.current = initialJobId;
  const wasOpenRef = useRef(false);

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);
  const createImportJob = useMutation(api.imports.createImportJob);
  const updateMapping = useMutation(api.imports.updateMapping);
  const runPreview = useMutation(api.imports.runPreview);
  const confirmImport = useMutation(api.imports.confirmImport);
  const cancelImport = useMutation(api.imports.cancelImport);
  const getFailedRowsCsv = useAction(api.imports.getFailedRowsCsv);

  const job = useQuery(
    api.imports.getImportJob,
    open && jobId ? { organizationId, jobId } : "skip"
  ) as ImportJobDoc | null | undefined;

  const fieldDefs = useQuery(
    api.fieldDefinitions.getFieldDefinitions,
    open ? { organizationId } : "skip"
  ) as ImportFieldDef[] | undefined;

  const resetWizard = () => {
    setJobId(null);
    setFile(null);
    setDraftMapping({});
    setEditingMapping(false);
    seededJobRef.current = null;
  };

  // Reabrir o wizard retoma o job ativo (ou começa do zero).
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setJobId(initialJobRef.current);
      setFile(null);
      setDraftMapping({});
      setEditingMapping(false);
      seededJobRef.current = null;
    }
    wasOpenRef.current = open;
  }, [open]);

  // Job sumiu (removido/de outra org): volta o wizard para o início.
  useEffect(() => {
    if (jobId && job === null) setJobId(null);
  }, [jobId, job]);

  // Semeia o mapeamento local com a sugestão do backend (uma vez por job).
  useEffect(() => {
    if (!job || !job.detectedHeaders) return;
    if (seededJobRef.current === job._id) return;
    seededJobRef.current = job._id;
    const base = job.mapping ?? job.suggestedMapping ?? {};
    const next: Record<string, string> = {};
    for (const header of job.detectedHeaders) {
      const key = encodeHeaderKey(header);
      next[key] = base[key] ?? IGNORE_FIELD;
    }
    setDraftMapping(next);
  }, [job]);

  const activeEntity: ImportEntity = job?.entity ?? entity;

  const targetOptions = useMemo(() => listImportTargets(activeEntity), [activeEntity]);
  const customOptions = useMemo(
    () => filterFieldDefs(fieldDefs, activeEntity),
    [fieldDefs, activeEntity]
  );

  const step = editingMapping && job?.status === "preview_ready" ? 1 : stepFromStatus(job?.status);

  const headers = job?.detectedHeaders ?? [];
  const mappedCount = headers.filter(
    (header) => (draftMapping[encodeHeaderKey(header)] ?? IGNORE_FIELD) !== IGNORE_FIELD
  ).length;

  const duplicatedTargets = useMemo(() => {
    const seen = new Map<string, number>();
    for (const header of headers) {
      const destination = draftMapping[encodeHeaderKey(header)] ?? IGNORE_FIELD;
      if (destination === IGNORE_FIELD) continue;
      seen.set(destination, (seen.get(destination) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, count]) => count > 1).map(([destination]) => destination);
  }, [headers, draftMapping]);

  // ===== Ações =====

  const handleStart = async () => {
    if (!file) return;
    setBusy(true);
    try {
      // O tipo reportado pelo navegador varia (text/plain, vnd.ms-excel, vazio):
      // como só aceitamos .csv, normalizamos para o MIME que o backend valida.
      const mimeType = "text/csv";
      const uploadUrl = await generateUploadUrl({ organizationId });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: file,
      });
      if (!response.ok) throw new Error("Falha ao enviar o arquivo");
      const { storageId } = await response.json();

      const fileId = await saveFile({
        organizationId,
        storageId,
        name: file.name,
        mimeType,
        size: file.size,
        fileType: "import_file",
      });

      const newJobId = await createImportJob({
        organizationId,
        entity,
        fileId,
        fileName: file.name,
        duplicateStrategy,
      });
      setJobId(newJobId);
      toast.success("Arquivo enviado — detectando as colunas...");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao iniciar a importação"));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveMapping = async () => {
    if (!jobId) return;
    if (mappedCount === 0) {
      toast.error("Mapeie ao menos uma coluna para continuar");
      return;
    }
    setBusy(true);
    try {
      await updateMapping({ organizationId, jobId, mapping: draftMapping });
      await runPreview({ organizationId, jobId });
      setEditingMapping(false);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao salvar o mapeamento"));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (!jobId) return;
    setBusy(true);
    try {
      await confirmImport({ organizationId, jobId });
      toast.success("Importação iniciada");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao confirmar a importação"));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!jobId) return;
    setBusy(true);
    try {
      await cancelImport({ organizationId, jobId });
      toast.success("Importação cancelada");
      resetWizard();
      onClose();
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao cancelar a importação"));
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadErrors = async () => {
    if (!jobId || !job) return;
    setBusy(true);
    try {
      const csv = await getFailedRowsCsv({ organizationId, jobId });
      if (!csv) {
        toast.info("Nenhuma linha com erro para baixar");
        return;
      }
      downloadTextFile(csv, `erros-${job.fileName}`, "text/csv;charset=utf-8");
      toast.success("Arquivo com as linhas de erro baixado");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao gerar o arquivo de erros"));
    } finally {
      setBusy(false);
    }
  };

  // ===== Render =====

  const title = job ? `Importar ${IMPORT_ENTITY_LABEL[job.entity].toLowerCase()}` : "Nova importação";
  const loadingJob = Boolean(jobId) && job === undefined;

  return (
    <Modal open={open} onClose={onClose} title={title} className="sm:max-w-3xl">
      <StepTrail current={step} />

      {loadingJob && (
        <div className="flex justify-center py-10">
          <Spinner size="lg" />
        </div>
      )}

      {!loadingJob && step === 0 && (
        <StepFile
          entity={entity}
          onEntityChange={setEntity}
          file={file}
          onFileChange={setFile}
          duplicateStrategy={duplicateStrategy}
          onStrategyChange={setDuplicateStrategy}
          busy={busy}
          onCancel={onClose}
          onStart={handleStart}
        />
      )}

      {step === 1 && job && (
        <StepMapping
          job={job}
          draftMapping={draftMapping}
          onDraftChange={setDraftMapping}
          targetOptions={targetOptions}
          customOptions={customOptions}
          mappedCount={mappedCount}
          duplicatedTargets={duplicatedTargets}
          busy={busy}
          onCancelJob={handleCancel}
          onContinue={handleSaveMapping}
        />
      )}

      {step === 2 && job && (
        <StepPreview
          job={job}
          entity={activeEntity}
          busy={busy}
          onBack={() => setEditingMapping(true)}
          onConfirm={handleConfirm}
        />
      )}

      {step === 3 && job && <StepRunning job={job} onClose={onClose} />}

      {step === 4 && job && (
        <StepResult
          job={job}
          busy={busy}
          onDownloadErrors={handleDownloadErrors}
          onRestart={resetWizard}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

// ===== Passo 1 — entidade, arquivo e estratégia =====

const ENTITY_CHOICES: Array<{
  value: ImportEntity;
  label: string;
  description: string;
  icon: typeof Users;
}> = [
  {
    value: "contacts",
    label: "Contatos",
    description: "Pessoas: nome, e-mail, telefone, empresa e campos personalizados.",
    icon: Users,
  },
  {
    value: "leads",
    label: "Leads",
    description: "Negócios no funil: título, valor, estágio e contato vinculado.",
    icon: Target,
  },
];

const STRATEGY_CHOICES: Array<{
  value: DuplicateStrategy;
  label: string;
  description: string;
}> = [
  {
    value: "skip",
    label: "Pular duplicados",
    description: "Mantém o registro que já existe e ignora a linha do arquivo.",
  },
  {
    value: "update",
    label: "Atualizar duplicados",
    description: "Completa o registro existente com os dados do arquivo.",
  },
  {
    value: "create",
    label: "Criar sempre",
    description: "Cria um novo registro mesmo que já exista um parecido.",
  },
];

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

function StepFile({
  entity,
  onEntityChange,
  file,
  onFileChange,
  duplicateStrategy,
  onStrategyChange,
  busy,
  onCancel,
  onStart,
}: {
  entity: ImportEntity;
  onEntityChange: (entity: ImportEntity) => void;
  file: File | null;
  onFileChange: (file: File | null) => void;
  duplicateStrategy: DuplicateStrategy;
  onStrategyChange: (strategy: DuplicateStrategy) => void;
  busy: boolean;
  onCancel: () => void;
  onStart: () => void;
}) {
  const oversize = file !== null && file.size > MAX_IMPORT_BYTES;

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-text-secondary">
          O que você quer importar?
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ENTITY_CHOICES.map((choice) => {
            const selected = entity === choice.value;
            const Icon = choice.icon;
            return (
              <button
                key={choice.value}
                type="button"
                onClick={() => onEntityChange(choice.value)}
                aria-pressed={selected}
                className={cn(
                  "flex items-start gap-3 rounded-card border p-3 text-left transition-colors",
                  "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-overlay",
                  selected
                    ? "border-brand-500 bg-brand-500/10"
                    : "border-border bg-surface-sunken hover:bg-surface-raised"
                )}
              >
                <Icon size={20} className={cn("mt-0.5 shrink-0", selected ? "text-brand-500" : "text-text-muted")} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text-primary">{choice.label}</span>
                  <span className="block text-xs text-text-secondary">{choice.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div>
        <p className="mb-2 text-[13px] font-medium text-text-secondary">Arquivo CSV</p>
        <FileDropZone
          file={file}
          onFileChange={onFileChange}
          accept=".csv"
          maxSizeBytes={MAX_IMPORT_BYTES}
          disabled={busy}
          hint="Somente .csv · até 10 MB · máximo de 10.000 linhas"
        />
        <p className="mt-2 text-xs text-text-muted">
          A primeira linha precisa conter os nomes das colunas. Aceitamos separador vírgula ou ponto e
          vírgula, datas em dd/mm/aaaa ou aaaa-mm-dd e listas separadas por ponto e vírgula.
        </p>
      </div>

      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-text-secondary">
          Quando o registro já existir
        </legend>
        <div className="space-y-2">
          {STRATEGY_CHOICES.map((choice) => {
            const selected = duplicateStrategy === choice.value;
            return (
              <label
                key={choice.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                  selected
                    ? "border-brand-500 bg-brand-500/10"
                    : "border-border bg-surface-sunken hover:bg-surface-raised"
                )}
              >
                <input
                  type="radio"
                  name="duplicate-strategy"
                  value={choice.value}
                  checked={selected}
                  disabled={busy}
                  onChange={() => onStrategyChange(choice.value)}
                  className="mt-1 h-4 w-4 shrink-0 accent-brand-600"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text-primary">{choice.label}</span>
                  <span className="block text-xs text-text-secondary">{choice.description}</span>
                </span>
              </label>
            );
          })}
        </div>
        {entity === "leads" && (
          <p className="mt-2 text-xs text-text-muted">
            Em leads a regra vale para o contato vinculado — o negócio é sempre criado.
          </p>
        )}
      </fieldset>

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={busy} className="sm:w-auto">
          Cancelar
        </Button>
        <Button onClick={onStart} disabled={busy || !file || oversize} className="sm:w-auto">
          {busy ? <Spinner size="sm" /> : "Enviar e mapear"}
        </Button>
      </div>
    </div>
  );
}

// ===== Passo 2 — mapeamento =====

function StepMapping({
  job,
  draftMapping,
  onDraftChange,
  targetOptions,
  customOptions,
  mappedCount,
  duplicatedTargets,
  busy,
  onCancelJob,
  onContinue,
}: {
  job: ImportJobDoc;
  draftMapping: Record<string, string>;
  onDraftChange: (mapping: Record<string, string>) => void;
  targetOptions: Array<{ field: string; label: string }>;
  customOptions: ImportFieldDef[];
  mappedCount: number;
  duplicatedTargets: string[];
  busy: boolean;
  onCancelJob: () => void;
  onContinue: () => void;
}) {
  const headers = job.detectedHeaders;

  if (!headers) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <Spinner size="lg" />
        <p className="text-sm text-text-secondary">Lendo o arquivo e detectando as colunas...</p>
      </div>
    );
  }

  const labelForDestination = (destination: string): string => {
    if (destination.startsWith(CUSTOM_FIELD_PREFIX)) {
      const key = destination.slice(CUSTOM_FIELD_PREFIX.length);
      const def = customOptions.find((option) => option.key === key);
      return def ? `${def.name} (personalizado)` : key;
    }
    return targetOptions.find((option) => option.field === destination)?.label ?? destination;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">
          Confira para onde vai cada coluna de{" "}
          <span className="font-medium text-text-primary">{job.fileName}</span>.
        </p>
        <Badge variant={mappedCount > 0 ? "success" : "warning"}>
          {formatCount(mappedCount)} de {formatCount(headers.length)} colunas mapeadas
        </Badge>
      </div>

      {duplicatedTargets.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/5 px-3 py-2 text-xs text-semantic-warning">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          Mais de uma coluna aponta para {duplicatedTargets.map(labelForDestination).join(", ")}. Só a
          última será usada.
        </p>
      )}

      <div className="space-y-2">
        {headers.map((header) => {
          const key = encodeHeaderKey(header);
          const value = draftMapping[key] ?? IGNORE_FIELD;
          const ignored = value === IGNORE_FIELD;
          const suggested = job.suggestedMapping?.[key];
          const isSuggested = !ignored && suggested === value;

          return (
            <div
              key={key}
              className={cn(
                "flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:gap-3",
                ignored
                  ? "border-semantic-warning/40 bg-semantic-warning/5"
                  : "border-semantic-success/40 bg-semantic-success/5"
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary" title={header}>
                  {header}
                </p>
                <p className="text-xs text-text-muted">
                  {ignored
                    ? "Não será importada"
                    : isSuggested
                      ? "Sugestão automática"
                      : "Definida por você"}
                </p>
              </div>

              <ArrowRight size={16} className="hidden shrink-0 text-text-muted sm:block" />

              <select
                value={value}
                disabled={busy}
                aria-label={`Destino da coluna ${header}`}
                onChange={(event) =>
                  onDraftChange({ ...draftMapping, [key]: event.target.value })
                }
                className="w-full rounded-field border border-border-strong bg-surface-raised px-3 py-2.5 text-base text-text-primary focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 sm:w-64 md:text-sm"
              >
                <option value={IGNORE_FIELD}>Ignorar esta coluna</option>
                <optgroup label="Campos padrão">
                  {targetOptions.map((option) => (
                    <option key={option.field} value={option.field}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
                {customOptions.length > 0 && (
                  <optgroup label="Campos personalizados">
                    {customOptions.map((option) => (
                      <option
                        key={option.key}
                        value={`${CUSTOM_FIELD_PREFIX}${option.key}`}
                      >
                        {option.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-between">
        <Button variant="secondary" onClick={onCancelJob} disabled={busy} className="sm:w-auto">
          Cancelar importação
        </Button>
        <Button onClick={onContinue} disabled={busy || mappedCount === 0} className="sm:w-auto">
          {busy ? <Spinner size="sm" /> : "Pré-visualizar"}
        </Button>
      </div>
    </div>
  );
}

// ===== Passo 3 — dry-run =====

function SummaryCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "warning" | "error" | "brand";
}) {
  const toneClass = {
    default: "text-text-primary",
    success: "text-semantic-success",
    warning: "text-semantic-warning",
    error: "text-semantic-error",
    brand: "text-brand-500",
  }[tone];

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={cn("text-lg font-semibold tabular-nums", toneClass)}>{formatCount(value)}</p>
    </div>
  );
}

function StepPreview({
  job,
  entity,
  busy,
  onBack,
  onConfirm,
}: {
  job: ImportJobDoc;
  entity: ImportEntity;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const targets = useMemo(() => listImportTargets(entity), [entity]);

  if (job.status === "previewing" || !job.dryRun) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <Spinner size="lg" />
        <p className="text-sm text-text-secondary">Validando as linhas do arquivo...</p>
      </div>
    );
  }

  const dryRun = job.dryRun;
  const previewColumns: string[] = [];
  for (const row of dryRun.preview) {
    for (const key of Object.keys(row)) {
      if (previewColumns.includes(key)) continue;
      if (dryRun.preview.every((item) => isEmptyPreviewValue(item[key]))) continue;
      previewColumns.push(key);
    }
  }
  previewColumns.sort((a, b) => {
    const order = (key: string) => (key === "linha" ? 0 : key === "erro" ? 1 : 2);
    return order(a) - order(b);
  });

  const columnLabel = (key: string): string =>
    PREVIEW_LABEL_OVERRIDES[key] ??
    targets.find((target) => target.field === key)?.label ??
    key;

  const visibleErrors = dryRun.sampleErrors.slice(0, 8);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <SummaryCard label="Linhas no arquivo" value={dryRun.totalRows} />
        <SummaryCard label="Linhas válidas" value={dryRun.validRows} tone="success" />
        <SummaryCard label="Linhas com erro" value={dryRun.errorRows} tone={dryRun.errorRows > 0 ? "error" : "default"} />
        <SummaryCard label="Serão criados" value={dryRun.newRows} tone="brand" />
        <SummaryCard label="Serão atualizados" value={dryRun.updateRows} />
        <SummaryCard label="Serão pulados" value={dryRun.skipRows} tone={dryRun.skipRows > 0 ? "warning" : "default"} />
      </div>

      {dryRun.preview.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-text-primary">
            Prévia das primeiras {formatCount(dryRun.preview.length)} linhas
          </h4>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-surface-sunken">
                <tr>
                  {previewColumns.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      className="whitespace-nowrap px-3 py-2 font-medium text-text-secondary"
                    >
                      {columnLabel(column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dryRun.preview.map((row, index) => (
                  <tr key={index} className="border-t border-border-subtle">
                    {previewColumns.map((column) => (
                      <td
                        key={column}
                        className={cn(
                          "max-w-[220px] truncate px-3 py-2",
                          column === "erro" ? "text-semantic-error" : "text-text-secondary",
                          column === "linha" && "tabular-nums text-text-muted"
                        )}
                        title={formatPreviewValue(row[column])}
                      >
                        {formatPreviewValue(row[column])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {visibleErrors.length > 0 && (
        <div className="rounded-lg border border-semantic-error/30 bg-semantic-error/5 p-3">
          <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-semantic-error">
            <AlertTriangle size={16} />
            Erros encontrados
          </h4>
          <ul className="space-y-1 text-xs text-text-secondary">
            {visibleErrors.map((error, index) => (
              <li key={`${error.row}-${index}`}>
                <span className="font-medium text-text-primary">Linha {error.row}</span>
                {error.field ? ` · ${error.field}` : ""} — {error.message}
              </li>
            ))}
          </ul>
          {dryRun.sampleErrors.length > visibleErrors.length && (
            <p className="mt-2 text-xs text-text-muted">
              e mais {formatCount(dryRun.sampleErrors.length - visibleErrors.length)} erro(s) na
              amostra. As linhas com erro são puladas na importação.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-between">
        <Button variant="secondary" onClick={onBack} disabled={busy} className="sm:w-auto">
          Ajustar colunas
        </Button>
        <Button onClick={onConfirm} disabled={busy || dryRun.validRows === 0} className="sm:w-auto">
          {busy ? <Spinner size="sm" /> : `Importar ${formatCount(dryRun.validRows)} linha(s)`}
        </Button>
      </div>
    </div>
  );
}

// ===== Passo 4 — execução =====

export function ImportProgressBar({ processed, total }: { processed: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Progresso da importação"
    >
      <div
        className="h-1.5 rounded-full bg-brand-500 transition-all duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function StepRunning({ job, onClose }: { job: ImportJobDoc; onClose: () => void }) {
  const { processed, total, created, updated, skipped, failed } = job.progress;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Spinner />
        <div>
          <p className="text-sm font-medium text-text-primary">Importando {job.fileName}</p>
          <p className="text-xs text-text-muted tabular-nums">
            {formatCount(processed)} de {formatCount(total)} linhas processadas
          </p>
        </div>
      </div>

      <ImportProgressBar processed={processed} total={total} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard label="Criados" value={created} tone="success" />
        <SummaryCard label="Atualizados" value={updated} />
        <SummaryCard label="Pulados" value={skipped} tone={skipped > 0 ? "warning" : "default"} />
        <SummaryCard label="Com erro" value={failed} tone={failed > 0 ? "error" : "default"} />
      </div>

      <p className="text-xs text-text-muted">
        Você pode fechar esta janela — a importação continua em segundo plano e o histórico é
        atualizado sozinho.
      </p>

      <div className="flex justify-end border-t border-border pt-4">
        <Button variant="secondary" onClick={onClose}>
          Fechar
        </Button>
      </div>
    </div>
  );
}

// ===== Passo 5 — resultado =====

function StepResult({
  job,
  busy,
  onDownloadErrors,
  onRestart,
  onClose,
}: {
  job: ImportJobDoc;
  busy: boolean;
  onDownloadErrors: () => void;
  onRestart: () => void;
  onClose: () => void;
}) {
  const meta = importStatusMeta(job.status);
  const failedRows = job.progress.failed;
  const success = job.status === "completed";
  const partial = job.status === "completed_with_errors";

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        {success ? (
          <CheckCircle2 size={28} className="shrink-0 text-semantic-success" />
        ) : partial ? (
          <AlertTriangle size={28} className="shrink-0 text-semantic-warning" />
        ) : (
          <XCircle size={28} className="shrink-0 text-semantic-error" />
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-text-primary">{job.fileName}</p>
            <Badge variant={meta.variant}>{meta.label}</Badge>
          </div>
          <p className="text-xs text-text-muted">
            {IMPORT_ENTITY_LABEL[job.entity]} ·{" "}
            {DUPLICATE_STRATEGY_LABEL[job.duplicateStrategy].toLowerCase()}
          </p>
        </div>
      </div>

      {job.error && (
        <p className="rounded-lg border border-semantic-error/30 bg-semantic-error/5 px-3 py-2 text-xs text-semantic-error">
          {job.error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard label="Criados" value={job.progress.created} tone="success" />
        <SummaryCard label="Atualizados" value={job.progress.updated} />
        <SummaryCard
          label="Pulados"
          value={job.progress.skipped}
          tone={job.progress.skipped > 0 ? "warning" : "default"}
        />
        <SummaryCard label="Com erro" value={failedRows} tone={failedRows > 0 ? "error" : "default"} />
      </div>

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row">
          {failedRows > 0 && (
            <Button variant="secondary" onClick={onDownloadErrors} disabled={busy}>
              <Download size={16} />
              Baixar linhas com erro
            </Button>
          )}
          <Button variant="ghost" onClick={onRestart} disabled={busy}>
            <RotateCcw size={16} />
            Nova importação
          </Button>
        </div>
        <Button onClick={onClose} disabled={busy}>
          Concluir
        </Button>
      </div>
    </div>
  );
}
