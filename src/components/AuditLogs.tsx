import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";

interface AuditLogsProps {
  organizationId: Id<"organizations">;
}

export function AuditLogs({ organizationId }: AuditLogsProps) {
  const [selectedSeverity, setSelectedSeverity] = useState<string>("all");
  const [selectedEntityType, setSelectedEntityType] = useState<string>("all");

  const auditLogs = useQuery(api.auditLogs.getAuditLogs, {
    organizationId,
    severity: selectedSeverity !== "all"
      ? (selectedSeverity as "low" | "medium" | "high" | "critical")
      : undefined,
    entityType: selectedEntityType !== "all" ? selectedEntityType : undefined,
  });

  const severityColors: Record<string, string> = {
    low: "bg-gray-100 text-gray-800",
    medium: "bg-yellow-100 text-yellow-800",
    high: "bg-orange-100 text-orange-800",
    critical: "bg-red-100 text-red-800",
  };

  const actionColors: Record<string, string> = {
    create: "bg-green-100 text-green-800",
    update: "bg-blue-100 text-blue-800",
    delete: "bg-red-100 text-red-800",
    move: "bg-purple-100 text-purple-800",
    assign: "bg-indigo-100 text-indigo-800",
    handoff: "bg-orange-100 text-orange-800",
  };

  const handleExportCsv = () => {
    if (!auditLogs || auditLogs.logs.length === 0) {
      toast.error("No data to export.");
      return;
    }
    const headers = ["Timestamp", "Action", "Entity Type", "Entity ID", "Severity", "Actor", "Actor Type", "Description"];
    const rows = auditLogs.logs.map((log) => {
      const meta = log.metadata as Record<string, unknown> | undefined;
      const desc = meta?.title || meta?.name || `${log.action} ${log.entityType}`;
      return [
        new Date(log.createdAt).toISOString(),
        log.action,
        log.entityType,
        log.entityId,
        log.severity,
        log.actorName,
        log.actorType,
        `"${String(desc).replace(/"/g, '""')}"`,
      ].join(",");
    });
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Audit Logs</h2>

        <div className="flex gap-4">
          <select
            value={selectedSeverity}
            onChange={(e) => setSelectedSeverity(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Severities</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>

          <select
            value={selectedEntityType}
            onChange={(e) => setSelectedEntityType(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Types</option>
            <option value="lead">Leads</option>
            <option value="contact">Contacts</option>
            <option value="organization">Organizations</option>
            <option value="teamMember">Team Members</option>
            <option value="handoff">Handoffs</option>
            <option value="message">Messages</option>
          </select>

          <button
            onClick={handleExportCsv}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 font-medium"
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg">
        {!auditLogs && (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        )}

        {auditLogs && auditLogs.logs.length === 0 && (
          <div className="text-center py-12">
            <h3 className="text-lg font-medium text-gray-900 mb-2">No audit logs found</h3>
            <p className="text-gray-600">
              Audit logs will appear here as activities occur in your organization.
            </p>
          </div>
        )}

        {auditLogs && auditLogs.logs.length > 0 && (
          <div className="divide-y divide-gray-100">
            {auditLogs.logs.map((log) => {
              // Build a changes summary string
              let changesSummary = "";
              if (log.changes) {
                const afterKeys = log.changes.after
                  ? Object.keys(log.changes.after)
                  : [];
                if (afterKeys.length > 0) {
                  changesSummary = afterKeys
                    .map((key) => {
                      const before = log.changes?.before?.[key];
                      const after = log.changes?.after?.[key];
                      if (typeof after === "object") {
                        return `${key} updated`;
                      }
                      return before !== undefined
                        ? `${key}: ${before} -> ${after}`
                        : `${key}: ${after}`;
                    })
                    .join(", ");
                }
              }

              // Build description from metadata or changes
              let description = "";
              if (log.metadata) {
                const meta = log.metadata as Record<string, unknown>;
                if (meta.title) {
                  description = `${log.action} ${log.entityType}: "${meta.title}"`;
                } else if (meta.name) {
                  description = `${log.action} ${log.entityType}: "${meta.name}"`;
                }
              }
              if (!description) {
                description = `${log.action} ${log.entityType}`;
              }

              return (
                <div
                  key={log._id}
                  className="flex items-center justify-between p-4 hover:bg-gray-50"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          actionColors[log.action] || "bg-gray-100 text-gray-800"
                        }`}
                      >
                        {log.action}
                      </span>
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          severityColors[log.severity] || "bg-gray-100 text-gray-800"
                        }`}
                      >
                        {log.severity}
                      </span>
                      <span className="px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                        {log.entityType}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">
                        {description}
                      </p>
                      {changesSummary && (
                        <p className="text-xs text-gray-500 truncate mt-0.5">
                          {changesSummary}
                        </p>
                      )}
                      <p className="text-sm text-gray-600">
                        by {log.actorName}{" "}
                        <span className="text-gray-400">({log.actorType})</span>
                      </p>
                    </div>
                  </div>

                  <span className="text-sm text-gray-500 whitespace-nowrap ml-4">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination hint */}
        {auditLogs && auditLogs.hasMore && (
          <div className="text-center py-3 border-t border-gray-100">
            <p className="text-sm text-gray-500">
              Showing {auditLogs.logs.length} of {auditLogs.total} entries
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
