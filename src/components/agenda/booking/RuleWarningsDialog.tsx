import { useEffect, useState } from "react";
import { AlertTriangle, Ban } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { VOCAB } from "@/lib/vocab";
import { BOOKING_COPY } from "@/lib/bookingCopy";
import {
  classifyViolations,
  isSlotTaken,
  unacceptedWarnings,
  violationText,
  type OfferedSlot,
  type ViolationView,
} from "@/lib/bookingFlow";
import { SlotButton } from "./SlotSuggestionList";

interface RuleWarningsDialogProps {
  open: boolean;
  violations: ViolationView[];
  /** Já lidas por `readAlternatives` (os dois formatos do servidor). */
  alternatives: OfferedSlot[];
  resourceNames?: ReadonlyMap<string, string>;
  tz: string;
  /** Como o horário foi escolhido: o título de "tomado" só vale para sugestão; digitado = "não está livre". */
  slotSource?: "suggestion" | "manual";
  busy?: boolean;
  /**
   * Reenvia com `force` SÓ dos avisos mostrados (nunca chamado quando há bloqueio): pares `CÓDIGO:resourceId` para
   * aviso de recurso, código puro para aviso do agendamento inteiro; inclui o que a pessoa já aceitou nesta abertura.
   */
  onForce: (tokens: string[]) => void;
  onPickAlternative: (slot: OfferedSlot) => void;
  onClose: () => void;
}

/**
 * Resposta do servidor às regras. Só avisos: lista em linguagem clara e "Marcar mesmo assim" (a equipe
 * decide). Com bloqueio (capacidade cheia, recurso fechado para a IA...): NÃO existe botão de forçar, e as
 * alternativas do servidor viram horários de um toque. Horário tomado no meio do fluxo é um bloqueio.
 */
export function RuleWarningsDialog({
  open,
  violations,
  alternatives,
  resourceNames,
  tz,
  slotSource = "suggestion",
  busy = false,
  onForce,
  onPickAlternative,
  onClose,
}: RuleWarningsDialogProps) {
  const t = BOOKING_COPY.rulesDialog;
  const outcome = classifyViolations(violations);
  const blocked = !outcome.canForce;
  // O que a pessoa já aceitou nesta abertura: se o servidor devolver aviso FORA desse conjunto, a agenda mudou.
  const [accepted, setAccepted] = useState<string[]>([]);
  useEffect(() => {
    if (!open) setAccepted([]);
  }, [open]);
  const fresh = !blocked && accepted.length > 0 ? unacceptedWarnings(outcome.warnings, accepted) : [];
  const changed = fresh.length > 0;
  const title = changed
    ? t.changedTitle
    : blocked
    ? isSlotTaken(violations)
      ? slotSource === "manual"
        ? t.notFreeTitle
        : t.takenTitle
      : t.blockTitle
    : t.warnTitle;
  const show = blocked ? violations : outcome.warnings;
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <ul className="space-y-2" aria-label={title}>
          {show.map((v, i) => (
            <li key={`${v.code}:${i}`} className="flex items-start gap-2.5 text-sm text-text-primary">
              {blocked && !outcome.warnings.includes(v) ? (
                <Ban size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-semantic-error" />
              ) : (
                <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-semantic-warning" />
              )}
              <span className={fresh.includes(v) ? "font-semibold" : undefined}>
                {fresh.includes(v) ? <span className="mr-1.5 rounded-sm bg-semantic-warning/15 px-1.5 py-0.5 text-caption font-semibold uppercase text-semantic-warning">{t.newBadge}</span> : null}
                {violationText(v, resourceNames)}
              </span>
            </li>
          ))}
        </ul>

        {outcome.canForce ? (
          <>
            <p className="text-sm text-text-secondary">{changed ? t.changedHint : t.warnHint}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="secondary" className="sm:flex-1" onClick={onClose}>
                {t.back}
              </Button>
              <Button type="button" className="sm:flex-1" loading={busy} onClick={() => {
                  const tokens = [...new Set([...accepted, ...outcome.forceTokens])];
                  setAccepted(tokens);
                  onForce(tokens);
                }}>
                {VOCAB.scheduling.forceBook}
              </Button>
            </div>
          </>
        ) : (
          <>
            <section aria-label={t.alternatives} className="space-y-2">
              <h3 className="text-caption font-semibold uppercase tracking-wide text-text-muted">{t.alternatives}</h3>
              {alternatives.length > 0 ? (
                <ul className="space-y-2">
                  {alternatives.map((s) => (
                    <SlotButton
                      key={`${s.startTime}:${s.resourceIds.join(",")}`}
                      slot={s}
                      tz={tz}
                      selected={false}
                      showDay
                      onPick={onPickAlternative}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-secondary">{t.noAlternatives}</p>
              )}
            </section>
            <Button type="button" variant="secondary" className="w-full" onClick={onClose}>
              {t.chooseOther}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
