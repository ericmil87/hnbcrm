import type { ScheduleForm } from "@/lib/attendantConfig";

// Atalhos de horário do passo "Atendimento" da configuração inicial.
// "Personalizado" não é um valor: o formulário só abre os campos de hora.

export interface HoursPresetDef {
  id: "always" | "business";
  label: string;
  /** Linha de apoio sob o controle (cabe em 360 px). */
  detail?: string;
  value: ScheduleForm;
}

export const CUSTOM_PRESET_ID = "custom";
export const CUSTOM_PRESET_LABEL = "Personalizado";

export const HOURS_PRESETS: ReadonlyArray<HoursPresetDef> = [
  { id: "always", label: "Sempre", detail: "Atende 24 horas, todos os dias", value: { allDay: true, startHour: 8, endHour: 18 } },
  {
    id: "business",
    label: "Comercial",
    detail: "seg–sex, 8h às 18h",
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

const DAY_NAMES = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** `[1,2,3,4,5]` vira "seg–sex"; outras listas viram "seg, qua, sex". */
export function formatDays(days: number[] | undefined): string | undefined {
  if (!days || days.length === 0) return undefined;
  const sorted = [...days].sort((a, b) => a - b);
  const range = sorted.length > 2 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  const name = (d: number) => DAY_NAMES[d] ?? String(d);
  return range ? `${name(sorted[0])}–${name(sorted[sorted.length - 1])}` : sorted.map(name).join(", ");
}
