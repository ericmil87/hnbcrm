/**
 * Agenda v2 (I1): funções PURAS da REST/MCP da agenda. Datas de entrada e saída em ISO com offset mais `local`
 * (`AAAA-MM-DDTHH:mm` no fuso da org) e `timezone`, nunca só epoch. Sem `ctx`.
 */
import type { Id } from "../_generated/dataModel";
import { atLocalMinutes, isValidLocalDate, localDateOf, minutesOfDay } from "./schedTime";
import { isoWithOffset } from "./schedBookingEffects";

/** Alias de tipo: a REST não escreve agendamento (o guard de build só quer ver o nome da tabela longe de `.replace(`). */
export type SchedAppointmentId = Id<"schedAppointments">;

const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

export type WhenInput = { startsAt?: unknown; startsAtLocal?: unknown; startTime?: unknown };
export type WhenResult = { ok: true; startTime: number } | { ok: false; error: string };

/**
 * Início de um agendamento a partir de `startsAt` (ISO com offset), `startsAtLocal` (`AAAA-MM-DDTHH:mm` no fuso da
 * org) ou `startTime` (epoch ms, o que o `Slot` devolve). Informado mais de um, têm de ser o MESMO instante.
 * Hora local inexistente (salto do horário de verão) e minuto quebrado são recusados, nunca ajustados em silêncio.
 */
export function parseWhen(input: WhenInput, tz: string): WhenResult {
  const found: number[] = [];
  if (input.startsAt !== undefined) {
    if (typeof input.startsAt !== "string" || !ISO_OFFSET_RE.test(input.startsAt)) {
      return { ok: false, error: "startsAt inválido: use ISO 8601 com fuso, ex.: 2026-11-27T14:30:00-03:00." };
    }
    const ms = Date.parse(input.startsAt);
    if (!Number.isFinite(ms)) return { ok: false, error: "startsAt inválido." };
    found.push(ms);
  }
  if (input.startsAtLocal !== undefined) {
    const m = typeof input.startsAtLocal === "string" ? LOCAL_RE.exec(input.startsAtLocal) : null;
    if (!m || !isValidLocalDate(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59) {
      return { ok: false, error: "startsAtLocal inválido: use AAAA-MM-DDTHH:mm no fuso da organização." };
    }
    let ms: number;
    try {
      ms = atLocalMinutes(m[1], Number(m[2]) * 60 + Number(m[3]), tz);
    } catch {
      return { ok: false, error: "startsAtLocal inválido." };
    }
    if (localDateOf(ms, tz) !== m[1] || minutesOfDay(ms, tz) !== Number(m[2]) * 60 + Number(m[3])) {
      return { ok: false, error: "Esse horário não existe no fuso da organização (mudança de horário de verão)." };
    }
    found.push(ms);
  }
  if (input.startTime !== undefined) {
    if (typeof input.startTime !== "number" || !Number.isFinite(input.startTime)) {
      return { ok: false, error: "startTime inválido: epoch em milissegundos." };
    }
    found.push(input.startTime);
  }
  if (found.length === 0) return { ok: false, error: "Informe startsAt, startsAtLocal ou startTime." };
  if (found.some((ms) => ms !== found[0])) return { ok: false, error: "startsAt, startsAtLocal e startTime indicam instantes diferentes." };
  const startTime = found[0];
  if (startTime % 60_000 !== 0) return { ok: false, error: "O horário precisa ser em minuto inteiro." };
  return { ok: true, startTime };
}

/** Acrescenta ISO com offset e hora local a um objeto com `startTime`/`endTime` (agendamento, horário, alternativa). */
export function withTimes<T extends { startTime: number; endTime?: number }>(
  row: T,
  tz: string
): T & { startsAt: string; startsAtLocal: string; endsAt?: string; endsAtLocal?: string; timezone: string } {
  const startsAt = isoWithOffset(row.startTime, tz);
  const out: T & { startsAt: string; startsAtLocal: string; endsAt?: string; endsAtLocal?: string; timezone: string } = {
    ...row,
    startsAt,
    startsAtLocal: startsAt.slice(0, 16),
    timezone: tz,
  };
  if (typeof row.endTime === "number") {
    const endsAt = isoWithOffset(row.endTime, tz);
    out.endsAt = endsAt;
    out.endsAtLocal = endsAt.slice(0, 16);
  }
  return out;
}

/** Texto livre que chega pela REST: aparado e com teto (a porta ainda sanitiza). */
export function cleanBodyText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t.slice(0, max);
}

/** Chave de idempotência de entrada → a que vai para a porta (`rest:`). 1–128 caracteres seguros. */
export function restIdempotencyKey(raw: unknown): { ok: true; key: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 128 || !/^[A-Za-z0-9._:\-]+$/.test(raw)) {
    return { ok: false, error: "Chave de idempotência obrigatória: 1 a 128 caracteres (letras, números, . _ : -), no cabeçalho Idempotency-Key ou no campo requestId." };
  }
  return { ok: true, key: `rest:${raw}` };
}
