import React from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

interface DashboardOverviewProps {
  organizationId: Id<"organizations">;
}

export function DashboardOverview({ organizationId }: DashboardOverviewProps) {
  const stats = useQuery(api.dashboard.getDashboardStats, {
    organizationId,
  });

  if (!stats) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const totalPipelineValue = stats.pipelineStats.reduce((sum, s) => sum + s.totalValue, 0);
  const totalLeads = stats.pipelineStats.reduce((sum, s) => sum + s.leadCount, 0);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <p className="text-sm text-gray-600">Total Pipeline Value</p>
          <p className="text-2xl font-bold text-green-600">${totalPipelineValue.toLocaleString()}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <p className="text-sm text-gray-600">Active Leads</p>
          <p className="text-2xl font-bold text-blue-600">{totalLeads}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <p className="text-sm text-gray-600">Pending Handoffs</p>
          <p className="text-2xl font-bold text-orange-600">{stats.pendingHandoffs}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <p className="text-sm text-gray-600">Lead Sources</p>
          <p className="text-2xl font-bold text-purple-600">{stats.leadsBySource.length}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pipeline by Stage */}
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Pipeline by Stage</h3>
          {stats.pipelineStats.length === 0 ? (
            <p className="text-gray-500">No leads in pipeline yet.</p>
          ) : (
            <div className="space-y-3">
              {stats.pipelineStats.map((stage) => {
                const percentage = totalPipelineValue > 0
                  ? (stage.totalValue / totalPipelineValue) * 100
                  : 0;
                return (
                  <div key={stage.stageId}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-700">{stage.stageName}</span>
                      <span className="text-sm text-gray-600">
                        {stage.leadCount} leads - ${stage.totalValue.toLocaleString()}
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2.5">
                      <div
                        className="h-2.5 rounded-full"
                        style={{
                          width: `${Math.max(percentage, 2)}%`,
                          backgroundColor: stage.stageColor,
                        }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Leads by Source */}
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Leads by Source</h3>
          {stats.leadsBySource.length === 0 ? (
            <p className="text-gray-500">No lead source data yet.</p>
          ) : (
            <div className="space-y-2">
              {stats.leadsBySource.map((source, index) => (
                <div key={index} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                  <span className="text-sm font-medium text-gray-700">{source.sourceName}</span>
                  <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-xs font-medium">
                    {source.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Team Performance */}
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Team Performance</h3>
          {stats.teamPerformance.length === 0 ? (
            <p className="text-gray-500">No team data yet.</p>
          ) : (
            <div className="space-y-2">
              {stats.teamPerformance.map((member, index) => (
                <div key={index} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm ${
                      member.memberType === "ai" ? "bg-orange-500" : "bg-blue-500"
                    }`}>
                      {member.memberName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <span className="text-sm font-medium text-gray-700">{member.memberName}</span>
                      <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${
                        member.memberType === "ai" ? "bg-orange-100 text-orange-800" : "bg-blue-100 text-blue-800"
                      }`}>
                        {member.memberType}
                      </span>
                    </div>
                  </div>
                  <span className="text-sm font-semibold text-gray-900">{member.leadCount} leads</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Activity</h3>
          {stats.recentActivities.length === 0 ? (
            <p className="text-gray-500">No recent activity.</p>
          ) : (
            <div className="space-y-3">
              {stats.recentActivities.map((activity) => {
                const typeColors: Record<string, string> = {
                  created: "bg-green-100 text-green-800",
                  stage_change: "bg-purple-100 text-purple-800",
                  assignment: "bg-indigo-100 text-indigo-800",
                  message_sent: "bg-blue-100 text-blue-800",
                  handoff: "bg-orange-100 text-orange-800",
                  qualification_update: "bg-yellow-100 text-yellow-800",
                  note: "bg-gray-100 text-gray-800",
                };
                return (
                  <div key={activity._id} className="flex items-start gap-3 text-sm">
                    <span className={`px-2 py-0.5 rounded text-xs shrink-0 ${typeColors[activity.type] || "bg-gray-100 text-gray-800"}`}>
                      {activity.type.replace("_", " ")}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-900 truncate">{activity.content || activity.type}</p>
                      <p className="text-gray-500 text-xs">
                        {activity.actorName} - {new Date(activity.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
