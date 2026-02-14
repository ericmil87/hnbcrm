import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";

interface OrganizationSelectorProps {
  selectedOrgId: Id<"organizations"> | null;
  onSelectOrg: (orgId: Id<"organizations"> | null) => void;
}

export function OrganizationSelector({ selectedOrgId, onSelectOrg }: OrganizationSelectorProps) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgSlug, setNewOrgSlug] = useState("");

  const organizations = useQuery(api.organizations.getUserOrganizations);
  const createOrganization = useMutation(api.organizations.createOrganization);

  const selectedOrg = organizations?.find(org => org && org._id === selectedOrgId);

  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOrgName.trim() || !newOrgSlug.trim()) return;

    try {
      const orgId = await createOrganization({
        name: newOrgName,
        slug: newOrgSlug,
      });
      onSelectOrg(orgId);
      setNewOrgName("");
      setNewOrgSlug("");
      setShowCreateForm(false);
    } catch (error) {
      toast.error("Failed to create organization. The slug might already be taken.");
    }
  };

  if (!organizations) {
    return (
      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
    );
  }

  return (
    <div className="relative">
      <select
        value={selectedOrgId || ""}
        onChange={(e) => onSelectOrg(e.target.value ? (e.target.value as Id<"organizations">) : null)}
        className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white min-w-48"
      >
        <option value="">Select Organization</option>
        {organizations.filter(Boolean).map((org) => {
          if (!org) return null;
          return (
            <option key={org._id} value={org._id}>
              {org.name} ({org.role})
            </option>
          );
        })}
      </select>

      {organizations.length === 0 && (
        <div className="absolute top-full left-0 mt-2 p-4 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-80">
          <h3 className="font-medium text-gray-900 mb-2">No organizations found</h3>
          <p className="text-sm text-gray-600 mb-4">Create your first organization to get started.</p>
          
          {!showCreateForm ? (
            <button
              onClick={() => setShowCreateForm(true)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
            >
              Create Organization
            </button>
          ) : (
            <form onSubmit={handleCreateOrg} className="space-y-3">
              <input
                type="text"
                placeholder="Organization Name"
                value={newOrgName}
                onChange={(e) => {
                  setNewOrgName(e.target.value);
                  setNewOrgSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'));
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
              <input
                type="text"
                placeholder="Slug (URL identifier)"
                value={newOrgSlug}
                onChange={(e) => setNewOrgSlug(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="flex-1 px-3 py-2 text-gray-600 border border-gray-300 rounded text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 px-3 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
                >
                  Create
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
