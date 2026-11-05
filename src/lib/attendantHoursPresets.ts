import type { ScheduleForm } from "@/lib/attendantConfig";

// Atalhos de horário do passo "Atendimento" da configuração inicial.
// "Personalizado" não é um valor: o formulário só abre os campos de hora.

export interface HoursPresetDef {
  id: "always" | "business";
  label: string;
  value: ScheduleForm;
}

export const CUSTOM_PRESET_ID = "custom";
export const CUSTOM_PRESET_LABEL = "Personalizado";

export const HOURS_PRESETS: ReadonlyArray<HoursPresetDef> = [
  { id: "always", label: "Sempre", value: { allDay: true, startHour: 8, endHour: 18 } },
  {
    id: "business",
    label: "Comercial (seg–sex, 8h às 18h)",
    value: { allDay: false, startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5] },
  },
];

/** Aplica o preset preservando o fuso já configurado. */
export function applyHoursPreset(preset: { value: ScheduleForm }, current: ScheduleForm): ScheduleForm {
  const timezone = current.timezone ?? preset.value.timezone;
  return { ...preset.value, ...(timezone ? { timezone } : {}) };
}

const sameDays = (a?: number[], b?: number[]) =>
  [...(a ?? [])].sort().join(",") === [...(b ?? [])].sort().join(",");

/** Id do preset que descreve o horário atual; `custom` se nenhum. */
export function matchHoursPreset(
  presets: ReadonlyArray<{ id: string; value: ScheduleForm }>,
  value: ScheduleForm,
): string {
  const hit = presets.find((p) =>
    p.value.allDay
      ? Boolean(value.allDay)
      : !value.allDay &&
        p.value.startHour === value.startHour &&
        p.value.endHour === value.endHour &&
        sameDays(p.value.days, value.days),
  );
  return hit?.id ?? CUSTOM_PRESET_ID;
}
