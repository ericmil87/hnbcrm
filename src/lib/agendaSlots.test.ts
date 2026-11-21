import { describe, expect, it } from "vitest";
import { type AllocationLite, computeDayAvailability, type ResourceLite } from "../../convex/lib/schedAvailability";
import type { Candidate } from "../../convex/lib/schedCandidates";
import { DEFAULT_WEIGHTS, scoreCandidate } from "../../convex/lib/schedScore";
import { atLocalMinutes } from "../../convex/lib/schedTime";
import { slotTouchesAnother } from "./agendaSlots";

describe("slotTouchesAnother", () => {
  it("prefere os códigos quando existem", () => {
    expect(slotTouchesAnother({ reasons: [], reasonCodes: ["ADJACENT"] })).toBe(true);
    expect(slotTouchesAnother({ reasons: ["logo após outro atendimento"], reasonCodes: ["OPENS_NEW"] })).toBe(false);
  });
  it("sem códigos, cai no texto", () => {
    expect(slotTouchesAnother({ reasons: ["logo antes de outro atendimento"] })).toBe(true);
    expect(slotTouchesAnother({ reasons: ["abre um recurso novo", "no início do expediente"] })).toBe(false);
  });
});

describe("PROTEÇÃO: o texto real do servidor ainda é reconhecido", () => {
  const tz = "America/Sao_Paulo";
  const MON = "2026-11-23";
  const at = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return atLocalMinutes(MON, h * 60 + m, tz);
  };
  const room: ResourceLite = { _id: "A", kind: "room", name: "Sala A", capacity: 1, weekly: [{ weekday: 1, startMin: 480, endMin: 1080 }], sortOrder: 0, active: true };
  const busy: AllocationLite = { appointmentId: "x", resourceId: "A", blockStart: at("09:00"), blockEnd: at("10:00"), coreStart: at("09:00"), coreEnd: at("10:00"), units: 1 };
  const day = computeDayAvailability({ date: MON, tz, resources: [room], exceptions: [], allocations: [busy], internalEvents: [] });
  const cand = (s: string, e: string): Candidate => ({ startTime: at(s), endTime: at(e), blockStart: at(s), blockEnd: at(e), plan: [{ role: "Sala", resourceId: "A", units: 1 }] });
  const score = (c: Candidate) => scoreCandidate(c, day, DEFAULT_WEIGHTS, { minUsefulGapMin: 30, tz });

  it("candidato colado em outro atendimento é 'encostado'", () => {
    const after = score(cand("10:00", "11:00"));
    expect(after.reasons.length).toBeGreaterThan(0);
    expect(slotTouchesAnother({ reasons: after.reasons })).toBe(true);
    const before = score(cand("08:00", "09:00"));
    expect(slotTouchesAnother({ reasons: before.reasons })).toBe(true);
  });
  it("candidato solto no meio do dia não é", () => {
    expect(slotTouchesAnother({ reasons: score(cand("14:00", "15:00")).reasons })).toBe(false);
  });
});
