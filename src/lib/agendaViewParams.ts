/**
 * Agenda v2 (B3): estado da página na URL. Codecs de `searchParamState` (constantes de módulo, como o hook
 * exige) e as regras puras de navegação por data. Datas são "YYYY-MM-DD" NO FUSO DA ORG (nunca `Date` local).
 *
 *   ?visao=dia|semana|lista|mes (replace; "semana" = a página de compromissos e tarefas da equipe; ausente = lista no celular, dia no computador)
 *   ?data=YYYY-MM-DD       (replace; ausente = hoje na org)
 *   ?por=sala|profissional (replace; agrupamento da grade e da lista)
 *   ?lista=hora|recurso    (replace; agrupamento da lista do dia)
 *   ?appt=<id>             (push; abre o painel do agendamento)
 *   ?pendencias=1          (push; abre a fila de pendências)
 * `?event=` e `?task=` seguem sendo os dos compromissos e tarefas (a página é única).
 */
import { addLocalDays, isValidLocalDate, shortDateLabel, weekdayOf, type LocalDate } from "./agendaZone";
import { WEEK_STARTS_ON } from "./agendaDates";
import { enumParam, stringParam, type ParamCodec } from "./searchParamState";
import type { GroupBy } from "./agendaGrid";

export const AGENDA_VIEWS = ["dia", "semana", "lista", "mes"] as const;
export type AgendaView = (typeof AGENDA_VIEWS)[number];

export const LIST_MODES = ["hora", "recurso"] as const;
export type ListMode = (typeof LIST_MODES)[number];

const GROUP_VALUES = ["sala", "profissional"] as const;
export type GroupParam = (typeof GROUP_VALUES)[number];

/** Visão escolhida na URL; `null` = ausente ou inválida (a tela usa o padrão do aparelho). */
export const viewParam: ParamCodec<AgendaView | null> = {
  parse: (raw) => ((AGENDA_VIEWS as readonly string[]).includes(raw ?? "") ? (raw as AgendaView) : null),
  serialize: (value) => value,
};

/** Data local válida ou `null`. */
export const dateKeyParam: ParamCodec<LocalDate | null> = {
  parse: (raw) => (raw !== null && isValidLocalDate(raw) ? raw : null),
  serialize: (value) => (value !== null && isValidLocalDate(value) ? value : null),
};

export const groupParam = enumParam(GROUP_VALUES, "sala");
export const listModeParam = enumParam(LIST_MODES, "hora");
export { stringParam as idParam };

export function defaultView(isMobile: boolean): AgendaView {
  return isMobile ? "lista" : "dia";
}

export function groupByOf(value: GroupParam): GroupBy {
  return value === "sala" ? "room" : "person";
}

export function groupParamOf(groupBy: GroupBy): GroupParam {
  return groupBy === "room" ? "sala" : "profissional";
}

// --- datas ---

export function firstOfMonth(date: LocalDate): LocalDate {
  return `${date.slice(0, 7)}-01`;
}

export function lastOfMonth(date: LocalDate): LocalDate {
  const [y, m] = date.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addLocalDays(next, -1);
}

/** Mês seguinte/anterior mantendo o dia quando existe (31/01 + 1 mês = 28 ou 29/02). */
export function shiftMonth(date: LocalDate, dir: 1 | -1): LocalDate {
  const [y, m, d] = date.split("-").map(Number);
  const idx = y * 12 + (m - 1) + dir;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const first = `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
  const last = Number(lastOfMonth(first).slice(8));
  return `${first.slice(0, 8)}${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Setas do cabeçalho: um dia nas visões Dia e Lista, um mês na visão Mês. */
export function shiftDate(date: LocalDate, view: AgendaView, dir: 1 | -1): LocalDate {
  return view === "mes" ? shiftMonth(date, dir) : addLocalDays(date, dir);
}

/** Período consultado na visão Mês: o mês inteiro (no máximo 31 dias; `listAgendaRange` aceita 35). */
export function monthRange(date: LocalDate): { from: LocalDate; to: LocalDate } {
  return { from: firstOfMonth(date), to: lastOfMonth(date) };
}

/** Quantas células vazias antes do dia 1 (a semana começa em `WEEK_STARTS_ON`). */
export function monthLeadingBlanks(date: LocalDate): number {
  return (weekdayOf(firstOfMonth(date)) - WEEK_STARTS_ON + 7) % 7;
}

const MONTH_NAMES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"] as const;

/** "Novembro de 2026" (visão Mês) ou "seg, 23/11" (Dia e Lista; sem ano, igual aos cartões da agenda). */
export function periodLabel(date: LocalDate, view: AgendaView): string {
  if (view === "mes") return `${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} de ${date.slice(0, 4)}`;
  return shortDateLabel(date);
}

/**
 * Parâmetros ANTIGOS da página de compromissos como sinônimos (o Painel e favoritos antigos ainda os usam):
 * `?date=` vira `?data=` e `?view=` vira `?visao=` (week -> semana, day -> dia, month -> mes). Devolve as escritas
 * (`null` remove) ou `null` quando não há o que migrar. Com `?visao=` já presente nada muda; na visão Semana os
 * parâmetros `view` e `date` são os da própria `CalendarPage` e ficam como estão.
 */
export function migrateLegacyParams(params: URLSearchParams): Record<string, string | null> | null {
  if (viewParam.parse(params.get("visao")) !== null) return null;
  const view = params.get("view");
  const dateRaw = params.get("date");
  const date = dateRaw !== null && isValidLocalDate(dateRaw) ? dateRaw : null;
  const hasData = params.get("data") !== null;
  if (view === "week") return { visao: "semana" };
  const writes: Record<string, string | null> = {};
  if (view === "day" || view === "month") {
    writes.visao = view === "day" ? "dia" : "mes";
    writes.view = null;
  } else if (view !== null) writes.view = null;
  if (dateRaw !== null) {
    writes.date = null;
    if (date && !hasData) writes.data = date;
  }
  return Object.keys(writes).length > 0 ? writes : null;
}
