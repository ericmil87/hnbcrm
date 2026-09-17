/**
 * Rótulos, datas e aritmética de agenda da aba "Publicações".
 *
 * O que é regra de negócio vem do MESMO módulo puro que o worker usa
 * (`convex/lib/groupPostSchedule.ts`, `convex/lib/groupPostCore.ts`) — a
 * descrição da agenda, o próximo horário e os tetos não podem divergir entre
 * o que a tela promete e o que o servidor faz.
 */
import {
  describeSchedule,
  localParts,
  nextRunAt,
} from "../../../../convex/lib/groupPostSchedule";
import { buildPostVars } from "../../../../convex/lib/groupPostCore";
import type { GroupPostContent, GroupPostSchedule, GroupPostStatus } from "./types";

export type BadgeVariant = "default" | "brand" | "success" | "error" | "warning" | "info";

export const POST_STATUS_LABELS: Record<GroupPostStatus, string> = {
  draft: "Rascunho",
  active: "Ativa",
  paused: "Pausada",
  ended: "Encerrada",
};

export const POST_STATUS_VARIANT: Record<GroupPostStatus, BadgeVariant> = {
  draft: "default",
  active: "success",
  paused: "warning",
  ended: "default",
};

/** 1 = segunda … 7 = domingo, a mesma numeração do schedule. */
export const WEEKDAYS: { value: number; short: string; long: string }[] = [
  { value: 1, short: "Seg", long: "segunda" },
  { value: 2, short: "Ter", long: "terça" },
  { value: 3, short: "Qua", long: "quarta" },
  { value: 4, short: "Qui", long: "quinta" },
  { value: 5, short: "Sex", long: "sexta" },
  { value: 6, short: "Sáb", long: "sábado" },
  { value: 7, short: "Dom", long: "domingo" },
];

export const DAY_PRESETS: { label: string; days: number[] }[] = [
  { label: "Todos os dias", days: [1, 2, 3, 4, 5, 6, 7] },
  { label: "Dias úteis", days: [1, 2, 3, 4, 5] },
  { label: "Fim de semana", days: [6, 7] },
];

/**
 * Fusos oferecidos no seletor. Lista curta de propósito: `Intl.supportedValuesOf`
 * não existe no `lib` deste projeto e 400 opções num `<select>` de celular não
 * ajudam ninguém. O fuso da org e o do navegador entram sempre (ver `timezoneOptions`).
 */
const COMMON_TIMEZONES = [
  "America/Sao_Paulo",
  "America/Bahia",
  "America/Fortaleza",
  "America/Recife",
  "America/Belem",
  "America/Cuiaba",
  "America/Manaus",
  "America/Porto_Velho",
  "America/Boa_Vista",
  "America/Rio_Branco",
  "America/Noronha",
  "America/Buenos_Aires",
  "America/New_York",
  "Europe/Lisbon",
  "UTC",
];

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";
  } catch {
    return "America/Sao_Paulo";
  }
}

export function timezoneOptions(...extras: (string | undefined | null)[]): string[] {
  const all = [...COMMON_TIMEZONES, browserTimezone(), ...extras.filter((t): t is string => !!t)];
  return Array.from(new Set(all));
}

// ── Datas ──

export function formatDateTime(ts: number | undefined | null, timezone?: string): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  } catch {
    return new Date(ts).toLocaleString("pt-BR");
  }
}

export function formatShortDateTime(ts: number | undefined | null, timezone?: string): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  } catch {
    return new Date(ts).toLocaleString("pt-BR");
  }
}

/** "em 3 h 10 min" / "em 12 min" / "atrasado há 5 min". */
export function untilText(target: number | undefined | null, now: number): string {
  if (!target) return "—";
  const diff = target - now;
  const late = diff < 0;
  const minutes = Math.floor(Math.abs(diff) / 60_000);
  const body =
    minutes < 1
      ? "menos de 1 min"
      : minutes < 60
        ? `${minutes} min`
        : minutes < 24 * 60
          ? (() => {
              const h = Math.floor(minutes / 60);
              const m = minutes % 60;
              return m > 0 ? `${h} h ${m} min` : `${h} h`;
            })()
          : (() => {
              const d = Math.floor(minutes / (60 * 24));
              return `${d} dia${d > 1 ? "s" : ""}`;
            })();
  return late ? `atrasado há ${body}` : `em ${body}`;
}

/** Contagem regressiva curta para o card de aprovação: "1:59:02" / "12:04". */
export function countdown(target: number, now: number): string {
  const diff = Math.max(0, target - now);
  const total = Math.floor(diff / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ── Agenda ──

/** `describeSchedule` do backend, tolerante a rascunho ainda incompleto. */
export function scheduleSummary(schedule: GroupPostSchedule): string {
  if (schedule.days.length === 0 || schedule.times.length === 0) {
    return "Escolha ao menos um dia e um horário";
  }
  try {
    return describeSchedule(schedule);
  } catch {
    return "Agenda inválida";
  }
}

/** Os próximos N disparos da agenda (prévia do wizard e do detalhe). */
export function nextRuns(schedule: GroupPostSchedule, from: number, count: number, seed = ""): number[] {
  const out: number[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    let next: number | null = null;
    try {
      next = nextRunAt(schedule, cursor, { seed });
    } catch {
      next = null;
    }
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** "YYYY-MM-DD" daquele instante NO FUSO da agenda (valor de `<input type="date">`). */
export function dateInputValue(ts: number | undefined, timezone: string): string {
  if (!ts) return "";
  try {
    const p = localParts(ts, timezone);
    return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

/**
 * "YYYY-MM-DD" + hora local do FUSO DA AGENDA → epoch. Mesma conversão de duas
 * passadas do backend (`zonedTimeToUtc`): a correção do offset pode cruzar uma
 * virada de horário de verão, e uma passada só erraria por 1 h nesse dia.
 */
export function dateInputToEpoch(value: string, timezone: string, hh: number, mm: number): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm);
  const offsetAt = (instant: number): number => {
    const p = localParts(instant, timezone);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - instant;
  };
  try {
    let result = naive - offsetAt(naive);
    result = naive - offsetAt(result);
    return result;
  } catch {
    return naive;
  }
}

// ── Conteúdo ──

/** Variáveis de amostra da prévia: as MESMAS que o worker monta no disparo. */
export function previewVars(groupName: string, at: number, timezone: string): Record<string, string> {
  return buildPostVars({ groupName, at, timezone });
}

export function contentSummary(content: GroupPostContent): string {
  if (content.kind === "ai") {
    const ai = content.ai;
    const approval = ai?.requiresApproval === false ? "sem aprovação" : "com aprovação";
    return `Gerada por IA · ${approval}`;
  }
  const items = content.library?.items.length ?? 0;
  const order = content.library?.order === "random" ? "aleatória" : "em sequência";
  return `Biblioteca · ${items} mensagem${items === 1 ? "" : "s"} ${order}`;
}
