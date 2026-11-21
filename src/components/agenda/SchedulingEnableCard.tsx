import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { CalendarClock, CalendarPlus, DoorOpen, Sparkles } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAccountReadOnly } from "@/hooks/useAccountReadOnly";
import { SectionCard } from "@/components/ui/SectionCard";
import { mutationErrorMessage } from "@/lib/errors";
import { VOCAB } from "@/lib/vocab";

export interface SchedulingEnableCardViewProps {
  /** `locked` = tem `agenda:manage`, mas não `settings:manage` (a mutation recusaria). */
  state: "ready" | "locked";
  busy?: boolean;
  /** Mensagem do servidor da última tentativa recusada (gate de plano, modo leitura...). */
  error?: string | null;
  /** Conta em modo leitura: avisa ANTES do clique (o servidor recusa ligar). */
  readOnly?: boolean;
  onActivate: () => void;
}

const BULLETS = [
  { icon: CalendarPlus, text: VOCAB.scheduling.enable.bullets.slots },
  { icon: DoorOpen, text: VOCAB.scheduling.enable.bullets.resources },
  { icon: Sparkles, text: VOCAB.scheduling.enable.bullets.ai },
] as const;

/** Cartão "Atende com hora marcada?" com o botão Ativar. Apresentacional; o container liga a mutation. */
export function SchedulingEnableCardView({ state, busy = false, error, readOnly = false, onActivate }: SchedulingEnableCardViewProps) {
  return (
    <SectionCard
      title={VOCAB.scheduling.enable.title}
      description={VOCAB.scheduling.enable.hint}
      icon={<CalendarClock size={20} aria-hidden="true" />}
    >
      <ul className="mb-4 space-y-2">
        {BULLETS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2.5 text-sm text-text-secondary">
            <Icon size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      {readOnly && state === "ready" && (
        <p role="status" className="mb-3 rounded-card border border-semantic-warning/30 bg-semantic-warning/5 p-3 text-sm text-semantic-warning">
          {VOCAB.scheduling.enable.readOnlyWarning}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 rounded-card border border-semantic-error/30 bg-semantic-error/5 p-3 text-sm text-semantic-error">
          {error}
        </p>
      )}
      {state === "ready" ? (
        <Button size="lg" className="w-full sm:w-auto" loading={busy} onClick={onActivate}>
          {VOCAB.scheduling.enable.cta}
        </Button>
      ) : (
        <p className="text-sm text-text-muted">{VOCAB.scheduling.enable.needsAdmin}</p>
      )}
    </SectionCard>
  );
}

/**
 * Liga o módulo `scheduling` pela mutation existente `orgModules.setOrgModules` (a mesma dos outros módulos
 * opcionais). O gate de plano e o modo leitura recusam no servidor: a mensagem dele aparece no cartão e no toast.
 */
export function SchedulingEnableCard({ organizationId, state }: { organizationId: Id<"organizations">; state: "ready" | "locked" }) {
  const setOrgModules = useMutation(api.orgModules.setOrgModules);
  const readOnly = useAccountReadOnly(organizationId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      await setOrgModules({ organizationId, modules: { scheduling: true } });
      toast.success(VOCAB.scheduling.enable.onToast);
    } catch (e) {
      const message = mutationErrorMessage(e, VOCAB.scheduling.enable.failed);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return <SchedulingEnableCardView state={state} busy={busy} error={error} readOnly={readOnly} onActivate={() => void activate()} />;
}

/** Texto do diálogo de desligar; com a conta em modo leitura avisa que não dá para religar. */
export function disableDialogText(readOnly: boolean): string {
  return readOnly ? `${VOCAB.scheduling.enable.offHint} ${VOCAB.scheduling.enable.offReadOnly}` : VOCAB.scheduling.enable.offHint;
}

/** Desligar o módulo (quem liga pode desligar), sempre atrás de confirmação. */
export function SchedulingDisableButton({ organizationId }: { organizationId: Id<"organizations"> }) {
  const setOrgModules = useMutation(api.orgModules.setOrgModules);
  const readOnly = useAccountReadOnly(organizationId);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const disable = async () => {
    setBusy(true);
    try {
      await setOrgModules({ organizationId, modules: { scheduling: false } });
      toast.success(VOCAB.scheduling.enable.offToast);
    } catch (e) {
      toast.error(mutationErrorMessage(e, VOCAB.scheduling.enable.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="secondary" loading={busy} onClick={() => setOpen(true)}>
        {VOCAB.scheduling.enable.off}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => void disable()}
        title={VOCAB.scheduling.enable.offTitle}
        description={disableDialogText(readOnly)}
        confirmLabel={VOCAB.scheduling.enable.offConfirm}
        variant="danger"
      />
    </>
  );
}
