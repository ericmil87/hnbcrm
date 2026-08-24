import { useState } from "react";
import { useOutletContext, useParams, useNavigate } from "react-router";
import { useQuery, usePaginatedQuery, type PaginatedQueryReference } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Inbox,
  Clock,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type SubmissionStatus = "processed" | "spam" | "error";

interface FormSubmission {
  _id: Id<"formSubmissions">;
  formId: Id<"forms">;
  organizationId: Id<"organizations">;
  data: Record<string, unknown>;
  processingStatus: SubmissionStatus;
  leadId?: Id<"leads">;
  contactId?: Id<"contacts">;
  ipAddress?: string;
  userAgent?: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  honeypotTriggered: boolean;
  createdAt: number;
}

interface FormDoc {
  _id: Id<"forms">;
  name: string;
  submissionCount?: number;
  fields?: Array<{
    id: string;
    type: string;
    label: string;
    crmMapping?: { entity: string; field: string };
  }>;
}

type StatusFilter = "all" | SubmissionStatus;
type MainTab = "submissions" | "partials";

interface PartialSubmission {
  _id: string;
  formId: string;
  sessionId: string;
  status: "in_progress" | "abandoned" | "converted";
  data: Record<string, unknown>;
  completedFieldIds: string[];
  totalFields: number;
  completionPercent: number;
  currentStep?: number;
  firstInteractionAt: number;
  lastActivityAt: number;
  convertedAt?: number;
}

type PartialStatusFilter = "all" | "in_progress" | "abandoned" | "converted";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/**
 * Tries to extract a readable name and email from a submission's data object.
 * Priority: CRM-mapped firstName/email fields, then first string values found.
 */
function extractNameAndEmail(
  data: Record<string, unknown>,
  fields?: FormDoc["fields"]
): { name: string | null; email: string | null } {
  let name: string | null = null;
  let email: string | null = null;

  if (fields && fields.length > 0) {
    for (const field of fields) {
      const value = data[field.id];
      if (typeof value !== "string" || !value) continue;

      if (field.crmMapping?.field === "firstName" && !name) {
        name = value;
      } else if (field.crmMapping?.field === "email" && !email) {
        email = value;
      }
    }
  }

  // Fallback: scan all string values
  if (!name || !email) {
    for (const [, value] of Object.entries(data)) {
      if (typeof value !== "string" || !value) continue;
      if (!email && value.includes("@") && value.includes(".")) {
        email = value;
      } else if (!name) {
        name = value;
      }
      if (name && email) break;
    }
  }

  return { name, email };
}

function statusConfig(status: SubmissionStatus): {
  label: string;
  variant: "success" | "warning" | "error";
} {
  switch (status) {
    case "processed":
      return { label: "Processado", variant: "success" };
    case "spam":
      return { label: "Spam", variant: "warning" };
    case "error":
      return { label: "Erro", variant: "error" };
  }
}

function partialStatusConfig(status: PartialSubmission["status"]): {
  label: string;
  variant: "info" | "warning" | "success";
} {
  switch (status) {
    case "in_progress":
      return { label: "Em progresso", variant: "info" };
    case "abandoned":
      return { label: "Abandonado", variant: "warning" };
    case "converted":
      return { label: "Convertido", variant: "success" };
  }
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes}min atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h atrás`;
  const days = Math.floor(hours / 24);
  return `${days}d atrás`;
}

// ── Filter tabs ───────────────────────────────────────────────────────────────

const STATUS_TABS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "Todas" },
  { key: "processed", label: "Processadas" },
  { key: "spam", label: "Spam" },
  { key: "error", label: "Erros" },
];

const PARTIAL_STATUS_TABS: Array<{ key: PartialStatusFilter; label: string }> = [
  { key: "all", label: "Todos" },
  { key: "in_progress", label: "Em progresso" },
  { key: "abandoned", label: "Abandonados" },
  { key: "converted", label: "Convertidos" },
];

// ── CSV export ────────────────────────────────────────────────────────────────

function exportToCsv(
  submissions: FormSubmission[],
  formName: string,
  fields?: FormDoc["fields"]
): void {
  if (submissions.length === 0) return;

  // Gather all unique data keys across submissions
  const dataKeys = Array.from(
    new Set(submissions.flatMap((s) => Object.keys(s.data)))
  );

  // Build header with human-readable field labels when available
  const fieldLabelMap: Record<string, string> = {};
  if (fields) {
    for (const f of fields) {
      fieldLabelMap[f.id] = f.label;
    }
  }

  const headers = [
    "Data",
    "Status",
    ...dataKeys.map((k) => fieldLabelMap[k] ?? k),
    "Lead",
  ];

  const escape = (val: unknown): string => {
    const str = val == null ? "" : String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = submissions.map((s) => {
    const { label } = statusConfig(s.processingStatus);
    return [
      escape(formatDate(s.createdAt)),
      escape(label),
      ...dataKeys.map((k) => escape(s.data[k])),
      escape(s.leadId ? "Sim" : "Não"),
    ].join(",");
  });

  const csvContent = [headers.map(escape).join(","), ...rows].join("\n");
  const bom = "\uFEFF"; // UTF-8 BOM for Excel compatibility
  const blob = new Blob([bom + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `submissoes-${formName.replace(/\s+/g, "-").toLowerCase()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ── Row component ─────────────────────────────────────────────────────────────

interface SubmissionRowProps {
  submission: FormSubmission;
  fields?: FormDoc["fields"];
  isExpanded: boolean;
  onToggle: () => void;
}

function SubmissionRow({
  submission,
  fields,
  isExpanded,
  onToggle,
}: SubmissionRowProps) {
  const navigate = useNavigate();
  const { name, email } = extractNameAndEmail(submission.data, fields);
  const { label, variant } = statusConfig(submission.processingStatus);

  // All data key-value pairs for expanded view, skipping empty values
  const dataEntries = Object.entries(submission.data).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );

  // Build a label for each field key
  const fieldLabelMap: Record<string, string> = {};
  if (fields) {
    for (const f of fields) {
      fieldLabelMap[f.id] = f.label;
    }
  }

  return (
    <>
      {/* Main row — always visible */}
      <tr
        className={cn(
          "border-b border-border-subtle transition-colors cursor-pointer",
          "hover:bg-surface-overlay",
          isExpanded && "bg-surface-overlay"
        )}
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        {/* Data */}
        <td className="px-4 py-3 whitespace-nowrap">
          <span className="text-sm text-text-secondary tabular-nums">
            {formatDate(submission.createdAt)}
          </span>
        </td>

        {/* Nome / Email */}
        <td className="px-4 py-3 min-w-0">
          <div className="flex flex-col gap-0.5">
            {name ? (
              <span className="text-sm font-medium text-text-primary truncate max-w-[200px]">
                {name}
              </span>
            ) : (
              <span className="text-sm text-text-muted italic">
                Sem nome
              </span>
            )}
            {email && (
              <span className="text-xs text-text-muted truncate max-w-[200px]">
                {email}
              </span>
            )}
          </div>
        </td>

        {/* Status */}
        <td className="px-4 py-3 whitespace-nowrap">
          <Badge variant={variant}>{label}</Badge>
        </td>

        {/* Lead link */}
        <td className="px-4 py-3 whitespace-nowrap">
          {submission.leadId ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate("/app/pipeline");
              }}
              aria-label="Abrir lead no pipeline"
              className={cn(
                "inline-flex items-center gap-1.5 text-xs font-medium",
                "text-brand-400 hover:text-brand-500 transition-colors",
                "min-h-[44px] min-w-[44px] justify-center",
                "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-raised rounded"
              )}
            >
              <ExternalLink size={14} />
              <span className="hidden sm:inline">Ver lead</span>
            </button>
          ) : (
            <span className="text-xs text-text-muted">—</span>
          )}
        </td>

        {/* Expand toggle */}
        <td className="px-4 py-3 whitespace-nowrap">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-label={isExpanded ? "Recolher detalhes" : "Expandir detalhes"}
            className={cn(
              "inline-flex items-center justify-center rounded-full transition-colors",
              "min-h-[44px] min-w-[44px]",
              "text-text-muted hover:text-text-primary hover:bg-surface-overlay",
              "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-raised"
            )}
          >
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </td>
      </tr>

      {/* Expanded detail row */}
      {isExpanded && (
        <tr className="border-b border-border-subtle bg-surface-sunken">
          <td colSpan={5} className="px-4 py-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {dataEntries.length === 0 ? (
                <p className="text-sm text-text-muted col-span-full">
                  Nenhum dado disponível nesta submissão.
                </p>
              ) : (
                dataEntries.map(([key, value]) => (
                  <div key={key} className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                      {fieldLabelMap[key] ?? key}
                    </span>
                    <span className="text-sm text-text-primary break-words">
                      {typeof value === "boolean"
? value
                        ? "Sim"
                        : "Não"
                      : String(value)}
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* Metadata row */}
            {(submission.ipAddress ||
              submission.referrer ||
              submission.utmSource) && (
              <div className="mt-4 pt-4 border-t border-border-subtle flex flex-wrap gap-4">
                {submission.ipAddress && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                      IP
                    </span>
                    <span className="text-xs text-text-secondary tabular-nums">
                      {submission.ipAddress}
                    </span>
                  </div>
                )}
                {submission.referrer && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                      Origem
                    </span>
                    <span className="text-xs text-text-secondary truncate max-w-[240px]">
                      {submission.referrer}
                    </span>
                  </div>
                )}
                {submission.utmSource && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                      UTM Source
                    </span>
                    <span className="text-xs text-text-secondary">
                      {submission.utmSource}
                    </span>
                  </div>
                )}
                {submission.utmMedium && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                      UTM Medium
                    </span>
                    <span className="text-xs text-text-secondary">
                      {submission.utmMedium}
                    </span>
                  </div>
                )}
                {submission.utmCampaign && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                      UTM Campaign
                    </span>
                    <span className="text-xs text-text-secondary">
                      {submission.utmCampaign}
                    </span>
                  </div>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Mobile card component ─────────────────────────────────────────────────────

interface SubmissionCardProps {
  submission: FormSubmission;
  fields?: FormDoc["fields"];
  isExpanded: boolean;
  onToggle: () => void;
}

function SubmissionCard({
  submission,
  fields,
  isExpanded,
  onToggle,
}: SubmissionCardProps) {
  const navigate = useNavigate();
  const { name, email } = extractNameAndEmail(submission.data, fields);
  const { label, variant } = statusConfig(submission.processingStatus);

  const dataEntries = Object.entries(submission.data).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );

  const fieldLabelMap: Record<string, string> = {};
  if (fields) {
    for (const f of fields) {
      fieldLabelMap[f.id] = f.label;
    }
  }

  return (
    <article
      className={cn(
        "rounded-card border border-border bg-surface-raised shadow-card",
        "transition-all duration-150"
      )}
    >
      {/* Card header — always visible */}
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-start gap-3 p-4 text-left",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base rounded-card"
        )}
        aria-expanded={isExpanded}
      >
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={variant}>{label}</Badge>
            <span className="text-xs text-text-muted tabular-nums">
              {formatDate(submission.createdAt)}
            </span>
          </div>
          {name ? (
            <p className="text-sm font-medium text-text-primary truncate">
              {name}
            </p>
          ) : (
            <p className="text-sm text-text-muted italic">Sem nome</p>
          )}
          {email && (
            <p className="text-xs text-text-muted truncate">{email}</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 mt-1">
          {submission.leadId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate("/app/pipeline");
              }}
              aria-label="Abrir lead no pipeline"
              className={cn(
                "inline-flex items-center justify-center rounded-full",
                "min-h-[44px] min-w-[44px]",
                "text-brand-400 hover:text-brand-500 hover:bg-brand-500/10 transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-raised"
              )}
            >
              <ExternalLink size={16} />
            </button>
          )}
          <span className="text-text-muted">
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </div>
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div className="px-4 pb-4 border-t border-border-subtle pt-4">
          <div className="grid grid-cols-1 gap-3">
            {dataEntries.length === 0 ? (
              <p className="text-sm text-text-muted">
                Nenhum dado disponível nesta submissão.
              </p>
            ) : (
              dataEntries.map(([key, value]) => (
                <div key={key} className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                    {fieldLabelMap[key] ?? key}
                  </span>
                  <span className="text-sm text-text-primary break-words">
                    {typeof value === "boolean"
                      ? value
                        ? "Sim"
                        : "Não"
                      : String(value)}
                  </span>
                </div>
              ))
            )}
          </div>

          {(submission.ipAddress ||
            submission.referrer ||
            submission.utmSource) && (
            <div className="mt-4 pt-4 border-t border-border-subtle flex flex-col gap-3">
              {submission.ipAddress && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                    IP
                  </span>
                  <span className="text-xs text-text-secondary tabular-nums">
                    {submission.ipAddress}
                  </span>
                </div>
              )}
              {submission.referrer && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                    Origem
                  </span>
                  <span className="text-xs text-text-secondary break-all">
                    {submission.referrer}
                  </span>
                </div>
              )}
              {submission.utmSource && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                    UTM Source
                  </span>
                  <span className="text-xs text-text-secondary">
                    {submission.utmSource}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

export function FormSubmissionsPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();

  const [mainTab, setMainTab] = useState<MainTab>("submissions");
  const [activeFilter, setActiveFilter] = useState<StatusFilter>("all");
  const [partialFilter, setPartialFilter] = useState<PartialStatusFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedPartialId, setExpandedPartialId] = useState<string | null>(null);

  const typedFormId = formId as Id<"forms"> | undefined;

  // Fetch form metadata (name + fields)
  const form = useQuery(
    api.forms.getForm,
    typedFormId ? { formId: typedFormId } : "skip"
  ) as FormDoc | null | undefined;

  // Paginated submissions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paginatedRef = api.formSubmissions.getFormSubmissionsPaginated as unknown as PaginatedQueryReference;
  const { results, status, loadMore } = usePaginatedQuery(
    paginatedRef,
    typedFormId
      ? {
          formId: typedFormId,
          organizationId,
          status:
            activeFilter !== "all"
              ? (activeFilter as SubmissionStatus)
              : undefined,
        }
      : "skip",
    { initialNumItems: PAGE_SIZE }
  );

  const submissions = results as FormSubmission[];

  // Partial submissions
  const partialsRaw = useQuery(
    api.formPartials.getFormPartials,
    typedFormId
      ? {
          organizationId,
          formId: typedFormId,
          status: partialFilter !== "all" ? partialFilter : undefined,
        }
      : "skip"
  );
  const partials = (partialsRaw ?? []) as PartialSubmission[];

  const partialStats = useQuery(
    api.formPartials.getPartialStats,
    typedFormId
      ? { organizationId, formId: typedFormId }
      : "skip"
  );

  function handleToggleRow(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  function handleFilterChange(filter: StatusFilter) {
    setActiveFilter(filter);
    setExpandedId(null);
  }

  function handleExportCsv() {
    exportToCsv(submissions, form?.name ?? "formulario", form?.fields);
  }

  const isLoadingForm = form === undefined;
  const isLoadingSubmissions = status === "LoadingFirstPage";
  const isLoading = isLoadingForm || isLoadingSubmissions;

  // Guard: invalid formId
  if (!typedFormId) {
    return (
      <main className="min-h-screen bg-surface-base flex items-center justify-center px-4">
        <p className="text-text-secondary text-sm">
          Formulário não encontrado.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-surface-base">
      <div className="max-w-6xl mx-auto px-4 py-6 md:px-6 md:py-8">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="flex items-start gap-3 mb-6 md:mb-8">
          <button
            onClick={() => navigate(`/app/formularios/${formId}`)}
            aria-label="Voltar para o formulário"
            className={cn(
              "inline-flex items-center justify-center rounded-full shrink-0",
              "min-h-[44px] min-w-[44px]",
              "text-text-secondary hover:text-text-primary hover:bg-surface-raised",
              "transition-colors border border-border",
              "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
            )}
          >
            <ArrowLeft size={18} />
          </button>

          <div className="flex-1 min-w-0">
            {isLoadingForm ? (
              <div className="space-y-2">
                <div className="h-6 w-48 bg-surface-raised rounded animate-pulse" />
                <div className="h-4 w-24 bg-surface-raised rounded animate-pulse" />
              </div>
            ) : form === null ? (
              <p className="text-text-muted text-sm">
                Formulário não encontrado.
              </p>
            ) : (
              <>
                <h1 className="text-lg font-bold text-text-primary md:text-xl truncate">
                  {form.name}
                </h1>
                <p className="text-sm text-text-secondary mt-0.5 tabular-nums">
                  {(form.submissionCount ?? 0).toLocaleString("pt-BR")}{" "}
                  {(form.submissionCount ?? 0) === 1
                    ? "submissão"
                    : "submissões"}{" "}
                  no total
                </p>
              </>
            )}
          </div>

          {/* CSV export */}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportCsv}
            disabled={submissions.length === 0}
            aria-label="Exportar submissões visíveis para CSV"
            className="shrink-0"
          >
            <Download size={16} />
            <span className="hidden sm:inline">Exportar CSV</span>
          </Button>
        </header>

        {/* ── Main tab switcher (Submissoes / Parciais) ─────────────────── */}
        <div className="flex gap-1 mb-4 border-b border-border">
          <button
            onClick={() => { setMainTab("submissions"); setExpandedId(null); }}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-all duration-150 border-b-2 -mb-px",
              "focus:outline-none",
              mainTab === "submissions"
                ? "border-brand-500 text-brand-400"
                : "border-transparent text-text-secondary hover:text-text-primary"
            )}
          >
            Submissões
          </button>
          <button
            onClick={() => { setMainTab("partials"); setExpandedPartialId(null); }}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-all duration-150 border-b-2 -mb-px",
              "focus:outline-none flex items-center gap-2",
              mainTab === "partials"
                ? "border-brand-500 text-brand-400"
                : "border-transparent text-text-secondary hover:text-text-primary"
            )}
          >
            Parciais
            {partialStats && partialStats.total > 0 && (
              <span className={cn(
                "inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-bold",
                mainTab === "partials"
                  ? "bg-brand-500/20 text-brand-400"
                  : "bg-surface-overlay text-text-muted"
              )}>
                {partialStats.total}
              </span>
            )}
          </button>
        </div>

        {/* ── Submissions tab content ────────────────────────────────────── */}
        {mainTab === "submissions" && (
          <>
        {/* ── Status filter tabs ──────────────────────────────────────────── */}
        <nav
          aria-label="Filtrar submissões por status"
          className="flex gap-1 mb-5 overflow-x-auto scrollbar-none"
        >
          {STATUS_TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleFilterChange(key)}
              aria-current={activeFilter === key ? "true" : undefined}
              className={cn(
                "px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-150",
                "min-h-[40px]",
                "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
                activeFilter === key
                  ? "bg-brand-600 text-white"
                  : "bg-surface-raised border border-border text-text-secondary hover:text-text-primary hover:border-border-strong"
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* ── Loading state ───────────────────────────────────────────────── */}
        {isLoading && (
          <div className="flex items-center justify-center py-24">
            <Spinner size="lg" />
          </div>
        )}

        {/* ── Error: form not found ───────────────────────────────────────── */}
        {!isLoadingForm && form === null && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <p className="text-text-secondary text-sm">
              Formulário não encontrado ou você não tem permissão para visualizá-lo.
            </p>
          </div>
        )}

        {/* ── Empty state ─────────────────────────────────────────────────── */}
        {!isLoading && form !== null && submissions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-surface-raised border border-border flex items-center justify-center mb-4">
              <Inbox size={28} className="text-text-muted" />
            </div>
            <h2 className="text-base font-semibold text-text-primary mb-1">
              {activeFilter === "all"
                ? "Nenhuma submissão ainda"
                : "Nenhuma submissão com este filtro"}
            </h2>
            <p className="text-sm text-text-secondary max-w-xs">
              {activeFilter === "all"
                ? "Quando alguém preencher o formulário, as submissões aparecerão aqui."
                : "Tente selecionar outro filtro de status."}
            </p>
          </div>
        )}

        {/* ── Desktop table ────────────────────────────────────────────────── */}
        {!isLoading && form !== null && submissions.length > 0 && (
          <>
            {/* Table — hidden on mobile */}
            <div className="hidden md:block rounded-card bg-surface-raised border border-border shadow-card overflow-hidden">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th
                      scope="col"
                      className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide whitespace-nowrap"
                    >
                      Data
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide"
                    >
                      Nome / Email
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide whitespace-nowrap"
                    >
                      Status
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide whitespace-nowrap"
                    >
                      Lead
                    </th>
                    <th scope="col" className="px-4 py-3 w-12">
                      <span className="sr-only">Expandir</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((submission) => (
                    <SubmissionRow
                      key={submission._id}
                      submission={submission}
                      fields={form.fields}
                      isExpanded={expandedId === submission._id}
                      onToggle={() => handleToggleRow(submission._id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile card list — visible only on mobile */}
            <div className="md:hidden space-y-3">
              {submissions.map((submission) => (
                <SubmissionCard
                  key={submission._id}
                  submission={submission}
                  fields={form.fields}
                  isExpanded={expandedId === submission._id}
                  onToggle={() => handleToggleRow(submission._id)}
                />
              ))}
            </div>

            {/* ── Load more ──────────────────────────────────────────────── */}
            {status !== "Exhausted" && (
              <div className="flex justify-center mt-6">
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => loadMore(PAGE_SIZE)}
                  disabled={status === "LoadingMore"}
                  aria-label="Carregar mais submissões"
                >
                  {status === "LoadingMore" ? (
                    <>
                      <Spinner size="sm" />
                      Carregando...
                    </>
                  ) : (
                    "Carregar mais"
                  )}
                </Button>
              </div>
            )}

            {/* Count summary */}
            <p className="text-center text-xs text-text-muted mt-4 tabular-nums">
              {submissions.length.toLocaleString("pt-BR")}{" "}
              {submissions.length === 1
                ? "submissão exibida"
                : "submissões exibidas"}
            </p>
          </>
        )}
          </>
        )}

        {/* ── Partials tab content ──────────────────────────────────────── */}
        {mainTab === "partials" && (
          <>
            {/* Stats bar */}
            {partialStats && partialStats.total > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                <StatCard label="Total" value={partialStats.total} />
                <StatCard label="Abandonados" value={partialStats.abandoned} />
                <StatCard label="Convertidos" value={partialStats.converted} />
                <StatCard
                  label="Taxa de conversão"
                  value={`${Math.round(partialStats.conversionRate)}%`}
                />
              </div>
            )}

            {/* Partial filter tabs */}
            <nav
              aria-label="Filtrar parciais por status"
              className="flex gap-1 mb-5 overflow-x-auto scrollbar-none"
            >
              {PARTIAL_STATUS_TABS.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => { setPartialFilter(key); setExpandedPartialId(null); }}
                  aria-current={partialFilter === key ? "true" : undefined}
                  className={cn(
                    "px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-150",
                    "min-h-[40px]",
                    "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
                    partialFilter === key
                      ? "bg-brand-600 text-white"
                      : "bg-surface-raised border border-border text-text-secondary hover:text-text-primary hover:border-border-strong"
                  )}
                >
                  {label}
                </button>
              ))}
            </nav>

            {/* Loading */}
            {partialsRaw === undefined && (
              <div className="flex items-center justify-center py-24">
                <Spinner size="lg" />
              </div>
            )}

            {/* Empty state */}
            {partialsRaw !== undefined && partials.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="w-16 h-16 rounded-2xl bg-surface-raised border border-border flex items-center justify-center mb-4">
                  <Clock size={28} className="text-text-muted" />
                </div>
                <h2 className="text-base font-semibold text-text-primary mb-1">
                  Nenhuma submissão parcial
                </h2>
                <p className="text-sm text-text-secondary max-w-xs">
                  Ative a captura parcial nas configurações do formulário para começar a recuperar dados de visitantes que não completam o envio.
                </p>
              </div>
            )}

            {/* Partials list */}
            {partialsRaw !== undefined && partials.length > 0 && (
              <>
                {/* Desktop table */}
                <div className="hidden md:block rounded-card bg-surface-raised border border-border shadow-card overflow-hidden">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-border">
                        <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide whitespace-nowrap">
                          Última atividade
                        </th>
                        <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide whitespace-nowrap">
                          Progresso
                        </th>
                        <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide whitespace-nowrap">
                          Status
                        </th>
                        <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide whitespace-nowrap">
                          Campos
                        </th>
                        <th scope="col" className="px-4 py-3 w-12">
                          <span className="sr-only">Expandir</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {partials.map((partial) => {
                        const { label, variant } = partialStatusConfig(partial.status);
                        const isExpanded = expandedPartialId === partial._id;
                        const dataEntries = Object.entries(partial.data).filter(
                          ([, v]) => v !== null && v !== undefined && v !== ""
                        );

                        return (
                          <>
                            <tr
                              key={partial._id}
                              className={cn(
                                "border-b border-border-subtle transition-colors cursor-pointer",
                                "hover:bg-surface-overlay",
                                isExpanded && "bg-surface-overlay"
                              )}
                              onClick={() => setExpandedPartialId(isExpanded ? null : partial._id)}
                            >
                              <td className="px-4 py-3 whitespace-nowrap">
                                <span className="text-sm text-text-secondary tabular-nums">
                                  {timeAgo(partial.lastActivityAt)}
                                </span>
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                <div className="flex items-center gap-2">
                                  <div className="w-20 h-2 rounded-full bg-surface-sunken overflow-hidden">
                                    <div
                                      className="h-full rounded-full transition-all"
                                      style={{
                                        width: `${Math.min(partial.completionPercent, 100)}%`,
                                        backgroundColor: partial.completionPercent >= 75
                                          ? "var(--color-semantic-success)"
                                          : partial.completionPercent >= 40
                                            ? "var(--color-brand-500)"
                                            : "var(--color-semantic-warning)",
                                      }}
                                    />
                                  </div>
                                  <span className="text-xs text-text-muted tabular-nums">
                                    {Math.round(partial.completionPercent)}%
                                  </span>
                                </div>
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                <Badge variant={variant}>{label}</Badge>
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                <span className="text-sm text-text-secondary tabular-nums">
                                  {partial.completedFieldIds.length}/{partial.totalFields}
                                </span>
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedPartialId(isExpanded ? null : partial._id);
                                  }}
                                  aria-label={isExpanded ? "Recolher detalhes" : "Expandir detalhes"}
                                  className={cn(
                                    "inline-flex items-center justify-center rounded-full transition-colors",
                                    "min-h-[44px] min-w-[44px]",
                                    "text-text-muted hover:text-text-primary hover:bg-surface-overlay",
                                    "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-raised"
                                  )}
                                >
                                  {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                </button>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr key={`${partial._id}-detail`} className="border-b border-border-subtle bg-surface-sunken">
                                <td colSpan={5} className="px-4 py-4">
                                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                    {dataEntries.length === 0 ? (
                                      <p className="text-sm text-text-muted col-span-full">
                                        Nenhum dado capturado ainda.
                                      </p>
                                    ) : (
                                      dataEntries.map(([key, value]) => {
                                        const fieldDef = form?.fields?.find((f) => f.id === key);
                                        return (
                                          <div key={key} className="flex flex-col gap-0.5">
                                            <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                                              {fieldDef?.label ?? key}
                                            </span>
                                            <span className="text-sm text-text-primary break-words">
                                              {String(value)}
                                            </span>
                                          </div>
                                        );
                                      })
                                    )}
                                  </div>
                                  <div className="mt-3 pt-3 border-t border-border-subtle flex flex-wrap gap-4 text-xs text-text-muted">
                                    <span>Sessão: <span className="font-mono">{partial.sessionId.slice(0, 8)}...</span></span>
                                    <span>Início: {formatDate(partial.firstInteractionAt)}</span>
                                    {partial.currentStep !== undefined && (
                                      <span>Etapa: {partial.currentStep + 1}</span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile card list */}
                <div className="md:hidden space-y-3">
                  {partials.map((partial) => {
                    const { label, variant } = partialStatusConfig(partial.status);
                    const isExpanded = expandedPartialId === partial._id;
                    const dataEntries = Object.entries(partial.data).filter(
                      ([, v]) => v !== null && v !== undefined && v !== ""
                    );

                    return (
                      <article
                        key={partial._id}
                        className="rounded-card border border-border bg-surface-raised shadow-card transition-all duration-150"
                      >
                        <button
                          onClick={() => setExpandedPartialId(isExpanded ? null : partial._id)}
                          className="w-full flex items-start gap-3 p-4 text-left focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base rounded-card"
                          aria-expanded={isExpanded}
                        >
                          <div className="flex-1 min-w-0 space-y-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge variant={variant}>{label}</Badge>
                              <span className="text-xs text-text-muted tabular-nums">
                                {timeAgo(partial.lastActivityAt)}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 rounded-full bg-surface-sunken overflow-hidden">
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${Math.min(partial.completionPercent, 100)}%`,
                                    backgroundColor: partial.completionPercent >= 75
                                      ? "var(--color-semantic-success)"
                                      : partial.completionPercent >= 40
                                        ? "var(--color-brand-500)"
                                        : "var(--color-semantic-warning)",
                                  }}
                                />
                              </div>
                              <span className="text-xs text-text-muted tabular-nums shrink-0">
                                {Math.round(partial.completionPercent)}%
                              </span>
                            </div>
                            <p className="text-xs text-text-muted">
                              {partial.completedFieldIds.length} de {partial.totalFields} campos
                            </p>
                          </div>
                          <span className="text-text-muted mt-1">
                            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </span>
                        </button>
                        {isExpanded && (
                          <div className="px-4 pb-4 border-t border-border-subtle pt-4">
                            <div className="grid grid-cols-1 gap-3">
                              {dataEntries.length === 0 ? (
                                <p className="text-sm text-text-muted">Nenhum dado capturado ainda.</p>
                              ) : (
                                dataEntries.map(([key, value]) => {
                                  const fieldDef = form?.fields?.find((f) => f.id === key);
                                  return (
                                    <div key={key} className="flex flex-col gap-0.5">
                                      <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
                                        {fieldDef?.label ?? key}
                                      </span>
                                      <span className="text-sm text-text-primary break-words">
                                        {String(value)}
                                      </span>
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>

                {/* Count summary */}
                <p className="text-center text-xs text-text-muted mt-4 tabular-nums">
                  {partials.length.toLocaleString("pt-BR")}{" "}
                  {partials.length === 1 ? "parcial exibido" : "parciais exibidos"}
                </p>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-card border border-border bg-surface-raised p-3">
      <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide">{label}</p>
      <p className="text-lg font-bold text-text-primary mt-0.5 tabular-nums">{String(value)}</p>
    </div>
  );
}
