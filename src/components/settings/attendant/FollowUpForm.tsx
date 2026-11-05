import { FileEdit, PowerOff, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  FOLLOW_UP_DEFAULT_MAX_CHAIN,
  FOLLOW_UP_DEFAULT_QUIET_END_HOUR,
  FOLLOW_UP_DEFAULT_QUIET_START_HOUR,
  FOLLOW_UP_MAX_CHAIN_LIMIT,
  FOLLOW_UP_MAX_DAILY_CAP,
  followUpResetDefaults,
  type ConfigFormProps,
  type FollowUpForm as FollowUpValue,
} from "@/lib/attendantConfig";
import { FollowUpModeCard, NumberField, WarningNote } from "./fields";

/** O que a IA faz quando chega a hora de um follow-up que ela marcou. Campo controlado, sem dados. */
export function FollowUpForm({
  value,
  onChange,
  disabled,
  errors,
  variant = "panel",
  isAutopilot = false,
}: ConfigFormProps<FollowUpValue> & {
  /** Muda o aviso do modo "Enviar sozinho" (em Sugerir respostas ele vira resposta sugerida). */
  isAutopilot?: boolean;
}) {
  const panel = variant === "panel";
  const set = (patch: Partial<FollowUpValue>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Follow-ups agendados pela IA" className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <FollowUpModeCard
          active={value.mode === "off"}
          icon={PowerOff}
          title="Desligado"
          subtitle="A IA só cria a tarefa. No vencimento nada acontece sozinho: alguém do time precisa agir."
          onClick={() => !disabled && set({ mode: "off" })}
        />
        <FollowUpModeCard
          active={value.mode === "draft"}
          icon={FileEdit}
          title="Preparar resposta sugerida"
          subtitle="No vencimento, a IA deixa uma resposta sugerida em Conversas: você revisa e envia."
          badge="Recomendado"
          onClick={() => !disabled && set({ mode: "draft" })}
        />
        <FollowUpModeCard
          active={value.mode === "send"}
          icon={Send}
          title="Enviar sozinho"
          subtitle="No vencimento, a IA manda a mensagem sozinha (em Responder sozinha)."
          onClick={() => !disabled && set({ mode: "send" })}
        />
      </div>

      {value.mode === "send" && panel && (
        <WarningNote
          messages={[
            "A IA manda a mensagem sem o cliente ter escrito nada antes. No WhatsApp por QR code isso conta como envio frio; no oficial (Meta), fora da janela de 24h o texto vira resposta sugerida automaticamente.",
            ...(isAutopilot
              ? []
              : ["O atendente está em Sugerir respostas: na prática, os follow-ups também viram resposta sugerida até você ativar Responder sozinha."]),
          ]}
        />
      )}

      {value.mode !== "off" && (
        <div className="space-y-4 pt-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-text-secondary">Ajustes</p>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(followUpResetDefaults(value))}>
              Restaurar padrões
            </Button>
          </div>
          <NumberField
            className="max-w-xs"
            label="Máximo de follow-ups seguidos sem resposta"
            min={1}
            max={FOLLOW_UP_MAX_CHAIN_LIMIT}
            placeholder={String(FOLLOW_UP_DEFAULT_MAX_CHAIN)}
            value={value.maxChain}
            disabled={disabled}
            error={errors?.maxChain}
            hint={panel ? `Depois disso a tarefa passa a ser de uma pessoa. Em branco = padrão (${FOLLOW_UP_DEFAULT_MAX_CHAIN}).` : undefined}
            onChange={(maxChain) => set({ maxChain })}
          />
          <div>
            <p className="text-[13px] font-medium text-text-secondary">Janela de envio</p>
            <div className="flex flex-wrap gap-4 mt-1.5">
              <NumberField
                className="w-28"
                label="Início (h)"
                min={0}
                max={24}
                placeholder={String(FOLLOW_UP_DEFAULT_QUIET_START_HOUR)}
                value={value.quietStart}
                disabled={disabled}
                error={errors?.quietStart}
                onChange={(quietStart) => set({ quietStart })}
              />
              <NumberField
                className="w-28"
                label="Fim (h)"
                min={0}
                max={24}
                placeholder={String(FOLLOW_UP_DEFAULT_QUIET_END_HOUR)}
                value={value.quietEnd}
                disabled={disabled}
                error={errors?.quietEnd}
                onChange={(quietEnd) => set({ quietEnd })}
              />
            </div>
            {panel && (
              <p className="text-xs text-text-muted mt-1.5">
                Vale junto com o horário de atendimento: o mais restritivo dos dois decide. Em branco = padrão (
                {FOLLOW_UP_DEFAULT_QUIET_START_HOUR}h a {FOLLOW_UP_DEFAULT_QUIET_END_HOUR}h).
              </p>
            )}
          </div>
          <NumberField
            className="max-w-xs"
            label="Teto diário de follow-ups por número"
            min={0}
            max={FOLLOW_UP_MAX_DAILY_CAP}
            placeholder="Automático"
            value={value.dailyCap}
            disabled={disabled}
            error={errors?.dailyCap}
            hint={panel ? "Em branco = automático (30 por dia no WhatsApp por QR code, 100 por dia no oficial). 0 = sem teto." : undefined}
            onChange={(dailyCap) => set({ dailyCap })}
          />
          <NumberField
            type="text"
            className="max-w-xs"
            label="Campo com a data do evento (chave do campo personalizado, tipo data)"
            maxLength={64}
            placeholder="ex.: data_evento"
            value={value.eventDateField}
            disabled={disabled}
            error={errors?.eventDateField}
            hint={panel ? "Opcional. Com o campo preenchido no lead, a IA não cobra evento que já aconteceu. Em branco = sem essa trava." : undefined}
            onChange={(eventDateField) => set({ eventDateField })}
          />
        </div>
      )}
    </div>
  );
}
