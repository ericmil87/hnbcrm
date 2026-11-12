import { useState, type ReactNode } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { checkReleaseReason, RELEASE_REASON_MAX, type DraftUpdate } from "@/lib/onboardingDraftEdit";
import { plainModelText } from "@/lib/onboardingChat";
import { cn } from "@/lib/utils";

/** Como a pessoa edita um cartão: `save` recebe a mudança e a versão que o formulário tinha ao abrir. */
export interface CardEditor {
  version: number;
  saving: boolean;
  save: (update: DraftUpdate, baseVersion: number) => Promise<boolean>;
}

/** Salvar / Cancelar de um formulário de ajuste (44 px no toque, pelo `Button`). */
export function FormActions({
  onSave,
  onCancel,
  saving,
  saveDisabled,
  saveLabel = "Salvar ajuste",
}: {
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
  saveLabel?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <Button size="sm" onClick={onSave} loading={saving} disabled={saveDisabled}>
        {saveLabel}
      </Button>
      <Button size="sm" variant="secondary" onClick={onCancel} disabled={saving}>
        Cancelar
      </Button>
    </div>
  );
}

/** Versão do rascunho que o formulário viu ao abrir (não a de agora): é a `baseVersion` que ele envia. */
export function useBaseVersion(version: number, reset?: () => void) {
  const [base, setBase] = useState(version);
  return {
    base,
    /** O rascunho mudou depois que o formulário abriu. */
    stale: version !== base,
    /** Descarta os campos e recarrega da versão nova. */
    reload: () => {
      reset?.();
      setBase(version);
    },
  };
}

/** Aviso de edição concorrente: o texto digitado fica na tela; gravar só depois de recarregar. */
export function StaleNotice({ stale, onReload }: { stale: boolean; onReload: () => void }) {
  if (!stale) return null;
  return (
    <div role="alert" className="space-y-1.5 rounded-field bg-semantic-warning/10 px-2 py-1.5 text-caption text-text-primary">
      <p>O rascunho mudou enquanto você editava. Seu texto continua aqui, mas não foi salvo. Recarregue os campos para ver a versão nova.</p>
      <Button size="sm" variant="secondary" onClick={onReload}>
        Recarregar os campos
      </Button>
    </div>
  );
}

export interface ReleaseControlProps {
  /** Versão do rascunho que a tela mostra agora. */
  version: number;
  /** Recebe o motivo já validado e a versão de quando o controle abriu; `false` mantém o formulário aberto. */
  onRelease: (reason: string, baseVersion: number) => Promise<boolean> | boolean | void;
  disabled?: boolean;
}

/**
 * "Usar mesmo assim": o item marcado só entra na operação depois de a pessoa
 * dizer por quê. O motivo vai em `release: { reason }` e é auditado no servidor.
 * A versão do rascunho é fixada ao abrir: se mudar com o controle aberto, ele
 * avisa e não libera (o item pode ser outro).
 */
export function ReleaseControl({ version, onRelease, disabled }: ReleaseControlProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { base, stale, reload } = useBaseVersion(version);

  if (!open) {
    return (
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled}
        onClick={() => {
          reload();
          setOpen(true);
        }}
      >
        Usar mesmo assim
      </Button>
    );
  }

  const confirm = async () => {
    const check = checkReleaseReason(reason);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await onRelease(check.reason, base);
      if (result !== false) setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full space-y-2 rounded-field border border-semantic-warning/40 bg-surface-sunken p-2">
      <Input
        label="Por que este trecho pode entrar?"
        value={reason}
        maxLength={RELEASE_REASON_MAX}
        onChange={(e) => {
          setReason(e.target.value);
          setError(null);
        }}
        error={error ?? undefined}
        placeholder="Ex.: é o telefone da minha loja"
      />
      <p className="text-caption text-text-muted">O motivo fica registrado no histórico de alterações.</p>
      {stale && (
        <p role="alert" className="text-caption text-text-primary">
          O rascunho mudou desde que você abriu. Confira o item na lista e abra de novo; nada foi liberado.
        </p>
      )}
      <FormActions
        onSave={() => void confirm()}
        onCancel={() => setOpen(false)}
        saving={busy}
        saveDisabled={stale}
        saveLabel="Usar mesmo assim"
      />
    </div>
  );
}

/** Aviso de item marcado: motivo (do servidor, como texto puro) e explicação curta. */
export function FlagNotice({ reason, children }: { reason?: string; children?: ReactNode }) {
  const clean = reason ? plainModelText(reason) : "";
  return (
    <p className="flex items-start gap-1.5 rounded-field bg-semantic-warning/10 px-2 py-1.5 text-caption text-text-primary">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-semantic-warning" aria-hidden="true" />
      <span>
        <span className="font-medium">Marcado para revisão.</span>{" "}
        {clean ? <>Motivo: {clean}. </> : null}
        Fica de fora da operação até você usar mesmo assim ou editar o texto.
        {children}
      </span>
    </p>
  );
}

/** Item bloqueado (nome estrutural): sem liberação, só edição. */
export function BlockedNotice({ label, reason }: { label: string; reason: string }) {
  return (
    <li className="flex items-start gap-1.5 rounded-field bg-semantic-error/10 px-2 py-1.5 text-caption text-text-primary">
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-semantic-error" aria-hidden="true" />
      <span>
        <span className="font-medium">{plainModelText(label)}</span>: {plainModelText(reason) || "texto não permitido"}. Edite o
        nome para continuar; não há como liberar.
      </span>
    </li>
  );
}

export function Tag({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "ok" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium",
        tone === "ok" ? "bg-semantic-success/15 text-text-primary" : "bg-surface-sunken text-text-secondary"
      )}
    >
      {children}
    </span>
  );
}
