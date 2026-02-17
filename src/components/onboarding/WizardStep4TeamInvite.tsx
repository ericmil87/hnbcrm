import { Bot, User, X } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface InviteRow {
  type: "human" | "ai";
  name: string;
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
  const update = (index: number, patch: Partial<InviteRow>) => {
    const updated = [...invites];
    updated[index] = { ...updated[index], ...patch };
    onInvitesChange(updated);
  };

  const handleRemove = (index: number) => {
    if (invites.length > 1) {
      onInvitesChange(invites.filter((_, i) => i !== index));
    }
  };

  const addHuman = () => {
    if (invites.length < 10) {
      onInvitesChange([...invites, { type: "human", name: "", email: "", role: "agent" }]);
    }
  };

  const addAI = () => {
    if (invites.length < 10) {
      onInvitesChange([...invites, { type: "ai", name: "", email: "", role: "agent" }]);
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold text-text-primary">
          Convide sua Equipe
        </h2>
        <p className="text-text-secondary">
          Adicione membros humanos e agentes de IA para colaborar no CRM
        </p>
      </div>

      <div className="space-y-3">
        {invites.map((invite, index) => (
          <div
            key={index}
            className="flex items-center gap-2 md:gap-3"
          >
            {/* Type icon */}
            <div className="flex-shrink-0 w-8 flex items-center justify-center">
              {invite.type === "ai" ? (
                <Bot size={18} className="text-semantic-warning" />
              ) : (
                <User size={18} className="text-brand-500" />
              )}
            </div>

            {invite.type === "ai" ? (
              <>
                <input
                  type="text"
                  placeholder="Nome do agente IA"
                  value={invite.name}
                  onChange={(e) => update(index, { name: e.target.value })}
                  className="flex-1 bg-surface-raised border border-border-strong rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-semantic-warning focus:ring-2 focus:ring-semantic-warning/20 focus:outline-none transition-colors"
                  style={{ fontSize: "16px" }}
                  aria-label={`Nome do agente IA ${index + 1}`}
                />
                <span className="flex-shrink-0 px-2 py-1 text-xs font-medium rounded-md bg-semantic-warning/15 text-semantic-warning border border-semantic-warning/30">
                  IA
                </span>
              </>
            ) : (
              <>
                <input
                  type="email"
                  placeholder="email@exemplo.com"
                  value={invite.email}
                  onChange={(e) => update(index, { email: e.target.value })}
                  className="flex-1 bg-surface-raised border border-border-strong rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none transition-colors"
                  style={{ fontSize: "16px" }}
                  aria-label={`Email do membro ${index + 1}`}
                />
                <select
                  value={invite.role}
                  onChange={(e) =>
                    update(index, { role: e.target.value as "admin" | "manager" | "agent" })
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
              </>
            )}

            {/* Remove button or spacer */}
            {invites.length > 1 ? (
              <button
                type="button"
                onClick={() => handleRemove(index)}
                className="flex-shrink-0 p-2 text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 rounded-lg transition-colors"
                aria-label={`Remover convite ${index + 1}`}
              >
                <X size={18} />
              </button>
            ) : (
              <div className="w-8 flex-shrink-0" />
            )}
          </div>
        ))}
      </div>

      {invites.length < 10 && (
        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={addHuman}
            className="flex-1 sm:flex-none"
          >
            <User size={16} />
            + Humano
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={addAI}
            className="flex-1 sm:flex-none text-semantic-warning hover:text-semantic-warning hover:bg-semantic-warning/10"
          >
            <Bot size={16} />
            + Agente IA
          </Button>
        </div>
      )}

      <p className="text-xs text-text-muted text-center mt-6">
        Você pode convidar mais membros depois nas configurações
      </p>
    </div>
  );
}
