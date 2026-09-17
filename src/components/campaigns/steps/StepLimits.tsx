import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { AlertTriangle, Lock, ShieldCheck, Unlock } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import type { CampaignPacing, CampaignSchedule, SafeDefaults } from "../types";
import { WEEKDAY_LABELS } from "../campaignUtils";
import { isWithinSafe, type WizardDraft } from "../wizardState";

interface StepLimitsProps {
  draft: WizardDraft;
  setDraft: (updater: (prev: WizardDraft) => WizardDraft) => void;
  now: number;
  editable: boolean;
}

const TIMEZONES = [
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Belem",
  "America/Fortaleza",
  "America/Recife",
  "America/Bahia",
  "America/Cuiaba",
  "America/Campo_Grande",
  "America/Rio_Branco",
  "America/Noronha",
  "America/Lisbon",
  "UTC",
];

export function StepLimits({ draft, setDraft, now, editable }: StepLimitsProps) {
  const defaults = useQuery(
    api.campaigns.getSafeDefaults,
    draft.channelConfigId
      ? {
          channelConfigId: draft.channelConfigId,
          now,
          audienceSource: draft.audience.source,
          ...(draft.tierAtLaunch ? { tier: draft.tierAtLaunch } : {}),
        }
      : "skip"
  ) as SafeDefaults | undefined;

  // Preenche pacing/schedule/safety com os defaults do canal na primeira vez
  useEffect(() => {
    if (!defaults) return;
    setDraft((d) => {
      // Modo seguro = "use o seguro": se o público mudou (1:1 → sala) e o
      // pacing guardado ficou acima do novo teto, realinha em silêncio.
      if (d.pacing && d.schedule) {
        if (d.safeMode && !isWithinSafe(d.pacing, defaults.safe)) {
          return { ...d, pacing: { ...defaults.safe }, overrideWord: "" };
        }
        return d;
      }
      return {
        ...d,
        pacing: d.pacing ?? { ...(d.provider === "bridge" ? defaults.safe : defaults.orgDefaults ?? defaults.safe) },
        schedule: d.schedule ?? defaults.schedule,
        safety: Object.keys(d.safety).length > 0 ? d.safety : { ...defaults.safety },
      };
    });
  }, [defaults, setDraft]);

  if (!defaults || !draft.pacing || !draft.schedule) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  const pacing = draft.pacing;
  const schedule = draft.schedule;
  const safe = defaults.safe;
  const hard = defaults.hardCap;
  const isBridge = defaults.provider === "bridge";
  const withinSafe = isWithinSafe(pacing, safe);
  const advanced = !draft.safeMode;

  const setPacing = (patch: Partial<CampaignPacing>) => setDraft((d) => ({ ...d, pacing: { ...(d.pacing as CampaignPacing), ...patch } }));
  const setSchedule = (patch: Partial<CampaignSchedule>) =>
    setDraft((d) => ({ ...d, schedule: { ...(d.schedule as CampaignSchedule), ...patch } }));

  const clampField = (key: keyof CampaignPacing, value: number) => {
    const n = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    if (advanced) {
      if (key === "maxPerDay") return Math.min(n, hard.maxPerDay);
      if (key === "maxPerHour") return Math.min(n, hard.maxPerHour);
      if (key === "minDelaySec") return Math.max(n, hard.minDelaySec);
      if (key === "maxNewContactsPerDay" && hard.maxNewContactsPerDay !== null) return Math.min(n, hard.maxNewContactsPerDay);
      return n;
    }
    if (key === "maxPerDay") return Math.min(n, safe.maxPerDay);
    if (key === "maxPerHour") return Math.min(n, safe.maxPerHour);
    if (key === "minDelaySec") return Math.max(n, safe.minDelaySec);
    if (key === "maxNewContactsPerDay" && safe.maxNewContactsPerDay !== undefined) return Math.min(n, safe.maxNewContactsPerDay);
    return n;
  };

  const toggleAdvanced = () => {
    if (advanced) {
      // Voltar ao modo seguro: reaplica os defaults
      setDraft((d) => ({ ...d, safeMode: true, pacing: { ...safe }, overrideWord: "" }));
    } else {
      setDraft((d) => ({ ...d, safeMode: false }));
    }
  };

  const toggleDay = (day: number) => {
    const days = schedule.days.includes(day) ? schedule.days.filter((d) => d !== day) : [...schedule.days, day].sort();
    setSchedule({ days });
  };

  const startLocal = schedule.startAt ? new Date(schedule.startAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";

  return (
    <div className="space-y-6">
      {/* Modo seguro vs avançado */}
      <div
        className={cn(
          "rounded-lg border p-4 space-y-3",
          withinSafe ? "border-semantic-success/40 bg-semantic-success/5" : "border-semantic-warning/40 bg-semantic-warning/10"
        )}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-2.5">
            {withinSafe ? (
              <ShieldCheck size={20} className="text-semantic-success shrink-0" />
            ) : (
              <AlertTriangle size={20} className="text-semantic-warning shrink-0" />
            )}
            <div>
              <p className="text-sm font-semibold text-text-primary">
                {withinSafe ? "Modo seguro" : "Limites acima do modo seguro"}
              </p>
              <p className="text-xs text-text-secondary mt-0.5">
                {isBridge
                  ? `Dia ${defaults.warmupDay} de aquecimento: até ${safe.maxPerDay}/dia, ${safe.maxPerHour}/h, ${safe.minDelaySec}–${safe.maxDelaySec}s entre envios, ${safe.maxNewContactsPerDay ?? "—"} novos contatos/dia.`
                  : `Tier ${defaults.tier ?? "250"}: até ${safe.maxPerDay}/dia (80% do limite do portfólio), ${safe.maxPerHour}/h.`}{" "}
                Todos os números são estimativas de engenharia calibráveis, não limites oficiais.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!editable}
            onClick={toggleAdvanced}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-overlay min-h-[36px] disabled:opacity-50"
          >
            {advanced ? <Lock size={13} /> : <Unlock size={13} />}
            {advanced ? "Voltar ao modo seguro" : "Modo avançado"}
          </button>
        </div>
        {advanced && (
          <div className="space-y-2">
            <p className="text-xs text-text-secondary">
              O teto duro não é ultrapassável nem no modo avançado
              {isBridge
                ? `: ${hard.maxPerDay}/dia, ${hard.maxPerHour}/h, delay mínimo de ${hard.minDelaySec}s, ${hard.maxNewContactsPerDay} novos contatos/dia.`
                : `: ${hard.maxPerDay.toLocaleString("pt-BR")}/dia (100% do tier).`}
            </p>
            {!withinSafe && (
              <Input
                label='Para lançar acima do modo seguro, digite "ENTENDO"'
                value={draft.overrideWord}
                onChange={(e) => setDraft((d) => ({ ...d, overrideWord: e.target.value }))}
                placeholder="ENTENDO"
                disabled={!editable}
              />
            )}
          </div>
        )}
      </div>

      {/* Pacing */}
      <div className="grid gap-3 md:grid-cols-3">
        <NumberField
          label="Delay mínimo (s)"
          value={pacing.minDelaySec}
          min={advanced ? hard.minDelaySec : safe.minDelaySec}
          onChange={(v) => setPacing({ minDelaySec: clampField("minDelaySec", v), maxDelaySec: Math.max(pacing.maxDelaySec, clampField("minDelaySec", v)) })}
          disabled={!editable}
          hint={`seguro ≥ ${safe.minDelaySec}s`}
        />
        <NumberField
          label="Delay máximo (s)"
          value={pacing.maxDelaySec}
          min={pacing.minDelaySec}
          onChange={(v) => setPacing({ maxDelaySec: Math.max(pacing.minDelaySec, Math.round(v) || 0) })}
          disabled={!editable}
          hint="jitter aleatório entre mín. e máx."
        />
        <NumberField
          label="Máx. por hora"
          value={pacing.maxPerHour}
          min={1}
          max={advanced ? hard.maxPerHour : safe.maxPerHour}
          onChange={(v) => setPacing({ maxPerHour: Math.max(1, clampField("maxPerHour", v)) })}
          disabled={!editable}
          hint={`seguro ≤ ${safe.maxPerHour}`}
        />
        <NumberField
          label="Máx. por dia"
          value={pacing.maxPerDay}
          min={1}
          max={advanced ? hard.maxPerDay : safe.maxPerDay}
          onChange={(v) => setPacing({ maxPerDay: Math.max(1, clampField("maxPerDay", v)) })}
          disabled={!editable}
          hint={`seguro ≤ ${safe.maxPerDay}`}
        />
        {isBridge && (
          <NumberField
            label="Novos contatos por dia"
            value={pacing.maxNewContactsPerDay ?? safe.maxNewContactsPerDay ?? 0}
            min={0}
            max={advanced ? hard.maxNewContactsPerDay ?? undefined : safe.maxNewContactsPerDay}
            onChange={(v) => setPacing({ maxNewContactsPerDay: clampField("maxNewContactsPerDay", v) })}
            disabled={!editable}
            hint="números sem conversa prévia — o maior risco"
          />
        )}
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Lote"
            value={pacing.batchSize}
            min={0}
            onChange={(v) => setPacing({ batchSize: Math.max(0, Math.round(v) || 0) })}
            disabled={!editable}
            hint="0 = sem pausa"
          />
          <NumberField
            label="Pausa (min)"
            value={pacing.batchPauseMin}
            min={0}
            onChange={(v) => setPacing({ batchPauseMin: Math.max(0, Math.round(v) || 0) })}
            disabled={!editable}
            hint="a cada lote"
          />
        </div>
      </div>

      {/* Janela */}
      <div className="rounded-lg border border-border bg-surface-sunken p-4 space-y-3">
        <p className="text-sm font-medium text-text-primary">Janela de envio</p>
        <div className="grid gap-3 md:grid-cols-3">
          <NumberField
            label="Das (hora)"
            value={schedule.windowStartHour}
            min={0}
            max={23}
            onChange={(v) => setSchedule({ windowStartHour: Math.min(23, Math.max(0, Math.round(v) || 0)) })}
            disabled={!editable}
          />
          <NumberField
            label="Até (hora)"
            value={schedule.windowEndHour}
            min={1}
            max={24}
            onChange={(v) => setSchedule({ windowEndHour: Math.min(24, Math.max(1, Math.round(v) || 1)) })}
            disabled={!editable}
          />
          <label className="block">
            <span className="block text-[13px] font-medium text-text-secondary mb-1.5">Fuso</span>
            <select
              className="w-full h-10 rounded-lg border border-border bg-surface-raised px-3 text-base md:text-sm text-text-primary"
              value={schedule.timezone}
              disabled={!editable}
              onChange={(e) => setSchedule({ timezone: e.target.value })}
            >
              {[schedule.timezone, ...TIMEZONES.filter((t) => t !== schedule.timezone)].map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAY_LABELS.map((label, day) => {
            const on = schedule.days.includes(day);
            return (
              <button
                key={label}
                type="button"
                disabled={!editable}
                onClick={() => toggleDay(day)}
                className={cn(
                  "h-10 w-12 rounded-full border text-xs font-medium",
                  on ? "border-brand-500 bg-brand-500/10 text-brand-400" : "border-border text-text-secondary"
                )}
                aria-pressed={on}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="grid gap-3 md:grid-cols-2 items-end">
          <Input
            type="datetime-local"
            label="Início (vazio = ao lançar)"
            value={startLocal}
            disabled={!editable}
            onChange={(e) => {
              const ts = e.target.value ? new Date(e.target.value).getTime() : undefined;
              setSchedule({ startAt: ts && !Number.isNaN(ts) ? ts : undefined });
            }}
          />
          <p className="text-xs text-text-muted">
            Fora da janela a campanha espera a próxima abertura. Fim de semana fica fora por padrão.
          </p>
        </div>
      </div>

      {/* Kill switches */}
      <div className="rounded-lg border border-border bg-surface-sunken p-4 space-y-3">
        <p className="text-sm font-medium text-text-primary">Paradas automáticas de segurança</p>
        <p className="text-xs text-text-muted">
          Quando um sinal de risco aparece a campanha pausa sozinha e avisa você. O que derruba um número é bloqueio e denúncia, então taxa
          de resposta e de entrega valem mais que qualquer delay.
        </p>
        <div className="space-y-2.5">
          {isBridge && (
            <>
              <RateSwitch
                label="Pausar se a taxa de resposta ficar abaixo de"
                value={draft.safety.stopOnReplyRateBelow ?? null}
                defaultValue={0.1}
                disabled={!editable}
                onChange={(v) => setDraft((d) => ({ ...d, safety: { ...d.safety, stopOnReplyRateBelow: v } }))}
              />
              <RateSwitch
                label="Pausar se a entrega (✓✓) ficar abaixo de"
                value={draft.safety.stopOnDeliveryRateBelow ?? null}
                defaultValue={0.6}
                disabled={!editable}
                onChange={(v) => setDraft((d) => ({ ...d, safety: { ...d.safety, stopOnDeliveryRateBelow: v } }))}
              />
            </>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-text-primary">Pausar após</span>
            <input
              type="number"
              min={1}
              max={50}
              disabled={!editable}
              value={draft.safety.maxConsecutiveFailures ?? 5}
              onChange={(e) =>
                setDraft((d) => ({ ...d, safety: { ...d.safety, maxConsecutiveFailures: Math.max(1, Number(e.target.value) || 1) } }))
              }
              className="h-10 w-20 rounded-lg border border-border bg-surface-raised px-2 text-base md:text-sm text-text-primary tabular-nums"
              aria-label="Falhas consecutivas"
            />
            <span className="text-sm text-text-primary">falhas consecutivas</span>
          </div>
          {isBridge && (
            <Checkbox
              checked={draft.safety.checkNumbersFirst ?? true}
              disabled={!editable}
              onChange={(e) => setDraft((d) => ({ ...d, safety: { ...d.safety, checkNumbersFirst: e.target.checked } }))}
              label="Verificar se o número tem WhatsApp antes de enviar"
              description="Grátis no bridge. Enviar para número inexistente é sinal de lista comprada."
            />
          )}
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="block">
      <span className="block text-[13px] font-medium text-text-secondary mb-1.5">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(Number(text))}
        onKeyDown={(e) => {
          if (e.key === "Enter") onChange(Number(text));
        }}
        className="w-full h-10 rounded-lg border border-border bg-surface-raised px-3 text-base md:text-sm text-text-primary tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
      />
      {hint && <span className="block text-[11px] text-text-muted mt-1">{hint}</span>}
    </label>
  );
}

function RateSwitch({
  label,
  value,
  defaultValue,
  disabled,
  onChange,
}: {
  label: string;
  value: number | null;
  defaultValue: number;
  disabled?: boolean;
  onChange: (v: number | null) => void;
}) {
  const on = value !== null;
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Checkbox checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked ? defaultValue : null)} label={label} />
      <input
        type="number"
        min={1}
        max={100}
        disabled={disabled || !on}
        value={on ? Math.round((value ?? defaultValue) * 100) : Math.round(defaultValue * 100)}
        onChange={(e) => onChange(Math.min(100, Math.max(1, Number(e.target.value) || 1)) / 100)}
        className="h-10 w-20 rounded-lg border border-border bg-surface-raised px-2 text-base md:text-sm text-text-primary tabular-nums disabled:opacity-50"
        aria-label="Percentual"
      />
      <span className="text-sm text-text-secondary">% (após 50 envios)</span>
    </div>
  );
}
