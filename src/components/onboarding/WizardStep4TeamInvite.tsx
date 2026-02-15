import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface InviteRow {
  email: string;
  role: "admin" | "manager" | "agent";
}

interface WizardStep4TeamInviteProps {
  invites: InviteRow[];
  onInvitesChange: (invites: InviteRow[]) => void;
}

const roleLabels: Record<"admin" | "manager" | "agent", string> = {
  admin: "Admin",
  manager: "Gerente",
  agent: "Agente",
};

export function WizardStep4TeamInvite({
  invites,
  onInvitesChange,
}: WizardStep4TeamInviteProps) {
  const handleEmailChange = (index: number, email: string) => {
    const updated = [...invites];
    updated[index] = { ...updated[index], email };
    onInvitesChange(updated);
  };

  const handleRoleChange = (index: number, role: "admin" | "manager" | "agent") => {
    const updated = [...invites];
    updated[index] = { ...updated[index], role };
    onInvitesChange(updated);
  };

  const handleRemove = (index: number) => {
    if (invites.length > 1) {
      const updated = invites.filter((_, i) => i !== index);
      onInvitesChange(updated);
    }
  };

  const handleAdd = () => {
    if (invites.length < 10) {
      onInvitesChange([...invites, { email: "", role: "agent" }]);
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold text-text-primary">
          Convide sua Equipe
        </h2>
        <p className="text-text-secondary">
          Adicione membros para colaborar no CRM
        </p>
      </div>

      <div className="space-y-3">
        {invites.map((invite, index) => (
          <div
            key={index}
            className="flex items-center gap-2 md:gap-3"
          >
            <input
              type="email"
              placeholder="email@exemplo.com"
              value={invite.email}
              onChange={(e) => handleEmailChange(index, e.target.value)}
              className="flex-1 bg-surface-raised border border-border-strong rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
              style={{ fontSize: "16px" }}
              aria-label={`Email do membro ${index + 1}`}
            />
            <select
              value={invite.role}
              onChange={(e) =>
                handleRoleChange(
                  index,
                  e.target.value as "admin" | "manager" | "agent"
                )
              }
              className="w-28 md:w-32 bg-surface-raised border border-border-strong rounded-lg px-3 py-2 text-sm text-text-primary focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors cursor-pointer"
              style={{ fontSize: "16px" }}
              aria-label={`Papel do membro ${index + 1}`}
            >
              {Object.entries(roleLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {invites.length > 1 && (
              <button
                type="button"
                onClick={() => handleRemove(index)}
                className="p-2 text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 rounded-lg transition-colors"
                aria-label={`Remover convite ${index + 1}`}
              >
                <X size={18} />
              </button>
            )}
          </div>
        ))}
      </div>

      {invites.length < 10 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleAdd}
          className="w-full md:w-auto"
        >
          <Plus size={18} />
          Adicionar outro
        </Button>
      )}

      <p className="text-xs text-text-muted text-center mt-6">
        Você pode convidar mais membros depois nas configurações
      </p>
    </div>
  );
}
