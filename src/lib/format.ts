/**
 * Formatadores de data, relativo, dinheiro e número (pt-BR fixo).
 * Porta única do front: telas não devem chamar `toLocale*String` direto.
 * Puro: `now` é sempre argumento; `timeZone` é opcional (padrão: o do navegador).
 * Telefone NÃO entra aqui (porta única em `lib/phone`).
 */

export const LOCALE = "pt-BR";

/** Marcador de valor ausente. */
export const EMPTY = "—";

type Timestamp = number | Date;

interface TimeZoneOption {
  /** IANA, ex.: "America/Sao_Paulo". Padrão: fuso do navegador. */
  timeZone?: string;
}

function isValid(ts: Timestamp | null | undefined): ts is Timestamp {
  if (ts === null || ts === undefined) return false;
  return Number.isFinite(ts instanceof Date ? ts.getTime() : ts);
}

/** 09/03/2025 */
export function formatDate(ts: Timestamp, { timeZone }: TimeZoneOption = {}): string {
  if (!isValid(ts)) return EMPTY;
  return new Date(ts).toLocaleDateString(LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  });
}

/** 14:30 */
export function formatTime(ts: Timestamp, { timeZone }: TimeZoneOption = {}): string {
  if (!isValid(ts)) return EMPTY;
  return new Date(ts).toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

/** 09/03/2025 14:30 */
export function formatDateTime(ts: Timestamp, opts: TimeZoneOption = {}): string {
  if (!isValid(ts)) return EMPTY;
  return `${formatDate(ts, opts)} ${formatTime(ts, opts)}`;
}

const MINUTE = 60_000;

/**
 * Tempo decorrido: "agora", "há 5 min", "há 3h", "há 2 dias"; a partir de 7
 * dias, a data curta ("09 de mar. de 2025"). Futuro conta como "agora".
 */
export function formatRelative(ts: Timestamp, now: number, { timeZone }: TimeZoneOption = {}): string {
  if (!isValid(ts)) return EMPTY;
  const time = new Date(ts).getTime();
  const minutes = Math.floor((now - time) / MINUTE);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `há ${days} dia${days > 1 ? "s" : ""}`;
  return new Date(time).toLocaleDateString(LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone,
  });
}

/**
 * Prazo por dia de calendário (tarefas): "3d atrás", "Ontem", "Hoje",
 * "Amanhã", "4d" (até 7 dias) e depois "09 de mar.". Usa o fuso do navegador.
 */
export function formatDueRelative(dueDate: number, now: number): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(dueDate);
  dueDay.setHours(0, 0, 0, 0);

  const diffDays = Math.round((dueDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < -1) return `${Math.abs(diffDays)}d atrás`;
  if (diffDays === -1) return "Ontem";
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Amanhã";
  if (diffDays <= 7) return `${diffDays}d`;
  return new Date(dueDate).toLocaleDateString(LOCALE, { day: "2-digit", month: "short" });
}

interface MoneyOptions {
  /** Casas decimais máximas. Padrão: as da moeda (2 para BRL). */
  fractionDigits?: number;
  /** "R$ 1,5 mil" / "R$ 2 mi". */
  compact?: boolean;
}

/**
 * Valor monetário. Ausente ou não finito → "—". Moeda inválida cai em BRL.
 */
export function formatMoney(
  value: number | null | undefined,
  currency: string = "BRL",
  { fractionDigits, compact }: MoneyOptions = {}
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  const options: Intl.NumberFormatOptions = {
    style: "currency",
    currency: currency || "BRL",
    ...(fractionDigits !== undefined && {
      maximumFractionDigits: fractionDigits,
      minimumFractionDigits: Math.min(fractionDigits, 2),
    }),
    ...(compact && { notation: "compact", maximumFractionDigits: fractionDigits ?? 1, minimumFractionDigits: 0 }),
  };
  try {
    return new Intl.NumberFormat(LOCALE, options).format(value);
  } catch {
    return new Intl.NumberFormat(LOCALE, { ...options, currency: "BRL" }).format(value);
  }
}

/** Custo em dólar; abaixo de 1 centavo (e acima de zero) vira "menos de US$ 0,01". */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "menos de US$ 0,01";
  return formatMoney(value, "USD");
}

/** Inteiro com separador de milhar: 1.234.567. */
export function formatCount(n: number): string {
  return n.toLocaleString(LOCALE);
}

/** "12,5" / "12.5" → 12.5; vazio ou inválido → null. */
export function parseDecimal(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * Data e hora compactas: sem o ano quando `ts` cai no mesmo ano de `now` ("09/03 14:30"),
 * com o ano completo nos demais casos ("09/03/2024 14:30"). Para linhas estreitas (375 px).
 */
export function formatDateTimeShort(ts: Timestamp, now: number, opts: TimeZoneOption = {}): string {
  if (!isValid(ts)) return EMPTY;
  const year = (value: Timestamp | number) =>
    new Date(value).toLocaleDateString(LOCALE, { year: "numeric", timeZone: opts.timeZone });
  if (year(ts) !== year(now)) return formatDateTime(ts, opts);
  const day = new Date(ts).toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit", timeZone: opts.timeZone });
  return `${day} ${formatTime(ts, opts)}`;
}

/**
 * Separador de dia do thread de mensagens (estilo WhatsApp): "Hoje", "Ontem",
 * "seg., 3 de nov." no mesmo ano de `now`, "3 de nov. de 2025" nos demais.
 * Dia de calendário no fuso informado (padrão: o do navegador).
 */
export function formatDayLabel(ts: Timestamp, now: number, { timeZone }: TimeZoneOption = {}): string {
  if (!isValid(ts)) return EMPTY;
  const key = (value: Timestamp) =>
    new Date(value).toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
  const day = key(ts);
  if (day === key(now)) return "Hoje";
  // Meio-dia de "ontem" evita a borda do horário de verão.
  const [y, m, d] = key(now).split("-").map(Number);
  const yesterday = Date.UTC(y, m - 1, d - 1, 12);
  if (day === new Date(yesterday).toISOString().slice(0, 10)) return "Ontem";
  const sameYear = day.slice(0, 4) === key(now).slice(0, 4);
  return new Date(ts).toLocaleDateString(
    LOCALE,
    sameYear
      ? { weekday: "short", day: "numeric", month: "short", timeZone }
      : { day: "numeric", month: "short", year: "numeric", timeZone }
  );
}
