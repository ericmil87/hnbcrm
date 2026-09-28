import { useState } from "react";
import { AlertTriangle, Bot, Check, Copy, MailWarning, UserCheck, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export type InviteOutcomeKind =
  | "new" // conta criada agora — tem senha temporária
  | "existing" // já tinha conta: só foi adicionada à org
  | "reactivated" // já tinha sido membro e foi removida: voltou
  | "already_member" // já era membro ativo — nada mudou
  | "ai"
  | "failed";

export interface InviteOutcome {
  key: string;
  name: string;
  email?: string;
  kind: InviteOutcomeKind;
  tempPassword?: string;
  emailSent?: boolean;
  /** Conta existente que ainda não trocou a senha temporária de outro convite. */
  pendingPasswordChange?: boolean;
  error?: string;
}

/** Resumo honesto para o toast: diz o que de fato aconteceu com cada linha. */
export function summarizeInviteOutcomes(outcomes: InviteOutcome[]): string {
  const count = (kinds: InviteOutcomeKind[]) =>
    outcomes.filter((o) => kinds.includes(o.kind)).length;
  const parts: string[] = [];
  const created = count(["new"]);
  const added = count(["existing", "reactivated"]);
  const ais = count(["ai"]);
  const already = count(["already_member"]);
  const failed = count(["failed"]);
  if (created) parts.push(`${created} convite${created > 1 ? "s" : ""} criado${created > 1 ? "s" : ""}`);
  if (added) parts.push(`${added} pessoa${added > 1 ? "s" : ""} com conta adicionada${added > 1 ? "s" : ""}`);
  if (ais) parts.push(`${ais} agente${ais > 1 ? "s" : ""} IA criado${ais > 1 ? "s" : ""}`);
  if (already) parts.push(`${already} já era${already > 1 ? "m" : ""} membro${already > 1 ? "s" : ""}`);
  if (failed) parts.push(`${failed} falha${failed > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

export function WizardInviteResults({ outcomes }: { outcomes: InviteOutcome[] }) {
  if (outcomes.length === 0) return null;
  const hasPasswords = outcomes.some((o) => o.tempPassword);

  return (
    <section aria-label="Resultado dos convites" className="mt-8 space-y-3">
      <h3 className="text-sm font-semibold text-text-primary">Convites da equipe</h3>
      {hasPasswords && (
        <div className="flex gap-3 bg-semantic-warning/10 border border-semantic-warning/30 rounded-lg p-3">
          <AlertTriangle size={18} className="shrink-0 text-semantic-warning mt-0.5" />
          <p className="text-sm text-text-primary leading-relaxed">
            Copie as senhas temporárias agora — elas não serão exibidas de novo. Cada pessoa troca a
            senha no primeiro acesso.
          </p>
        </div>
      )}
      <ul className="space-y-2">
        {outcomes.map((o) => (
          <InviteOutcomeRow key={o.key} outcome={o} />
        ))}
      </ul>
    </section>
  );
}

function InviteOutcomeRow({ outcome }: { outcome: InviteOutcome }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!outcome.tempPassword) return;
    try {
      await navigator.clipboard.writeText(outcome.tempPassword);
      setCopied(true);
      toast.success("Senha copiada");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar. Selecione a senha e copie manualmente.");
    }
  };

  const { icon: Icon, tone, text } = describe(outcome);

  return (
    <li className="bg-surface-raised border border-border rounded-card p-3 space-y-2">
      <div className="flex items-start gap-3">
        <span className={cn("flex items-center justify-center h-8 w-8 rounded-lg shrink-0", tone.bg)}>
          <Icon size={16} className={tone.fg} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary truncate">{outcome.name}</p>
          {outcome.email && <p className="text-xs text-text-muted truncate">{outcome.email}</p>}
          <p className="text-xs text-text-secondary mt-1">{text}</p>
        </div>
      </div>

      {outcome.tempPassword && (
        <div className="flex items-center gap-2 bg-surface-sunken border border-border rounded-lg pl-3 pr-1 py-1">
          <code className="flex-1 text-sm font-mono text-text-primary break-all select-all">
            {outcome.tempPassword}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center justify-center h-11 w-11 shrink-0 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
            aria-label={`Copiar senha temporária de ${outcome.name}`}
          >
            {copied ? <Check size={16} className="text-semantic-success" /> : <Copy size={16} />}
          </button>
        </div>
      )}

      {outcome.tempPassword && outcome.emailSent === false && (
        <p className="flex items-start gap-2 text-xs text-semantic-warning">
          <MailWarning size={14} className="shrink-0 mt-0.5" />
          O e-mail de convite não foi enviado — mande a senha por outro canal.
        </p>
      )}
    </li>
  );
}

function describe(o: InviteOutcome) {
  const ok = { bg: "bg-semantic-success/10", fg: "text-semantic-success" };
  switch (o.kind) {
    case "new":
      return {
        icon: UserPlus,
        tone: ok,
        text: o.emailSent
          ? "Conta criada. Enviamos o convite com a senha temporária por e-mail."
          : "Conta criada com a senha temporária abaixo.",
      };
    case "existing":
      return {
        icon: UserCheck,
        tone: ok,
        text: o.pendingPasswordChange
          ? `Já tinha conta, mas ainda não trocou a senha temporária.${
              o.emailSent ? " Avisamos por e-mail." : " O e-mail de aviso não saiu — avise por outro canal."
            }`
          : o.emailSent
            ? "Já tinha conta: entrou na organização com a senha de sempre. Avisamos por e-mail."
            : "Já tinha conta: entrou na organização com a senha de sempre. O e-mail de aviso não saiu — avise por outro canal.",
      };
    case "reactivated":
      return {
        icon: UserCheck,
        tone: ok,
        text: "Já tinha sido membro: o acesso foi reativado.",
      };
    case "already_member":
      return {
        icon: UserCheck,
        tone: { bg: "bg-surface-overlay", fg: "text-text-muted" },
        text: "Já era membro desta organização.",
      };
    case "ai":
      return {
        icon: Bot,
        tone: { bg: "bg-semantic-warning/10", fg: "text-semantic-warning" },
        text: "Agente IA criado. Gere a chave API em Configurações quando for usar.",
      };
    case "failed":
      return {
        icon: AlertTriangle,
        tone: { bg: "bg-semantic-error/10", fg: "text-semantic-error" },
        text: o.error ? `Não foi possível convidar: ${o.error}` : "Não foi possível convidar.",
      };
  }
}
