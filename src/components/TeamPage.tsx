import { useState, useMemo } from "react";
import { useOutletContext } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { PermissionGate } from "@/components/guards/PermissionGate";
import { InviteMemberModal } from "@/components/team/InviteMemberModal";
import { MemberDetailSlideOver } from "@/components/team/MemberDetailSlideOver";
import { usePermissions } from "@/hooks/usePermissions";
import { cn } from "@/lib/utils";
import {
  Search,
  UserPlus,
  Users,
  Bot,
  Shield,
  Filter,
} from "lucide-react";

type RoleFilter = "all" | "admin" | "manager" | "agent" | "ai";
type TypeFilter = "all" | "human" | "ai";
type StatusFilter = "all" | "active" | "inactive" | "busy";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Gerente",
  agent: "Agente",
  ai: "IA",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Ativo",
  busy: "Ocupado",
  inactive: "Inativo",
};

export function TeamPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { can, member: currentMember } = usePermissions(organizationId);
  const canManage = can("team", "manage");

  const [showInvite, setShowInvite] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState<Id<"teamMembers"> | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showFilters, setShowFilters] = useState(false);

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, {
    organizationId,
  });

  const filteredMembers = useMemo(() => {
    if (!teamMembers) return [];

    return teamMembers.filter((m) => {
      // Search
      if (search) {
        const q = search.toLowerCase();
        const matchesName = m.name.toLowerCase().includes(q);
        const matchesEmail = m.email?.toLowerCase().includes(q);
        if (!matchesName && !matchesEmail) return false;
      }

      // Role
      if (roleFilter !== "all" && m.role !== roleFilter) return false;

      // Type
      if (typeFilter !== "all" && m.type !== typeFilter) return false;

      // Status
      if (statusFilter !== "all" && m.status !== statusFilter) return false;

      return true;
    });
  }, [teamMembers, search, roleFilter, typeFilter, statusFilter]);

  const selectedMember = useMemo(() => {
    if (!selectedMemberId || !teamMembers) return null;
    return teamMembers.find((m) => m._id === selectedMemberId) || null;
  }, [selectedMemberId, teamMembers]);

  // Stats
  const stats = useMemo(() => {
    if (!teamMembers) return { total: 0, humans: 0, ais: 0, active: 0 };
    return {
      total: teamMembers.length,
      humans: teamMembers.filter((m) => m.type === "human").length,
      ais: teamMembers.filter((m) => m.type === "ai").length,
      active: teamMembers.filter((m) => m.status === "active").length,
    };
  }, [teamMembers]);

  const hasActiveFilters = roleFilter !== "all" || typeFilter !== "all" || statusFilter !== "all";

  const clearFilters = () => {
    setRoleFilter("all");
    setTypeFilter("all");
    setStatusFilter("all");
    setSearch("");
  };

  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case "admin": return "brand" as const;
      case "manager": return "info" as const;
      case "agent": return "success" as const;
      case "ai": return "warning" as const;
      default: return "default" as const;
    }
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case "active": return "success" as const;
      case "busy": return "warning" as const;
      case "inactive": return "error" as const;
      default: return "default" as const;
    }
  };

  if (!teamMembers) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text-primary">Equipe</h2>
          <p className="text-sm text-text-secondary mt-1">
            {stats.total} membros &middot; {stats.active} ativos
          </p>
        </div>
        <PermissionGate
          organizationId={organizationId}
          category="team"
          level="manage"
        >
          <Button onClick={() => setShowInvite(true)}>
            <UserPlus size={18} />
            Adicionar Membro
          </Button>
        </PermissionGate>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="flex items-center gap-3 !p-3">
          <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-brand-500/10 shrink-0">
            <Users size={20} className="text-brand-500" />
          </div>
          <div>
            <p className="text-xl font-bold text-text-primary tabular-nums">{stats.total}</p>
            <p className="text-xs text-text-muted">Total</p>
          </div>
        </Card>
        <Card className="flex items-center gap-3 !p-3">
          <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-semantic-info/10 shrink-0">
            <Users size={20} className="text-semantic-info" />
          </div>
          <div>
            <p className="text-xl font-bold text-text-primary tabular-nums">{stats.humans}</p>
            <p className="text-xs text-text-muted">Humanos</p>
          </div>
        </Card>
        <Card className="flex items-center gap-3 !p-3">
          <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-semantic-warning/10 shrink-0">
            <Bot size={20} className="text-semantic-warning" />
          </div>
          <div>
            <p className="text-xl font-bold text-text-primary tabular-nums">{stats.ais}</p>
            <p className="text-xs text-text-muted">Agentes IA</p>
          </div>
        </Card>
        <Card className="flex items-center gap-3 !p-3">
          <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-semantic-success/10 shrink-0">
            <Shield size={20} className="text-semantic-success" />
          </div>
          <div>
            <p className="text-xl font-bold text-text-primary tabular-nums">{stats.active}</p>
            <p className="text-xs text-text-muted">Ativos</p>
          </div>
        </Card>
      </div>

      {/* Search & Filters */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              icon={<Search size={18} />}
              placeholder="Buscar por nome ou email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button
            variant={hasActiveFilters ? "primary" : "secondary"}
            size="md"
            onClick={() => setShowFilters(!showFilters)}
            aria-label="Filtros"
          >
            <Filter size={18} />
            <span className="hidden sm:inline">Filtros</span>
          </Button>
        </div>

        {showFilters && (
          <div className="flex flex-wrap gap-3 p-3 bg-surface-raised border border-border rounded-lg animate-fade-in-up">
            {/* Role filter */}
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">
                Função
              </label>
              <div className="flex flex-wrap gap-1">
                {(["all", "admin", "manager", "agent", "ai"] as RoleFilter[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRoleFilter(r)}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-xs font-medium transition-colors min-h-[32px]",
                      roleFilter === r
                        ? "bg-brand-500 text-white"
                        : "bg-surface-overlay text-text-secondary hover:text-text-primary"
                    )}
                  >
                    {r === "all" ? "Todos" : ROLE_LABELS[r]}
                  </button>
                ))}
              </div>
            </div>

            {/* Type filter */}
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">
                Tipo
              </label>
              <div className="flex gap-1">
                {(["all", "human", "ai"] as TypeFilter[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t)}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-xs font-medium transition-colors min-h-[32px]",
                      typeFilter === t
                        ? "bg-brand-500 text-white"
                        : "bg-surface-overlay text-text-secondary hover:text-text-primary"
                    )}
                  >
                    {t === "all" ? "Todos" : t === "human" ? "Humano" : "IA"}
                  </button>
                ))}
              </div>
            </div>

            {/* Status filter */}
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">
                Status
              </label>
              <div className="flex gap-1">
                {(["all", "active", "inactive", "busy"] as StatusFilter[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-xs font-medium transition-colors min-h-[32px]",
                      statusFilter === s
                        ? "bg-brand-500 text-white"
                        : "bg-surface-overlay text-text-secondary hover:text-text-primary"
                    )}
                  >
                    {s === "all" ? "Todos" : STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
            </div>

            {hasActiveFilters && (
              <div className="flex items-end">
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Limpar Filtros
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Members grid */}
      {filteredMembers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Users size={48} className="text-text-muted mb-4" />
          <p className="text-text-secondary text-sm">
            {search || hasActiveFilters
              ? "Nenhum membro encontrado com os filtros atuais."
              : "Nenhum membro na equipe ainda."}
          </p>
          {(search || hasActiveFilters) && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="mt-2">
              Limpar Filtros
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {filteredMembers.map((member) => (
            <Card
              key={member._id}
              variant="interactive"
              onClick={() => setSelectedMemberId(member._id)}
              className={cn(
                "relative",
                member.status === "inactive" && "opacity-60"
              )}
            >
              <div className="flex items-center gap-3 mb-3">
                <Avatar
                  name={member.name}
                  type={member.type as "human" | "ai"}
                  size="lg"
                  status={member.status as "active" | "busy" | "inactive"}
                />
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-text-primary truncate">
                    {member.name}
                  </h3>
                  {member.email && (
                    <p className="text-sm text-text-secondary truncate">
                      {member.email}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={getRoleBadgeVariant(member.role)}>
                  {ROLE_LABELS[member.role] || member.role}
                </Badge>
                <Badge variant={member.type === "ai" ? "warning" : "info"}>
                  {member.type === "ai" ? "IA" : "Humano"}
                </Badge>
                <Badge variant={getStatusBadgeVariant(member.status)}>
                  {STATUS_LABELS[member.status] || member.status}
                </Badge>
              </div>

              <div className="text-xs text-text-muted mt-3">
                Desde {new Date(member.createdAt).toLocaleDateString("pt-BR")}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Invite modal */}
      <InviteMemberModal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        organizationId={organizationId}
      />

      {/* Member detail slide-over */}
      <MemberDetailSlideOver
        open={!!selectedMemberId}
        onClose={() => setSelectedMemberId(null)}
        member={selectedMember as any}
        organizationId={organizationId}
        canManage={canManage}
        currentMemberId={currentMember?._id as Id<"teamMembers">}
      />
    </div>
  );
}
