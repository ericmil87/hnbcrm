import { MAX_SEARCH_DAYS } from "./schedConstants";
/**
 * Agenda v2 — referências de data relativas resolvidas NO SERVIDOR (puro).
 *
 * O modelo da IA manda "amanha", "proxima_semana" ou "2026-12-03"; quem
 * calcula a data é este módulo, sempre no fuso da organização. Nunca soma 24 h
 * ao epoch: opera em calendário local (`schedTime`).
 *
 * Convenções:
 *  - semana = segunda a domingo (igual a `copilotDates.ts`); `esta_semana`
 *    começa HOJE e vai até o domingo (num domingo, só hoje);
 *  - `proxima_semana` = segunda a domingo da semana seguinte;
 *  - `proximos_dias` = hoje + 6 dias (7 dias);
 *  - toda janela é cortada em `MAX_SEARCH_DAYS` (7) dias;
 *  - data explícita no passado é recusada.
 */

import {
  addLocalDays,
  assertValidTimezone,
  diffLocalDays,
  formatLocalDateLabel,
  isValidLocalDate,
  type LocalDate,
  localDateOf,
  weekdayOf,
} from "./schedTime";

export type DateRef =
  | "hoje"
  | "amanha"
  | "depois_de_amanha"
  | "esta_semana"
  | "proxima_semana"
  | "proximos_dias"
  | LocalDate;

/** Janela máxima de busca em dias (`MAX_SEARCH_DAYS`, A1). UNIFICAR com `schedConstants`. */

const TOKENS: readonly string[] = [
  "hoje",
  "amanha",
  "depois_de_amanha",
  "esta_semana",
  "proxima_semana",
  "proximos_dias",
];

function normalizeToken(ref: string): string {
  return ref
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** Sempre no fuso da org; janela máxima 7 dias; "esta_semana" começa hoje. `echo` volta para a IA: "qui, 27/11/2026". */
export function resolveDateRef(
  ref: string,
  now: number,
  tz: string,
  opts?: { maxAdvanceDays?: number }
): { ok: true; from: LocalDate; to: LocalDate; echo: string } | { ok: false; error: string } {
  assertValidTimezone(tz);
  const today = localDateOf(now, tz);
  const token = typeof ref === "string" ? normalizeToken(ref) : "";

  let from: LocalDate;
  let to: LocalDate;
  if (token === "hoje") {
    from = to = today;
  } else if (token === "amanha") {
    from = to = addLocalDays(today, 1);
  } else if (token === "depois_de_amanha") {
    from = to = addLocalDays(today, 2);
  } else if (token === "esta_semana") {
    from = today;
    const wd = weekdayOf(today); // 0 = domingo
    to = addLocalDays(today, wd === 0 ? 0 : 7 - wd);
  } else if (token === "proxima_semana") {
    const wd = weekdayOf(today);
    from = addLocalDays(today, wd === 0 ? 1 : 8 - wd); // próxima segunda
    to = addLocalDays(from, 6);
  } else if (token === "proximos_dias") {
    from = today;
    to = addLocalDays(today, 6);
  } else if (typeof ref === "string" && isValidLocalDate(ref.trim())) {
    from = to = ref.trim();
    if (diffLocalDays(today, from) < 0) {
      return { ok: false, error: `A data ${formatLocalDateLabel(from)} já passou. Peça uma data a partir de hoje.` };
    }
    const maxAdv = opts?.maxAdvanceDays;
    if (maxAdv !== undefined && diffLocalDays(today, from) > maxAdv) {
      return { ok: false, error: `A data ${formatLocalDateLabel(from)} está longe demais: só é possível marcar com até ${maxAdv} dias de antecedência.` };
    }
  } else {
    return {
      ok: false,
      error: `Referência de data inválida. Use ${TOKENS.join(", ")} ou uma data no formato AAAA-MM-DD.`,
    };
  }

  if (diffLocalDays(from, to) > MAX_SEARCH_DAYS - 1) to = addLocalDays(from, MAX_SEARCH_DAYS - 1);
  const echo =
    from === to ? formatLocalDateLabel(from) : `${formatLocalDateLabel(from)} a ${formatLocalDateLabel(to)}`;
  return { ok: true, from, to, echo };
}

/** manhã 0–720, tarde 720–1080, noite 1080–1440 (minutos locais, `[start, end)`). */
export function periodWindow(period: "manha" | "tarde" | "noite" | "qualquer"): { startMin: number; endMin: number } {
  switch (period) {
    case "manha":
      return { startMin: 0, endMin: 720 };
    case "tarde":
      return { startMin: 720, endMin: 1080 };
    case "noite":
      return { startMin: 1080, endMin: 1440 };
    case "qualquer":
      return { startMin: 0, endMin: 1440 };
  }
}
