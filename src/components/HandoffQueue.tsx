import React from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

interface HandoffQueueProps {
  organizationId: string;
}

export function HandoffQueue({ organizationId }: HandoffQueueProps) {
  const handoffs = useQuery(api.handoffs.getHandoffs, {
    organizationId: organizationId as Id<"organizations">,
    status: "pending",
  });

  const acceptHandoff = useMutation(api.handoffs.acceptHandoff);
  const rejectHandoff = useMutation(api.handoffs.rejectHandoff);

  const handleAccept = async (handoffId: string) => {
    try {
      await acceptHandoff({
        handoffId: handoffId as Id<"handoffs">,
      });
    } catch (error) {
      console.error("Failed to accept handoff:", error);
    }
  };

  const handleReject = async (handoffId: string) => {
    try {
      await rejectHandoff({
        handoffId: handoffId as Id<"handoffs">,
      });
    } catch (error) {
      console.error("Failed to reject handoff:", error);
    }
  };

  if (!handoffs) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Handoff Queue</h2>
        <span className="bg-orange-100 text-orange-800 px-3 py-1 rounded-full text-sm font-medium">
          {handoffs.length} pending
        </span>
      </div>

      {handoffs.length === 0 ? (
        <div className="text-center py-12">
          <h3 className="text-lg font-medium text-gray-900 mb-2">No pending handoffs</h3>
          <p className="text-gray-600">All handoff requests have been processed.</p>
        </div>
      ) : (
        <div className="grid gap-6">
          {handoffs.map((handoff) => (
            <div key={handoff._id} className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">
                    {handoff.lead?.title}
                  </h3>
                  <p className="text-gray-600">
                    {handoff.contact?.firstName} {handoff.contact?.lastName}
                    {handoff.contact?.company && ` • ${handoff.contact?.company}`}
                  </p>
                </div>
                <span className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded-full text-sm">
                  Pending
                </span>
              </div>

              <div className="grid md:grid-cols-2 gap-4 mb-4">
                <div>
                  <h4 className="font-medium text-gray-900 mb-2">From</h4>
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-sm">
                      {handoff.fromMember?.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{handoff.fromMember?.name}</p>
                      <p className="text-sm text-gray-600">{handoff.fromMember?.role}</p>
                    </div>
                  </div>
                </div>

                {handoff.toMember && (
                  <div>
                    <h4 className="font-medium text-gray-900 mb-2">To</h4>
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center text-white text-sm">
                        {handoff.toMember.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{handoff.toMember.name}</p>
                        <p className="text-sm text-gray-600">{handoff.toMember.role}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="mb-4">
                <h4 className="font-medium text-gray-900 mb-2">Reason</h4>
                <p className="text-gray-700">{handoff.reason}</p>
              </div>

              {handoff.summary && (
                <div className="mb-4">
                  <h4 className="font-medium text-gray-900 mb-2">Summary</h4>
                  <p className="text-gray-700">{handoff.summary}</p>
                </div>
              )}

              {handoff.suggestedActions.length > 0 && (
                <div className="mb-6">
                  <h4 className="font-medium text-gray-900 mb-2">Suggested Actions</h4>
                  <ul className="list-disc list-inside space-y-1">
                    {handoff.suggestedActions.map((action, index) => (
                      <li key={index} className="text-gray-700">{action}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">
                  Requested {new Date(handoff.createdAt).toLocaleDateString()}
                </span>
                
                <div className="flex gap-2">
                  <button
                    onClick={() => handleReject(handoff._id)}
                    className="px-4 py-2 text-red-600 border border-red-300 rounded-lg hover:bg-red-50"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => handleAccept(handoff._id)}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Accept
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
