/**
 * Agenda das publicações programadas em grupos de WhatsApp — PURO (sem Convex,
 * sem `Date.now()`), para ser testado de ponta a ponta. Molde de estilo:
 * `lib/campaignPacing.ts` (`isWithinWindow`/`nextWindowOpenAt`) e
 * `attendant.ts` (`isWithinSchedule`) — mesma ideia de "hora local por fuso"
 * via `Intl.DateTimeFormat`, mas aqui com granularidade de MINUTO (a janela
 * de campanha só precisa de hora cheia) e conversão local→UTC exata, exigida
 * para calcular o próximo instante e para o jitter.
 *
 * Conversão "partes locais → instante UTC": Date.UTC dos componentes locais
 * tratado como se já fosse UTC ("naive"), menos o offset do fuso medido
 * naquele instante via `formatToParts` — com uma 2ª iteração medindo o offset
 * no resultado da 1ª, para o caso raro de a correção cruzar uma transição de
 * horário de verão (DST).
 */

export type GroupPostSchedule = {
  timezone: string; // IANA, ex. "America/Sao_Paulo"
  times: string[]; // "HH:MM" locais, 1..10, únicos
  days: number[]; // 1..7 (1 = segunda … 7 = domingo), não vazio
  startAt?: number; // epoch ms; antes disso não roda
  endAt?: number; // epoch ms; depois disso não roda
  jitterMinutes?: number; // 0..30; deslocamento aleatório determinístico
};

export type LocalDateParts = {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  weekday: number; // 1..7 (1 = segunda … 7 = domingo)
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKAHEAD_DAYS = 400;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const DAY_NAMES_PT: Record<number, string> = {
  1: "Seg",
  2: "Ter",
  3: "Qua",
  4: "Qui",
  5: "Sex",
  6: "Sáb",
  7: "Dom",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Fuso inválido não pode derrubar o cálculo — cai em São Paulo (mesma postura de campaignPacing). */
function safeTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : "America/Sao_Paulo";
}

/** Formata um instante nas partes locais do fuso, incluindo o dia da semana (1=Seg…7=Dom). */
export function localParts(ms: number, timezone: string): LocalDateParts {
  const tz = safeTimezone(timezone);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  let hh = Number(get("hour"));
  if (hh === 24) hh = 0; // alguns motores devolvem "24" à meia-noite mesmo com hourCycle h23
  const mm = Number(get("minute"));
  // Dia da semana é função pura do y/m/d do calendário — calcular via Date.UTC
  // com esses mesmos componentes dá o dia correto independente do fuso.
  const jsWeekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Dom…6=Sáb
  const weekday = jsWeekday === 0 ? 7 : jsWeekday;
  return { y, m, d, hh, mm, weekday };
}

/** Offset (ms, leste positivo) do fuso no instante `ms`. */
function offsetMsAt(ms: number, timezone: string): number {
  const tz = safeTimezone(timezone);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  let hh = Number(get("hour"));
  if (hh === 24) hh = 0;
  const asUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    hh,
    Number(get("minute")),
    Number(get("second"))
  );
  return asUtc - ms;
}

/** Componentes locais (y/m/d/hh/mm) → instante UTC, correto através de DST (2 iterações). */
function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, timezone: string): number {
  const naiveUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offset1 = offsetMsAt(naiveUtc, timezone);
  const utc1 = naiveUtc - offset1;
  const offset2 = offsetMsAt(utc1, timezone);
  return offset2 === offset1 ? utc1 : naiveUtc - offset2;
}

function parseHHMM(s: string): { hh: number; mm: number } {
  const [hh, mm] = s.split(":").map(Number);
  return { hh, mm };
}

function slotKeyFromParts(y: number, m: number, d: number, hh: number, mm: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}`;
}

/** Hash simples e determinístico (FNV-1a) — não precisa ser criptográfico, só estável. */
function simpleHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deslocamento determinístico em [0, maxMinutes] a partir de (seed, slot local). */
function jitterMinutesFor(seed: string, slotStr: string, maxMinutes: number): number {
  if (maxMinutes <= 0) return 0;
  const hash = simpleHash(`${seed}|${slotStr}`);
  return hash % (maxMinutes + 1);
}

/**
 * Próximo disparo: o instante COM jitter (`at`) e a chave do slot-base que o
 * originou (`slotKey`), > afterMs, respeitando fuso (inclusive DST) e
 * startAt/endAt. `null` se nunca mais (endAt já passou para todos os slots
 * possíveis, ou nenhum slot em até 400 dias).
 *
 * Devolver a chave JUNTO do instante é o que evita ter de deduzi-la de trás
 * para frente: com dois horários próximos e jitter grande, o walk-back de
 * `slotKey` casava com o horário ERRADO e a idempotência engolia o slot
 * seguinte. Quem agenda grava o par (`nextRunAt`, `nextSlotKey`).
 */
export function nextRun(
  schedule: GroupPostSchedule,
  afterMs: number,
  opts?: { seed?: string }
): { at: number; slotKey: string } | null {
  const days = Array.from(new Set(schedule.days)).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  const times = Array.from(new Set(schedule.times)).filter((t) => TIME_RE.test(t)).sort();
  if (days.length === 0 || times.length === 0) return null;

  const jitterMax = Math.max(0, Math.min(30, Math.floor(schedule.jitterMinutes ?? 0)));
  const seed = opts?.seed ?? "";

  const startLocal = localParts(afterMs, schedule.timezone);
  const startDayUtcMs = Date.UTC(startLocal.y, startLocal.m - 1, startLocal.d);

  for (let dayOffset = 0; dayOffset <= MAX_LOOKAHEAD_DAYS; dayOffset++) {
    const dateObj = new Date(startDayUtcMs + dayOffset * DAY_MS);
    const y = dateObj.getUTCFullYear();
    const m = dateObj.getUTCMonth() + 1;
    const d = dateObj.getUTCDate();
    const jsWeekday = dateObj.getUTCDay();
    const weekday = jsWeekday === 0 ? 7 : jsWeekday;
    if (!days.includes(weekday)) continue;

    for (const time of times) {
      const { hh, mm } = parseHHMM(time);
      const base = zonedTimeToUtc(y, m, d, hh, mm, schedule.timezone);

      // Ordem cronológica: dia e horário avançam de forma monotônica através
      // desta busca, então passar do endAt aqui significa que NENHUM slot
      // futuro (mesmo dia mais tarde, ou dia seguinte) poderá ser <= endAt.
      if (schedule.endAt !== undefined && base > schedule.endAt) return null;
      if (schedule.startAt !== undefined && base < schedule.startAt) continue;

      const slot = slotKeyFromParts(y, m, d, hh, mm);
      const jitter = jitterMinutesFor(seed, slot, jitterMax);
      const final = base + jitter * 60_000;

      if (final <= afterMs) continue;
      if (schedule.endAt !== undefined && final > schedule.endAt) continue; // só este slot jitterou pra fora
      return { at: final, slotKey: slot };
    }
  }
  return null;
}

/** Só o instante do próximo disparo (compatibilidade: UI e cálculos de prévia). */
export function nextRunAt(
  schedule: GroupPostSchedule,
  afterMs: number,
  opts?: { seed?: string }
): number | null {
  return nextRun(schedule, afterMs, opts)?.at ?? null;
}

/**
 * Chave do slot local ("YYYY-MM-DDTHH:MM", sem jitter) usada para idempotência
 * ("já enviei este slot?"). Aceita tanto o instante exato do horário
 * configurado quanto um instante deslocado pelo jitter — anda para trás minuto
 * a minuto, até `jitterMinutes`, procurando o horário-base que bateria com a
 * agenda.
 *
 * FALLBACK, não a fonte da verdade: o walk-back devolve o PRIMEIRO horário que
 * casa, que com dois horários a menos de `jitterMinutes` de distância pode ser
 * o errado. Quem agenda usa `nextRun`, que já entrega a chave certa e a grava
 * em `groupPosts.nextSlotKey`; esta função só cobre documentos antigos (sem o
 * campo) e ticks cujo `nextRunAt` veio de outro caminho. `validateGroupPostSchedule`
 * recusa jitter maior ou igual à menor distância entre dois horários, o que
 * mantém o walk-back exato para tudo que passa pela validação.
 */
export function slotKey(schedule: GroupPostSchedule, runAtMs: number): string {
  const jitterMax = Math.max(0, Math.min(30, Math.floor(schedule.jitterMinutes ?? 0)));
  const times = new Set(schedule.times);
  const days = new Set(schedule.days);

  for (let back = 0; back <= jitterMax; back++) {
    const t = runAtMs - back * 60_000;
    const { y, m, d, hh, mm, weekday } = localParts(t, schedule.timezone);
    const hhmm = `${pad2(hh)}:${pad2(mm)}`;
    if (times.has(hhmm) && days.has(weekday)) {
      return slotKeyFromParts(y, m, d, hh, mm);
    }
  }
  // Nenhum horário-base bateu dentro da tolerância (ex.: runAtMs não veio de
  // nextRunAt) — cai no local puro do instante recebido.
  const { y, m, d, hh, mm } = localParts(runAtMs, schedule.timezone);
  return slotKeyFromParts(y, m, d, hh, mm);
}

function joinPt(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** Descrição PT-BR da agenda, ex.: "Seg, Qua e Sex às 09:00 e 18:00 (America/Sao_Paulo)". */
export function describeSchedule(schedule: GroupPostSchedule): string {
  const days = Array.from(new Set(schedule.days)).sort((a, b) => a - b);
  const times = Array.from(new Set(schedule.times)).sort();
  const daysStr = joinPt(days.map((d) => DAY_NAMES_PT[d] ?? "?"));
  const timesStr = joinPt(times);
  return `${daysStr} às ${timesStr} (${schedule.timezone})`;
}

/**
 * Menor distância (em minutos) entre dois horários da agenda, contando a volta
 * pela meia-noite. `null` quando há um horário só (não existe distância).
 */
export function smallestTimeGapMinutes(times: string[]): number | null {
  const mins = Array.from(
    new Set(times.filter((t) => typeof t === "string" && TIME_RE.test(t)))
  )
    .map((t) => {
      const { hh, mm } = parseHHMM(t);
      return hh * 60 + mm;
    })
    .sort((a, b) => a - b);
  if (mins.length < 2) return null;
  let smallest = 24 * 60 - mins[mins.length - 1] + mins[0]; // volta pela meia-noite
  for (let i = 1; i < mins.length; i++) {
    smallest = Math.min(smallest, mins[i] - mins[i - 1]);
  }
  return smallest;
}

export type ValidateGroupPostScheduleResult =
  | { ok: true; value: GroupPostSchedule }
  | { ok: false; error: string };

/** Valida (e normaliza: dedupe + ordena times/days) uma agenda vinda de fora (mutation args). */
export function validateGroupPostSchedule(s: unknown): ValidateGroupPostScheduleResult {
  if (typeof s !== "object" || s === null) {
    return { ok: false, error: "agenda inválida: esperado um objeto" };
  }
  const raw = s as Record<string, unknown>;

  if (typeof raw.timezone !== "string" || raw.timezone.length === 0 || !isValidTimezone(raw.timezone)) {
    return { ok: false, error: "fuso horário inválido" };
  }

  if (!Array.isArray(raw.times) || raw.times.length < 1 || raw.times.length > 10) {
    return { ok: false, error: "times deve ter entre 1 e 10 horários" };
  }
  for (const t of raw.times) {
    if (typeof t !== "string" || !TIME_RE.test(t)) {
      return { ok: false, error: `horário mal formatado: ${String(t)} (use HH:MM, 24h)` };
    }
  }
  if (new Set(raw.times as string[]).size !== raw.times.length) {
    return { ok: false, error: "times deve conter horários únicos" };
  }

  if (!Array.isArray(raw.days) || raw.days.length === 0) {
    return { ok: false, error: "days não pode ser vazio" };
  }
  for (const d of raw.days) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 7) {
      return { ok: false, error: `dia inválido (use 1..7, 1=segunda): ${String(d)}` };
    }
  }

  if (raw.startAt !== undefined && (typeof raw.startAt !== "number" || !Number.isFinite(raw.startAt))) {
    return { ok: false, error: "startAt deve ser um epoch em ms" };
  }
  if (raw.endAt !== undefined && (typeof raw.endAt !== "number" || !Number.isFinite(raw.endAt))) {
    return { ok: false, error: "endAt deve ser um epoch em ms" };
  }
  if (
    typeof raw.startAt === "number" &&
    typeof raw.endAt === "number" &&
    raw.endAt <= raw.startAt
  ) {
    return { ok: false, error: "endAt deve ser depois de startAt" };
  }

  if (raw.jitterMinutes !== undefined) {
    if (
      typeof raw.jitterMinutes !== "number" ||
      !Number.isInteger(raw.jitterMinutes) ||
      raw.jitterMinutes < 0 ||
      raw.jitterMinutes > 30
    ) {
      return { ok: false, error: "jitterMinutes deve ser um inteiro entre 0 e 30" };
    }
    // Jitter maior que o intervalo entre dois horários faz um disparo invadir o
    // horário seguinte: as duas publicações do dia caem no mesmo slot e a
    // segunda morre calada na idempotência.
    const gap = smallestTimeGapMinutes(raw.times as string[]);
    if (gap !== null && raw.jitterMinutes >= gap) {
      return {
        ok: false,
        error: `jitterMinutes (${raw.jitterMinutes}) precisa ser menor que o intervalo entre dois horários (${gap} min) — senão um disparo invade o horário seguinte`,
      };
    }
  }

  const value: GroupPostSchedule = {
    timezone: raw.timezone,
    times: Array.from(new Set(raw.times as string[])).sort(),
    days: Array.from(new Set(raw.days as number[])).sort((a, b) => a - b),
  };
  if (typeof raw.startAt === "number") value.startAt = raw.startAt;
  if (typeof raw.endAt === "number") value.endAt = raw.endAt;
  if (typeof raw.jitterMinutes === "number") value.jitterMinutes = raw.jitterMinutes;

  return { ok: true, value };
}
