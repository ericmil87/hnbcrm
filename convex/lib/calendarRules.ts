/**
 * Regras PURAS da agenda (sem ctx): validação de entrada, transições de status,
 * posse do evento (próprios × todos) e cálculo da próxima ocorrência no fuso da
 * org. O núcleo com banco está em `calendarCore.ts`; `calendar.ts` só registra.
 */
import { ConvexError } from "convex/values";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./permissions";
import { localParts } from "./groupPostSchedule";
import { localInstant } from "./copilotDates";
import { safeTimezone } from "./promptDateTime";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Teto de duração de um evento (também é a "folga" de leitura por sobreposição). */
export const MAX_EVENT_DURATION_MS = 31 * DAY_MS;
/** Janela máxima de uma consulta (a grade mais larga é o mês: ~42 dias). */
export const MAX_QUERY_WINDOW_MS = 400 * DAY_MS;
/** Epoch aceito: 1970 .. 2100. */
export const MIN_EPOCH_MS = 0;
export const MAX_EPOCH_MS = 4_102_444_800_000;

export const MAX_TITLE_LENGTH = 200;
export const MAX_TEXT_LENGTH = 5000;
export const MAX_SHORT_LENGTH = 500;
export const MAX_COLOR_LENGTH = 40;
export const MAX_ATTENDEES = 50;

/** Teto de linhas lidas por consulta de grade e de itens devolvidos. */
export const EVENTS_SCAN_CAP = 1500;
export const EVENTS_DEFAULT_LIMIT = 1000;
export const EVENTS_MAX_LIMIT = 500;

export type EventStatus = "scheduled" | "completed" | "cancelled";
export type RecurrencePattern = "daily" | "weekly" | "biweekly" | "monthly";

export function fail(message: string): never {
  throw new ConvexError(message);
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

function assertEpoch(value: number, label: string): void {
  if (!Number.isFinite(value) || value < MIN_EPOCH_MS || value > MAX_EPOCH_MS) {
    fail(`${label} inválido`);
  }
}

function assertMaxLength(value: string | undefined, max: number, label: string): void {
  if (value !== undefined && value.length > max) {
    fail(`${label} muito longo (máximo ${max} caracteres)`);
  }
}

/** `endTime >= startTime`, datas finitas, duração dentro do teto. */
export function validateEventTimes(startTime: number, endTime: number): void {
  assertEpoch(startTime, "Início");
  assertEpoch(endTime, "Término");
  if (endTime < startTime) fail("O término não pode ser anterior ao início");
  if (endTime - startTime > MAX_EVENT_DURATION_MS) {
    fail("Duração máxima de um evento: 31 dias");
  }
}

/** Título aparado e não vazio. */
export function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) fail("Informe um título para o evento");
  if (trimmed.length > MAX_TITLE_LENGTH) {
    fail(`Título muito longo (máximo ${MAX_TITLE_LENGTH} caracteres)`);
  }
  return trimmed;
}

export function validateEventTexts(input: {
  description?: string;
  notes?: string;
  location?: string;
  meetingUrl?: string;
  color?: string;
}): void {
  assertMaxLength(input.description, MAX_TEXT_LENGTH, "Descrição");
  assertMaxLength(input.notes, MAX_TEXT_LENGTH, "Notas");
  assertMaxLength(input.location, MAX_SHORT_LENGTH, "Local");
  assertMaxLength(input.meetingUrl, MAX_SHORT_LENGTH, "Link da reunião");
  assertMaxLength(input.color, MAX_COLOR_LENGTH, "Cor");
}

export function validateRecurrence(
  recurrence: { pattern: RecurrencePattern; endDate?: number } | undefined,
  startTime: number,
): void {
  if (!recurrence) return;
  if (recurrence.endDate !== undefined) {
    assertEpoch(recurrence.endDate, "Fim da recorrência");
    if (recurrence.endDate < startTime) fail("O fim da recorrência não pode ser anterior ao início do evento");
  }
}

export function dedupeIds<T extends string>(ids: T[] | undefined): T[] | undefined {
  if (!ids) return undefined;
  const unique = [...new Set(ids)];
  if (unique.length > MAX_ATTENDEES) fail(`Participantes demais (máximo ${MAX_ATTENDEES})`);
  return unique;
}

/** Janela de uma consulta de grade: finita, ordenada e de tamanho razoável. */
export function validateQueryWindow(startDate: number, endDate: number): void {
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate)) fail("Intervalo de datas inválido");
  if (endDate < startDate) fail("A data final não pode ser anterior à inicial");
  if (endDate - startDate > MAX_QUERY_WINDOW_MS) fail("Intervalo máximo de consulta: 400 dias");
}

export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), max);
}

// ---------------------------------------------------------------------------
// Transições de status
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<EventStatus, string> = {
  scheduled: "agendado",
  completed: "concluído",
  cancelled: "cancelado",
};

/** Só evento agendado conclui, cancela ou é reagendado. */
export function assertCanTransition(
  current: EventStatus,
  action: "complete" | "cancel" | "reschedule",
): void {
  if (current === "scheduled") return;
  if (action === "reschedule") {
    fail(`Evento ${STATUS_LABEL[current]} não pode ser reagendado`);
  }
  if (current === (action === "complete" ? "completed" : "cancelled")) {
    fail(`Este evento já está ${STATUS_LABEL[current]}`);
  }
  fail(
    action === "complete"
      ? `Evento ${STATUS_LABEL[current]} não pode ser concluído`
      : `Evento ${STATUS_LABEL[current]} não pode ser cancelado`,
  );
}

// ---------------------------------------------------------------------------
// Permissões (categoria `tasks` enquanto a Agenda v2 não traz a própria)
// ---------------------------------------------------------------------------

type EventOwnership = {
  createdBy: string;
  assignedTo?: string | null;
  attendees?: string[] | null;
};

type MemberLike = { _id: string; role: string; permissions?: unknown };

export function memberPermissions(member: MemberLike, override?: Permissions): Permissions {
  return override ?? resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
}

/** Dono para EDITAR: quem criou ou o responsável. */
export function isEventEditor(memberId: string, event: EventOwnership): boolean {
  return event.createdBy === memberId || event.assignedTo === memberId;
}

/** Dono para VER: dono para editar ou participante. */
export function isEventParticipant(memberId: string, event: EventOwnership): boolean {
  return isEventEditor(memberId, event) || (event.attendees ?? []).includes(memberId);
}

/** `view_all` ou mais vê todos os eventos; `view_own` só os seus. */
export function canViewAllEvents(perms: Permissions): boolean {
  return hasPermission(perms, "tasks", "view_all");
}

export function canViewAnyEvent(perms: Permissions): boolean {
  return hasPermission(perms, "tasks", "view_own");
}

export function canViewEvent(perms: Permissions, memberId: string, event: EventOwnership): boolean {
  if (!hasPermission(perms, "tasks", "view_own")) return false;
  return canViewAllEvents(perms) || isEventParticipant(memberId, event);
}

/** Criar exige `edit_own`. */
export function canCreateEvent(perms: Permissions): boolean {
  return hasPermission(perms, "tasks", "edit_own");
}

/** Editar/reagendar/concluir/cancelar/excluir: os seus com `edit_own`, os dos outros com `edit_all`. */
export function canEditEvent(perms: Permissions, memberId: string, event: EventOwnership): boolean {
  if (isEventEditor(memberId, event)) return hasPermission(perms, "tasks", "edit_own");
  return hasPermission(perms, "tasks", "edit_all");
}

// ---------------------------------------------------------------------------
// Recorrência no fuso da org
// ---------------------------------------------------------------------------

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Início da próxima ocorrência, mantendo a HORA DE PAREDE no fuso `timezone`
 * (atravessar horário de verão não desloca 1 h). `monthly` em dia 29–31 fixa
 * no último dia do mês curto (31/01 → 28/02) em vez de transbordar para março.
 */
export function nextOccurrenceStart(
  startTime: number,
  pattern: RecurrencePattern,
  timezone: string | null | undefined,
): number {
  const tz = safeTimezone(timezone);
  const p = localParts(startTime, tz);
  let y = p.y;
  let m = p.m;
  let d = p.d;
  if (pattern === "monthly") {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    d = Math.min(d, daysInMonth(y, m));
  } else {
    const step = pattern === "daily" ? 1 : pattern === "weekly" ? 7 : 14;
    const shifted = new Date(Date.UTC(y, m - 1, d + step));
    y = shifted.getUTCFullYear();
    m = shifted.getUTCMonth() + 1;
    d = shifted.getUTCDate();
  }
  return localInstant(y, m, d, p.hh, p.mm, tz) + (startTime % 60_000);
}
