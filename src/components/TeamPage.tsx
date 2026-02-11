import React, { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

interface TeamPageProps {
  organizationId: string;
}

export function TeamPage({ organizationId }: TeamPageProps) {
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMember, setNewMember] = useState({
    name: "",
    email: "",
    role: "agent" as "admin" | "manager" | "agent" | "ai",
    type: "human" as "human" | "ai",
  });

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, {
    organizationId: organizationId as Id<"organizations">,
  });

  const createTeamMember = useMutation(api.teamMembers.createTeamMember);
  const updateTeamMemberStatus = useMutation(api.teamMembers.updateTeamMemberStatus);

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMember.name.trim()) return;

    try {
      await createTeamMember({
        organizationId: organizationId as Id<"organizations">,
        name: newMember.name,
        email: newMember.email || undefined,
        role: newMember.role,
        type: newMember.type,
      });
      
      setNewMember({ name: "", email: "", role: "agent", type: "human" });
      setShowAddMember(false);
    } catch (error) {
      console.error("Failed to add team member:", error);
    }
  };

  const handleStatusChange = async (memberId: string, status: "active" | "inactive" | "busy") => {
    try {
      await updateTeamMemberStatus({
        teamMemberId: memberId as Id<"teamMembers">,
        status,
      });
    } catch (error) {
      console.error("Failed to update status:", error);
    }
  };

  if (!teamMembers) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active": return "bg-green-100 text-green-800";
      case "busy": return "bg-yellow-100 text-yellow-800";
      case "inactive": return "bg-gray-100 text-gray-800";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  const getRoleColor = (role: string) => {
    switch (role) {
      case "admin": return "bg-purple-100 text-purple-800";
      case "manager": return "bg-blue-100 text-blue-800";
      case "agent": return "bg-green-100 text-green-800";
      case "ai": return "bg-orange-100 text-orange-800";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Team Members</h2>
        <button
          onClick={() => setShowAddMember(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Add Member
        </button>
      </div>

      {/* Add Member Modal */}
      {showAddMember && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">Add Team Member</h3>
            
            <form onSubmit={handleAddMember} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name *
                </label>
                <input
                  type="text"
                  value={newMember.name}
                  onChange={(e) => setNewMember({ ...newMember, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={newMember.email}
                  onChange={(e) => setNewMember({ ...newMember, email: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Type
                </label>
                <select
                  value={newMember.type}
                  onChange={(e) => setNewMember({ ...newMember, type: e.target.value as "human" | "ai" })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="human">Human</option>
                  <option value="ai">AI Agent</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Role
                </label>
                <select
                  value={newMember.role}
                  onChange={(e) => setNewMember({ ...newMember, role: e.target.value as any })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="agent">Agent</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                  {newMember.type === "ai" && <option value="ai">AI</option>}
                </select>
              </div>

              <div className="flex gap-2 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAddMember(false)}
                  className="flex-1 px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Add Member
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Team Members Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {teamMembers.map((member) => (
          <div key={member._id} className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center text-white text-lg font-semibold ${
                member.type === "ai" ? "bg-orange-500" : "bg-blue-500"
              }`}>
                {member.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">{member.name}</h3>
                {member.email && (
                  <p className="text-sm text-gray-600">{member.email}</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 mb-3">
              <span className={`px-2 py-1 rounded-full text-xs font-medium ${getRoleColor(member.role)}`}>
                {member.role}
              </span>
              <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                member.type === "ai" ? "bg-orange-100 text-orange-800" : "bg-blue-100 text-blue-800"
              }`}>
                {member.type}
              </span>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Status
              </label>
              <select
                value={member.status}
                onChange={(e) => handleStatusChange(member._id, e.target.value as any)}
                className={`w-full px-2 py-1 rounded text-sm font-medium ${getStatusColor(member.status)}`}
              >
                <option value="active">Active</option>
                <option value="busy">Busy</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>

            <div className="text-xs text-gray-500">
              Joined {new Date(member.createdAt).toLocaleDateString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
