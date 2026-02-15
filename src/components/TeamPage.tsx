import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";

interface TeamPageProps {
  organizationId: Id<"organizations">;
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
    organizationId,
  });

  const createTeamMember = useMutation(api.teamMembers.createTeamMember);
  const updateTeamMemberStatus = useMutation(api.teamMembers.updateTeamMemberStatus);

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMember.name.trim()) return;

    try {
      await createTeamMember({
        organizationId,
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
        <Spinner size="lg" />
      </div>
    );
  }

  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case "admin": return "brand";
      case "manager": return "info";
      case "agent": return "success";
      case "ai": return "warning";
      default: return "default";
    }
  };

  const getTypeBadgeVariant = (type: string) => {
    return type === "ai" ? "warning" : "info";
  };

  return (
    <div className="space-y-6">
      <SpotlightTooltip spotlightId="team" organizationId={organizationId} />

      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-text-primary">Membros da Equipe</h2>
        <Button onClick={() => setShowAddMember(true)}>
          Adicionar Membro
        </Button>
      </div>

      {/* Add Member Modal */}
      <Modal
        open={showAddMember}
        onClose={() => setShowAddMember(false)}
        title="Adicionar Membro da Equipe"
      >
        <form onSubmit={handleAddMember} className="space-y-4">
          <Input
            label="Nome *"
            type="text"
            value={newMember.name}
            onChange={(e) => setNewMember({ ...newMember, name: e.target.value })}
            required
          />

          <Input
            label="Email"
            type="email"
            value={newMember.email}
            onChange={(e) => setNewMember({ ...newMember, email: e.target.value })}
          />

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Tipo
            </label>
            <select
              value={newMember.type}
              onChange={(e) => setNewMember({ ...newMember, type: e.target.value as "human" | "ai" })}
              className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            >
              <option value="human">Humano</option>
              <option value="ai">Agente IA</option>
            </select>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Função
            </label>
            <select
              value={newMember.role}
              onChange={(e) => setNewMember({ ...newMember, role: e.target.value as any })}
              className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            >
              <option value="agent">Agente</option>
              <option value="manager">Gerente</option>
              <option value="admin">Admin</option>
              {newMember.type === "ai" && <option value="ai">IA</option>}
            </select>
          </div>

          <div className="flex gap-2 pt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowAddMember(false)}
              className="flex-1"
            >
              Cancelar
            </Button>
            <Button type="submit" className="flex-1">
              Adicionar Membro
            </Button>
          </div>
        </form>
      </Modal>

      {/* Team Members Grid */}
      <div className="grid gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {teamMembers.map((member) => (
          <Card key={member._id}>
            <div className="flex items-center gap-3 mb-4">
              <Avatar
                name={member.name}
                type={member.type}
                size="lg"
                status={member.status}
              />
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-text-primary truncate">{member.name}</h3>
                {member.email && (
                  <p className="text-sm text-text-secondary truncate">{member.email}</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <Badge variant={getRoleBadgeVariant(member.role)}>
                {member.role}
              </Badge>
              <Badge variant={getTypeBadgeVariant(member.type)}>
                {member.type === "ai" ? "IA" : "Humano"}
              </Badge>
            </div>

            <div className="mb-4">
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Status
              </label>
              <select
                value={member.status}
                onChange={(e) => handleStatusChange(member._id, e.target.value as any)}
                className={cn(
                  "w-full px-3 py-2 rounded-field text-sm font-medium border transition-colors",
                  "bg-surface-raised border-border-strong text-text-primary",
                  "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                )}
              >
                <option value="active">Ativo</option>
                <option value="busy">Ocupado</option>
                <option value="inactive">Inativo</option>
              </select>
            </div>

            <div className="text-xs text-text-muted">
              Desde {new Date(member.createdAt).toLocaleDateString("pt-BR")}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
