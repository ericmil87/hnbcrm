import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { CircleCheck, CircleX } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { mutationErrorMessage } from "@/lib/errors";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { LOST_REASONS, formatBRL, nightsBetween } from "./centralMeta";

export type OutcomeKind = "converted" | "not_converted";

interface OutcomeModalProps {
  open: boolean;
  kind: OutcomeKind;
  onClose: () => void;
  conversationId: Id<"conversations">;
  /** Valor atual do lead — ponto de partida do campo "Valor". */
  currentValue?: number;
  /** customFields já gravados (checkin/checkout/hospedes) para pré-preencher. */
  customFields?: Record<string, unknown>;
}

const fieldClass =
  "h-11 w-full rounded-lg border border-border-strong bg-surface-raised px-3 text-base text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 md:text-sm";
const labelClass = "mb-1.5 block text-[13px] font-medium text-text-secondary";

/**
 * "Convertido" (valor, check-in, check-out, hóspedes) ou "Não convertido"
 * (motivo). Fecha o lead pelo mesmo núcleo do Kanban (estágio Ganho/Perdido).
 */
export function OutcomeModal({
  open,
  kind,
  onClose,
  conversationId,
  currentValue,
  customFields,
}: OutcomeModalProps) {
  const markOutcome = useMutation(api.conversationRouting.markConversationOutcome);
  const [value, setValue] = useState("");
  const [checkin, setCheckin] = useState("");
  const [checkout, setCheckout] = useState("");
  const [guests, setGuests] = useState("");
  const [reason, setReason] = useState<string>(LOST_REASONS[0]);
  const [otherReason, setOtherReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    setValue(currentValue && currentValue > 0 ? String(currentValue) : "");
    setCheckin(str(customFields?.checkin));
    setCheckout(str(customFields?.checkout));
    const g = customFields?.hospedes;
    setGuests(typeof g === "number" || typeof g === "string" ? String(g) : "");
    setReason(LOST_REASONS[0]);
    setOtherReason("");
    // customFields muda de identidade a cada render da query; basta reabrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isConverted = kind === "converted";
  const numericValue = value.trim() === "" ? undefined : Number(value.replace(",", "."));
  const valueInvalid = numericValue !== undefined && (!Number.isFinite(numericValue) || numericValue < 0);
  const datesInvalid = !!checkin && !!checkout && checkout <= checkin;
  const nights = checkin && checkout ? nightsBetween(checkin, checkout) : null;
  const finalReason = reason === "Outro" ? otherReason.trim() : reason;
  const canSubmit = isConverted ? !valueInvalid && !datesInvalid : finalReason.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      if (isConverted) {
        const guestsNum = guests.trim() ? Math.max(1, Math.round(Number(guests))) : undefined;
        await markOutcome({
          conversationId,
          outcome: "converted",
          ...(numericValue !== undefined ? { value: numericValue } : {}),
          ...(checkin ? { checkin } : {}),
          ...(checkout ? { checkout } : {}),
          ...(guestsNum !== undefined && Number.isFinite(guestsNum) ? { guests: guestsNum } : {}),
        });
        toast.success("Reserva confirmada — lead marcado como convertido");
      } else {
        await markOutcome({ conversationId, outcome: "not_converted", reason: finalReason });
        toast.success("Lead marcado como não convertido");
      }
      onClose();
    } catch (err) {
      toast.error(mutationErrorMessage(err, "Falha ao registrar o desfecho"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isConverted ? "Reserva confirmada" : "Não convertido"}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {isConverted ? (
          <>
            <div>
              <label htmlFor="outcome-value" className={labelClass}>
                Valor da reserva
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-muted">
                  R$
                </span>
                <input
                  id="outcome-value"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="0"
                  className={`${fieldClass} pl-10 tabular-nums`}
                  aria-invalid={valueInvalid}
                />
              </div>
              {valueInvalid && <p className="mt-1 text-xs text-semantic-error">Valor inválido</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="outcome-checkin" className={labelClass}>
                  Check-in
                </label>
                <input
                  id="outcome-checkin"
                  type="date"
                  value={checkin}
                  onChange={(e) => setCheckin(e.target.value)}
                  className={fieldClass}
                />
              </div>
              <div>
                <label htmlFor="outcome-checkout" className={labelClass}>
                  Check-out
                </label>
                <input
                  id="outcome-checkout"
                  type="date"
                  value={checkout}
                  min={checkin || undefined}
                  onChange={(e) => setCheckout(e.target.value)}
                  className={fieldClass}
                  aria-invalid={datesInvalid}
                />
              </div>
            </div>
            {datesInvalid && (
              <p className="-mt-2 text-xs text-semantic-error">O check-out precisa ser depois do check-in</p>
            )}
            <div>
              <label htmlFor="outcome-guests" className={labelClass}>
                Hóspedes
              </label>
              <input
                id="outcome-guests"
                type="number"
                min={1}
                max={50}
                inputMode="numeric"
                value={guests}
                onChange={(e) => setGuests(e.target.value)}
                placeholder="2"
                className={`${fieldClass} tabular-nums`}
              />
            </div>
            {(nights || (numericValue !== undefined && !valueInvalid && numericValue > 0)) && (
              <p className="flex items-center gap-2 rounded-lg bg-semantic-success/10 px-3 py-2 text-sm text-semantic-success">
                <CircleCheck size={15} className="shrink-0" aria-hidden />
                <span className="tabular-nums">
                  {[
                    numericValue !== undefined && !valueInvalid && numericValue > 0
                      ? formatBRL(numericValue)
                      : null,
                    nights ? `${nights} noite${nights === 1 ? "" : "s"}` : null,
                    nights && numericValue ? `${formatBRL(numericValue / nights)}/noite` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </p>
            )}
          </>
        ) : (
          <>
            <div>
              <label htmlFor="outcome-reason" className={labelClass}>
                Motivo
              </label>
              <select
                id="outcome-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={fieldClass}
              >
                {LOST_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            {reason === "Outro" && (
              <div>
                <label htmlFor="outcome-other" className={labelClass}>
                  Qual motivo?
                </label>
                <input
                  id="outcome-other"
                  value={otherReason}
                  onChange={(e) => setOtherReason(e.target.value)}
                  maxLength={200}
                  autoFocus
                  className={fieldClass}
                />
              </div>
            )}
            <p className="flex items-start gap-2 text-xs text-text-muted">
              <CircleX size={14} className="mt-px shrink-0" aria-hidden />
              O lead vai para o estágio de Perdido do funil, com o motivo registrado para o painel.
            </p>
          </>
        )}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant={isConverted ? "primary" : "danger"}
            className="flex-1"
            disabled={!canSubmit || submitting}
          >
            {submitting ? "Salvando…" : isConverted ? "Confirmar reserva" : "Marcar não convertido"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
