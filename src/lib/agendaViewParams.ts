/**
 * Agenda v2 (B3): estado da página na URL. Codecs de `searchParamState` (constantes de módulo, como o hook
 * exige) e as regras puras de navegação por data. Datas são "YYYY-MM-DD" NO FUSO DA ORG (nunca `Date` local).
 *
 *   ?visao=dia|semana|lista|mes (replace; ausente = a última escolhida neste aparelho, senão lista no celular e dia no computador)
 *   ?data=YYYY-MM-DD       (replace; ausente = hoje na org)
 *   ?por=sala|profissional (replace; agrupamento da grade e da lista)
 *   ?lista=hora|recurso    (replace; agrupamento da lista do dia)
 *   ?appt=<id>             (push; abre o painel do agendamento)
 *   ?pendencias=1          (push; abre a fila de pendências)
 * `?event=` e `?task=` seguem sendo os dos compromissos e tarefas (a página é única).
 */
import { addLocalDays, isValidLocalDate, weekdayOf, weekStartOf, type LocalDate } from "./agendaZone";
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

/** Setas da barra: um dia nas visões Dia e Lista, sete na Semana, um mês na visão Mês. */
export function shiftDate(date: LocalDate, view: AgendaView, dir: 1 | -1): LocalDate {
  if (view === "mes") return shiftMonth(date, dir);
  return addLocalDays(date, view === "semana" ? 7 * dir : dir);
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
export const MONTH_ABBR = ["jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."] as const;

const dayOf = (d: LocalDate) => Number(d.slice(8));
const monthIdx = (d: LocalDate) => Number(d.slice(5, 7)) - 1;
const monthLong = (d: LocalDate) => MONTH_NAMES[monthIdx(d)].toLowerCase();

/**
 * Título do período na barra (estilo Google Agenda): Dia/Lista "26 de novembro de 2026"; Semana "23 – 29 de nov. de 2026"
 * (cruzando mês ou ano: "30 de nov. – 6 de dez. de 2026"); Mês "Novembro de 2026". `compact` (celular) encurta Dia/Lista
 * e Semana, sem o ano ("26 de nov.", "23 – 29 de nov.").
 */
export function periodLabel(date: LocalDate, view: AgendaView, compact = false): string {
  const year = date.slice(0, 4);
  if (view === "mes") return `${MONTH_NAMES[monthIdx(date)]} de ${year}`;
  if (view === "semana") {
    const first = weekStartOf(date);
    const last = addLocalDays(first, 6);
    const tail = compact ? "" : ` de ${last.slice(0, 4)}`;
    if (first.slice(0, 7) === last.slice(0, 7)) return `${dayOf(first)} – ${dayOf(last)} de ${MONTH_ABBR[monthIdx(last)]}${tail}`;
    if (first.slice(0, 4) === last.slice(0, 4)) return `${dayOf(first)} de ${MONTH_ABBR[monthIdx(first)]} – ${dayOf(last)} de ${MONTH_ABBR[monthIdx(last)]}${tail}`;
    return `${dayOf(first)} de ${MONTH_ABBR[monthIdx(first)]} de ${first.slice(0, 4)} – ${dayOf(last)} de ${MONTH_ABBR[monthIdx(last)]} de ${last.slice(0, 4)}`;
  }
  return compact ? `${dayOf(date)} de ${MONTH_ABBR[monthIdx(date)]}` : `${dayOf(date)} de ${monthLong(date)} de ${year}`;
}

/**
 * Parâmetros ANTIGOS da página de compromissos como sinônimos (o Painel e favoritos antigos ainda os usam):
 * `?date=` vira `?data=` e `?view=` vira `?visao=` (week -> semana, day -> dia, month -> mes). Devolve as escritas
 * (`null` remove) ou `null` quando não há o que migrar. Com `?visao=` já presente nada muda.
 */
export function migrateLegacyParams(params: URLSearchParams): Record<string, string | null> | null {
  if (viewParam.parse(params.get("visao")) !== null) return null;
  const view = params.get("view");
  const dateRaw = params.get("date");
  const date = dateRaw !== null && isValidLocalDate(dateRaw) ? dateRaw : null;
  const hasData = params.get("data") !== null;
  const writes: Record<string, string | null> = {};
  if (view === "day" || view === "month" || view === "week") {
    writes.visao = view === "day" ? "dia" : view === "month" ? "mes" : "semana";
    writes.view = null;
  } else if (view !== null) writes.view = null;
  if (dateRaw !== null) {
    writes.date = null;
    if (date && !hasData) writes.data = date;
  }
  return Object.keys(writes).length > 0 ? writes : null;
}
