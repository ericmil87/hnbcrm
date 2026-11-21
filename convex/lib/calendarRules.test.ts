import { describe, expect, it } from "vitest";
import { DEFAULT_PERMISSIONS, type Permissions } from "./permissions";
import {
  DAY_MS,
  MAX_EVENT_DURATION_MS,
  assertCanTransition,
  canCreateEvent,
  canEditEvent,
  canViewEvent,
  clampLimit,
  dedupeIds,
  nextOccurrenceStart,
  normalizeTitle,
  validateEventTimes,
  validateQueryWindow,
  validateRecurrence,
} from "./calendarRules";

const withTasks = (tasks: Permissions["tasks"]): Permissions => ({ ...DEFAULT_PERMISSIONS.agent, tasks });
const msg = (fn: () => void) => {
  try {
    fn();
  } catch (e: any) {
    return String(e.data ?? e.message);
  }
  return null;
};

describe("validação", () => {
  it("rejeita término antes do início, NaN, negativo e duração acima do teto", () => {
    expect(msg(() => validateEventTimes(2000, 1000))).toMatch(/anterior ao início/);
    expect(msg(() => validateEventTimes(NaN, 1000))).toMatch(/inválido/);
    expect(msg(() => validateEventTimes(-5, 1000))).toMatch(/inválido/);
    expect(msg(() => validateEventTimes(0, Infinity))).toMatch(/inválido/);
    expect(msg(() => validateEventTimes(1000, 1000 + MAX_EVENT_DURATION_MS + 1))).toMatch(/31 dias/);
    expect(msg(() => validateEventTimes(1000, 1000))).toBeNull();
    expect(msg(() => validateEventTimes(1000, 1000 + MAX_EVENT_DURATION_MS))).toBeNull();
  });

  it("título aparado e não vazio", () => {
    expect(normalizeTitle("  Reunião  ")).toBe("Reunião");
    expect(msg(() => normalizeTitle("   "))).toMatch(/título/i);
    expect(msg(() => normalizeTitle("x".repeat(201)))).toMatch(/muito longo/);
  });

  it("recorrência com fim antes do início é recusada", () => {
    expect(msg(() => validateRecurrence({ pattern: "daily", endDate: 5 }, 10))).toMatch(/recorrência/);
    expect(msg(() => validateRecurrence({ pattern: "daily", endDate: 50 }, 10))).toBeNull();
  });

  it("janela de consulta e limites", () => {
    expect(msg(() => validateQueryWindow(2, 1))).toMatch(/final/);
    expect(msg(() => validateQueryWindow(0, 401 * DAY_MS))).toMatch(/400 dias/);
    expect(msg(() => validateQueryWindow(NaN, 1))).toMatch(/inválido/);
    expect(clampLimit(undefined, 200, 500)).toBe(200);
    expect(clampLimit(9999, 200, 500)).toBe(500);
    expect(clampLimit(-3, 200, 500)).toBe(1);
    expect(clampLimit(NaN, 200, 500)).toBe(200);
  });

  it("participantes: deduplica e limita", () => {
    expect(dedupeIds(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(msg(() => dedupeIds(Array.from({ length: 51 }, (_, i) => String(i))))).toMatch(/demais/);
  });
});

describe("transições de status", () => {
  it("só agendado conclui, cancela e reagenda", () => {
    expect(msg(() => assertCanTransition("scheduled", "complete"))).toBeNull();
    expect(msg(() => assertCanTransition("scheduled", "cancel"))).toBeNull();
    expect(msg(() => assertCanTransition("scheduled", "reschedule"))).toBeNull();
    expect(msg(() => assertCanTransition("completed", "complete"))).toMatch(/já está concluído/);
    expect(msg(() => assertCanTransition("cancelled", "cancel"))).toMatch(/já está cancelado/);
    expect(msg(() => assertCanTransition("cancelled", "complete"))).toMatch(/não pode ser concluído/);
    expect(msg(() => assertCanTransition("completed", "cancel"))).toMatch(/não pode ser cancelado/);
    expect(msg(() => assertCanTransition("completed", "reschedule"))).toMatch(/reagendado/);
  });
});

describe("permissões da agenda (categoria tasks)", () => {
  const ev = { createdBy: "m1", assignedTo: "m2", attendees: ["m3"] };
  it("view_own vê só os seus (criador, responsável, participante); view_all vê todos", () => {
    const own = withTasks("view_own");
    expect(canViewEvent(own, "m1", ev)).toBe(true);
    expect(canViewEvent(own, "m2", ev)).toBe(true);
    expect(canViewEvent(own, "m3", ev)).toBe(true);
    expect(canViewEvent(own, "m9", ev)).toBe(false);
    expect(canViewEvent(withTasks("view_all"), "m9", ev)).toBe(true);
    expect(canViewEvent(withTasks("none"), "m1", ev)).toBe(false);
  });
  it("criar exige edit_own; editar de outro exige edit_all", () => {
    expect(canCreateEvent(withTasks("view_all"))).toBe(false);
    expect(canCreateEvent(withTasks("edit_own"))).toBe(true);
    expect(canEditEvent(withTasks("edit_own"), "m1", ev)).toBe(true);
    expect(canEditEvent(withTasks("edit_own"), "m2", ev)).toBe(true);
    expect(canEditEvent(withTasks("edit_own"), "m3", ev)).toBe(false); // participante não edita
    expect(canEditEvent(withTasks("edit_own"), "m9", ev)).toBe(false);
    expect(canEditEvent(withTasks("edit_all"), "m9", ev)).toBe(true);
    expect(canEditEvent(withTasks("view_all"), "m1", ev)).toBe(false);
  });
  it("papéis padrão: admin/manager editam todos; agent/ai só os seus", () => {
    expect(canEditEvent(DEFAULT_PERMISSIONS.admin, "x", ev)).toBe(true);
    expect(canEditEvent(DEFAULT_PERMISSIONS.manager, "x", ev)).toBe(true);
    expect(canEditEvent(DEFAULT_PERMISSIONS.agent, "x", ev)).toBe(false);
    expect(canEditEvent(DEFAULT_PERMISSIONS.ai, "m1", ev)).toBe(true);
    expect(canViewEvent(DEFAULT_PERMISSIONS.agent, "x", ev)).toBe(true);
  });
});

describe("recorrência no fuso da org", () => {
  const SP = "America/Sao_Paulo";
  const at = (iso: string) => Date.parse(iso);
  it("diário/semanal/quinzenal mantêm a hora local", () => {
    const start = at("2026-03-02T14:00:00-03:00");
    expect(nextOccurrenceStart(start, "daily", SP)).toBe(at("2026-03-03T14:00:00-03:00"));
    expect(nextOccurrenceStart(start, "weekly", SP)).toBe(at("2026-03-09T14:00:00-03:00"));
    expect(nextOccurrenceStart(start, "biweekly", SP)).toBe(at("2026-03-16T14:00:00-03:00"));
  });
  it("mensal em dia 29–31 fixa no último dia do mês curto", () => {
    expect(nextOccurrenceStart(at("2026-01-31T10:00:00-03:00"), "monthly", SP)).toBe(at("2026-02-28T10:00:00-03:00"));
    expect(nextOccurrenceStart(at("2028-01-31T10:00:00-03:00"), "monthly", SP)).toBe(at("2028-02-29T10:00:00-03:00"));
    expect(nextOccurrenceStart(at("2026-03-31T10:00:00-03:00"), "monthly", SP)).toBe(at("2026-04-30T10:00:00-03:00"));
    expect(nextOccurrenceStart(at("2026-12-15T10:00:00-03:00"), "monthly", SP)).toBe(at("2027-01-15T10:00:00-03:00"));
  });
  it("usa o fuso da org: 22h em São Paulo é dia seguinte em UTC, mas a recorrência segue a parede local", () => {
    const start = at("2026-03-02T22:30:00-03:00"); // 01:30Z do dia 3
    expect(nextOccurrenceStart(start, "daily", SP)).toBe(at("2026-03-03T22:30:00-03:00"));
  });
  it("atravessa horário de verão sem deslocar a hora de parede", () => {
    const NY = "America/New_York";
    // 7/mar/2026 (EST, -05:00) → 14/mar (EST) → semana seguinte cruza o DST em 8/mar
    const start = at("2026-03-07T09:00:00-05:00");
    expect(nextOccurrenceStart(start, "weekly", NY)).toBe(at("2026-03-14T09:00:00-04:00"));
  });
  it("fuso inválido cai no default sem lançar", () => {
    const start = at("2026-03-02T14:00:00-03:00");
    expect(nextOccurrenceStart(start, "daily", "Nao/Existe")).toBe(at("2026-03-03T14:00:00-03:00"));
  });
});
