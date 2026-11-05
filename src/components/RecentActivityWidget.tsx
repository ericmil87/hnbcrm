import { useState, useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import {
  ENTITY_ICONS,
  ACTION_LABELS,
  FIELD_LABELS,
  groupLogsByDate,
  formatRelativeTime,
  buildClientDescription,
  formatDiffValue,
} from "@/lib/auditUtils";
import {
  Shield,
  ChevronDown,
  ChevronRight,
  Globe,
  Monitor,
} from "lucide-react";

type DatePreset = "24h" | "7d" | "30d" | "all";
type ActionFilter = "all" | "create" | "update" | "delete" | "move" | "assign" | "handoff";

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "all", label: "Tudo" },
];

const ACTION_FILTERS: { value: ActionFilter; label: string }[] = [
  { value: "all", label: "Tudo" },
  { value: "create", label: "Criar" },
  { value: "update", label: "Atualizar" },
  { value: "move", label: "Mover" },
  { value: "assign", label: "Atribuir" },
  { value: "delete", label: "Excluir" },
  { value: "handoff", label: "Repassar" },
];

export function RecentActivityWidget({
  organizationId,
}: {
  organizationId: Id<"organizations">;
}) {
  const navigate = useNavigate();

  // Filter state
  const [selectedAction, setSelectedAction] = useState<ActionFilter>("all");
  const [datePreset, setDatePreset] = useState<DatePreset>("7d");

  // UI state
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  // Compute timestamps from preset
  const { startTimestamp, endTimestamp } = useMemo(() => {
    const now = Date.now();
    if (datePreset === "24h") return { startTimestamp: now - 86400000, endTimestamp: now };
    if (datePreset === "7d") return { startTimestamp: now - 7 * 86400000, endTimestamp: now };
    if (datePreset === "30d") return { startTimestamp: now - 30 * 86400000, endTimestamp: now };
    return { startTimestamp: 0, endTimestamp: 0 };
  }, [datePreset]);

  const auditLogs = useQuery(api.auditLogs.getAuditLogs, {
    organizationId,
    action: selectedAction !== "all" ? selectedAction : undefined,
    startDate: startTimestamp || undefined,
    endDate: endTimestamp || undefined,
    limit: 15,
  });

  const hasActiveFilters = selectedAction !== "all" || datePreset !== "7d";

  const clearFilters = () => {
    setSelectedAction("all");
    setDatePreset("7d");
  };

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-text-primary">Atividade Recente</h3>
        <button
          onClick={() => navigate("/app/auditoria")}
          className="flex items-center gap-1 text-sm text-brand-500 hover:text-brand-400 transition-colors font-medium"
        >
          Ver tudo
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Compact filter bar */}
      <div className="space-y-2 mb-4">
        {/* Date presets */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.value}
              onClick={() => setDatePreset(preset.value)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                datePreset === preset.value
                  ? "bg-brand-500/20 text-brand-400"
                  : "bg-surface-overlay text-text-secondary hover:text-text-primary"
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {/* Action filter pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {ACTION_FILTERS.map((action) => (
            <button
              key={action.value}
              onClick={() => setSelectedAction(action.value)}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                selectedAction === action.value
                  ? "bg-brand-500/20 text-brand-400"
                  : "bg-surface-overlay text-text-secondary hover:text-text-primary"
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading skeleton */}
      {auditLogs === undefined && (
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 py-3">
              <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-16 rounded-full" />
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-3 w-14 shrink-0" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {auditLogs && auditLogs.logs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 px-4">
          <div className="w-12 h-12 rounded-xl bg-surface-overlay flex items-center justify-center mb-3">
            <Shield size={24} className="text-text-muted" />
          </div>
          <p className="text-sm font-medium text-text-primary mb-1">
            Nenhuma atividade encontrada
          </p>
          <p className="text-xs text-text-muted text-center">
            {hasActiveFilters
              ? "Tente ajustar os filtros."
              : "As atividades aparecerão aqui automaticamente."}
          </p>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" className="mt-3" onClick={clearFilters}>
              Limpar filtros
            </Button>
          )}
        </div>
      )}

      {/* Date-grouped log entries */}
      {auditLogs && auditLogs.logs.length > 0 && (
        <>
          {groupLogsByDate(auditLogs.logs).map((group, gi) => (
            <div key={gi}>
              {/* Date group header */}
              <div className="flex items-center gap-3 py-2">
                <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                  {group.label}
                </span>
                <div className="flex-1 h-px bg-border" />
                <span className="text-[10px] text-text-muted">
                  {group.logs.length} {group.logs.length === 1 ? "evento" : "eventos"}
                </span>
              </div>

              {/* Logs in group */}
              <div className="divide-y divide-border">
                {group.logs.map((log: any) => {
                  const EntityIcon = ENTITY_ICONS[log.entityType] || Globe;
                  const actionInfo = ACTION_LABELS[log.action] || {
                    label: log.action,
                    variant: "default",
                  };
                  const isExpanded = expandedLogId === log._id;
                  const hasChanges = log.changes && (log.changes.before || log.changes.after);
                  const description = log.description || buildClientDescription(log);

                  return (
                    <div key={log._id}>
                      <button
                        onClick={() =>
                          hasChanges && setExpandedLogId(isExpanded ? null : log._id)
                        }
                        className={cn(
                          "w-full text-left flex items-start gap-3 py-3 transition-colors",
                          hasChanges
                            ? "hover:bg-surface-overlay cursor-pointer"
                            : "cursor-default"
                        )}
                      >
                        {/* Entity icon */}
                        <div className="p-1.5 rounded-lg bg-surface-overlay shrink-0">
                          <EntityIcon size={14} className="text-text-muted" />
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          {/* Badges */}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Badge variant={actionInfo.variant as any} className="text-[10px]">
                              {actionInfo.label}
                            </Badge>
                            {log.severity !== "low" && (
                              <span
                                className={cn(
                                  "text-[10px]",
                                  log.severity === "medium" && "text-semantic-warning",
                                  (log.severity === "high" || log.severity === "critical") &&
                                    "text-semantic-error"
                                )}
                              >
                                {"\u25CF"}
                              </span>
                            )}
                          </div>
                          {/* Description */}
                          <p className="font-medium text-text-primary text-sm mt-0.5 truncate">
                            {description}
                          </p>
                          {/* Actor */}
                          <div className="flex items-center gap-1.5 mt-1">
                            <Avatar
                              name={log.actorName}
                              type={log.actorMemberType === "ai" ? "ai" : "human"}
                              size="sm"
                              className="scale-75 origin-left"
                            />
                            <span className="text-xs text-text-secondary">
                              {log.actorName}
                            </span>
                          </div>
                        </div>

                        {/* Timestamp + chevron */}
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <span
                            className="text-[10px] text-text-muted"
                            title={new Date(log.createdAt).toLocaleString("pt-BR")}
                          >
                            {formatRelativeTime(log.createdAt)}
                          </span>
                          {hasChanges && (
                            <ChevronDown
                              size={12}
                              className={cn(
                                "text-text-muted transition-transform duration-200",
                                isExpanded && "rotate-180"
                              )}
                            />
                          )}
                        </div>
                      </button>

                      {/* Expanded detail panel */}
                      {isExpanded && hasChanges && (
                        <div className="pl-10 pr-2 pb-3">
                          {(() => {
                            const afterKeys = log.changes.after
                              ? Object.keys(log.changes.after)
                              : [];
                            const beforeKeys = log.changes.before
                              ? Object.keys(log.changes.before)
                              : [];
                            const allKeys = [...new Set([...beforeKeys, ...afterKeys])];

                            if (allKeys.length === 0) return null;

                            return (
                              <div className="rounded-lg border border-border overflow-hidden">
                                {/* Header */}
                                <div className="grid grid-cols-1 sm:grid-cols-3 bg-surface-sunken">
                                  <div className="px-3 py-1.5 text-[10px] font-medium text-text-muted">
                                    Campo
                                  </div>
                                  <div className="px-3 py-1.5 text-[10px] font-medium text-semantic-error/70 hidden sm:block">
                                    Antes
                                  </div>
                                  <div className="px-3 py-1.5 text-[10px] font-medium text-semantic-success/70 hidden sm:block">
                                    Depois
                                  </div>
                                </div>
                                {/* Rows */}
                                <div className="divide-y divide-border">
                                  {allKeys.map((key) => {
                                    const before = log.changes.before?.[key];
                                    const after = log.changes.after?.[key];
                                    const label = FIELD_LABELS[key] || key;
                                    return (
                                      <div key={key}>
                                        {/* Desktop: 3-col grid */}
                                        <div className="hidden sm:grid sm:grid-cols-3 bg-surface-raised">
                                          <div className="px-3 py-1.5 text-[10px] text-text-secondary font-medium">
                                            {label}
                                          </div>
                                          <div className="px-3 py-1.5 text-[10px] text-text-muted">
                                            {formatDiffValue(before)}
                                          </div>
                                          <div className="px-3 py-1.5 text-[10px] text-text-primary">
                                            {formatDiffValue(after)}
                                          </div>
                                        </div>
                                        {/* Mobile: stacked */}
                                        <div className="sm:hidden px-3 py-1.5 bg-surface-raised space-y-0.5">
                                          <div className="text-[10px] text-text-secondary font-medium">
                                            {label}
                                          </div>
                                          <div className="text-[10px]">
                                            <span className="text-text-muted">
                                              {formatDiffValue(before)}
                                            </span>
                                            <span className="text-text-muted mx-1">
                                              {"\u2192"}
                                            </span>
                                            <span className="text-text-primary">
                                              {formatDiffValue(after)}
                                            </span>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })()}

                          {/* IP + User Agent */}
                          {(log.ipAddress || log.userAgent) && (
                            <div className="flex items-center gap-3 mt-1.5 text-[10px] text-text-muted">
                              {log.ipAddress && (
                                <span className="flex items-center gap-1">
                                  <Monitor size={10} /> {log.ipAddress}
                                </span>
                              )}
                              {log.userAgent && (
                                <span className="truncate">{log.userAgent}</span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Footer */}
          {auditLogs.hasMore && (
            <div className="pt-3 border-t border-border mt-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => navigate("/app/auditoria")}
              >
                Ver mais no histórico de alterações
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
