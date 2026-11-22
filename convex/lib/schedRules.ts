/**
 * Agenda v2 — regras nomeadas de marcação (puro; §2.5 do plano).
 *
 * `evaluateRules` devolve TODAS as violações com a severidade resolvida pela
 * CLASSE da origem (`staff`/`ai`/`public`). Não decide se a marcação passa:
 * quem decide é `applyForce` — `warn` só passa com aceite explícito em `force`,
 * e só `staff` pode forçar; `block` nunca passa.
 *
 * Mensagens em PT-BR sem dado de terceiros: IA e link público só sabem
 * "indisponível". Nome de recurso e `detail` só saem para `staff`.
 *
 * Decisões onde o plano não fixa:
 *  - `import` conta como classe `staff` (carga feita pela equipe);
 *  - ação `cancel` só avalia `CLIENT_CANNOT_CANCEL`; `reschedule` avalia as
 *    regras de horário do NOVO horário mais as de política da remarcação;
 *  - `fit_in` (em `applyForce`) quando se força regra de horário, folga ou
 *    grade: `OUTSIDE_HOURS`, `RESOURCE_CLOSED`, `RESOURCE_BLOCKED`,
 *    `INTERNAL_EVENT_OVERLAP`, `BUFFER_OVERLAP`, `OFF_GRID`;
 *  - "janela máxima" usa `now + dias * 24 h` em ms.
 */

import {
  assertUnits,
  type Interval,
  MAX_BLOCK_MIN,
  overlaps,
  peakUnits,
  type ResourceDay,
  type SchedId,
} from "./schedAvailability";
import { minutesOfDay } from "./schedTime";

export type SchedOrigin = "staff" | "ai" | "public" | "api" | "human_message" | "waitlist" | "import";
export type OriginClass = "staff" | "ai" | "public";

export function originClass(origin: SchedOrigin): OriginClass {
  switch (origin) {
    case "staff":
    case "api":
    case "human_message":
    case "import":
      return "staff";
    case "ai":
    case "waitlist":
      return "ai";
    case "public":
      return "public";
  }
}

export const RULE_CODES = [
  "CAPACITY_EXCEEDED",
  "DURATION_TOO_LONG",
  "WRONG_ORG_OR_INACTIVE",
  "RESOURCE_CLOSED",
  "OUTSIDE_HOURS",
  "RESOURCE_BLOCKED",
  "BUFFER_OVERLAP",
  "INTERNAL_EVENT_OVERLAP",
  "CLIENT_OVERLAP",
  "MAX_ACTIVE_PER_CONTACT",
  "MIN_NOTICE",
  "MAX_ADVANCE",
  "OFF_GRID",
  "PAST_START",
  "SERVICE_NOT_AI_BOOKABLE",
  "CLIENT_CANNOT_CANCEL",
  "CLIENT_CANNOT_RESCHEDULE",
  "RESCHEDULE_NOTICE",
  "AI_DAILY_LIMIT",
] as const;
export type RuleCode = (typeof RULE_CODES)[number];
export type Severity = "block" | "warn";
export type Violation = { code: RuleCode; severity: Severity; message: string; detail?: Record<string, unknown> };

/** Matriz código × classe de origem (§2.5). `na` = a regra não se aplica e nunca é emitida. */
export const RULE_MATRIX: Record<RuleCode, Record<OriginClass, Severity | "na">> = {
  CAPACITY_EXCEEDED: { staff: "block", ai: "block", public: "block" },
  DURATION_TOO_LONG: { staff: "block", ai: "block", public: "block" },
  WRONG_ORG_OR_INACTIVE: { staff: "block", ai: "block", public: "block" },
  RESOURCE_CLOSED: { staff: "warn", ai: "block", public: "block" },
  OUTSIDE_HOURS: { staff: "warn", ai: "block", public: "block" },
  RESOURCE_BLOCKED: { staff: "warn", ai: "block", public: "block" },
  BUFFER_OVERLAP: { staff: "warn", ai: "block", public: "block" },
  INTERNAL_EVENT_OVERLAP: { staff: "warn", ai: "block", public: "block" },
  CLIENT_OVERLAP: { staff: "warn", ai: "block", public: "block" },
  MAX_ACTIVE_PER_CONTACT: { staff: "warn", ai: "block", public: "block" },
  MIN_NOTICE: { staff: "na", ai: "block", public: "block" },
  MAX_ADVANCE: { staff: "warn", ai: "block", public: "block" },
  OFF_GRID: { staff: "na", ai: "block", public: "block" },
  PAST_START: { staff: "warn", ai: "block", public: "block" },
  SERVICE_NOT_AI_BOOKABLE: { staff: "na", ai: "block", public: "na" },
  CLIENT_CANNOT_CANCEL: { staff: "na", ai: "block", public: "block" },
  CLIENT_CANNOT_RESCHEDULE: { staff: "na", ai: "block", public: "block" },
  RESCHEDULE_NOTICE: { staff: "na", ai: "block", public: "block" },
  AI_DAILY_LIMIT: { staff: "na", ai: "block", public: "na" },
};

/** Códigos cujo aceite forçado transforma o agendamento em `fit_in` (horário, folga ou grade). */
export const FIT_IN_CODES: readonly RuleCode[] = [
  "OUTSIDE_HOURS",
  "RESOURCE_CLOSED",
  "RESOURCE_BLOCKED",
  "INTERNAL_EVENT_OVERLAP",
  "BUFFER_OVERLAP",
  "OFF_GRID",
];

const UNAVAILABLE = "Esse horário não está disponível.";
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

export type RulePlanEntry = {
  resourceId: SchedId;
  role: string;
  units: number;
  /** Dia do recurso (de `computeDayAvailability`); alocações JÁ sem o agendamento ignorado. */
  day: ResourceDay;
};

export type RuleInput = {
  origin: SchedOrigin;
  action?: "book" | "cancel" | "reschedule"; // default "book"
  now: number;
  tz: string;
  startTime: number;
  endTime: number;
  blockStart: number;
  blockEnd: number;
  plan: RulePlanEntry[];
  service: {
    aiBookable?: boolean;
    slotIntervalMin?: number;
    minNoticeMin?: number;
    maxAdvanceDays?: number;
    maxActivePerContact?: number;
    clientCanCancel?: boolean;
    clientCanReschedule?: boolean;
    minRescheduleNoticeMin?: number;
  };
  settings: {
    gridMinutes: number;
    minNoticeMin: number;
    maxAdvanceDays: number;
    maxAiBookingsPerContactPerDay: number;
  };
  /** Problemas de integridade achados pela porta: serviço/recurso/contato de outra org, inativo, ou recurso que não atende o requisito. */
  entityProblems?: Array<"service" | "resource" | "contact" | "requirement">;
  /** Outros agendamentos ATIVOS do mesmo contato (sem o ignorado) — para `CLIENT_OVERLAP`. */
  contactAppointments?: Interval[];
  /** Quantos agendamentos futuros ativos o contato já tem DESTE serviço (sem o duplicado exato nem o ignorado). */
  contactActiveSameService?: number;
  /** Quantas marcações de IA o contato recebeu hoje — para `AI_DAILY_LIMIT`. */
  aiBookingsTodayForContact?: number;
  /** Início do agendamento existente em cancelar/remarcar — para `RESCHEDULE_NOTICE`. */
  existingStartTime?: number;
};

export function evaluateRules(input: RuleInput): Violation[] {
  const cls = originClass(input.origin);
  const action = input.action ?? "book";
  const out: Violation[] = [];
  const emit = (code: RuleCode, message: string, detail?: Record<string, unknown>) => {
    const sev = RULE_MATRIX[code][cls];
    if (sev === "na") return;
    const v: Violation = { code, severity: sev, message: cls === "staff" ? message : UNAVAILABLE };
    if (cls === "staff" && detail) v.detail = detail;
    out.push(v);
  };
  const svc = input.service;
  const set = input.settings;

  if (action === "cancel") {
    if (svc.clientCanCancel === false) {
      emit("CLIENT_CANNOT_CANCEL", "Este serviço não permite cancelamento pelo cliente.");
    }
    return out;
  }

  // --- integridade e limites duros
  for (const problem of [...new Set(input.entityProblems ?? [])]) {
    const label = { service: "serviço", resource: "recurso", contact: "contato", requirement: "recurso" }[problem];
    emit(
      "WRONG_ORG_OR_INACTIVE",
      problem === "requirement"
        ? "O recurso escolhido não atende ao que o serviço exige."
        : `O ${label} está inativo ou não pertence a esta organização.`,
      { entity: problem }
    );
  }
  const maxBlockMs = MAX_BLOCK_MIN * MINUTE_MS;
  if (input.blockEnd - input.blockStart > maxBlockMs) {
    emit("DURATION_TOO_LONG", "A duração do serviço com as folgas passa do limite permitido.");
  }

  // --- por recurso do plano
  // O mesmo recurso em dois papéis do plano é recusado (bloqueio duro, não forçável) e
  // as unidades são SOMADAS por recurso antes do teste de pico.
  const seenResources = new Set<SchedId>();
  const unitsByResource = new Map<SchedId, number>();
  for (const entry of input.plan) {
    assertUnits(entry.units);
    if (seenResources.has(entry.resourceId)) {
      emit("WRONG_ORG_OR_INACTIVE", "O mesmo recurso foi usado em mais de um papel do agendamento.", {
        entity: "duplicate_resource",
        resourceId: entry.resourceId,
      });
    }
    seenResources.add(entry.resourceId);
    unitsByResource.set(entry.resourceId, (unitsByResource.get(entry.resourceId) ?? 0) + entry.units);
  }
  const checked = new Set<SchedId>();
  for (const entry of input.plan) {
    if (checked.has(entry.resourceId)) continue;
    checked.add(entry.resourceId);
    const units = unitsByResource.get(entry.resourceId)!;
    const { day } = entry;
    const name = day.resource.name;
    const cap = day.resource.capacity;
    const corePeak = peakUnits(day.allocations, input.startTime, input.endTime, "core");
    const coreExceeded = corePeak + units > cap;
    if (coreExceeded) {
      emit("CAPACITY_EXCEEDED", `${name} já está com a capacidade cheia nesse horário.`, {
        resourceId: entry.resourceId,
        peak: corePeak,
        units,
        capacity: cap,
      });
    } else {
      const blockPeak = peakUnits(day.allocations, input.blockStart, input.blockEnd, "block");
      if (blockPeak + units > cap) {
        emit("BUFFER_OVERLAP", `A folga do atendimento encosta em outro atendimento de ${name}.`, {
          resourceId: entry.resourceId,
        });
      }
    }
    if (day.closed) {
      emit("RESOURCE_CLOSED", `${name} está fechado nesse dia.`, { resourceId: entry.resourceId });
    } else if (!day.open.some((o) => o.start <= input.startTime && o.end >= input.endTime)) {
      emit("OUTSIDE_HOURS", `Esse horário está fora do expediente de ${name}.`, { resourceId: entry.resourceId });
    }
    if (day.blocks.some((b) => b.source === "block" && overlaps(b.start, b.end, input.startTime, input.endTime))) {
      emit("RESOURCE_BLOCKED", `${name} está bloqueado nesse horário.`, { resourceId: entry.resourceId });
    }
    if (
      day.blocks.some((b) => b.source === "internal_event" && overlaps(b.start, b.end, input.startTime, input.endTime))
    ) {
      emit("INTERNAL_EVENT_OVERLAP", `${name} tem um compromisso interno nesse horário.`, {
        resourceId: entry.resourceId,
      });
    }
  }

  // --- contato
  if (
    (input.contactAppointments ?? []).some((a) => overlaps(a.start, a.end, input.startTime, input.endTime))
  ) {
    emit("CLIENT_OVERLAP", "O cliente já tem outro agendamento nesse horário.");
  }
  const activeLimit = svc.maxActivePerContact ?? (cls === "staff" ? undefined : 1);
  if (activeLimit !== undefined && (input.contactActiveSameService ?? 0) >= activeLimit) {
    emit("MAX_ACTIVE_PER_CONTACT", `O cliente já tem ${activeLimit} agendamento(s) futuro(s) deste serviço.`, {
      limit: activeLimit,
    });
  }

  // --- tempo
  const minNoticeMin = svc.minNoticeMin ?? set.minNoticeMin;
  if (input.startTime < input.now + minNoticeMin * MINUTE_MS) {
    emit("MIN_NOTICE", `Falta menos que a antecedência mínima de ${minNoticeMin} min.`, { minNoticeMin });
  }
  const maxAdvanceDays = svc.maxAdvanceDays ?? set.maxAdvanceDays;
  if (input.startTime > input.now + maxAdvanceDays * DAY_MS) {
    emit("MAX_ADVANCE", `O horário passa da janela máxima de ${maxAdvanceDays} dias.`, { maxAdvanceDays });
  }
  const step = svc.slotIntervalMin ?? set.gridMinutes;
  if (step > 0 && minutesOfDay(input.startTime, input.tz) % step !== 0) {
    emit("OFF_GRID", `O horário não está na grade de ${step} min.`, { step });
  }
  if (input.startTime < input.now) emit("PAST_START", "O horário já passou.");

  // --- serviço e IA
  if (svc.aiBookable === false) emit("SERVICE_NOT_AI_BOOKABLE", "Este serviço não pode ser marcado pela IA.");
  if (
    cls === "ai" &&
    (input.aiBookingsTodayForContact ?? 0) >= set.maxAiBookingsPerContactPerDay
  ) {
    emit("AI_DAILY_LIMIT", "A IA já atingiu o limite de marcações do dia para este cliente.", {
      limit: set.maxAiBookingsPerContactPerDay,
    });
  }

  // --- política de remarcação
  if (action === "reschedule") {
    if (svc.clientCanReschedule === false) {
      emit("CLIENT_CANNOT_RESCHEDULE", "Este serviço não permite remarcação pelo cliente.");
    }
    const noticeMin = svc.minRescheduleNoticeMin ?? 0;
    if (
      noticeMin > 0 &&
      input.existingStartTime !== undefined &&
      input.existingStartTime - input.now < noticeMin * MINUTE_MS
    ) {
      emit("RESCHEDULE_NOTICE", `A remarcação exige ${noticeMin} min de antecedência.`, { noticeMin });
    }
  }
  return out;
}

export type ForceResolution = {
  /** Violações que impedem a marcação (block, ou warn sem aceite válido). */
  blocking: Violation[];
  /** Códigos warn aceitos — vão para `forcedRules` e `auditLogs.metadata.forcedRules`. */
  forced: RuleCode[];
  /** Códigos pedidos em `force` que não valeram (origem não `staff`, `block`, ou sem violação). */
  ignoredForce: string[];
  /** `fit_in` quando algum código forçado é de horário, folga ou grade. */
  kind: "normal" | "fit_in";
};

/**
 * `warn` só passa se o código vier em `force`, e só `staff` pode forçar; `block` nunca passa. `force` aceita o CÓDIGO
 * (`RESOURCE_CLOSED`: vale para qualquer recurso, compatível com a tela) ou o PAR `CÓDIGO:resourceId`
 * (`RESOURCE_CLOSED:<id>`: só aquele recurso; o Copiloto guarda pares para não aceitar aviso novo de outro recurso).
 */
export function applyForce(violations: Violation[], force: string[] | undefined, origin: SchedOrigin): ForceResolution {
  const canForce = originClass(origin) === "staff";
  const requested = new Set(force ?? []);
  const used = new Set<string>();
  const blocking: Violation[] = [];
  const forced: RuleCode[] = [];
  for (const v of violations) {
    const rid = typeof v.detail?.resourceId === "string" ? v.detail.resourceId : undefined;
    const pair = rid !== undefined ? `${v.code}:${rid}` : undefined;
    const token = v.severity === "warn" && canForce ? (requested.has(v.code) ? v.code : pair !== undefined && requested.has(pair) ? pair : undefined) : undefined;
    if (token !== undefined) {
      used.add(token);
      if (!forced.includes(v.code)) forced.push(v.code);
    } else {
      blocking.push(v);
    }
  }
  const ignoredForce = [...requested].filter((c) => !used.has(c));
  const kind = forced.some((c) => FIT_IN_CODES.includes(c)) ? "fit_in" : "normal";
  return { blocking, forced, ignoredForce, kind };
}
