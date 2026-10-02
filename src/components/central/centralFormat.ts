/**
 * Formatação e rótulos do Painel da Central (pt-BR). Puro — testado em
 * `centralFormat.test.ts`.
 */

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const brlCompact = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 1,
});
const intFmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 });
const decFmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const EMPTY = "—";

export function formatBRL(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return brl.format(value);
}

/** R$ 12,3 mil — para eixos e rótulos apertados. */
export function formatBRLCompact(value: number): string {
  if (Math.abs(value) < 1000) return brl.format(Math.round(value)).replace(/,00$/, "");
  return brlCompact.format(value);
}

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return intFmt.format(value);
}

/** 0.234 → "23,4%". */
export function formatPct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return EMPTY;
  return pctFmt.format(ratio);
}

/** ROAS como multiplicador: 4.25 → "4,3×". */
export function formatRoas(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return `${decFmt.format(value)}×`;
}

/** Segundos → "45 s", "3 min", "1 h 20 min". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EMPTY;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** "2026-09-28" → "28/09". */
export function formatDayMonth(date: string): string {
  const [, m, d] = date.split("-");
  return `${d}/${m}`;
}

/** "2026-09-28" → "28/09/2026". */
export function formatFullDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

/** Data local AAAA-MM-DD (do navegador). */
export function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Soma dias a uma data AAAA-MM-DD (aritmética de calendário). */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Últimos N dias, incluindo hoje. */
export function lastNDays(n: number, today: string): { from: string; to: string } {
  return { from: shiftDate(today, -(n - 1)), to: today };
}

export const SOURCE_LABELS: Record<string, string> = {
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  instagram: "Instagram",
  site: "Site",
  booking: "Booking",
  indicacao: "Indicação",
  organico: "Orgânico",
  retorno: "Retorno",
  outros: "Outros",
  sem_origem: "Sem origem",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/_/g, " ");
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/**
 * "Origem · campanha", sem repetir a origem quando o nome da campanha já
 * começa com ela ("Google Ads — pousada centro" → "Google Ads · pousada centro").
 */
export function campaignLabel(source: string, campaignName?: string): string {
  const label = sourceLabel(source);
  const name = campaignName?.trim();
  if (!name) return label;
  if (fold(name).startsWith(fold(label))) {
    const after = name.slice(label.length);
    // "Google Ads — pousada…" → separador explícito: tira o prefixo repetido.
    // "Indicação de hóspede" → o rótulo faz parte da frase: mostra o nome inteiro.
    if (/^\s*[—–\-·:|/]/.test(after)) {
      const rest = after.replace(/^[\s—–\-·:|/]+/, "").trim();
      return rest ? `${label} · ${rest}` : label;
    }
    return after.trim() ? name : label;
  }
  return `${label} · ${name}`;
}

export const CONTACT_KIND_LABELS: Record<string, string> = {
  lead: "Leads (possível reserva)",
  guest: "Hóspedes",
  supplier: "Fornecedores",
  agency: "Agências",
  other: "Outros",
};

export function contactKindLabel(kind: string): string {
  return CONTACT_KIND_LABELS[kind] ?? kind;
}
