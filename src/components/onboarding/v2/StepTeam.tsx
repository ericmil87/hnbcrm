import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { Plus, UserPlus, X } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SectionCard } from "@/components/ui/SectionCard";
import { Select } from "@/components/ui/Select";
import { mutationErrorMessage } from "@/lib/errors";
import { inviteKey, inviteRowsToSend, MAX_INVITES, ROLE_OPTIONS, type InviteRole, type InviteRow } from "@/lib/onboardingTeam";
import { WizardInviteResults, summarizeInviteOutcomes, type InviteOutcome } from "../WizardInviteResults";
import { WizardNav } from "./OnboardingWizardV2View";

interface StepTeamProps {
  organizationId: Id<"organizations">;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  skipLoading?: boolean;
}

const emptyRow = (): InviteRow => ({ name: "", email: "", role: "agent" });

/** Passo 7: convites humanos (nome, e-mail, papel). Voltar e avançar de novo não reconvida quem já foi processado. */
export function StepTeam({ organizationId, onBack, onNext, onSkip, skipLoading }: StepTeamProps) {
  const inviteHumanMember = useAction(api.nodeActions.inviteHumanMember);
  const [rows, setRows] = useState<InviteRow[]>(() => [emptyRow()]);
  const [outcomes, setOutcomes] = useState<InviteOutcome[]>([]);
  const [sending, setSending] = useState(false);

  const update = (index: number, patch: Partial<InviteRow>) =>
    setRows((r) => r.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const send = async () => {
    const done = new Set(outcomes.filter((o) => o.kind !== "failed").map((o) => o.key));
    const toSend = inviteRowsToSend(rows, done);
    if (toSend.length === 0) {
      onNext();
      return;
    }
    setSending(true);
    const results: InviteOutcome[] = [];
    for (const row of toSend) {
      const key = inviteKey(row);
      const email = row.email.trim();
      const name = row.name.trim() || email.split("@")[0];
      try {
        const r = await inviteHumanMember({ organizationId, name, email, role: row.role });
        results.push({
          key,
          name,
          email,
          kind: r.isNewUser ? "new" : r.reactivated ? "reactivated" : "existing",
          tempPassword: r.tempPassword,
          emailSent: r.emailSent,
          pendingPasswordChange: !r.isNewUser && r.pendingPasswordChange,
        });
      } catch (e) {
        const message = mutationErrorMessage(e, "Não foi possível convidar.");
        results.push({
          key,
          name,
          email,
          kind: /já é membro/i.test(message) ? "already_member" : "failed",
          error: message,
        });
      }
    }
    setSending(false);
    setOutcomes((prev) => [...prev.filter((o) => !results.some((r) => r.key === o.key)), ...results]);
    const summary = summarizeInviteOutcomes(results);
    const failed = results.some((r) => r.kind === "failed");
    if (failed) toast.warning(summary);
    else toast.success(summary);
    // Com senha temporária para copiar, a pessoa fica aqui até avançar por conta própria.
    if (!failed && !results.some((r) => r.tempPassword)) onNext();
  };

  const hasPending = inviteRowsToSend(rows, new Set(outcomes.filter((o) => o.kind !== "failed").map((o) => o.key))).length > 0;
  const hasResults = outcomes.length > 0;

  return (
    <div className="space-y-4">
      <SectionCard title="Convide sua equipe" description="Cada pessoa recebe um e-mail com o acesso. Dá para convidar mais gente depois, em Equipe.">
        <div className="space-y-4">
          {rows.map((row, index) => (
            <div key={index} className="grid gap-3 sm:grid-cols-[1fr_1fr_160px_auto] sm:items-end">
              <Input
                label="Nome"
                id={`invite-name-${index}`}
                value={row.name}
                onChange={(e) => update(index, { name: e.target.value })}
                placeholder="Maria Souza"
                autoComplete="off"
              />
              <Input
                label="E-mail"
                id={`invite-email-${index}`}
                type="email"
                value={row.email}
                onChange={(e) => update(index, { email: e.target.value })}
                placeholder="maria@exemplo.com"
                autoComplete="off"
              />
              <Select
                label="Papel"
                id={`invite-role-${index}`}
                value={row.role}
                onValueChange={(v) => update(index, { role: v as InviteRole })}
                options={ROLE_OPTIONS}
              />
              {rows.length > 1 ? (
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={`Remover convite ${index + 1}`}
                  onClick={() => setRows((r) => r.filter((_, i) => i !== index))}
                >
                  <X size={18} aria-hidden="true" />
                </Button>
              ) : (
                <span className="hidden w-11 sm:block" aria-hidden="true" />
              )}
            </div>
          ))}
          {rows.length < MAX_INVITES && (
            <Button variant="secondary" size="sm" onClick={() => setRows((r) => [...r, emptyRow()])}>
              <Plus size={16} aria-hidden="true" />
              Adicionar outra pessoa
            </Button>
          )}
        </div>
        <WizardInviteResults outcomes={outcomes} />
      </SectionCard>
      <WizardNav
        onBack={onBack}
        onSkip={hasResults ? undefined : onSkip}
        skipLoading={skipLoading}
        onContinue={() => void send()}
        continueLoading={sending}
        continueLabel={hasPending ? "Convidar e continuar" : "Continuar"}
      />
      {!hasPending && !hasResults && (
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <UserPlus size={14} aria-hidden="true" />
          Preencha o e-mail de quem você quer convidar, ou pule por enquanto.
        </p>
      )}
    </div>
  );
}
