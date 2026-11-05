import {
  DEFAULT_DEBOUNCE_SECONDS,
  DEFAULT_REPLIES_PER_CONVERSATION,
  DEFAULT_REPLIES_PER_HOUR,
  MAX_DEBOUNCE_SECONDS,
  behaviorWarnings,
  type BehaviorForm,
  type ConfigFormProps,
} from "@/lib/attendantConfig";
import { BOT_TAG_MAX_CHARS, DEFAULT_BOT_TAG } from "../../../../convex/lib/botGuard";
import { NumberField, SwitchRow, WarningNote } from "./fields";

/** Agrupamento de mensagens, limite de respostas seguidas, data/hora e proteção contra robôs. */
export function ConversationBehaviorForm({
  value,
  onChange,
  disabled,
  errors,
  variant = "panel",
}: ConfigFormProps<BehaviorForm>) {
  const panel = variant === "panel";
  const set = (patch: Partial<BehaviorForm>) => onChange({ ...value, ...patch });
  const warnings = behaviorWarnings(value);
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <NumberField
          className="max-w-52"
          label="Agrupar mensagens por (segundos)"
          min={1}
          max={MAX_DEBOUNCE_SECONDS}
          placeholder={String(DEFAULT_DEBOUNCE_SECONDS)}
          value={value.debounceSeconds}
          disabled={disabled}
          error={errors?.debounceSeconds}
          hint={
            panel
              ? `Mensagens que chegam dentro desse intervalo de silêncio viram uma resposta só. Aumente (10 a 15 s) se seus clientes digitam fragmentado. Em branco = padrão (${DEFAULT_DEBOUNCE_SECONDS} s).`
              : undefined
          }
          onChange={(debounceSeconds) => set({ debounceSeconds })}
        />
        <WarningNote messages={warnings.debounce} />
      </div>

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-text-secondary">Limite de respostas seguidas</p>
        {panel && (
          <p className="text-xs text-text-muted">
            Para quando o outro lado também é uma automação. Em branco = padrão ({DEFAULT_REPLIES_PER_CONVERSATION} por
            conversa, {DEFAULT_REPLIES_PER_HOUR} por hora). 0 = sem limite (use só em testes).
          </p>
        )}
        <div className="flex flex-wrap gap-4">
          <NumberField
            className="w-40"
            label="Máx. por conversa"
            min={0}
            placeholder={String(DEFAULT_REPLIES_PER_CONVERSATION)}
            value={value.maxPerConversation}
            disabled={disabled}
            error={errors?.maxPerConversation}
            onChange={(maxPerConversation) => set({ maxPerConversation })}
          />
          <NumberField
            className="w-40"
            label="Máx. por hora"
            min={0}
            placeholder={String(DEFAULT_REPLIES_PER_HOUR)}
            value={value.maxPerHour}
            disabled={disabled}
            error={errors?.maxPerHour}
            onChange={(maxPerHour) => set({ maxPerHour })}
          />
        </div>
        <WarningNote messages={warnings.limits} />
      </div>

      <SwitchRow
        title="Informar data e hora atuais à IA"
        description={
          panel
            ? "Necessário para regras que dependem de data: lotes de preço, prazos, validade de cupom e agendamentos. Ligado por padrão."
            : undefined
        }
        checked={value.includeCurrentDateTime}
        disabled={disabled}
        onChange={(includeCurrentDateTime) => set({ includeCurrentDateTime })}
      />

      <div className="space-y-2">
        <SwitchRow
          title="Proteção contra robôs e mensagens automáticas"
          description={
            panel
              ? "Quando o outro lado parece um robô (auto-resposta, boletim, outra IA), a IA para de responder, abre um pedido de ajuda e etiqueta o lead. Ligado por padrão."
              : undefined
          }
          checked={value.botGuardEnabled}
          disabled={disabled}
          onChange={(botGuardEnabled) => set({ botGuardEnabled })}
        />
        {value.botGuardEnabled && (
          <NumberField
            type="text"
            label="Etiqueta do lead"
            maxLength={BOT_TAG_MAX_CHARS}
            placeholder={DEFAULT_BOT_TAG}
            value={value.botGuardTag}
            disabled={disabled}
            error={errors?.botGuardTag}
            hint={panel ? "Aplicada ao lead quando a suspeita é registrada: útil para filtrar no funil." : undefined}
            onChange={(botGuardTag) => set({ botGuardTag })}
          />
        )}
      </div>
    </div>
  );
}
