import React, { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { LeadDetailPanel } from "./LeadDetailPanel";
import { CreateLeadModal } from "./CreateLeadModal";

interface KanbanBoardProps {
  organizationId: string;
}

export function KanbanBoard({ organizationId }: KanbanBoardProps) {
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const boards = useQuery(api.boards.getBoards, {
    organizationId: organizationId as Id<"organizations">
  });

  const stages = useQuery(api.boards.getStages,
    selectedBoardId ? { boardId: selectedBoardId as Id<"boards"> } : "skip"
  );

  const leads = useQuery(api.leads.getLeads,
    selectedBoardId ? {
      organizationId: organizationId as Id<"organizations">,
      boardId: selectedBoardId as Id<"boards">,
    } : "skip"
  );

  const moveLeadToStage = useMutation(api.leads.moveLeadToStage);

  // Select first board by default
  React.useEffect(() => {
    if (boards && boards.length > 0 && !selectedBoardId) {
      setSelectedBoardId(boards[0]._id);
    }
  }, [boards, selectedBoardId]);

  if (!boards) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (boards.length === 0) {
    return (
      <div className="text-center py-12">
        <h3 className="text-lg font-medium text-gray-900 mb-2">No boards found</h3>
        <p className="text-gray-600">Create your first sales pipeline to get started.</p>
      </div>
    );
  }

  const handleDragStart = (e: React.DragEvent, leadId: string) => {
    e.dataTransfer.setData("text/plain", leadId);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent, stageId: string) => {
    e.preventDefault();
    const leadId = e.dataTransfer.getData("text/plain");

    if (leadId && stageId) {
      try {
        await moveLeadToStage({
          leadId: leadId as Id<"leads">,
          stageId: stageId as Id<"stages">,
        });
      } catch (error) {
        console.error("Failed to move lead:", error);
      }
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Board Selector + Create Lead */}
      <div className="mb-6">
        <div className="flex items-center gap-4">
          <div className="flex gap-2 overflow-x-auto flex-1">
            {boards.map((board) => (
              <button
                key={board._id}
                onClick={() => setSelectedBoardId(board._id)}
                className={`px-4 py-2 rounded-lg font-medium whitespace-nowrap ${
                  selectedBoardId === board._id
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {board.name}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 whitespace-nowrap"
          >
            + Create Lead
          </button>
        </div>
      </div>

      {/* Kanban Board */}
      {stages && (
        <div className="flex-1 overflow-x-auto">
          <div className="flex gap-6 h-full min-w-max pb-6">
            {stages.map((stage) => {
              const stageLeads = leads?.filter(lead => lead.stageId === stage._id) || [];

              return (
                <div
                  key={stage._id}
                  className="flex-shrink-0 w-80 bg-gray-50 rounded-lg p-4 flex flex-col"
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, stage._id)}
                >
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-gray-900">{stage.name}</h3>
                    <span className="bg-gray-200 text-gray-700 px-2 py-1 rounded-full text-sm">
                      {stageLeads.length}
                    </span>
                  </div>

                  <div className="space-y-3 flex-1 overflow-y-auto">
                    {stageLeads.map((lead) => (
                      <div
                        key={lead._id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, lead._id)}
                        onClick={() => setSelectedLeadId(lead._id)}
                        className="bg-white p-4 rounded-lg shadow-sm border cursor-pointer hover:shadow-md transition-shadow"
                      >
                        <h4 className="font-medium text-gray-900 mb-2">{lead.title}</h4>

                        {lead.contact && (
                          <p className="text-sm text-gray-600 mb-2">
                            {lead.contact.firstName} {lead.contact.lastName}
                            {lead.contact.company && ` • ${lead.contact.company}`}
                          </p>
                        )}

                        <div className="flex items-center justify-between">
                          <span className="text-lg font-semibold text-green-600">
                            ${lead.value.toLocaleString()}
                          </span>

                          {lead.assignee && (
                            <div className="flex items-center gap-1">
                              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-xs ${
                                lead.assignee.type === "ai" ? "bg-orange-500" : "bg-blue-500"
                              }`}>
                                {lead.assignee.name.charAt(0).toUpperCase()}
                              </div>
                              <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${
                                lead.assignee.type === "ai" ? "bg-orange-100 text-orange-700" : "bg-blue-100 text-blue-700"
                              }`}>
                                {lead.assignee.type === "ai" ? "AI" : "H"}
                              </span>
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-2 mt-2">
                          <span className={`px-2 py-1 rounded-full text-xs ${
                            lead.priority === "urgent" ? "bg-red-100 text-red-800" :
                            lead.priority === "high" ? "bg-orange-100 text-orange-800" :
                            lead.priority === "medium" ? "bg-yellow-100 text-yellow-800" :
                            "bg-gray-100 text-gray-800"
                          }`}>
                            {lead.priority}
                          </span>

                          <span className={`px-2 py-1 rounded-full text-xs ${
                            lead.temperature === "hot" ? "bg-red-100 text-red-800" :
                            lead.temperature === "warm" ? "bg-orange-100 text-orange-800" :
                            "bg-blue-100 text-blue-800"
                          }`}>
                            {lead.temperature}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Lead Detail Panel */}
      {selectedLeadId && (
        <LeadDetailPanel
          leadId={selectedLeadId}
          organizationId={organizationId}
          onClose={() => setSelectedLeadId(null)}
        />
      )}

      {/* Create Lead Modal */}
      {showCreateModal && selectedBoardId && (
        <CreateLeadModal
          organizationId={organizationId}
          boardId={selectedBoardId}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}
