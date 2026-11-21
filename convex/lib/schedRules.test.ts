import { describe, expect, it } from "vitest";
import { type AllocationLite, computeDayAvailability, type ExceptionLite, type ResourceLite } from "./schedAvailability";
import {
  applyForce,
  evaluateRules,
  FIT_IN_CODES,
  originClass,
  RULE_CODES,
  RULE_MATRIX,
  type OriginClass,
  type RuleCode,
  type RuleInput,
  type SchedOrigin,
  type Violation,
} from "./schedRules";
import { atLocalMinutes } from "./schedTime";

const tz = "America/Sao_Paulo";
const MIN = 60_000;
const MON = "2026-11-23";
const at = (hhmm: string, date = MON) => {
  const [h, m] = hhmm.split(":").map(Number);
  return atLocalMinutes(date, h * 60 + m, tz);
};
const NOW = at("08:00");

const room: ResourceLite = {
  _id: "r1", kind: "room", name: "Sala 1", capacity: 1,
  weekly: [{ weekday: 1, startMin: 480, endMin: 1080 }], sortOrder: 0, active: true,
};
const person: ResourceLite = { ...room, _id: "p1", kind: "person", name: "Ana", teamMemberId: "tm1" };

function dayOf(
  resource: ResourceLite,
  extra: { exceptions?: ExceptionLite[]; allocations?: AllocationLite[]; internalEvents?: Array<{ teamMemberId: string; start: number; end: number }> } = {}
) {
  return computeDayAvailability({
    date: MON, tz, resources: [resource], exceptions: extra.exceptions ?? [],
    allocations: extra.allocations ?? [], internalEvents: extra.internalEvents ?? [],
  }).get(resource._id)!;
}
const alloc = (s: string, e: string, over: Partial<AllocationLite> = {}): AllocationLite => ({
  appointmentId: "other", resourceId: "r1", blockStart: at(s), blockEnd: at(e), coreStart: at(s), coreEnd: at(e), units: 1, ...over,
});

function baseInput(origin: SchedOrigin, over: Partial<RuleInput> = {}): RuleInput {
  return {
    origin, now: NOW, tz,
    startTime: at("12:00"), endTime: at("13:00"), blockStart: at("12:00"), blockEnd: at("13:00"),
    plan: [{ resourceId: "r1", role: "Sala", units: 1, day: dayOf(room) }],
    service: {},
    settings: { gridMinutes: 30, minNoticeMin: 120, maxAdvanceDays: 60, maxAiBookingsPerContactPerDay: 2 },
    ...over,
  };
}
const codes = (v: Violation[]) => v.map((x) => x.code);

describe("originClass", () => {
  it("staff = staff/api/human_message/import; ai = ai/waitlist; public = public", () => {
    const table: Record<SchedOrigin, OriginClass> = {
      staff: "staff", api: "staff", human_message: "staff", import: "staff", ai: "ai", waitlist: "ai", public: "public",
    };
    for (const [o, c] of Object.entries(table)) expect(originClass(o as SchedOrigin)).toBe(c);
  });
});

describe("a base não viola nada", () => {
  it.each(["staff", "ai", "public"] as const)("origem %s", (o) => {
    expect(evaluateRules(baseInput(o))).toEqual([]);
  });
});

// Tabela do §2.5 copiada à mão: um erro de edição em RULE_MATRIX quebra aqui.
const EXPECTED: Record<RuleCode, [string, string, string]> = {
  CAPACITY_EXCEEDED: ["block", "block", "block"],
  DURATION_TOO_LONG: ["block", "block", "block"],
  WRONG_ORG_OR_INACTIVE: ["block", "block", "block"],
  RESOURCE_CLOSED: ["warn", "block", "block"],
  OUTSIDE_HOURS: ["warn", "block", "block"],
  RESOURCE_BLOCKED: ["warn", "block", "block"],
  BUFFER_OVERLAP: ["warn", "block", "block"],
  INTERNAL_EVENT_OVERLAP: ["warn", "block", "block"],
  CLIENT_OVERLAP: ["warn", "block", "block"],
  MAX_ACTIVE_PER_CONTACT: ["warn", "block", "block"],
  MIN_NOTICE: ["na", "block", "block"],
  MAX_ADVANCE: ["warn", "block", "block"],
  OFF_GRID: ["na", "block", "block"],
  PAST_START: ["warn", "block", "block"],
  SERVICE_NOT_AI_BOOKABLE: ["na", "block", "na"],
  CLIENT_CANNOT_CANCEL: ["na", "block", "block"],
  CLIENT_CANNOT_RESCHEDULE: ["na", "block", "block"],
  RESCHEDULE_NOTICE: ["na", "block", "block"],
  AI_DAILY_LIMIT: ["na", "block", "na"],
};

/** Monta a entrada que dispara `code` para a origem dada. */
const TRIGGERS: Record<RuleCode, (o: SchedOrigin) => RuleInput> = {
  CAPACITY_EXCEEDED: (o) => baseInput(o, { plan: [{ resourceId: "r1", role: "Sala", units: 1, day: dayOf(room, { allocations: [alloc("12:30", "13:30")] }) }] }),
  DURATION_TOO_LONG: (o) => baseInput(o, { blockEnd: at("12:00") + 481 * MIN }),
  WRONG_ORG_OR_INACTIVE: (o) => baseInput(o, { entityProblems: ["service"] }),
  RESOURCE_CLOSED: (o) => baseInput(o, { plan: [{ resourceId: "r1", role: "Sala", units: 1, day: dayOf(room, { exceptions: [{ localDate: MON, mode: "closed", resourceId: "r1" }] }) }] }),
  OUTSIDE_HOURS: (o) => baseInput(o, { startTime: at("19:00"), endTime: at("20:00"), blockStart: at("19:00"), blockEnd: at("20:00") }),
  RESOURCE_BLOCKED: (o) => baseInput(o, { plan: [{ resourceId: "r1", role: "Sala", units: 1, day: dayOf(room, { exceptions: [{ localDate: MON, mode: "block", resourceId: "r1", intervals: [{ startMin: 750, endMin: 780 }] }] }) }] }),
  BUFFER_OVERLAP: (o) =>
    baseInput(o, {
      startTime: at("11:50"), endTime: at("12:50"), blockStart: at("11:40"), blockEnd: at("13:00"),
      plan: [{ resourceId: "r1", role: "Sala", units: 1, day: dayOf(room, { allocations: [alloc("11:00", "12:00", { coreStart: at("11:10"), coreEnd: at("11:50") })] }) }],
    }),
  INTERNAL_EVENT_OVERLAP: (o) => baseInput(o, { plan: [{ resourceId: "p1", role: "Terapeuta", units: 1, day: dayOf(person, { internalEvents: [{ teamMemberId: "tm1", start: at("12:30"), end: at("13:30") }] }) }] }),
  CLIENT_OVERLAP: (o) => baseInput(o, { contactAppointments: [{ start: at("12:30"), end: at("13:30") }] }),
  MAX_ACTIVE_PER_CONTACT: (o) => baseInput(o, { service: { maxActivePerContact: 1 }, contactActiveSameService: 1 }),
  MIN_NOTICE: (o) => baseInput(o, { startTime: NOW + 30 * MIN }),
  MAX_ADVANCE: (o) => baseInput(o, { startTime: NOW + 61 * 24 * 60 * MIN }),
  OFF_GRID: (o) => baseInput(o, { startTime: at("12:10") }),
  PAST_START: (o) => baseInput(o, { startTime: NOW - 60 * MIN }),
  SERVICE_NOT_AI_BOOKABLE: (o) => baseInput(o, { service: { aiBookable: false } }),
  CLIENT_CANNOT_CANCEL: (o) => baseInput(o, { action: "cancel", service: { clientCanCancel: false } }),
  CLIENT_CANNOT_RESCHEDULE: (o) => baseInput(o, { action: "reschedule", service: { clientCanReschedule: false } }),
  RESCHEDULE_NOTICE: (o) => baseInput(o, { action: "reschedule", service: { minRescheduleNoticeMin: 240 }, existingStartTime: NOW + 60 * MIN }),
  AI_DAILY_LIMIT: (o) => baseInput(o, { aiBookingsTodayForContact: 2 }),
};

describe("matriz código × origem (§2.5)", () => {
  it("RULE_MATRIX é exatamente a tabela do plano", () => {
    expect([...RULE_CODES].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const code of RULE_CODES) {
      expect([RULE_MATRIX[code].staff, RULE_MATRIX[code].ai, RULE_MATRIX[code].public]).toEqual(EXPECTED[code]);
    }
  });
  const origins: Array<[OriginClass, SchedOrigin[]]> = [
    ["staff", ["staff", "api", "human_message", "import"]],
    ["ai", ["ai", "waitlist"]],
    ["public", ["public"]],
  ];
  for (const code of RULE_CODES) {
    for (const [cls, list] of origins) {
      for (const origin of list) {
        const idx = cls === "staff" ? 0 : cls === "ai" ? 1 : 2;
        const expected = EXPECTED[code][idx];
        it(`${code} × ${origin} (${cls}) = ${expected}`, () => {
          const hits = evaluateRules(TRIGGERS[code](origin)).filter((v) => v.code === code);
          if (expected === "na") expect(hits).toEqual([]);
          else {
            expect(hits).toHaveLength(1);
            expect(hits[0].severity).toBe(expected);
          }
        });
      }
    }
  }
  it("cada gatilho da base realmente dispara só o que se espera para staff (sem ruído colateral relevante)", () => {
    expect(codes(evaluateRules(TRIGGERS.CAPACITY_EXCEEDED("staff")))).toEqual(["CAPACITY_EXCEEDED"]);
    expect(codes(evaluateRules(TRIGGERS.RESOURCE_CLOSED("staff")))).toEqual(["RESOURCE_CLOSED"]);
    expect(codes(evaluateRules(TRIGGERS.BUFFER_OVERLAP("staff")))).toEqual(["BUFFER_OVERLAP"]);
  });
});

describe("detalhes das regras", () => {
  it("capacidade é por PICO e usa o núcleo: sala dupla aceita 2 e recusa o 3º; encostar não conflita", () => {
    const dupla = { ...room, capacity: 2 };
    const two = [alloc("12:00", "13:00"), alloc("12:00", "13:00", { appointmentId: "o2" })];
    const one = two.slice(0, 1);
    const mk = (allocs: AllocationLite[], over: Partial<RuleInput> = {}) =>
      baseInput("staff", { plan: [{ resourceId: "r1", role: "Sala", units: 1, day: dayOf(dupla, { allocations: allocs }) }], ...over });
    expect(codes(evaluateRules(mk(one)))).toEqual([]);
    expect(codes(evaluateRules(mk(two)))).toEqual(["CAPACITY_EXCEEDED"]);
    // dois de 30 min em sequência dentro dos 60 min: pico 1, cabe na sala simples
    const seq = [alloc("12:00", "12:30"), alloc("12:30", "13:00", { appointmentId: "o2" })];
    expect(codes(evaluateRules(baseInput("staff", { plan: [{ resourceId: "r1", role: "Sala", units: 1, day: dayOf(room, { allocations: seq }) }] })))).toEqual(["CAPACITY_EXCEEDED"]);
    expect(codes(evaluateRules(baseInput("staff", { plan: [{ resourceId: "r1", role: "Sala", units: 1, day: dayOf(dupla, { allocations: seq }) }] })))).toEqual([]);
    // encostar (outro termina às 12:00) não conflita
    expect(codes(evaluateRules(baseInput("staff", { plan: [{ resourceId: "r1", role: "Sala", units: 1, day: dayOf(room, { allocations: [alloc("11:00", "12:00")] }) }] })))).toEqual([]);
    // units pesam
    expect(codes(evaluateRules(baseInput("staff", { plan: [{ resourceId: "r1", role: "Sala", units: 2, day: dayOf(dupla, { allocations: one }) }] })))).toEqual(["CAPACITY_EXCEEDED"]);
  });
  it("RESOURCE_CLOSED não duplica com OUTSIDE_HOURS; fora do expediente sem fechar só OUTSIDE_HOURS", () => {
    expect(codes(evaluateRules(TRIGGERS.RESOURCE_CLOSED("ai")))).toEqual(["RESOURCE_CLOSED"]);
    expect(codes(evaluateRules(TRIGGERS.OUTSIDE_HOURS("ai")))).toEqual(["OUTSIDE_HOURS"]);
  });
  it("mensagens: IA e link só dizem 'indisponível' e sem detail; equipe vê o recurso e o detail", () => {
    for (const o of ["ai", "public"] as const) {
      const v = evaluateRules(TRIGGERS.CAPACITY_EXCEEDED(o))[0];
      expect(v.message).toBe("Esse horário não está disponível.");
      expect(v.detail).toBeUndefined();
    }
    const staff = evaluateRules(TRIGGERS.CAPACITY_EXCEEDED("staff"))[0];
    expect(staff.message).toContain("Sala 1");
    expect(staff.detail).toMatchObject({ resourceId: "r1", capacity: 1 });
  });
  it("MAX_ACTIVE_PER_CONTACT: equipe sem teto no serviço não é avisada; IA e link assumem 1", () => {
    const noCap = (o: SchedOrigin) => baseInput(o, { contactActiveSameService: 3 });
    expect(codes(evaluateRules(noCap("staff")))).toEqual([]);
    expect(codes(evaluateRules(noCap("ai")))).toEqual(["MAX_ACTIVE_PER_CONTACT"]);
    expect(codes(evaluateRules(noCap("public")))).toEqual(["MAX_ACTIVE_PER_CONTACT"]);
    expect(codes(evaluateRules(baseInput("ai", { service: { maxActivePerContact: 2 }, contactActiveSameService: 1 })))).toEqual([]);
  });
  it("antecedência e janela: o serviço sobrepõe a org; limites exatos passam", () => {
    const edge = baseInput("public", { startTime: NOW + 120 * MIN, endTime: NOW + 180 * MIN, blockStart: NOW + 120 * MIN, blockEnd: NOW + 180 * MIN, plan: [] });
    expect(codes(evaluateRules(edge))).toEqual([]);
    expect(codes(evaluateRules({ ...edge, service: { minNoticeMin: 180 } }))).toEqual(["MIN_NOTICE"]);
    const far = baseInput("public", { startTime: NOW + 60 * 24 * 60 * MIN, plan: [] });
    expect(codes(evaluateRules(far))).not.toContain("MAX_ADVANCE");
    expect(codes(evaluateRules({ ...far, service: { maxAdvanceDays: 30 } }))).toContain("MAX_ADVANCE");
  });
  it("OFF_GRID usa minutos de hora local e o passo do serviço", () => {
    const base = baseInput("ai", { startTime: at("12:15"), plan: [] });
    expect(codes(evaluateRules(base))).toContain("OFF_GRID");
    expect(codes(evaluateRules({ ...base, service: { slotIntervalMin: 15 } }))).not.toContain("OFF_GRID");
    // Kolkata (+05:30): 12:00 local = 06:30Z; passo 30 passa, e o minuto UTC (30) não engana
    const kol = baseInput("ai", { tz: "Asia/Kolkata", startTime: atLocalMinutes(MON, 720, "Asia/Kolkata"), plan: [] });
    expect(codes(evaluateRules(kol))).not.toContain("OFF_GRID");
    expect(codes(evaluateRules({ ...kol, settings: { ...kol.settings, gridMinutes: 60 } }))).not.toContain("OFF_GRID");
  });
  it("cancelar só avalia a política de cancelamento; remarcar avalia horário + política", () => {
    const cancel = baseInput("public", { action: "cancel", startTime: NOW - 1, service: { clientCanCancel: false } });
    expect(codes(evaluateRules(cancel))).toEqual(["CLIENT_CANNOT_CANCEL"]);
    expect(codes(evaluateRules({ ...cancel, service: {} }))).toEqual([]);
    const re = baseInput("ai", { action: "reschedule", service: { clientCanReschedule: false, minRescheduleNoticeMin: 60 }, existingStartTime: NOW + 30 * MIN, startTime: at("12:10") });
    expect(codes(evaluateRules(re)).sort()).toEqual(["CLIENT_CANNOT_RESCHEDULE", "OFF_GRID", "RESCHEDULE_NOTICE"].sort());
  });
  it("AI_DAILY_LIMIT só para classe ai; abaixo do limite passa", () => {
    expect(codes(evaluateRules(baseInput("ai", { aiBookingsTodayForContact: 1 })))).toEqual([]);
    expect(codes(evaluateRules(baseInput("waitlist", { aiBookingsTodayForContact: 2 })))).toEqual(["AI_DAILY_LIMIT"]);
    expect(codes(evaluateRules(baseInput("public", { aiBookingsTodayForContact: 9 })))).toEqual([]);
  });
  it("WRONG_ORG_OR_INACTIVE: uma violação por problema distinto, block para todos", () => {
    const v = evaluateRules(baseInput("staff", { entityProblems: ["service", "service", "contact", "requirement"] }));
    expect(v).toHaveLength(3);
    expect(v.every((x) => x.severity === "block")).toBe(true);
  });
});

describe("applyForce", () => {
  const warn = (code: RuleCode): Violation => ({ code, severity: "warn", message: "x" });
  const block = (code: RuleCode): Violation => ({ code, severity: "block", message: "x" });

  it("staff força warn pedido; warn não pedido continua bloqueando; block nunca passa", () => {
    const r = applyForce([warn("OUTSIDE_HOURS"), warn("CLIENT_OVERLAP"), block("CAPACITY_EXCEEDED")], ["OUTSIDE_HOURS", "CAPACITY_EXCEEDED"], "staff");
    expect(r.forced).toEqual(["OUTSIDE_HOURS"]);
    expect(r.blocking.map((v) => v.code)).toEqual(["CLIENT_OVERLAP", "CAPACITY_EXCEEDED"]);
    expect(r.ignoredForce).toEqual(["CAPACITY_EXCEEDED"]);
  });
  it("api e human_message também forçam (classe staff); ai, waitlist e public nunca", () => {
    for (const o of ["staff", "api", "human_message", "import"] as const) {
      expect(applyForce([warn("RESOURCE_CLOSED")], ["RESOURCE_CLOSED"], o).blocking).toEqual([]);
    }
    for (const o of ["ai", "waitlist", "public"] as const) {
      const r = applyForce([warn("RESOURCE_CLOSED")], ["RESOURCE_CLOSED"], o);
      expect(r.blocking).toHaveLength(1);
      expect(r.forced).toEqual([]);
      expect(r.ignoredForce).toEqual(["RESOURCE_CLOSED"]);
    }
  });
  it("fit_in só quando se força horário, folga ou grade", () => {
    for (const c of FIT_IN_CODES) expect(applyForce([warn(c)], [c], "staff").kind).toBe("fit_in");
    for (const c of ["CLIENT_OVERLAP", "MAX_ACTIVE_PER_CONTACT", "MAX_ADVANCE", "PAST_START"] as const) {
      expect(applyForce([warn(c)], [c], "staff").kind).toBe("normal");
    }
    expect(applyForce([warn("OUTSIDE_HOURS")], [], "staff")).toMatchObject({ kind: "normal", forced: [] });
    expect(applyForce([], undefined, "staff")).toEqual({ blocking: [], forced: [], ignoredForce: [], kind: "normal" });
  });
  it("mesmo código em dois recursos entra uma vez em forced", () => {
    expect(applyForce([warn("RESOURCE_CLOSED"), warn("RESOURCE_CLOSED")], ["RESOURCE_CLOSED"], "staff").forced).toEqual(["RESOURCE_CLOSED"]);
  });
  it("integração: staff fora do expediente forçado vira fit_in; IA no mesmo horário fica bloqueada", () => {
    const staffV = evaluateRules(TRIGGERS.OUTSIDE_HOURS("staff"));
    expect(applyForce(staffV, ["OUTSIDE_HOURS", "PAST_START"], "staff")).toMatchObject({ blocking: [], forced: ["OUTSIDE_HOURS"], kind: "fit_in" });
    const aiV = evaluateRules(TRIGGERS.OUTSIDE_HOURS("ai"));
    expect(applyForce(aiV, ["OUTSIDE_HOURS"], "ai").blocking.length).toBeGreaterThan(0);
  });
});
