/**
 * Agenda v2 (B1): editor de horário semanal. PURO. O formulário guarda "HH:mm" por turno (é o que o
 * `<input type="time">` entrega); a conversão para `{ weekday, startMin, endMin }` usa as MESMAS regras do
 * servidor (`validateWeekly` de `convex/lib/schedAvailability.ts`, fonte única): sem turno que cruza a
 * meia-noite, sem sobreposição, no máximo 28 turnos.
 */
import { validateWeekly } from "../../convex/lib/schedAvailability";
import { minutesLabel, parseMinutes } from "./agendaZone";

export interface ShiftForm {
  start: string;
  end: string;
}
/** Sete listas, índice = dia da semana (0 = domingo). */
export type WeekForm = ShiftForm[][];
export interface WeeklyItem {
  weekday: number;
  startMin: number;
  endMin: number;
}

/** Ordem de exibição: segunda a domingo (a semana comercial). */
export const WEEK_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_NAMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"] as const;
export const WEEKDAY_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;
/** Chave de `weekErrors` para erros que não são de um dia só. */
export const WEEK_GENERAL_ERROR = 7;
export const MAX_SHIFTS_PER_WEEK = 28;

export function emptyWeek(): WeekForm {
  return Array.from({ length: 7 }, () => []);
}

/** Minutos do dia -> "HH:mm". 1440 vira "24:00" (o servidor aceita `endMin = 1440`; o editor mostra um botão no lugar do campo de hora). */
export function minutesToTime(minutes: number): string {
  return minutesLabel(minutes);
}

/** Fim de turno à meia-noite do dia seguinte ("24:00"): o `<input type="time">` não representa. */
export const END_OF_DAY = "24:00";

export function weekFromWeekly(weekly: ReadonlyArray<WeeklyItem>): WeekForm {
  const week = emptyWeek();
  const sorted = [...weekly].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  for (const w of sorted) {
    if (w.weekday < 0 || w.weekday > 6) continue;
    week[w.weekday].push({ start: minutesToTime(w.startMin), end: minutesToTime(w.endMin) });
  }
  return week;
}

/** Mesmos turnos nos dias informados (0 = domingo). */
export function weekWith(weekdays: ReadonlyArray<number>, shifts: ReadonlyArray<ShiftForm>): WeekForm {
  const week = emptyWeek();
  for (const d of weekdays) week[d] = shifts.map((s) => ({ ...s }));
  return week;
}

const toMinutesOrNull = (s: ShiftForm) => {
  const start = parseMinutes(s.start);
  const end = parseMinutes(s.end);
  return start === null || end === null ? null : { startMin: start, endMin: end };
};

/** Mensagens por dia (índice 0..6) e `WEEK_GENERAL_ERROR` para o total; vazio = válido. */
export function weekErrors(week: WeekForm): Record<number, string> {
  const errors: Record<number, string> = {};
  let total = 0;
  for (let day = 0; day < 7; day++) {
    const shifts = week[day] ?? [];
    total += shifts.length;
    const parsed: Array<{ startMin: number; endMin: number }> = [];
    for (const s of shifts) {
      const m = toMinutesOrNull(s);
      if (!m) {
        errors[day] = "Preencha o início e o fim de cada turno.";
        break;
      }
      if (m.endMin <= m.startMin) {
        errors[day] =
          "O fim precisa ser depois do início. Turno que passa da meia-noite não é aceito: termine às 23:59 e continue no dia seguinte.";
        break;
      }
      parsed.push(m);
    }
    if (errors[day]) continue;
    parsed.sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i].startMin < parsed[i - 1].endMin) {
        errors[day] = "Os turnos do mesmo dia não podem se sobrepor.";
        break;
      }
    }
  }
  if (total > MAX_SHIFTS_PER_WEEK) errors[WEEK_GENERAL_ERROR] = `No máximo ${MAX_SHIFTS_PER_WEEK} turnos por semana.`;
  return errors;
}

/** Converte para o formato do servidor (ordenado) ou devolve a primeira mensagem. */
export function weeklyFromWeek(week: WeekForm): { ok: true; weekly: WeeklyItem[] } | { ok: false; error: string } {
  const errors = weekErrors(week);
  const first = Object.values(errors)[0];
  if (first) return { ok: false, error: first };
  const weekly: WeeklyItem[] = [];
  for (let day = 0; day < 7; day++) {
    for (const s of week[day] ?? []) {
      const m = toMinutesOrNull(s)!;
      weekly.push({ weekday: day, startMin: m.startMin, endMin: m.endMin });
    }
  }
  weekly.sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  const server = validateWeekly(weekly);
  if (!server.ok) return { ok: false, error: server.error };
  return { ok: true, weekly };
}

export function sameWeek(a: WeekForm, b: WeekForm): boolean {
  const norm = (w: WeekForm) =>
    JSON.stringify(
      Array.from({ length: 7 }, (_, d) =>
        [...(w[d] ?? [])].map((s) => [s.start, s.end]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      )
    );
  return norm(a) === norm(b);
}

function replaceDay(week: WeekForm, day: number, shifts: ShiftForm[]): WeekForm {
  return week.map((s, i) => (i === day ? shifts : s));
}

/** Copia os turnos de `from` para cada dia de `targets` (substitui o que havia). */
export function copyDayTo(week: WeekForm, from: number, targets: ReadonlyArray<number>): WeekForm {
  const source = week[from] ?? [];
  return week.map((shifts, i) => (targets.includes(i) && i !== from ? source.map((s) => ({ ...s })) : shifts));
}

/** Novo turno com um padrão útil: 09:00–18:00 no dia vazio; depois do último turno nos demais. */
export function addShift(week: WeekForm, day: number): WeekForm {
  const shifts = week[day] ?? [];
  if (shifts.length === 0) return replaceDay(week, day, [{ start: "09:00", end: "18:00" }]);
  const last = shifts[shifts.length - 1];
  const lastEnd = parseMinutes(last.end) ?? 17 * 60;
  const startMin = Math.min(lastEnd + 120, 22 * 60);
  const endMin = Math.min(startMin + 180, 1439);
  return replaceDay(week, day, [...shifts, { start: minutesToTime(startMin), end: minutesToTime(endMin) }]);
}

export function removeShift(week: WeekForm, day: number, index: number): WeekForm {
  return replaceDay(week, day, (week[day] ?? []).filter((_, i) => i !== index));
}

export function setShift(week: WeekForm, day: number, index: number, patch: Partial<ShiftForm>): WeekForm {
  return replaceDay(week, day, (week[day] ?? []).map((s, i) => (i === index ? { ...s, ...patch } : s)));
}

/**
 * "Dois turnos com almoço": um turno único que cobre o meio-dia vira manhã + tarde com pausa das 12:00 às
 * 14:00. Se já há mais de um turno ou o turno não cobre o almoço, devolve o mesmo dia (nada a dividir).
 */
export function splitWithLunch(week: WeekForm, day: number): WeekForm {
  const shifts = week[day] ?? [];
  if (shifts.length !== 1) return week;
  const start = parseMinutes(shifts[0].start);
  const end = parseMinutes(shifts[0].end);
  if (start === null || end === null || start >= 12 * 60 || end <= 14 * 60) return week;
  return replaceDay(week, day, [
    { start: shifts[0].start, end: "12:00" },
    { start: "14:00", end: shifts[0].end },
  ]);
}

/** Segunda a sexta (atalho do "copiar para"). */
export const WEEKDAYS_MON_FRI = [1, 2, 3, 4, 5] as const;

const shiftText = (s: ShiftForm) => `${s.start}–${s.end}`;

/** "Seg a sex: 09:00–12:00 e 14:00–18:00 · Sáb: 09:00–12:00". Sem nenhum turno: "Sem horário". */
export function weekSummary(week: WeekForm): string {
  const parts: string[] = [];
  let i = 0;
  const order = WEEK_DISPLAY_ORDER;
  while (i < order.length) {
    const day = order[i];
    const shifts = week[day] ?? [];
    if (shifts.length === 0) {
      i++;
      continue;
    }
    const key = shifts.map(shiftText).join("|");
    let j = i;
    while (j + 1 < order.length && (week[order[j + 1]] ?? []).map(shiftText).join("|") === key) j++;
    const label = j === i ? WEEKDAY_SHORT[day] : j === i + 1 ? `${WEEKDAY_SHORT[day]} e ${WEEKDAY_SHORT[order[j]].toLowerCase()}` : `${WEEKDAY_SHORT[day]} a ${WEEKDAY_SHORT[order[j]].toLowerCase()}`;
    parts.push(`${label}: ${shifts.map(shiftText).join(" e ")}`);
    i = j + 1;
  }
  return parts.length === 0 ? "Sem horário" : parts.join(" · ");
}
