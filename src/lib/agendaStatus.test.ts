import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_STATUS_META,
  isActiveStatus,
  isKnownOrigin,
  isKnownStatus,
  originBadgeKind,
  originLabel,
  statusMeta,
  vacancyOf,
} from "./agendaStatus";
import { APPOINTMENT_ORIGINS, APPOINTMENT_STATUSES } from "./agendaTypes";

describe("status", () => {
  it("todo status do schema tem meta, e só eles", () => {
    expect(Object.keys(APPOINTMENT_STATUS_META).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
  });

  it("ativos são os que ocupam horário (plano §2.4)", () => {
    const active = APPOINTMENT_STATUSES.filter((s) => APPOINTMENT_STATUS_META[s].active);
    expect(active).toEqual(["pending_approval", "scheduled", "confirmed", "checked_in", "completed"]);
    expect(isActiveStatus("no_show")).toBe(false);
    expect(isActiveStatus("cancelled")).toBe(false);
  });

  it("só aguardando aprovação é tracejado", () => {
    expect(APPOINTMENT_STATUSES.filter((s) => APPOINTMENT_STATUS_META[s].dashed)).toEqual(["pending_approval"]);
    expect(APPOINTMENT_STATUS_META.pending_approval.blockClassName).toContain("border-dashed");
  });

  it("classes usam só tokens do tema (nada de cor crua)", () => {
    for (const s of APPOINTMENT_STATUSES) {
      expect(APPOINTMENT_STATUS_META[s].blockClassName, s).not.toMatch(/#[0-9a-f]{3,8}|\b(?:red|green|blue|yellow|gray|slate|zinc)-\d{2,3}\b|\b(?:bg|text|border)-(?:white|black)\b/i);
    }
  });

  it("status desconhecido não quebra", () => {
    expect(statusMeta("novo_do_backend").label).toBe("Marcado");
    expect(isKnownStatus("novo_do_backend")).toBe(false);
    expect(isKnownStatus("confirmed")).toBe(true);
  });
});

describe("origem", () => {
  it("IA, Equipe, Link", () => {
    expect(originBadgeKind("ai")).toBe("ai");
    expect(originBadgeKind("waitlist")).toBe("ai");
    expect(originBadgeKind("public")).toBe("link");
    for (const o of ["staff", "api", "human_message", "import", "outra"]) expect(originBadgeKind(o), o).toBe("staff");
    expect(originLabel("ai")).toBe("IA");
    expect(originLabel("public")).toBe("Link");
    expect(originLabel("human_message")).toBe("Equipe");
  });

  it("origens do schema são conhecidas", () => {
    for (const o of APPOINTMENT_ORIGINS) expect(isKnownOrigin(o)).toBe(true);
    expect(isKnownOrigin("x")).toBe(false);
  });
});

describe("vacancyOf", () => {
  it("1/2, cheio e limites", () => {
    expect(vacancyOf(1, 2)).toMatchObject({ label: "1/2", full: false, a11y: "1 de 2 vagas ocupadas" });
    expect(vacancyOf(2, 2)).toMatchObject({ label: "2/2", full: true });
    expect(vacancyOf(0, 1)).toMatchObject({ label: "0/1", full: false, a11y: "0 de 1 vaga ocupada" });
    expect(vacancyOf(5, 2).label).toBe("2/2");
    expect(vacancyOf(-1, 2).label).toBe("0/2");
    expect(vacancyOf(1, 0).label).toBe("1/1");
    expect(vacancyOf(NaN, NaN).label).toBe("0/1");
    expect(vacancyOf(1, 2.9).capacity).toBe(2);
  });
});
