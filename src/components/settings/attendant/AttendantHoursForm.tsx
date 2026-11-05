import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { NumberField, SwitchRow } from "./fields";
import {
  CUSTOM_PRESET_ID,
  CUSTOM_PRESET_LABEL,
  applyHoursPreset,
  formatDays,
  matchHoursPreset,
} from "@/lib/attendantHoursPresets";
import type { ConfigFormProps, ScheduleForm } from "@/lib/attendantConfig";

export interface HoursPreset {
  id: string;
  label: string;
  /** Linha de apoio sob o controle (variante wizard). */
  detail?: string;
  value: ScheduleForm;
}

export interface AttendantHoursFormProps extends ConfigFormProps<ScheduleForm> {
  /** Atalhos de horário (a lista vem de fora; o fv2-22 define os presets). */
  presets?: ReadonlyArray<HoursPreset>;
}

const toHour = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw));
const fromHour = (n: number) => (Number.isNaN(n) ? "" : String(n));

/** Horário de atendimento (início e fim, em horas cheias). Campo controlado, sem dados. */
export function AttendantHoursForm({
  value,
  onChange,
  disabled,
  errors,
  variant = "panel",
  presets,
}: AttendantHoursFormProps) {
  const wizardPresets = variant === "wizard" && presets && presets.length > 0 ? presets : undefined;
  const [customOpen, setCustomOpen] = useState(false);
  // 24 h escolhido de fora (ex.: Copiloto) fecha o "Personalizado".
  useEffect(() => {
    if (value.allDay) setCustomOpen(false);
  }, [value.allDay]);
  const selected = wizardPresets
    ? customOpen && !value.allDay
      ? CUSTOM_PRESET_ID
      : matchHoursPreset(wizardPresets, value)
    : undefined;
  const selectedDetail =
    selected === CUSTOM_PRESET_ID
      ? formatDays(value.days) && !value.allDay
        ? `Dias: ${formatDays(value.days)}`
        : undefined
      : wizardPresets?.find((p) => p.id === selected)?.detail;
  const showFields = !wizardPresets || selected === CUSTOM_PRESET_ID;

  const pick = (id: string) => {
    if (!wizardPresets || disabled) return;
    if (id === CUSTOM_PRESET_ID) {
      setCustomOpen(true);
      if (value.allDay) onChange({ ...value, allDay: false });
      return;
    }
    const preset = wizardPresets.find((p) => p.id === id);
    if (!preset) return;
    setCustomOpen(false);
    onChange(applyHoursPreset(preset, value));
  };

  return (
    <div className="space-y-3">
      {wizardPresets && (
        <div className="space-y-1.5" aria-disabled={disabled || undefined}>
        <SegmentedControl
          ariaLabel="Horário de atendimento"
          value={selected ?? CUSTOM_PRESET_ID}
          onValueChange={pick}
          options={[
            ...wizardPresets.map((p) => ({ value: p.id, label: p.label })),
            { value: CUSTOM_PRESET_ID, label: CUSTOM_PRESET_LABEL },
          ]}
          className={disabled ? "pointer-events-none opacity-60" : undefined}
        />
        {selectedDetail && <p className="text-xs text-text-muted">{selectedDetail}</p>}
        </div>
      )}
      {!wizardPresets && presets && presets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button key={p.id} variant="secondary" size="sm" disabled={disabled} onClick={() => onChange(p.value)}>
              {p.label}
            </Button>
          ))}
        </div>
      )}
      {!wizardPresets && (
      <SwitchRow
        title="Atender 24 horas"
        description={variant === "panel" ? "Sem horário: a IA responde a qualquer hora, inclusive de madrugada." : undefined}
        checked={Boolean(value.allDay)}
        disabled={disabled}
        onChange={(allDay) => onChange({ ...value, allDay })}
      />
      )}
      {showFields && !value.allDay && (
      <div className="flex flex-wrap gap-4">
        <NumberField
          className="w-28"
          label="Início (h)"
          min={0}
          max={23}
          value={fromHour(value.startHour)}
          disabled={disabled}
          error={errors?.startHour}
          onChange={(raw) => onChange({ ...value, startHour: toHour(raw) })}
        />
        <NumberField
          className="w-28"
          label="Fim (h)"
          min={1}
          max={24}
          value={fromHour(value.endHour)}
          disabled={disabled}
          error={errors?.endHour}
          onChange={(raw) => onChange({ ...value, endHour: toHour(raw) })}
        />
      </div>
      )}
      {variant === "panel" && !value.allDay && (
        <p className="text-xs text-text-muted">
          Fora dessa janela a IA não responde: a conversa espera por alguém da equipe.
        </p>
      )}
    </div>
  );
}
