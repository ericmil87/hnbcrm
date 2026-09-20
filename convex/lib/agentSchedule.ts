/**
 * Agenda do ATENDENTE IA — horário de atendimento + janela de follow-up.
 * Módulo PURO (sem ctx, sem Convex, sem `Date.now()`), para ser testado de
 * ponta a ponta e importado tanto no servidor quanto num futuro simulador.
 *
 * `isWithinSchedule` é a MESMA função hoje em `convex/attendant.ts:117-142`,
 * movida para cá (F0 do plano de follow-up, seção 4.2) — mesma semântica,
 * só trocando `hour12:false` por `hourCycle:"h23"` (evita o "24:00" que
 * `hour12:false` produz em parte dos ICUs à meia-noite; mesmo cuidado de
 * `lib/promptDateTime.ts` e `lib/groupPostSchedule.ts`).
 *
 * `localToEpoch`/`nextOpening` são NOVOS: a tool `scheduleFollowUp` recebe
 * hora local ("amanhã às 9h") e precisa de um instante UTC; se cair fora do
 * horário de atendimento, precisa saber a PRÓXIMA abertura para avisar o
 * cliente. Técnica de fuso via `Intl.DateTimeFormat` + `formatToParts` é a
 * mesma de `lib/groupPostSchedule.ts`/`lib/campaignPacing.ts`, mas aqui
 * `localToEpoch` trata explicitamente os dois casos de DST que aquele módulo
 * não precisa resolver (seus horários de agenda quase nunca caem no intervalo
 * de 1h da virada): hora INEXISTENTE (salto de primavera) avança para o
 * próximo instante válido; hora AMBÍGUA (volta do horário de verão) resolve
 * para a PRIMEIRA ocorrência.
 */

import { resolveAgentTimezone, safeTimezone } from "./promptDateTime";

/** days: 0=Dom…6=Sáb (mesma convenção de `agentProfile.schedule` no schema); ausente/vazio = todos. */
export type AgentSchedule = {
  timezone: string;
  startHour: number;
  endHour: number;
  days?: number[];
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const NEXT_OPENING_MAX_DAYS = 14;
// Buffer usado para amostrar o offset "antes"/"depois" de uma eventual
// transição de DST perto do instante alvo. 26h é folgado o bastante para
// nunca cair dentro do próprio intervalo de virada (no máximo ~2h em
// qualquer fuso real) e curto o bastante para nunca atravessar DUAS
// transições (elas nunca ficam a menos de meses de distância).
const DST_BUFFER_MS = 26 * 60 * 60 * 1000;
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * Mesma semântica de `isWithinSchedule` em `convex/attendant.ts:117-142`:
 * schedule ausente/nulo => dentro (true); timezone inválida => dentro (true,
 * não pode derrubar o atendimento); `days` ausente/vazio => todos os dias.
 */
export function isWithinSchedule(schedule: AgentSchedule | null | undefined, now: number): boolean {
  if (!schedule) return true;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.timezone,
      hourCycle: "h23",
      hour: "numeric",
      weekday: "short",
    }).formatToParts(new Date(now));
    let hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    if (hour === 24) hour = 0; // defensivo — ver nota do cabeçalho
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
    const dayIndex = WEEKDAY_INDEX[weekday] ?? 1;
    if (schedule.days && schedule.days.length > 0 && !schedule.days.includes(dayIndex)) {
      return false;
    }
    return hour >= schedule.startHour && hour < schedule.endHour;
  } catch {
    // Timezone inválida não pode derrubar o atendimento — considera dentro.
    return true;
  }
}

type WallClock = { y: number; m: number; d: number; hh: number; mm: number };

/** Offset (ms, leste positivo) do fuso no instante `ms`. Mesma técnica de `lib/groupPostSchedule.ts`. */
function offsetMsAt(ms: number, timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
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

/** Partes locais (y/m/d/hh/mm) de um instante, no fuso dado. */
function wallClockAt(ms: number, timezone: string): WallClock {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  let hh = Number(get("hour"));
  if (hh === 24) hh = 0;
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    hh,
    mm: Number(get("minute")),
  };
}

/** `Date.UTC` "arredonda" mês/dia fora de faixa em vez de recusar — este round-trip detecta isso. */
function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d && a.hh === b.hh && a.mm === b.mm;
}

/**
 * "YYYY-MM-DDTHH:mm" (hora de parede no fuso) -> epoch ms. `null` se o
 * formato ou a data forem inválidos (mês/dia impossível, hora/minuto fora de
 * faixa). Fuso inválido cai no default do produto via `safeTimezone`.
 *
 * DST: amostra o offset bem ANTES (`-26h`) e bem DEPOIS (`+26h`) do instante
 * alvo. Se os dois batem, não há transição por perto — instante único. Se
 * divergem, testa os dois candidatos (um por offset) contra o relógio de
 * parede que cada um produziria de volta:
 *  - os dois batem com o alvo  -> hora AMBÍGUA (dobra do horário de verão):
 *    devolve a PRIMEIRA ocorrência (o instante UTC menor dos dois).
 *  - só um bate                -> não é ambígua nem inexistente (a transição
 *    está perto no calendário mas não afeta este horário específico).
 *  - nenhum bate                -> hora INEXISTENTE (salto de primavera):
 *    o candidato calculado com o offset ANTERIOR sempre cai DEPOIS da
 *    virada (senão ele teria batido), o que já É "avançar para o próximo
 *    instante válido" — é o candidato devolvido.
 */
export function localToEpoch(local: string, timezone: string): number | null {
  const match = LOCAL_DATETIME_RE.exec(local);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const hh = Number(match[4]);
  const mm = Number(match[5]);
  if (hh > 23 || mm > 59) return null;
  if (!isValidCalendarDate(y, m, d)) return null;

  const tz = safeTimezone(timezone);
  const naiveUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const target: WallClock = { y, m, d, hh, mm };

  const offsetBefore = offsetMsAt(naiveUtc - DST_BUFFER_MS, tz);
  const offsetAfter = offsetMsAt(naiveUtc + DST_BUFFER_MS, tz);
  if (offsetBefore === offsetAfter) {
    return naiveUtc - offsetBefore;
  }

  const candidateBefore = naiveUtc - offsetBefore;
  const candidateAfter = naiveUtc - offsetAfter;
  const matchesBefore = sameWallClock(wallClockAt(candidateBefore, tz), target);
  const matchesAfter = sameWallClock(wallClockAt(candidateAfter, tz), target);

  if (matchesBefore && matchesAfter) return Math.min(candidateBefore, candidateAfter);
  if (matchesBefore) return candidateBefore;
  if (matchesAfter) return candidateAfter;
  return candidateBefore; // hora inexistente — avança para o próximo instante válido
}

/**
 * Menor instante >= `from` que está dentro do `schedule`. Já dentro => `from`.
 * `schedule` ausente => `from`. Janela inválida (`startHour >= endHour`) ou
 * que nunca abre dentro do teto de busca => `from`.
 *
 * Caminha por CALENDÁRIO LOCAL (um dia por vez, no fuso do schedule), nunca
 * somando 24h ao epoch — a mesma cautela de `lib/promptDateTime.ts` quanto a
 * DST. Abertura de um dia permitido é sempre `startHour:00` local; se hoje
 * ainda não chegou lá, a resposta é hoje; se hoje já passou (ou não é
 * permitido), avança dia a dia até `NEXT_OPENING_MAX_DAYS`.
 */
export function nextOpening(schedule: AgentSchedule | null | undefined, from: number): number {
  if (!schedule) return from;
  if (schedule.startHour >= schedule.endHour) return from;
  if (isWithinSchedule(schedule, from)) return from;

  const tz = safeTimezone(schedule.timezone);
  const days = schedule.days && schedule.days.length > 0 ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  const startWall = wallClockAt(from, tz);
  const startDayUtcMs = Date.UTC(startWall.y, startWall.m - 1, startWall.d);
  const startHH = String(schedule.startHour).padStart(2, "0");

  for (let dayOffset = 0; dayOffset < NEXT_OPENING_MAX_DAYS; dayOffset++) {
    const dateObj = new Date(startDayUtcMs + dayOffset * DAY_MS);
    const y = dateObj.getUTCFullYear();
    const m = dateObj.getUTCMonth() + 1;
    const d = dateObj.getUTCDate();
    const weekday = dateObj.getUTCDay(); // 0=Dom…6=Sáb — mesma convenção do schedule
    if (!days.includes(weekday)) continue;

    const local = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${startHH}:00`;
    const openAt = localToEpoch(local, tz);
    if (openAt !== null && openAt >= from) return openAt;
  }
  return from;
}

/**
 * Janela efetiva para follow-up: a janela de silêncio (`quietStartHour`..
 * `quietEndHour`) vale SEMPRE, intersectada com o `schedule` do atendente
 * quando ele existe — não "ou um ou outro". Sem isso, um atendente com
 * `schedule` 0–24h (comum — cobre o dia todo) deixaria o follow-up disparar
 * às 3h da manhã, que é exatamente o que a janela de silêncio existe para
 * evitar.
 *
 * Sem `schedule`: janela padrão = silêncio, todos os dias.
 * Com `schedule`: fuso = `schedule.timezone` se válido, senão `timezone`
 * (mesma precedência de `resolveAgentTimezone`); horário = interseção
 * (`max(startHour)`..`min(endHour)`); `days` = os do schedule.
 * Interseção vazia (ex.: schedule 22–24h, silêncio 8–20h) => usa só a janela
 * de silêncio, mas PRESERVA os `days` do schedule (um atendente de
 * ter/qui não passa a aceitar follow-up todo dia só porque a interseção de
 * horário zerou).
 */
export function followUpWindow(
  schedule: AgentSchedule | null | undefined,
  timezone: string,
  quietStartHour: number,
  quietEndHour: number
): AgentSchedule {
  if (!schedule) {
    return { timezone: safeTimezone(timezone), startHour: quietStartHour, endHour: quietEndHour };
  }
  const tz = resolveAgentTimezone(schedule.timezone, timezone);
  const startHour = Math.max(schedule.startHour, quietStartHour);
  const endHour = Math.min(schedule.endHour, quietEndHour);
  if (startHour >= endHour) {
    return { timezone: tz, startHour: quietStartHour, endHour: quietEndHour, days: schedule.days };
  }
  return { timezone: tz, startHour, endHour, days: schedule.days };
}

/** "seg 21/09 09:00" no fuso pedido (pt-BR, h23) — para o texto que volta ao LLM e à UI. */
export function formatLocalShort(epoch: number, timezone: string): string {
  const tz = safeTimezone(timezone);
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(epoch));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday").replace(/\.$/, ""); // pt-BR abrevia com ponto ("seg.")
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return `${weekday} ${get("day")}/${get("month")} ${hour}:${get("minute")}`;
}
